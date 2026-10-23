// Spike: FTS5 in node:sqlite. Checks bm25() ranking, whether raw user input
// passed to MATCH (even as a bound parameter) throws, and a candidate sanitiser.
//
// Usage: node --no-warnings spike/fts.js
import { DatabaseSync } from 'node:sqlite'

const db = new DatabaseSync(':memory:')
console.log(JSON.stringify({ sqlite: db.prepare('SELECT sqlite_version() AS v').get()?.v }))

db.exec("CREATE VIRTUAL TABLE chunks_fts USING fts5(title, text, tokenize = 'unicode61')")
const docs = [
  ['Auth', 'token refresh token rotation token expiry'],
  ['Auth notes', 'the token is refreshed once per hour'],
  ['Deploy', 'deploy the service with docker compose'],
  ['Long', 'token ' + 'filler words about many unrelated topics '.repeat(30)],
  ['C++ build', 'compile with g++ and link against foo-bar library, see a*b notes'],
  ['Unicode', 'café naïve résumé 東京 データ']
]
const ins = db.prepare('INSERT INTO chunks_fts (rowid, title, text) VALUES (?, ?, ?)')
docs.forEach(([title, text], i) => ins.run(i + 1, title, text))

const search = db.prepare(`
  SELECT rowid AS id, title, bm25(chunks_fts) AS score
  FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY score LIMIT 10`)

// 1. ranking: bm25() is lower-is-better (negative); more and denser matches rank first
console.log(JSON.stringify({ test: 'bm25 ranking for "token"', rows: search.all('token') }))
console.log(JSON.stringify({ test: 'bm25 ranking for "deploy docker"', rows: search.all('deploy docker') }))

// 2. raw user input through a bound parameter
const inputs = [
  '"foo', 'a*b NEAR(', 'foo:bar', 'foo-bar', 'C++', 'g++', 'what\'s up', 'hello.world',
  '(', ')', '*', 'AND', 'foo OR', 'NOT', '-token', '^token', 'token*', 'NEAR(token deploy)',
  'title:token', '{title text}: token', 'café', '東京', ''
]
const raw = inputs.map((q) => {
  try {
    const rows = search.all(q)
    return { q, throws: false, hits: rows.length }
  } catch (err) {
    return { q, throws: true, error: /** @type {Error} */ (err).message }
  }
})
for (const r of raw) console.log(JSON.stringify({ test: 'raw MATCH', ...r }))
console.log(JSON.stringify({ test: 'raw MATCH summary', inputs: raw.length, threw: raw.filter((r) => r.throws).length }))

// 3. candidate sanitiser: keep letter/number runs, quote each as a phrase, OR them.
/** @param {string} input */
function toFtsQuery (input) {
  const terms = input.match(/[\p{L}\p{N}_]+/gu) || []
  return terms.slice(0, 32).map((t) => `"${t}"`).join(' OR ')
}
const safe = inputs.map((q) => {
  const fts = toFtsQuery(q)
  if (!fts) return { q, fts, throws: false, hits: 0, skipped: true }
  try {
    return { q, fts, throws: false, hits: search.all(fts).length }
  } catch (err) {
    return { q, fts, throws: true, error: /** @type {Error} */ (err).message }
  }
})
for (const r of safe) console.log(JSON.stringify({ test: 'sanitised MATCH', ...r }))
console.log(JSON.stringify({ test: 'sanitised MATCH summary', inputs: safe.length, threw: safe.filter((r) => r.throws).length }))
console.log(JSON.stringify({ test: 'sanitised ranking for "how does token refresh work?"', fts: toFtsQuery('how does token refresh work?'), rows: search.all(toFtsQuery('how does token refresh work?')) }))

db.close()
