# PotluckRAG

[![test](https://github.com/jtxmp/potluckrag/actions/workflows/test.yml/badge.svg)](https://github.com/jtxmp/potluckrag/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22.13-brightgreen)](package.json)

PotluckRAG is a command-line tool that answers questions from the documents on your team members' machines without copying those documents anywhere. Each member runs `potluckrag share <folder>`, which indexes that folder on their own machine. `potluckrag ask` sends the question to every connected member over [Hyperswarm](https://github.com/holepunchto/hyperswarm). Each member searches its own index and returns at most a few passages. The asker ranks the passages and a local model writes an answer that cites them.

There is no server. No index holds everyone's files, and no member's files leave their machine except the passages that match a question. Every member records which passages it sent to whom.

It is a sibling of [PotluckLLM](https://github.com/jtxmp/potluckllm) and uses the same identity and team file, so a team that already shares models with `potluck` can search documents with no new setup.

## Who this is for

- A small team whose working notes, specs and runbooks are spread across members' laptops, and who will not upload them to a shared server or a cloud AI service.
- One person with documents on several machines.

Members must trust each other: a member who answers sees the question, and a member who asks receives the matching passages. See [Security](#security).

## Quickstart

Requires Node 22.13 or later and an OpenAI-compatible server for embeddings and chat, such as [Ollama](https://ollama.com):

```sh
ollama pull nomic-embed-text      # embeddings, 274 MB
ollama pull llama3.2:3b           # answers; any chat model works
```

PotluckRAG is not on npm yet. From a clone, run `pnpm install`, then use `node bin/potluckrag.js` wherever this README says `potluckrag`.

Every member prints their public key and sends it to the team owner. If you use PotluckLLM, this is the same key:

```sh
potluckrag id
```

The team owner creates the team file, adds members, and sends `team.json` to each of them over a private channel:

```sh
potluckrag team init my-team --member alice
potluckrag team add bob <bob's public key>
```

Each member shares one or more folders and leaves the command running:

```sh
potluckrag share ~/notes ~/specs
```

Then, from any member's machine:

```sh
potluckrag ask "How do we roll back a release?"
```

The answer streams to the terminal, followed by its sources (`[1] alice:notes/runbook.md#L3-12`) and how many members answered.

### Try it without Ollama

```sh
node bin/potluckrag.js try
```

This starts two members in one process with throwaway keys, sample notes and a fake model. They connect through the public HyperDHT, and one asks a question that only the other's notes can answer.

## Commands and options

| Command | What it does |
|---|---|
| `potluckrag try` | Two members, sample notes and a fake model on one machine |
| `potluckrag id` | Prints your public key, creating it on first run |
| `potluckrag team init <team-name> [--member <name>]` | Creates a team file with you as the first member |
| `potluckrag team add <name> <public-key>` | Adds a member to the team file |
| `potluckrag share <folder>...` | Indexes the folders, watches them for changes and answers the team's searches |
| `potluckrag ask <question>` | Searches every member's folders and answers with sources |
| `potluckrag status` | Lists connected members and index sizes |
| `potluckrag log` | Lists which passages you sent to which member, and when |

| Option | Used by | Default |
|---|---|---|
| `--team <file>` | `team`, `share` | `./team.json` |
| `--port <n>` | `share`, `ask`, `status` | 11600 |
| `--embed-url <url>` | `share` | `http://127.0.0.1:11434` |
| `--embed-model <name>` | `share` | `nomic-embed-text` |
| `--chat-url <url>` | `ask`. PotluckLLM's `http://127.0.0.1:11500` works | `http://127.0.0.1:11434` |
| `--chat-model <name>` | `ask` | `llama3.2:3b` |
| `-k <n>` | `ask`: passages per answer, at most 20 | 8 |
| `--deadline <s>` | `share`: how long a question waits for members | 3 |
| `--json` | `ask`: print the passages as JSON and skip the answer | off |
| `--no-watch` | `share`: index once, do not watch | off |

`POTLUCKRAG_API_KEY` makes the local endpoint require a bearer key. `POTLUCKRAG_CHAT_KEY` is sent to `--chat-url` if that server needs one. `share` reloads the team file when it changes and disconnects removed members.

## How it works

```
 asker                                       each member (same command)
 ┌──────────────────────────────┐          ┌──────────────────────────────────┐
 │ potluckrag ask "q"           │          │ potluckrag share ~/notes         │
 │   │ http 127.0.0.1:11600      │          │   watch -> chunk -> embed        │
 │   ▼                          │  search  │   SQLite: text, vectors, FTS5    │
 │ potluckrag share (local)     ├─────────▶│   hybrid search                  │
 │   own index + members' hits  │◀─────────┤   passages only, no scores       │
 │   re-ranked with own model   │   hits   │   audit log: who got which lines │
 │   ▼                          │          └──────────────────────────────────┘
 │ chat model writes the answer │    Hyperswarm topic from team.json,
 │ with [n] citations           │    Noise-encrypted, key allow-list
 └──────────────────────────────┘
```

- **Index.** Text, Markdown and code files are split at headings and paragraphs into passages of at most 1,600 characters with line ranges. Each passage is embedded once; a file is re-embedded only when its hash changes. Passages, vectors and a full-text index live in one SQLite file (Node's built-in `node:sqlite`) in `~/.potluckrag/`.
- **Search on each member.** Vector similarity and BM25 keyword ranking, merged with reciprocal rank fusion.
- **Fan-out.** The question goes to every connected member at once. The asker waits until all have answered or the deadline passes, then continues with what it has and reports, for example, "2 of 3 other members answered".
- **Ranking across members.** Scores from different indexes cannot be compared (members may use different embedding models), and a member could inflate them. Members therefore send no scores. The asker embeds every returned passage with its own model and ranks all of them against the question.
- **Answer.** The passages go to the chat model as numbered, fenced sources marked as data. The model is told to answer only from them and cite `[n]`. The CLI prints the source list after the answer.
- **Connections.** Same as PotluckLLM: Ed25519 identity in `~/.potluck/`, a random topic in `team.json`, HyperDHT hole punching, and a firewall that closes connections from keys not in the team file before any data flows.

## What leaves your machine

| Data | Who receives it |
|---|---|
| Your question | Every connected member |
| Passages from your shared folders that match a member's question (at most 20 per question, 2,000 characters each) | The member who asked |
| Root-relative file paths and line ranges of those passages | The member who asked |
| Your embeddings, whole files, absolute paths, files outside the shared folders | Nobody |
| Passages and your question, inside the prompt | The chat server at `--chat-url` |

Hidden files and folders, `.env*`, keys and certificates, `credentials.json`, `secrets.*`, databases, `node_modules` and build output are never indexed. Add more patterns in a `.potluckragignore` at the top of a shared folder.

## Security

PotluckRAG protects a team from outsiders on the internet, from web pages running in a member's browser, and from a member's buggy or hostile software crashing another member's process or reading files outside the shared folders. It does not protect members from each other: what a member receives, they can keep.

- A key not in `team.json` cannot connect.
- Each member answers at most 10 searches per member per 10 seconds and 4 at once, and records every passage it sends (`potluckrag log`). This slows a member who tries to copy someone's folder through many questions and leaves a record. It does not stop them.
- Hits from other members are checked field by field; malformed ones are dropped. Paths and titles with control characters are dropped, and control characters are stripped from answers before they reach the terminal.
- Symlinks that point outside a shared folder are not followed.
- The local endpoint listens on 127.0.0.1, refuses requests with an `Origin` header or a foreign `Host` header, and accepts only JSON bodies.
- Passages can contain text written to mislead the model (prompt injection). The answer step has no tools, so the worst case is a wrong answer. Check answers against their sources.
- Logs hold events, timings and root-relative paths. They never hold questions, passages or answers.

The full threat model, with the test that covers each control, is in [docs/threat-model.md](docs/threat-model.md).

## Measurements

### Retrieval quality: federated vs one central index

The question is how much search quality a team gives up by keeping documents apart. [`eval/`](eval/) splits 20 Holepunch module READMEs (MIT and Apache-2.0) across three simulated members and asks 28 questions with known source files. `central` indexes all files in one place. `federated` is what PotluckRAG does: each member returns its top 8, the asker re-ranks. `federated-no-rescore` merges members' lists in turn without re-ranking.

Measured 2026-10-23 with `nomic-embed-text:v1.5` on Ollama 0.35.1.

| Mode | Recall@5 | MRR@5 |
|---|---|---|
| central | 0.929 | 0.848 |
| federated | 0.893 | 0.798 |
| federated-no-rescore | 0.821 | 0.528 |

Central minus federated: recall@5 +0.036 (95% interval -0.036 to +0.125), MRR@5 +0.051 (-0.071 to +0.176), paired bootstrap over questions. The intervals include zero, so this run shows no loss from federation, and it cannot rule out a loss of about 0.1. Re-ranking at the asker raised MRR@5 by 0.270 over merging without it (+0.130 to +0.401).

Limits: 28 questions written by the person who built the system, one embedding model, one corpus. Details and reproduction steps are in [eval/README.md](eval/README.md).

### End to end on one machine

Two `share` processes with separate identities, the `alice` and `bob` eval corpora, real Ollama models, connected through the public HyperDHT on 2026-10-23. One question with `-k 4`: the search across both members took 108 ms (daemon log `search ... ms=108`), and the whole `ask` command, including the `llama3.2:3b` answer on an RTX 3050 Ti Laptop GPU, took 5.1 s. One run only; both processes shared one network, so this does not measure a real network path.

### Search speed and connection time

Measured 2026-10-23 on an i7-11600H with Node 22.22.2. Scripts and raw output are in [`spike/`](spike/RESULTS.md).

| Passages in one member's index | Median vector search, 768 dimensions | Memory for vectors |
|---|---|---|
| 10,000 | 8 ms | 30 MiB |
| 50,000 | 39 ms | 147 MiB |
| 100,000 | 78 ms | 293 MiB |

Vectors are loaded from SQLite into memory when `share` starts. Reading them from SQLite on every search was 5 to 6 times slower in the same test. The eval corpus of 20 READMEs makes 585 passages, so 100,000 passages corresponds to a few thousand documents of that size.

Two members on one machine found each other through the public HyperDHT in a median of 4.3 s (3 runs). Members that join at the same moment can miss each other's announcements, so each member looks up the topic again with backoff (5 s, up to 60 s) for as long as any team member is not connected.

## Limits

- Members who are offline cannot answer, and their documents are not cached anywhere. This is the cost of keeping documents on their owners' machines.
- Text, Markdown and code only. PDF and Word files are not indexed.
- Vector search compares the question against every stored passage, so search time grows with the size of the shared folders: about 78 ms and 293 MiB at 100,000 passages.
- A member that stays offline makes every other member look up the topic once a minute.
- Small models can cite the wrong source number. In one test run, `llama3.2:3b` cited `[3]` for text that came from `[2]`. The printed source list is correct; the citation in the answer text may not be.
- `nomic-embed-text` is trained with `search_query:` and `search_document:` prefixes, which PotluckRAG does not add yet.
- Tested on Linux only. Windows and macOS are untested.
- No relay fallback, so networks where hole punching fails cannot connect (same as PotluckLLM).

## Development

```sh
pnpm install
pnpm test                          # unit and integration tests on a local DHT testnet, fake model, no GPU or internet
node bin/potluckrag.js try         # the whole path on one machine
node --no-warnings eval/run.js --model nomic-embed-text:v1.5   # retrieval eval, needs Ollama
node eval/compare.js eval/results/<file>.json  # bootstrap interval between two modes
git config core.hooksPath .githooks            # scan each commit for secrets (needs gitleaks)
```

Module interfaces are in [docs/contracts.md](docs/contracts.md).

## License

MIT. See [LICENSE](LICENSE). The eval corpus in `eval/corpus/` is third-party documentation under its own licenses, listed in [eval/corpus/SOURCES.md](eval/corpus/SOURCES.md).

## How this was built

PotluckRAG was planned and built with Claude Code, with four agents working in parallel against shared interface contracts. The product requirements and measured results are in [docs/PRD.md](docs/PRD.md).
