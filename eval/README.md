# Retrieval eval

This eval measures how much retrieval quality PotluckRAG loses by keeping each member's files on their own machine, compared with one central index over the same files.

## Reproduce

Requirements: Node 22.13+, `pnpm install`, and an OpenAI-compatible embeddings server. The recorded run used Ollama 0.35.1 on localhost.

```sh
OLLAMA_HOST=127.0.0.1:11434 ollama serve &
ollama pull nomic-embed-text:v1.5
node --no-warnings eval/run.js --model nomic-embed-text:v1.5
```

Flags:

| Flag | Default | Meaning |
|---|---|---|
| `--url` | `http://127.0.0.1:11434` | Embeddings server base URL |
| `--model` | `nomic-embed-text:v1.5` | Embedding model, used for indexing and for rescoring |
| `--k` | `8` | Snippets each member returns in federated modes (1 to 20) |

The runner builds every index from scratch in a temporary directory under `os.tmpdir()` and deletes it on exit. It prints a Markdown table to stdout, per-question progress to stderr, and writes `eval/results/<date>-<model>.json` with the summary, every question's top 5 snippets (file and line range) and the rank of each gold file.

To check the wiring without a GPU, use the fake upstream. Its scores mean nothing.

```sh
node src/fake-upstream.js 11999 &
node --no-warnings eval/run.js --url http://127.0.0.1:11999 --model fake-embed
```

## Modes

All three modes use only the modules' public functions: `createEmbedder`, `createIndex` (`watch: false`), `Index.search` and `rescore` from `src/ask.js`.

- `central`: one index over the three member folders. `search(question, 5)`.
- `federated`: one index per member. Each returns its top `k` snippets with scores removed, as on the wire. The asker merges them and calls `rescore` with the same embedding model, keeping the top 5. This is what `potluckrag ask` does.
- `federated-no-rescore`: the same per-member lists, merged by taking each member's first snippet, then each member's second, and so on, until there are 5. The starting member rotates with the question index so no member always goes first. This is the baseline that shows what rescoring adds.

## Metrics

A question's gold set is one or more corpus files, written as `member/file.md`. A snippet counts as a match when it comes from a gold file. Metrics look only at the 5 snippets the asker would pass to the chat model.

- Recall@5: the share of a question's gold files that appear among the top 5 snippets, averaged over questions. A question with two gold files and one found scores 0.5.
- MRR@5: 1 divided by the rank of the first snippet from any gold file (0 if none in the top 5), averaged over questions.
- Top cosine: the highest cosine similarity between the question and any of the 5 snippets, with the eval's embedding model. It uses the same scale in every mode and shows whether "no answer" questions look different from answerable ones.

The three questions with an empty gold set (`n01` to `n03`) are excluded from recall and MRR and reported only through top cosine.

## Corpus

20 `README.md` files from Holepunch repositories under MIT or Apache-2.0, fetched at the commits listed in `corpus/SOURCES.md`. Line 1 of each file names the repository, license and commit. Each member holds a coherent subset:

| Member | Theme | Files |
|---|---|---|
| alice | storage and data structures | hypercore, hyperbee, hyperdrive, hyperblobs, autobase, hyperdb, localdrive, mirror-drive |
| bob | networking | hyperswarm, hyperdht, hyperswarm-secret-stream, protomux, blind-peer, blind-peering |
| carol | runtime, platform and primitives | bare, bare-fs, bare-module, pear, compact-encoding, hypercore-crypto |

`corestore` was left out because the GitHub API reports no license for it. `secret-stream` does not exist as a repository; `hyperswarm-secret-stream` is the package's repository.

## Questions

`questions.json` holds 31 questions: 28 with gold files and 3 with none. Each answerable question was written from a passage cited in its `evidence` field (`member/file.md:start-end`, 1-based lines including the source comment on line 1). The questions avoid the passage's wording: no question shares more than three consecutive words with its gold files. Four questions need files from two members (q16, q23, q27, q28), and three more need two files from one member (q14, q19, q21).

## Results (2026-10-23, nomic-embed-text:v1.5, k=8)

Model digest `0a109f422b47e3a30ba2b10eca18548e944e8a23073ee3f3e947efcf3c45e59f`. Chunks: 585 central; alice 308, bob 140, carol 137. Two runs gave identical numbers.

| Mode | Recall@5 (n=28) | MRR@5 | Recall@5 cross-member (n=4) | MRR@5 cross-member | Top cosine, answerable | Top cosine, no answer (n=3) |
|---|---|---|---|---|---|---|
| central | 0.929 | 0.848 | 0.750 | 1.000 | 0.635 | 0.553 |
| federated | 0.893 | 0.798 | 0.750 | 0.875 | 0.638 | 0.553 |
| federated-no-rescore | 0.821 | 0.528 | 0.875 | 0.583 | 0.630 | 0.551 |

Central minus federated, with a paired bootstrap 95% interval over questions (10,000 resamples, seeded, from `node eval/compare.js eval/results/2026-10-23-nomic-embed-text-v1.5.json`): recall@5 +0.036 (-0.036 to +0.125), MRR@5 +0.051 (-0.071 to +0.176). Central scored higher on 2 questions for recall and lower on 1. The intervals include zero, so this run does not show a loss from federation, and it cannot rule out a loss of about 0.1 either.

Central minus federated without rescoring (`compare.js <file> central federated-no-rescore`): recall@5 +0.107 (+0.000 to +0.232), MRR@5 +0.320 (+0.205 to +0.432). Federated minus federated without rescoring: MRR@5 +0.270 (+0.130 to +0.401). Rescoring at the asker accounts for most of the difference between the two federated modes, mainly in rank order.

Central and federated each missed one question entirely: central missed q21 (the two blind-peer files), federated missed q12 (localdrive's atomic writes, where hyperdrive snippets filled the top 5).

Top cosine does not separate the no-answer questions. Their top cosines (0.505 to 0.585) overlap with the lowest answerable ones (minimum 0.535 in every mode), so a fixed cosine threshold would reject some answerable questions before it rejected all no-answer ones.

## Limits

- The person who wrote the questions also built the system and read the corpus before writing them. Questions may favour the chunking and phrasing the system handles well.
- n is small: 28 answerable questions, 4 of them cross-member. One question changes recall@5 by about 0.036.
- One embedding model. nomic-embed-text is trained with `search_query:` and `search_document:` prefixes, which the embedder does not add. Other models may rank differently.
- One corpus of API READMEs with heavy shared vocabulary (many files define `ready`, `close`, `replicate`), and gold labels are at file level, not passage level.
- Federated modes run the per-member indexes in one process. The eval does not cover network loss, deadlines or members that do not answer.
- The run is deterministic for a fixed model and corpus, but the numbers depend on the chunker, BM25 and fusion settings in `src/index/` at the time of the run.
