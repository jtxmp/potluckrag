# Contributing to PotluckRAG

Contributions are welcome, from a docs fix to new file formats. Issues labelled [`good first issue`](https://github.com/jtxmp/potluckrag/labels/good%20first%20issue) are small and self-contained. The most useful single contribution is [#2](https://github.com/jtxmp/potluckrag/issues/2): run two members on two real networks and post the numbers.

For questions and ideas, use [Discussions](https://github.com/jtxmp/potluckrag/discussions). For security problems, follow [SECURITY.md](SECURITY.md) and don't open a public issue.

## Setup

You need Node 22.13 or later and pnpm. No GPU, Ollama or second machine is needed for development.

```sh
git clone https://github.com/jtxmp/potluckrag && cd potluckrag
pnpm install
pnpm test                             # local DHT testnet and fake model
node bin/potluckrag.js try            # two members and a fake model, over the real DHT
git config core.hooksPath .githooks   # optional: scan each commit for secrets (needs gitleaks)
```

The retrieval eval needs Ollama with an embedding model: `node --no-warnings eval/run.js --model nomic-embed-text:v1.5`. See [eval/README.md](eval/README.md).

## Code map

| File | What it does |
|---|---|
| `bin/potluckrag.js` | CLI: argument parsing, `try`, `id`, `team`, `share`, `ask`, `status`, `log`; prints answers and sources |
| `src/daemon.js` | What `share` runs: index + peer + local HTTP endpoint; merges local and remote hits and re-ranks them |
| `src/peer.js` | Hyperswarm: allow-list, `hello`, answering searches with limits, fan-out with a deadline, validation of incoming hits, lookup retry |
| `src/ask.js` | Re-ranking (`rescore`), the prompt (`buildMessages`), streaming from the chat server (`streamAnswer`) |
| `src/http.js` | Local endpoint on 127.0.0.1: `GET /status`, `POST /search`, Host/Origin/content-type checks, optional API key |
| `src/audit.js` | Append-only JSONL of passages sent to members |
| `src/protocol.js` | Wire format: newline-delimited JSON (message list at the top of the file) |
| `src/index/indexer.js` | Scans and watches shared folders, re-indexes changed files, keeps paths root-relative, symlink checks |
| `src/index/chunk.js` | Splits text into passages with line ranges |
| `src/index/ignore.js` | Deny list, `.potluckragignore`, which extensions are indexed |
| `src/index/embed.js` | Client for `/v1/embeddings` |
| `src/index/store.js` | `node:sqlite` storage, FTS5 keyword search, in-memory vector search |
| `src/index/search.js` | Hybrid search: vectors + BM25, reciprocal rank fusion |
| `src/team.js`, `src/identity.js`, `src/log.js` | Shared with PotluckLLM: team file, Ed25519 identity, event logs |
| `src/fake-upstream.js` | Fake OpenAI-compatible server (embeddings and chat) for `try` and the tests |
| `test/*.test.js` | `index`, `peer`, `ask` and end-to-end `daemon` tests |
| `eval/` | Retrieval eval: corpus, questions, runner, bootstrap comparison |
| `spike/` | Measurements behind design choices (connections, vector scan, `fs.watch`, FTS5) |

A question goes: `ask` → `POST /search` on the local `share` → own index and `search` messages to every member → each member's `hybridSearch` → `hits` back → `rescore` → `buildMessages` → `streamAnswer`.

## House rules

- **Plain JavaScript with types in comments.** ES modules, `// @ts-check` and JSDoc types, no build step. Match the style of the file you're editing.
- **No new runtime dependency without an issue first.** There is one today (`hyperswarm`). A dependency is code every user has to trust.
- **Every fix and feature comes with a test.** Tests must not need a GPU, Ollama or the internet; use `src/fake-upstream.js` and `hyperdht/testnet`. Check that your test fails without your change.
- **Validate whatever crosses a trust boundary.** Messages from peers, files in shared folders and requests to the local endpoint are untrusted. [docs/threat-model.md](docs/threat-model.md) lists the controls and their tests. A change that weakens one needs a discussion first.
- **Never log questions, passages or answers.** Logs hold event names, 8-character key prefixes, root-relative paths and timings.
- **Retrieval changes come with an eval run.** If you change chunking, search or ranking, include the before and after table from `eval/run.js`.

## Pull requests

- Keep each pull request to one change, and link the issue it closes.
- Say how you verified it: tests added, commands run, networks tried.
- CI runs the tests on Linux and macOS, `pnpm audit` and a secrets scan. All must pass.
- Contributions are licensed under the [MIT License](LICENSE).
