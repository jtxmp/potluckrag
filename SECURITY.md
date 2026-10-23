# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub: [open a private advisory](https://github.com/jtxmp/potluckrag/security/advisories/new). Please don't open a public issue for a security problem.

Include what you found, how to reproduce it, and what an attacker gains. This is a personal project, so reports are handled on a best-effort basis. Fixes land on `main`, which is the only supported version.

## What PotluckRAG defends against

The full threat model is in [docs/threat-model.md](docs/threat-model.md). In short: PotluckRAG protects a team from outsiders on the internet, from web pages running in a member's browser, and from files outside the shared folders being sent. It does not protect members from each other: a member who answers sees the question, and a member who asks keeps the passages it receives.

In scope:

- Connecting to a member without a key listed in `team.json`
- Reading a file outside a shared folder, or a denied file inside one (`.env`, keys, hidden files), through a search
- Learning a member's absolute paths or embeddings
- Reaching the local endpoint from a web page or another origin
- Crashing or hanging a member with crafted protocol messages
- Getting more passages than the per-member limits allow
- Questions, passages, answers or private keys appearing in logs

Out of scope:

- A member keeping or sharing passages they received, or seeing questions they answered
- Prompt injection that makes the chat model give a wrong answer (the answer step has no tools)
- Attacks that need write access to the user's home directory
- Vulnerabilities in Ollama or the embedding and chat servers
