# Threat model

PotluckRAG lets team members search each other's shared folders. This file lists what it protects, from whom, and what it does not protect.

## Assets

- The contents of each member's shared folders.
- Files near the shared folders that were never meant to be shared (keys, `.env` files, other folders).
- The questions members ask.
- Each member's machine: the local endpoint, the embedding server and the chat server.

## Trust assumptions

- Team members trust each other. A member who answers a search sees the question. A member who asks receives snippets. Neither side can stop the other from keeping what it saw.
- The team file reaches members over a private channel. It holds no secrets: an outsider who reads it learns the topic and the member keys, but cannot connect without a member's private key.
- The embedding and chat servers run on the member's own machine, or on a server the member trusts. PotluckLLM's `potluck use` endpoint counts as trusted: the provider sees the prompt, including the snippets.

## Outsiders on the internet

| Threat | Control | Test |
|---|---|---|
| A key not in the team file connects | Hyperswarm firewall closes the connection before any data flows, on both sides | peer.test.js: outside key gets no hits |
| Someone who knows the topic floods the log with rejected attempts | Reject lines rate-limited per window | Not tested in this repo. `src/log.js` is copied unchanged from PotluckLLM, where it is tested. |
| Traffic is read or altered in transit | Noise encryption bound to each Ed25519 key (Hyperswarm) | Not tested here; provided by `hyperswarm` |

## Members who misbehave or run buggy software

| Threat | Control | Test |
|---|---|---|
| Malformed or oversized messages crash the process | NDJSON framing caps messages at 4 MB, invalid JSON closes the connection, every hit field is type- and size-checked and invalid hits are dropped | peer.test.js: malicious peer |
| A peer claims another member's name | Names come from the asker's own team file, not from `hello` | peer.test.js |
| Control characters in a path or title rewrite the asker's terminal | Hits with control characters in `path` or `title` are dropped; streamed answers are stripped of control characters before printing | peer.test.js, bin/potluckrag.js `printable` |
| A member scrapes another's folders with many queries | At most 10 searches per member per 10 s, 4 at once, 20 snippets of 2000 characters per search. Every answered search is recorded with the passages sent (`potluckrag log`). This slows scraping and records it; it does not prevent it. | peer.test.js: rate limit, audit |
| One member's results crowd out others by reporting high scores | Scores are never sent. The asker re-scores every snippet with its own embedding model. | ask.test.js, eval (rescoring vs round-robin) |
| A snippet contains instructions aimed at the model (prompt injection) | Snippets are fenced and labelled as data in the prompt; the answer step has no tools; every answer lists its sources. A model can still be misled, so the answer must be checked against the sources. | ask.test.js: fence escape |

## Files that should never leave the machine

| Threat | Control | Test |
|---|---|---|
| Secrets inside a shared folder are indexed | Deny list: hidden files and folders (`.env`, `.ssh`, `.git`), `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `credentials.json`, `secrets.*`, databases, `node_modules`, build output. `.potluckragignore` adds patterns; `!` lines are skipped, so it cannot un-ignore a denied file. | index.test.js |
| A symlink inside a shared folder points outside it | Symlinked folders are never followed. A symlinked file is indexed only if its real path is inside the shared folder; it is opened with `O_NOFOLLOW` after the check. | index.test.js |
| Absolute paths reveal a member's username or folder layout | Only `<root name>/<relative path>` leaves the index layer and the logs | index.test.js, daemon.test.js |
| Embeddings are inverted to recover text | Embeddings never leave the machine. Only snippet text is sent, and only in answer to a search. | Design: wire protocol has no vector field |

## Web pages in a member's browser

| Threat | Control | Test |
|---|---|---|
| A page sends a cross-site request to the local endpoint | Any request with an `Origin` header is refused; POST bodies must be `application/json`, which a cross-site form cannot send without a preflight | daemon.test.js |
| DNS rebinding | Requests whose `Host` is not `127.0.0.1`, `localhost` or `[::1]` with the right port get 421 | daemon.test.js |
| Another local user calls the endpoint | Optional `POTLUCKRAG_API_KEY` bearer key, compared in constant time | daemon.test.js |

## Local data

- `~/.potluck/identity.json` holds the private seed (mode 0600, shared with PotluckLLM). Startup refuses a group- or world-writable identity folder.
- `~/.potluckrag/index.db` holds chunk text and embeddings of the shared folders. `~/.potluckrag/audit.jsonl` records who received which passages. The folder is created with mode 0700, and startup refuses it if other users can read it.
- Logs on stderr hold events, timings, key prefixes and root-relative paths. They never hold questions, snippet text or answers.

## Not covered

- A member who keeps what they received. Sharing a folder means trusting every member with the passages that match their questions.
- Questions are visible to every member who answers them.
- Members who are offline cannot answer, and their documents are not cached anywhere else. This is deliberate.
- Networks where hole punching fails. There is no relay fallback (same limit as PotluckLLM).
- The embedding and chat servers. Their security is their own.
