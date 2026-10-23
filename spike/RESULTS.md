# M0 spike results

Measured on 2026-10-23.

## Machine

| | |
|---|---|
| CPU | 11th Gen Intel(R) Core(TM) i7-11600H @ 2.90GHz, 12 logical CPUs (`/proc/cpuinfo`) |
| RAM | 65548396 kB (62.5 GiB) (`/proc/meminfo`) |
| OS | Linux 7.1.13-100.fc43.x86_64 (Fedora 43) |
| Node | v22.22.2 |
| SQLite (node:sqlite) | 3.50.2 |
| `os.tmpdir()` | `/tmp`, a tmpfs mount, so the SQLite file in question 2 lived in RAM |
| Packages | hyperswarm 4.17.2, hyperdht 6.34.1 |

Derived numbers below (medians, ratios, per-chunk costs, chunks per 100 ms) were computed with Python over the scripts' JSON output.

## 1. Connections

```
node --no-warnings spike/connections.js                   # local testnet, 2/3/5 members, 3 runs per join mode
node --no-warnings spike/connections.js public            # public DHT, 2 members, 3 runs per join mode
node --no-warnings spike/connections.js testnet refresh   # one network, one join mode
```

Every member calls `swarm.join(topic, { server: true, client: true })`. The script tracks `connection` events, and opens and closes per remote public key. It waits for full mesh (every member has at least one live connection to every other member, 30 s timeout), then 5 s more to settle, then reads the state. Three join modes:

- `simultaneous`: all members call `join()` in the same tick.
- `staggered`: each member joins after the previous member's `join().flushed()` resolves.
- `refresh`: simultaneous, then every member calls `discovery.refresh()` once after `flushed()`.

### Testnet (`createTestnet(3)`), per-run summary

`mesh` is ms from the first `join()` call; `afterLast` is ms from the last member's `join()` call; `exact1` is pairs where both sides hold exactly one live connection after settling; `events` is `connection` events per member; `dupOpens` is the count of second opens to an already-seen remote key.

```
simultaneous n=2 run=1 joins [0, 1] flushed 10 mesh -1 afterLast -1 exact1 0/1 events [0, 0] dupOpens 0
simultaneous n=2 run=2 joins [0, 0] flushed 4 mesh -1 afterLast -1 exact1 0/1 events [0, 0] dupOpens 0
simultaneous n=2 run=3 joins [0, 0] flushed 4 mesh -1 afterLast -1 exact1 0/1 events [0, 0] dupOpens 0
simultaneous n=3 run=1 joins [0, 1, 1] flushed 5 mesh -1 afterLast -1 exact1 0/3 events [0, 0, 0] dupOpens 0
simultaneous n=3 run=2 joins [0, 0, 0] flushed 4 mesh -1 afterLast -1 exact1 0/3 events [0, 0, 0] dupOpens 0
simultaneous n=3 run=3 joins [0, 0, 0] flushed 4 mesh -1 afterLast -1 exact1 0/3 events [0, 0, 0] dupOpens 0
simultaneous n=5 run=1 joins [0, 0, 0, 0, 0] flushed 6 mesh -1 afterLast -1 exact1 0/10 events [0, 0, 0, 0, 0] dupOpens 0
simultaneous n=5 run=2 joins [0, 0, 0, 0, 0] flushed 6 mesh -1 afterLast -1 exact1 0/10 events [0, 0, 0, 0, 0] dupOpens 0
simultaneous n=5 run=3 joins [0, 0, 0, 0, 0] flushed 6 mesh -1 afterLast -1 exact1 0/10 events [0, 0, 0, 0, 0] dupOpens 0
staggered n=2 run=1 joins [0, 3] flushed 11 mesh 16 afterLast 13 exact1 1/1 events [1, 1] dupOpens 0
staggered n=2 run=2 joins [0, 2] flushed 5 mesh 7 afterLast 5 exact1 1/1 events [1, 1] dupOpens 0
staggered n=2 run=3 joins [0, 2] flushed 5 mesh 7 afterLast 5 exact1 1/1 events [1, 1] dupOpens 0
staggered n=3 run=1 joins [0, 2, 5] flushed 11 mesh 14 afterLast 9 exact1 3/3 events [2, 2, 2] dupOpens 0
staggered n=3 run=2 joins [0, 2, 5] flushed 8 mesh 12 afterLast 7 exact1 3/3 events [2, 2, 2] dupOpens 0
staggered n=3 run=3 joins [0, 2, 4] flushed 8 mesh 12 afterLast 8 exact1 3/3 events [2, 2, 2] dupOpens 0
staggered n=5 run=1 joins [0, 2, 4, 8, 14] flushed 21 mesh 26 afterLast 12 exact1 10/10 events [4, 4, 4, 4, 4] dupOpens 0
staggered n=5 run=2 joins [0, 3, 5, 8, 14] flushed 22 mesh 27 afterLast 13 exact1 10/10 events [4, 4, 4, 4, 4] dupOpens 0
staggered n=5 run=3 joins [0, 3, 6, 12, 21] flushed 33 mesh 41 afterLast 20 exact1 10/10 events [4, 4, 4, 4, 4] dupOpens 0
refresh n=2 run=1 joins [0, 0] flushed 8 mesh 9 afterLast 9 exact1 1/1 events [2, 1] dupOpens 1
refresh n=2 run=2 joins [0, 0] flushed 5 mesh 6 afterLast 6 exact1 1/1 events [1, 2] dupOpens 1
refresh n=2 run=3 joins [0, 0] flushed 5 mesh 6 afterLast 6 exact1 1/1 events [1, 2] dupOpens 1
refresh n=3 run=1 joins [0, 1, 1] flushed 11 mesh 15 afterLast 14 exact1 3/3 events [2, 3, 4] dupOpens 3
refresh n=3 run=2 joins [0, 1, 1] flushed 11 mesh 15 afterLast 14 exact1 3/3 events [2, 3, 4] dupOpens 3
refresh n=3 run=3 joins [0, 1, 1] flushed 11 mesh 14 afterLast 13 exact1 3/3 events [4, 2, 3] dupOpens 3
refresh n=5 run=1 joins [0, 0, 0, 1, 1] flushed 21 mesh 57 afterLast 56 exact1 10/10 events [7, 8, 5, 4, 6] dupOpens 10
refresh n=5 run=2 joins [0, 0, 0, 0, 0] flushed 22 mesh 46 afterLast 46 exact1 10/10 events [6, 5, 7, 7, 4] dupOpens 9
refresh n=5 run=3 joins [0, 0, 0, 0, 0] flushed 23 mesh 46 afterLast 46 exact1 10/10 events [7, 6, 6, 5, 4] dupOpens 8
```

Aggregates (median over 3 runs):

| mode | n | meshed | median mesh ms | `connection` events per member (min..max) |
|---|---|---|---|---|
| simultaneous | 2 | 0/3 | none in 35 s | 0..0 |
| simultaneous | 3 | 0/3 | none in 35 s | 0..0 |
| simultaneous | 5 | 0/3 | none in 35 s | 0..0 |
| staggered | 2 | 3/3 | 7 | 1..1 |
| staggered | 3 | 3/3 | 12 | 2..2 |
| staggered | 5 | 3/3 | 27 | 4..4 |
| refresh | 2 | 3/3 | 6 | 1..2 |
| refresh | 3 | 3/3 | 15 | 2..4 |
| refresh | 5 | 3/3 | 46 | 4..8 |

Which duplicate closes (`testnet refresh` rerun, `closedOrder` = which open to that remote closed before the snapshot): 37 of 37 duplicate pairs closed connection 1 (the older one) and kept connection 2. All 3+3+3 runs ended with every pair at exactly one live connection. This rerun did not record whether the old connection closed before or after the new one opened.

```
2 1 mesh 27 exact1 1 / 1 [('m0', 'm1', 2, [1])]
2 2 mesh 11 exact1 1 / 1 [('m0', 'm1', 2, [1])]
2 3 mesh 11 exact1 1 / 1 [('m1', 'm0', 2, [1])]
3 1 mesh 20 exact1 3 / 3 [('m0', 'm2', 2, [1]), ('m0', 'm1', 2, [1]), ('m2', 'm1', 2, [1])]
3 2 mesh 19 exact1 3 / 3 [('m1', 'm2', 2, [1]), ('m1', 'm0', 2, [1]), ('m2', 'm0', 2, [1])]
3 3 mesh 16 exact1 3 / 3 [('m1', 'm2', 2, [1]), ('m1', 'm0', 2, [1]), ('m2', 'm0', 2, [1])]
5 1 mesh 59 exact1 10 / 10 [7 duplicate pairs, all closedOrder [1]]
5 2 mesh 49 exact1 10 / 10 [9 duplicate pairs, all closedOrder [1]]
5 3 mesh 51 exact1 10 / 10 [9 duplicate pairs, all closedOrder [1]]
Counter({'[1]': 37})
```

Why simultaneous joins fail on the testnet: with `server: true` the join runs a single DHT `announce` query, and peers are only read from that query's replies. When all members announce in the same few ms, no member's record is stored yet when the others query. `lib/peer-discovery.js` schedules the next refresh at `REFRESH_INTERVAL = 1000 * 60 * 10` (10 min) plus jitter. That interval comes from reading the source; the spike did not wait 10 minutes to observe it.

### Public DHT, 2 members on this machine

```
{"mode": "public", "joinMode": "simultaneous", "run": 1, "joinStartsMs": [0, 1], "announcedMs": 5770, "meshMs": 5553, "meshAfterLastJoinMs": 5552, "pairsExactlyOne": 1, "pairsTotal": 1, "connectionEvents": [1, 1]}
{"mode": "public", "joinMode": "simultaneous", "run": 2, "joinStartsMs": [0, 0], "announcedMs": 4762, "meshMs": -1, "meshAfterLastJoinMs": -1, "pairsExactlyOne": 0, "pairsTotal": 1, "connectionEvents": [0, 0]}
{"mode": "public", "joinMode": "simultaneous", "run": 3, "joinStartsMs": [0, 0], "announcedMs": 6015, "meshMs": 5320, "meshAfterLastJoinMs": 5320, "pairsExactlyOne": 1, "pairsTotal": 1, "connectionEvents": [1, 1]}
{"mode": "public", "joinMode": "staggered", "run": 1, "joinStartsMs": [0, 4580], "announcedMs": 8144, "meshMs": 8939, "meshAfterLastJoinMs": 4359, "pairsExactlyOne": 1, "pairsTotal": 1, "connectionEvents": [1, 1]}
{"mode": "public", "joinMode": "staggered", "run": 2, "joinStartsMs": [0, 5821], "announcedMs": 11708, "meshMs": 10107, "meshAfterLastJoinMs": 4286, "pairsExactlyOne": 1, "pairsTotal": 1, "connectionEvents": [1, 1]}
{"mode": "public", "joinMode": "staggered", "run": 3, "joinStartsMs": [0, 6665], "announcedMs": 12083, "meshMs": 9871, "meshAfterLastJoinMs": 3206, "pairsExactlyOne": 1, "pairsTotal": 1, "connectionEvents": [1, 1]}
{"mode": "public", "joinMode": "refresh", "run": 1, "joinStartsMs": [0, 0], "announcedMs": 7043, "meshMs": 5994, "meshAfterLastJoinMs": 5994, "pairsExactlyOne": 1, "pairsTotal": 1, "connectionEvents": [1, 1]}
{"mode": "public", "joinMode": "refresh", "run": 2, "joinStartsMs": [0, 1], "announcedMs": 7125, "meshMs": 6158, "meshAfterLastJoinMs": 6157, "pairsExactlyOne": 1, "pairsTotal": 1, "connectionEvents": [1, 2]}
{"mode": "public", "joinMode": "refresh", "run": 3, "joinStartsMs": [0, 0], "announcedMs": 7316, "meshMs": 5813, "meshAfterLastJoinMs": 5813, "pairsExactlyOne": 1, "pairsTotal": 1, "connectionEvents": [2, 1]}
```

Medians over 3 runs: simultaneous 2/3 connected, median 5436.5 ms over the 2 that connected; staggered 3/3, median 4286 ms from the second member's `join()`; refresh 3/3, median 5994 ms. The first member's own `join().flushed()` took 4580 to 6665 ms in the staggered runs.

**Consequence:** "one live connection per pair" holds after settling (every meshed run, 100%), but `connection` can fire twice for the same remote key, and two members that join at the same moment can miss each other for up to the 10-minute refresh. `peer.js` must key connections by remote public key, let a new connection replace the old one, ignore `close` from a replaced connection, and call `discovery.refresh()` once after `flushed()` (or on a short timer while the member list is incomplete). Budget about 5 to 6 s for the first connection on the public DHT.

## 2. Vector scan speed

```
node --no-warnings --expose-gc spike/vector-scan.js            # 10000 50000 100000
node --no-warnings --expose-gc spike/vector-scan.js 100000     # one size
```

768 dims, random vectors (fixed-seed PRNG), top-20 with a small insertion list, 20 timed queries after one warm-up. Variants:

- (a) `memory`: one contiguous `Float32Array`, full cosine (dot and both norms computed per row).
- (a2) `memoryDotPrenormalised`: same, vectors and query normalised in advance, plain dot product.
- (b) `sqlite`: `SELECT id, vector FROM chunks` via `stmt.iterate()` on every query, then the same cosine. The `chunks` row also holds path, lines, title and 1000 characters of text, so each row is about 4.6 KB and spills to overflow pages.
- (b2) `sqliteVectorOnlyTable`: same read from `vectors(id, vector)`.

All four variants returned the same top result on the last query (`topResultAgrees: true`).

Run 1 (all sizes in one process):

```
{"chunks":10000,"dims":768,"queries":20,"memory":{"medianMs":8.9,"minMs":8.8,"maxMs":9.54,"float32ArrayMB":29.3,"arrayBuffersDeltaMB":29.3,"rssDeltaMB":30.9},"memoryDotPrenormalised":{"medianMs":7.65,"minMs":7.54,"maxMs":17.8},"sqlite":{"medianMs":47.32,"minMs":45.59,"maxMs":51.29,"chunksTableFileMB":44,"chunksTableFileBytes":46100480,"insertMs":68},"sqliteVectorOnlyTable":{"medianMs":47.31,"minMs":45.12,"maxMs":51.69},"sqliteOverMemoryMedian":5.32,"sqliteVectorOnlyOverMemoryMedian":5.32,"topResultAgrees":true}
{"chunks":50000,"dims":768,"queries":20,"memory":{"medianMs":44.46,"minMs":44.18,"maxMs":45.41,"float32ArrayMB":146.5,"arrayBuffersDeltaMB":146.5,"rssDeltaMB":149.5},"memoryDotPrenormalised":{"medianMs":38.17,"minMs":37.88,"maxMs":39.16},"sqlite":{"medianMs":262.23,"minMs":255.97,"maxMs":291.04,"chunksTableFileMB":219.8,"chunksTableFileBytes":230469632,"insertMs":337},"sqliteVectorOnlyTable":{"medianMs":249.21,"minMs":240.7,"maxMs":304.1},"sqliteOverMemoryMedian":5.9,"sqliteVectorOnlyOverMemoryMedian":5.61,"topResultAgrees":true}
{"chunks":100000,"dims":768,"queries":20,"memory":{"medianMs":95.06,"minMs":93.3,"maxMs":99.78,"float32ArrayMB":293,"arrayBuffersDeltaMB":293,"rssDeltaMB":292.9},"memoryDotPrenormalised":{"medianMs":155.2,"minMs":153.24,"maxMs":160.22},"sqlite":{"medianMs":508.72,"minMs":492.89,"maxMs":564.34,"chunksTableFileMB":439.6,"chunksTableFileBytes":460935168,"insertMs":735},"sqliteVectorOnlyTable":{"medianMs":492.45,"minMs":478.69,"maxMs":510.43},"sqliteOverMemoryMedian":5.35,"sqliteVectorOnlyOverMemoryMedian":5.18,"topResultAgrees":true}
```

Runs 2 and 3 (100k only, fresh process each):

```
{"chunks":100000,"dims":768,"queries":20,"memory":{"medianMs":92.49,"minMs":91.73,"maxMs":95.81,"float32ArrayMB":293,"arrayBuffersDeltaMB":293,"rssDeltaMB":295},"memoryDotPrenormalised":{"medianMs":78.86,"minMs":78.39,"maxMs":94.85},"sqlite":{"medianMs":485.73,"minMs":469.4,"maxMs":503.3,"chunksTableFileMB":439.6,"chunksTableFileBytes":460935168,"insertMs":709},"sqliteVectorOnlyTable":{"medianMs":465.24,"minMs":459.99,"maxMs":486.81},"sqliteOverMemoryMedian":5.25,"sqliteVectorOnlyOverMemoryMedian":5.03,"topResultAgrees":true}
{"chunks":100000,"dims":768,"queries":20,"memory":{"medianMs":93.64,"minMs":92.73,"maxMs":97.48,"float32ArrayMB":293,"arrayBuffersDeltaMB":293,"rssDeltaMB":294.8},"memoryDotPrenormalised":{"medianMs":80.23,"minMs":79.21,"maxMs":96.35},"sqlite":{"medianMs":478.92,"minMs":473.76,"maxMs":509.97,"chunksTableFileMB":439.6,"chunksTableFileBytes":460935168,"insertMs":693},"sqliteVectorOnlyTable":{"medianMs":468.48,"minMs":457.29,"maxMs":510.02},"sqliteOverMemoryMedian":5.11,"sqliteVectorOnlyOverMemoryMedian":5,"topResultAgrees":true}
```

Derived (run 1 unless noted):

| chunks | (a) memory median ms | (a2) dot median ms | (b) sqlite median ms | (b2) vector table median ms | (b)/(a) | RAM for (a) | SQLite file |
|---|---|---|---|---|---|---|---|
| 10k | 8.9 | 7.65 | 47.32 | 47.31 | 5.32 | 29.3 MiB | 44.0 MiB |
| 50k | 44.46 | 38.17 | 262.23 | 249.21 | 5.9 | 146.5 MiB | 219.8 MiB |
| 100k | 95.06 | 155.2 | 508.72 | 492.45 | 5.35 | 293.0 MiB | 439.6 MiB (460935168 bytes) |
| 100k, median of the 3 runs' medians | 93.64 | 80.23 | 485.73 | 468.48 | | | |

Per-chunk cost: (a) 0.89 to 0.95 µs, (a2) 0.76 µs (1.55 µs in the one outlier run), (b) 4.7 to 5.2 µs. Linear extrapolation to a 100 ms median: (a) about 105k to 112k chunks, (a2) about 130k, (b) about 19k to 21k. RAM for (a) matches `chunks * 768 * 4` bytes; `rssDeltaMB` was within 3 MB of the array size. SQLite file is about 4610 bytes per chunk with 1000 characters of text.

The (a2) 155.2 ms result at 100k in run 1 did not repeat in runs 2 and 3 (78.86 and 80.23 ms). Run 1 held the 10k and 50k arrays' garbage plus two 293 MB arrays at that point; the cause was not isolated.

Reading vectors out of a vector-only table (b2) saved 0.0% to 5.0% of the (b) median across the five measurements, so overflow pages are not the main cost. The rest is spent reading rows through node:sqlite; the spike did not profile which part of that dominates.

**Consequence:** reading vectors from SQLite on every query stays under 100 ms only up to about 20k chunks, so `Store.vectorSearch` must load vectors into one contiguous `Float32Array` at open (and update it on upsert/remove). With that, v1 can support up to 100k chunks per member at a median of 92 to 95 ms (293 MB RAM); store vectors pre-normalised to get about 80 ms at 100k, and treat 50k (44 ms, 147 MB) as the comfortable target.

## 3. fs.watch({ recursive: true })

```
node --no-warnings spike/watch.js
```

Node v22.22.2 on Linux 7.1.13. Each step runs, then waits 300 ms and lists the events it produced. Run 4 times. Output of run 1 below; in runs 2 to 4 the `rename directory`, `rm -r` and race lines (the only ones compared) matched run 1.

```
{"step":"create top-level file","events":["rename:a.txt"],"expect":[{"file":"a.txt","reported":true}]}
{"step":"modify file","events":["change:a.txt"],"expect":[{"file":"a.txt","reported":true}]}
{"step":"mkdir + write file immediately","events":["rename:sub","rename:sub/b.txt"],"expect":[{"file":"sub","reported":true},{"file":"sub/b.txt","reported":true}]}
{"step":"mkdir, then (after pause) write file","events":["rename:sub2"],"expect":[{"file":"sub2","reported":true}]}
{"step":"  write file in sub2","events":["rename:sub2/c.txt"],"expect":[{"file":"sub2/c.txt","reported":true}]}
{"step":"mkdir -p 3 levels + write file immediately","events":["rename:deep","rename:deep/x","rename:deep/x/y","rename:deep/x/y/d.txt"],"expect":[{"file":"deep/x/y/d.txt","reported":true}]}
{"step":"write file in deep/x/y after pause","events":["rename:deep/x/y/d2.txt"],"expect":[{"file":"deep/x/y/d2.txt","reported":true}]}
{"step":"rename top-level file","events":["rename:a2.txt","rename:a.txt","change:a2.txt"],"expect":[{"file":"a.txt","reported":true},{"file":"a2.txt","reported":true}]}
{"step":"rename file in subdir","events":["rename:sub/b2.txt","rename:sub/b.txt","change:sub/b2.txt"],"expect":[{"file":"sub/b.txt","reported":true},{"file":"sub/b2.txt","reported":true}]}
{"step":"rename directory sub2 -> sub3","events":["rename:sub3","rename:sub3/c.txt","rename:sub2"],"expect":[{"file":"sub2","reported":true},{"file":"sub3","reported":true}]}
{"step":"  write file in renamed dir sub3","events":["rename:sub3/e.txt"],"expect":[{"file":"sub3/e.txt","reported":true}]}
{"step":"move file across dirs sub3/c.txt -> sub/c.txt","events":["rename:sub/c.txt","rename:sub3/c.txt","change:sub/c.txt"],"expect":[{"file":"sub3/c.txt","reported":true},{"file":"sub/c.txt","reported":true}]}
{"step":"delete top-level file","events":["rename:a2.txt"],"expect":[{"file":"a2.txt","reported":true}]}
{"step":"delete file in subdir","events":["rename:sub/b2.txt"],"expect":[{"file":"sub/b2.txt","reported":true}]}
{"step":"rm -r deep (contains d.txt, d2.txt)","events":["rename:deep/x/y/d.txt","rename:deep/x/y","rename:deep/x","rename:deep"],"expect":[{"file":"deep/x/y/d.txt","reported":true},{"file":"deep/x/y/d2.txt","reported":false},{"file":"deep","reported":true}]}
{"step":"recreate deep/x after rm, write file after pause","events":["rename:deep","rename:deep/x"],"expect":[{"file":"deep","reported":true}]}
{"step":"  write deep/x/f.txt","events":["rename:deep/x/f.txt"],"expect":[{"file":"deep/x/f.txt","reported":true}]}
{"step":"race: mkdir + immediate write","repeats":20,"fileEventsMissed":0}
{"node":"v22.22.2","platform":"linux","kernel":"7.1.13-100.fc43.x86_64"}
```

Files created in a new subdirectory (immediately or after a pause, including 3 levels deep and in a re-created directory) were reported every time: 0 misses in 80 mkdir-then-write races (20 per run, 4 runs). Renames come as two `rename` events (old and new name), and a `change` on the new name. Deletions come as `rename`. Two limits, seen in all 4 runs:

- `rm -r deep` reported `deep/x/y/d.txt` and the directories but not `deep/x/y/d2.txt`.
- Renaming directory `sub2` to `sub3` reported `sub2`, `sub3` and `sub3/c.txt`, but no event for `sub2/c.txt`.

**Consequence:** recursive watch works on this Node and kernel for creates, renames and deletes, but the event type does not tell create, delete and rename apart, and directory removal or rename does not name every file inside. The indexer must `stat` the reported path on each event, and when the path is missing or is a directory, remove every indexed file under that prefix and rescan the directory, rather than trusting per-file events.

## 4. FTS5 in node:sqlite

```
node --no-warnings spike/fts.js
```

```
{"sqlite":"3.50.2"}
{"test":"bm25 ranking for \"token\"","rows":[{"id":1,"title":"Auth","score":-0.0000019035222052067381},{"id":2,"title":"Auth notes","score":-0.000001452102803738318},{"id":4,"title":"Long","score":-3.894720350932164e-7}]}
{"test":"bm25 ranking for \"deploy docker\"","rows":[{"id":3,"title":"Deploy","score":-4.265226554944236}]}
{"test":"raw MATCH","q":"\"foo","throws":true,"error":"unterminated string"}
{"test":"raw MATCH","q":"a*b NEAR(","throws":true,"error":"fts5: syntax error near \"\""}
{"test":"raw MATCH","q":"foo:bar","throws":true,"error":"no such column: foo"}
{"test":"raw MATCH","q":"foo-bar","throws":true,"error":"no such column: bar"}
{"test":"raw MATCH","q":"C++","throws":true,"error":"fts5: syntax error near \"+\""}
{"test":"raw MATCH","q":"g++","throws":true,"error":"fts5: syntax error near \"+\""}
{"test":"raw MATCH","q":"what's up","throws":true,"error":"fts5: syntax error near \"'\""}
{"test":"raw MATCH","q":"hello.world","throws":true,"error":"fts5: syntax error near \".\""}
{"test":"raw MATCH","q":"(","throws":true,"error":"fts5: syntax error near \"\""}
{"test":"raw MATCH","q":")","throws":true,"error":"fts5: syntax error near \")\""}
{"test":"raw MATCH","q":"*","throws":true,"error":"unknown special query: "}
{"test":"raw MATCH","q":"AND","throws":true,"error":"fts5: syntax error near \"AND\""}
{"test":"raw MATCH","q":"foo OR","throws":true,"error":"fts5: syntax error near \"\""}
{"test":"raw MATCH","q":"NOT","throws":true,"error":"fts5: syntax error near \"NOT\""}
{"test":"raw MATCH","q":"-token","throws":true,"error":"no such column: token"}
{"test":"raw MATCH","q":"^token","throws":false,"hits":2}
{"test":"raw MATCH","q":"token*","throws":false,"hits":3}
{"test":"raw MATCH","q":"NEAR(token deploy)","throws":false,"hits":0}
{"test":"raw MATCH","q":"title:token","throws":false,"hits":0}
{"test":"raw MATCH","q":"{title text}: token","throws":false,"hits":3}
{"test":"raw MATCH","q":"café","throws":false,"hits":1}
{"test":"raw MATCH","q":"東京","throws":false,"hits":1}
{"test":"raw MATCH","q":"","throws":true,"error":"fts5: syntax error near \"\""}
{"test":"raw MATCH summary","inputs":23,"threw":16}
{"test":"sanitised MATCH summary","inputs":23,"threw":0}
{"test":"sanitised ranking for \"how does token refresh work?\"","fts":"\"how\" OR \"does\" OR \"token\" OR \"refresh\" OR \"work\"","rows":[{"id":1,"title":"Auth","score":-1.9481427349744542},{"id":2,"title":"Auth notes","score":-0.000001452102803738318},{"id":4,"title":"Long","score":-3.894720350932164e-7}]}
```

(The per-input sanitised lines are omitted here; run the script to see them.)

FTS5 is compiled into Node's bundled SQLite. `bm25()` returns negative scores where lower is better, so `ORDER BY bm25(t)` ascending gives best first; the doc with three `token` occurrences ranked above one occurrence, and the long doc ranked last. A term that appears in half or more of the rows ("token" is in 3 of 6) gets a near-zero score (about -1e-6), so absolute bm25 values are not useful for thresholds. Rank order still holds.

Raw input threw in 16 of 23 cases even though it was passed as a bound parameter (`MATCH ?`), including both examples from the brief (`"foo` and `a*b NEAR(`). Some inputs that did not throw still changed meaning: `title:token` filtered to one column, `^token` anchored to the start, `token*` became a prefix query. The candidate sanitiser in the script (keep `[\p{L}\p{N}_]+` runs, wrap each in double quotes, join with `OR`, cap at 32 terms, skip the query when empty) threw in 0 of 23 cases and kept Unicode terms (`café`, `東京`).

**Consequence:** `Store.keywordSearch` must never pass the query text to `MATCH` as-is; it must build the FTS expression from quoted word tokens (as in `toFtsQuery` in `spike/fts.js`) and return no keyword hits for an empty token list. Use bm25 for rank order only, which fits the RRF fusion in `hybridSearch`.

## 5. After the fix: vector search through Store

`src/index/store.js` now keeps normalised vectors in memory (a Map of Float32Array per chunk), loaded at open and updated on upsert and remove. Measured with the real Store, 768 dimensions, top 40, median of 20 queries after one warm-up, on the same machine:

```
node --no-warnings --max-old-space-size=4096 spike/store-bench.js
{"N":10000,"medianMs":7.8,"heapMiB":29.6}
{"N":50000,"medianMs":39.11,"heapMiB":146.8}
{"N":100000,"medianMs":78.41,"heapMiB":293.3}
```

`heapMiB` is `process.memoryUsage().arrayBuffers` after the run, so later rows can include buffers from earlier stores not yet collected. The medians match the pre-normalised in-memory scan in section 2.
