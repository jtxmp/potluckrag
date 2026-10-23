// Spike: full-scan cosine top-k over 768-dim Float32 vectors in plain JS.
//   (a) all vectors in one contiguous Float32Array held in memory
//   (a2) same as (a) with vectors normalised at insert, so a query is a plain dot product
//   (b) vectors read from a node:sqlite BLOB column on every query
//       (SELECT id, vector FROM chunks), then scanned. chunks also holds ~1000 chars of text.
//   (b2) same read from a vector-only table (vectors(id, vector)), text kept elsewhere
// Prints median / min / max of 20 queries per size, RAM for (a), SQLite file size.
//
// Usage: node --no-warnings --expose-gc spike/vector-scan.js [sizes...]
//   default sizes: 10000 50000 100000
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const DIMS = 768
const QUERIES = 20
const K = 20
const TEXT_CHARS = 1000 // realistic chunk text stored next to the vector
const sizes = process.argv.slice(2).map(Number).filter(Boolean)
if (sizes.length === 0) sizes.push(10000, 50000, 100000)

// deterministic PRNG so runs are comparable
let seed = 42
function rand () {
  seed = (seed * 1664525 + 1013904223) >>> 0
  return seed / 4294967296 - 0.5
}

/** @param {Float32Array} v */
function fill (v) { for (let i = 0; i < v.length; i++) v[i] = rand() }

/** @param {number[]} xs */
function median (xs) {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/**
 * Keeps the k best (score, id) pairs. Simple insertion into a small sorted array.
 * @param {number} k
 */
function topK (k) {
  const scores = new Float64Array(k).fill(-Infinity)
  const ids = new Int32Array(k).fill(-1)
  return {
    scores,
    ids,
    /** @param {number} score @param {number} id */
    push (score, id) {
      if (score <= scores[k - 1]) return
      let i = k - 1
      while (i > 0 && scores[i - 1] < score) { scores[i] = scores[i - 1]; ids[i] = ids[i - 1]; i-- }
      scores[i] = score; ids[i] = id
    }
  }
}

/**
 * Full cosine: dot / (|q| |v|), norms of v computed per query.
 * @param {Float32Array} q @param {Float32Array} all @param {number} off
 */
function cosineAt (q, qNorm, all, off) {
  let dot = 0
  let nv = 0
  for (let i = 0; i < DIMS; i++) {
    const x = all[off + i]
    dot += q[i] * x
    nv += x * x
  }
  return dot / (qNorm * Math.sqrt(nv) || 1)
}

/** @param {Float32Array} q */
function norm (q) { let s = 0; for (let i = 0; i < q.length; i++) s += q[i] * q[i]; return Math.sqrt(s) }

/** @param {Float32Array} q @param {Float32Array} all @param {number} n */
function scanDot (q, all, n) {
  const top = topK(K)
  for (let r = 0; r < n; r++) {
    const off = r * DIMS
    let dot = 0
    for (let i = 0; i < DIMS; i++) dot += q[i] * all[off + i]
    top.push(dot, r)
  }
  return top
}

/** @param {Float32Array} q @param {Float32Array} all @param {number} n */
function scanContiguous (q, all, n) {
  const qn = norm(q)
  const top = topK(K)
  for (let r = 0; r < n; r++) top.push(cosineAt(q, qn, all, r * DIMS), r)
  return top
}

/** @param {Float32Array} q @param {import('node:sqlite').StatementSync} stmt */
function scanSqlite (q, stmt) {
  const qn = norm(q)
  const top = topK(K)
  for (const row of stmt.iterate()) {
    const blob = /** @type {Uint8Array} */ (row.vector)
    const v = blob.byteOffset % 4 === 0
      ? new Float32Array(blob.buffer, blob.byteOffset, DIMS)
      : new Float32Array(blob.slice().buffer, 0, DIMS)
    top.push(cosineAt(q, qn, v, 0), /** @type {number} */ (row.id))
  }
  return top
}

function mb (bytes) { return Math.round(bytes / 1048576 * 10) / 10 }

const gc = /** @type {any} */ (globalThis).gc || (() => {})
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'potluckrag-vscan-'))
const text = 'lorem ipsum dolor sit amet '.repeat(Math.ceil(TEXT_CHARS / 27)).slice(0, TEXT_CHARS)

const queries = Array.from({ length: QUERIES }, () => { const q = new Float32Array(DIMS); fill(q); return q })

try {
  for (const n of sizes) {
    // (a) contiguous
    gc()
    const before = process.memoryUsage()
    const all = new Float32Array(n * DIMS)
    fill(all)
    gc()
    const after = process.memoryUsage()

    scanContiguous(queries[0], all, n) // warm-up, lets V8 optimise
    const memTimes = []
    let memTop
    for (const q of queries) {
      const t = process.hrtime.bigint()
      memTop = scanContiguous(q, all, n)
      memTimes.push(Number(process.hrtime.bigint() - t) / 1e6)
    }

    // (a2) pre-normalised copy, normalised query
    const unit = new Float32Array(all)
    for (let r = 0; r < n; r++) {
      const v = unit.subarray(r * DIMS, (r + 1) * DIMS)
      const nv = norm(v)
      for (let i = 0; i < DIMS; i++) v[i] /= nv
    }
    const unitQueries = queries.map((q) => { const u = new Float32Array(q); const nq = norm(u); for (let i = 0; i < DIMS; i++) u[i] /= nq; return u })
    scanDot(unitQueries[0], unit, n)
    const dotTimes = []
    let dotTop
    for (const q of unitQueries) {
      const t = process.hrtime.bigint()
      dotTop = scanDot(q, unit, n)
      dotTimes.push(Number(process.hrtime.bigint() - t) / 1e6)
    }

    // (b) sqlite
    const file = path.join(tmp, `chunks-${n}.db`)
    const db = new DatabaseSync(file)
    db.exec(`CREATE TABLE chunks (
      id INTEGER PRIMARY KEY, path TEXT NOT NULL, start_line INTEGER, end_line INTEGER,
      title TEXT, text TEXT NOT NULL, vector BLOB NOT NULL)`)
    const ins = db.prepare('INSERT INTO chunks (id, path, start_line, end_line, title, text, vector) VALUES (?, ?, ?, ?, ?, ?, ?)')
    const tIns = process.hrtime.bigint()
    db.exec('BEGIN')
    for (let r = 0; r < n; r++) {
      const v = all.subarray(r * DIMS, (r + 1) * DIMS)
      ins.run(r, `notes/file-${r % 1000}.md`, 1, 40, 'Heading', text, new Uint8Array(v.buffer, v.byteOffset, DIMS * 4))
    }
    db.exec('COMMIT')
    db.exec('CREATE TABLE vectors (id INTEGER PRIMARY KEY, vector BLOB NOT NULL)')
    db.exec('INSERT INTO vectors (id, vector) SELECT id, vector FROM chunks')
    const insertMs = Number(process.hrtime.bigint() - tIns) / 1e6
    
    const stmt = db.prepare('SELECT id, vector FROM chunks')
    scanSqlite(queries[0], stmt) // warm-up
    const sqlTimes = []
    let sqlTop
    for (const q of queries) {
      const t = process.hrtime.bigint()
      sqlTop = scanSqlite(q, stmt)
      sqlTimes.push(Number(process.hrtime.bigint() - t) / 1e6)
    }
    const stmt2 = db.prepare('SELECT id, vector FROM vectors')
    scanSqlite(queries[0], stmt2)
    const sql2Times = []
    let sql2Top
    for (const q of queries) {
      const t = process.hrtime.bigint()
      sql2Top = scanSqlite(q, stmt2)
      sql2Times.push(Number(process.hrtime.bigint() - t) / 1e6)
    }
    db.close()
    // size of a file holding the realistic chunks table only (vectors table dropped)
    const chunksOnly = new DatabaseSync(file)
    chunksOnly.exec('DROP TABLE vectors')
    chunksOnly.exec('VACUUM')
    chunksOnly.close()
    const chunksOnlyBytes = fs.statSync(file).size
    fs.rmSync(file)

    // both paths must agree on the last query's top result
    const agree = !!(memTop && sqlTop && sql2Top && dotTop &&
      memTop.ids[0] === sqlTop.ids[0] && memTop.ids[0] === sql2Top.ids[0] && memTop.ids[0] === dotTop.ids[0])

    const r2 = (x) => Math.round(x * 100) / 100
    console.log(JSON.stringify({
      chunks: n,
      dims: DIMS,
      queries: QUERIES,
      memory: {
        medianMs: r2(median(memTimes)),
        minMs: r2(Math.min(...memTimes)),
        maxMs: r2(Math.max(...memTimes)),
        float32ArrayMB: mb(all.byteLength),
        arrayBuffersDeltaMB: mb(after.arrayBuffers - before.arrayBuffers),
        rssDeltaMB: mb(after.rss - before.rss)
      },
      memoryDotPrenormalised: {
        medianMs: r2(median(dotTimes)),
        minMs: r2(Math.min(...dotTimes)),
        maxMs: r2(Math.max(...dotTimes))
      },
      sqlite: {
        medianMs: r2(median(sqlTimes)),
        minMs: r2(Math.min(...sqlTimes)),
        maxMs: r2(Math.max(...sqlTimes)),
        chunksTableFileMB: mb(chunksOnlyBytes),
        chunksTableFileBytes: chunksOnlyBytes,
        insertMs: Math.round(insertMs)
      },
      sqliteVectorOnlyTable: {
        medianMs: r2(median(sql2Times)),
        minMs: r2(Math.min(...sql2Times)),
        maxMs: r2(Math.max(...sql2Times))
      },
      sqliteOverMemoryMedian: r2(median(sqlTimes) / median(memTimes)),
      sqliteVectorOnlyOverMemoryMedian: r2(median(sql2Times) / median(memTimes)),
      topResultAgrees: agree
    }))
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
