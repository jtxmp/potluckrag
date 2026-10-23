# Changelog

All notable changes are listed here. Versions follow [Semantic Versioning](https://semver.org/).

## 0.1.1 (2026-10-23)

- Chat and embedding requests now time out reliably. A stalled chat stream hung past its timeout in a macOS CI run. Both clients now use a plain timer, and the embeddings timeout also covers reading the response body ([#14](https://github.com/jtxmp/potluckrag/pull/14)).

## 0.1.0 (2026-10-23)

First release.

- `potluckrag share` indexes folders into SQLite (full-text and vectors), watches them, and answers team members' searches over Hyperswarm. `potluckrag ask` searches every connected member, re-ranks the passages with the asker's own embedding model and streams a cited answer from an OpenAI-compatible chat server.
- `potluckrag try` runs two members, sample notes and a fake model on one machine over the real DHT.
- `potluckrag id`, `team init` and `team add` share PotluckLLM's identity and team file format.
- Per-member limits on searches, an audit log of passages sent (`potluckrag log`), and a deny list for secrets and hidden files.
- Retrieval eval in `eval/`: federated vs central index on 28 questions.
