// @ts-check
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * @typedef {{ startLine: number, endLine: number, title: string, text: string, vector: Float32Array }} StoredChunk
 * @typedef {{ id: number, path: string, startLine: number, endLine: number, title: string, text: string }} ChunkRow
 * @typedef {{
 *   upsertFile: (file: { path: string, hash: string, chunks: StoredChunk[] }) => void,
 *   removeFile: (path: string) => void,
 *   fileHash: (path: string) => string | undefined,
 *   listFiles: () => string[],
 *   stats: () => { files: number, chunks: number },
 *   keywordSearch: (query: string, n: number) => { id: number, score: number }[],
 *   vectorSearch: (vector: Float32Array, n: number) => { id: number, score: number }[],
 *   getChunks: (ids: number[]) => ChunkRow[],
 *   getMeta: (key: string) => string | undefined,
 *   setMeta: (key: string, value: string) => void,
 *   close: () => void
 * }} Store
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  title TEXT NOT NULL,
  text TEXT NOT NULL,
  vector BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS chunks_path ON chunks (path);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5 (title, text, tokenize = 'porter unicode61 remove_diacritics 2');
`

// Bounds the MATCH expression for very long queries.
const MAX_TERMS = 64

/**
 * Opens (or creates) the index database. Chunk rows and their FTS rows share
 * an id, so both are written and deleted together inside one transaction.
 *
 * @param {string} file path, or ':memory:'
 * @returns {Store}
 */
export function openStore (file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(file)
  let closed = false
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;')
  db.exec(SCHEMA)

  const q = {
    getHash: db.prepare('SELECT hash FROM files WHERE path = ?'),
    putFile: db.prepare('INSERT INTO files (path, hash) VALUES (?, ?) ON CONFLICT (path) DO UPDATE SET hash = excluded.hash'),
    delFile: db.prepare('DELETE FROM files WHERE path = ?'),
    delFts: db.prepare('DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE path = ?)'),
    delChunks: db.prepare('DELETE FROM chunks WHERE path = ?'),
    putChunk: db.prepare('INSERT INTO chunks (path, start_line, end_line, title, text, vector) VALUES (?, ?, ?, ?, ?, ?)'),
    putFts: db.prepare('INSERT INTO chunks_fts (rowid, title, text) VALUES (?, ?, ?)'),
    listFiles: db.prepare('SELECT path FROM files ORDER BY path'),
    countFiles: db.prepare('SELECT count(*) AS n FROM files'),
    countChunks: db.prepare('SELECT count(*) AS n FROM chunks'),
    keyword: db.prepare('SELECT rowid AS id, bm25(chunks_fts) AS rank FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY rank LIMIT ?'),
    vectors: db.prepare('SELECT id, path, vector FROM chunks'),
    chunksById: db.prepare('SELECT id, path, start_line, end_line, title, text FROM chunks WHERE id IN (SELECT value FROM json_each(?))'),
    getMeta: db.prepare('SELECT value FROM meta WHERE key = ?'),
    setMeta: db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
  }

  /** @param {() => void} fn */
  function transaction (fn) {
    db.exec('BEGIN IMMEDIATE')
    try {
      fn()
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }

  /** @param {string} filePath */
  function deleteFileRows (filePath) {
    q.delFts.run(filePath)
    q.delChunks.run(filePath)
  }

  // Vectors stay in memory, mirrored from the chunks table. Decoding them
  // from SQLite on every query was 5 to 6 times slower (spike/RESULTS.md).
  /** @type {Map<number, Float32Array>} */
  const vectors = new Map()
  /** @type {Map<string, number[]>} */
  const idsByPath = new Map()
  for (const row of q.vectors.iterate()) {
    const id = Number(row.id)
    vectors.set(id, fromBlob(/** @type {Uint8Array} */ (row.vector)))
    const ids = idsByPath.get(String(row.path)) ?? []
    ids.push(id)
    idsByPath.set(String(row.path), ids)
  }

  /** @param {string} filePath */
  function forgetVectors (filePath) {
    for (const id of idsByPath.get(filePath) ?? []) vectors.delete(id)
    idsByPath.delete(filePath)
  }

  return {
    upsertFile ({ path: filePath, hash, chunks }) {
      const rows = chunks.map((c) => {
        const vector = normalize(c.vector)
        return { ...c, vector, blob: toBlob(vector) }
      })
      /** @type {[number, Float32Array][]} */
      const added = []
      transaction(() => {
        deleteFileRows(filePath)
        q.putFile.run(filePath, hash)
        for (const c of rows) {
          const { lastInsertRowid } = q.putChunk.run(filePath, c.startLine, c.endLine, c.title, c.text, c.blob)
          q.putFts.run(lastInsertRowid, c.title, c.text)
          added.push([Number(lastInsertRowid), c.vector])
        }
      })
      forgetVectors(filePath)
      for (const [id, vector] of added) vectors.set(id, vector)
      idsByPath.set(filePath, added.map(([id]) => id))
    },

    removeFile (filePath) {
      transaction(() => {
        deleteFileRows(filePath)
        q.delFile.run(filePath)
      })
      forgetVectors(filePath)
    },

    fileHash (filePath) {
      const row = q.getHash.get(filePath)
      return row ? String(row.hash) : undefined
    },

    listFiles () {
      return q.listFiles.all().map((row) => String(row.path))
    },

    stats () {
      return { files: Number(q.countFiles.get()?.n), chunks: Number(q.countChunks.get()?.n) }
    },

    keywordSearch (query, n) {
      const match = toMatchExpression(query)
      if (!match || n < 1) return []
      return q.keyword.all(match, Math.floor(n)).map((row) => ({ id: Number(row.id), score: -Number(row.rank) }))
    },

    vectorSearch (vector, n) {
      if (n < 1) return []
      const query = normalize(vector)
      /** @type {{ id: number, score: number }[]} */
      const top = []
      for (const [id, stored] of vectors) {
        // Vectors from a different model or dimension can't be compared.
        if (stored.length !== query.length) continue
        let dot = 0
        for (let i = 0; i < query.length; i++) dot += query[i] * stored[i]
        insertTop(top, { id, score: dot }, n)
      }
      return top
    },

    getChunks (ids) {
      if (ids.length === 0) return []
      const rows = q.chunksById.all(JSON.stringify(ids.map(Number)))
      const byId = new Map(rows.map((row) => [Number(row.id), {
        id: Number(row.id),
        path: String(row.path),
        startLine: Number(row.start_line),
        endLine: Number(row.end_line),
        title: String(row.title),
        text: String(row.text)
      }]))
      /** @type {ChunkRow[]} */
      const out = []
      for (const id of ids) {
        const row = byId.get(Number(id))
        if (row) out.push(row)
      }
      return out
    },

    getMeta (key) {
      const row = q.getMeta.get(key)
      return row ? String(row.value) : undefined
    },

    setMeta (key, value) {
      q.setMeta.run(key, value)
    },

    close () {
      if (closed) return
      closed = true
      db.close()
    }
  }
}

/**
 * Turns free text into an FTS5 expression of quoted terms joined by OR, so
 * user input can never be read as FTS syntax (quotes, `*`, `NEAR`, `-`,
 * parentheses, column filters). BM25 still ranks chunks with more matching
 * terms first.
 *
 * @param {string} query
 * @returns {string}
 */
export function toMatchExpression (query) {
  const terms = String(query).toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []
  const unique = [...new Set(terms)].slice(0, MAX_TERMS)
  return unique.map((t) => `"${t}"`).join(' OR ')
}

/** @param {Float32Array} vector */
function normalize (vector) {
  let norm = 0
  for (let i = 0; i < vector.length; i++) norm += vector[i] * vector[i]
  norm = Math.sqrt(norm)
  const out = new Float32Array(vector.length)
  if (norm === 0 || !Number.isFinite(norm)) return out
  for (let i = 0; i < vector.length; i++) out[i] = vector[i] / norm
  return out
}

/** @param {Float32Array} vector */
function toBlob (vector) {
  return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength)
}

/** @param {Uint8Array} blob */
function fromBlob (blob) {
  // Copy: the blob's offset is not guaranteed to be 4-byte aligned.
  return new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength))
}

/**
 * Keeps `top` sorted by descending score with at most `n` entries.
 *
 * @param {{ id: number, score: number }[]} top
 * @param {{ id: number, score: number }} item
 * @param {number} n
 */
function insertTop (top, item, n) {
  if (top.length >= n && item.score <= top[top.length - 1].score) return
  let i = top.length
  while (i > 0 && top[i - 1].score < item.score) i--
  top.splice(i, 0, item)
  if (top.length > n) top.pop()
}
