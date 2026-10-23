// @ts-check
// Retrieval-quality eval: how much does federation lose against one central
// index over the same files? See eval/README.md.
//
//   node --no-warnings eval/run.js [--url http://127.0.0.1:11434] [--model nomic-embed-text:v1.5] [--k 8]
//
// Uses only the contract APIs (docs/contracts.md): createEmbedder,
// createIndex, Index.search and rescore.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { createEmbedder } from '../src/index/embed.js'
import { createIndex } from '../src/index/indexer.js'
import { rescore, cosine } from '../src/ask.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CORPUS = path.join(HERE, 'corpus')
const MEMBERS = ['alice', 'bob', 'carol']
const TOP = 5
const MODES = ['central', 'federated', 'federated-no-rescore']

/** @typedef {{ path: string, startLine: number, endLine: number, title: string, text: string, score: number }} Hit */
/** @typedef {Hit & { member: string }} MemberHit */
/** @typedef {{ id: string, question: string, gold: string[], evidence: string[] }} Question */

const { values: args } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://127.0.0.1:11434' },
    model: { type: 'string', default: 'nomic-embed-text:v1.5' },
    k: { type: 'string', default: '8' },
    help: { type: 'boolean', default: false }
  }
})

if (args.help) {
  console.log('usage: node --no-warnings eval/run.js [--url URL] [--model EMBED_MODEL] [--k PER_MEMBER_K]')
  process.exit(0)
}

const k = Number(args.k)
if (!Number.isInteger(k) || k < 1 || k > 20) throw new Error('--k must be an integer from 1 to 20 (the wire protocol caps k at 20)')

/** @type {Question[]} */
const questions = JSON.parse(fs.readFileSync(path.join(HERE, 'questions.json'), 'utf8'))
const embedder = createEmbedder({ url: args.url, model: args.model })
const log = () => {}

// Index files live in a throwaway directory, never in ~/.potluckrag.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'potluckrag-eval-'))

/**
 * Map a hit path (`<root>/<relative path>`) to the `member/file` form used in
 * questions.json. Each corpus folder is shared under its own basename, so
 * the root name is the member name in both setups.
 *
 * @param {string} hitPath
 */
function goldKey (hitPath) {
  const slash = hitPath.indexOf('/')
  const root = hitPath.slice(0, slash)
  if (!MEMBERS.includes(root)) throw new Error(`unexpected root in hit path: ${hitPath}`)
  return `${root}/${hitPath.slice(slash + 1)}`
}

/**
 * @param {string[]} dirs
 * @param {string} name
 */
async function openIndex (dirs, name) {
  const index = createIndex({ dirs, dbFile: path.join(tmp, `${name}.db`), embedder, log, watch: false })
  await index.ready
  const stats = index.stats()
  const expected = dirs.map((d) => path.basename(d))
  if (JSON.stringify([...stats.roots].sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`index ${name} has roots ${stats.roots.join(',')}, expected ${expected.join(',')}`)
  }
  return { index, stats }
}

/**
 * Interleave ranked lists one item at a time. `start` rotates which member
 * goes first so no member gets a fixed head start across questions.
 *
 * @template T
 * @param {T[][]} lists
 * @param {number} start
 * @param {number} n
 */
function roundRobin (lists, start, n) {
  /** @type {T[]} */
  const out = []
  const depth = Math.max(...lists.map((l) => l.length))
  for (let r = 0; r < depth && out.length < n; r++) {
    for (let j = 0; j < lists.length && out.length < n; j++) {
      const item = lists[(start + j) % lists.length][r]
      if (item !== undefined) out.push(item)
    }
  }
  return out
}

/**
 * Per-question scores for one ranked list of `member/file` keys.
 * recall@5: share of gold files that appear anywhere in the top 5 snippets.
 * rr: 1 / rank of the first snippet from a gold file, 0 if none in the top 5.
 *
 * @param {string[]} ranked
 * @param {string[]} gold
 */
function score (ranked, gold) {
  /** @type {Record<string, number | null>} */
  const goldRanks = {}
  for (const g of gold) {
    const i = ranked.indexOf(g)
    goldRanks[g] = i === -1 ? null : i + 1
  }
  const found = Object.values(goldRanks).filter((r) => r !== null)
  const first = found.length ? Math.min(.../** @type {number[]} */ (found)) : null
  return {
    recall: gold.length ? found.length / gold.length : null,
    rr: first ? 1 / first : 0,
    firstRank: first,
    goldRanks
  }
}

/** @param {number[]} xs */
function mean (xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null
}

/**
 * Highest cosine between the query and any returned snippet. Same scale for
 * every mode, so it can show whether no-answer questions score lower.
 *
 * @param {Float32Array} qv
 * @param {Hit[]} hits
 */
async function topCosine (qv, hits) {
  if (hits.length === 0) return null
  const vectors = await embedder.embed(hits.map((h) => h.text))
  return Math.max(...vectors.map((v) => cosine(qv, v)))
}

/** @param {number | null} x */
const fmt = (x) => (x === null ? '-' : x.toFixed(3))

async function main () {
  const started = Date.now()
  const central = await openIndex(MEMBERS.map((m) => path.join(CORPUS, m)), 'central')
  /** @type {Record<string, Awaited<ReturnType<typeof openIndex>>>} */
  const members = {}
  for (const m of MEMBERS) members[m] = await openIndex([path.join(CORPUS, m)], m)
  const indexMs = Date.now() - started

  const perQuestion = []
  for (const [qi, q] of questions.entries()) {
    const [qv] = await embedder.embed([q.question])

    /** @type {Hit[]} */
    const centralHits = await central.index.search(q.question, TOP)

    // What each member would send: its own top k, scores stripped as on the wire.
    /** @type {MemberHit[][]} */
    const lists = []
    for (const m of MEMBERS) {
      const hits = await members[m].index.search(q.question, k)
      lists.push(hits.map(({ score, ...h }) => ({ ...h, score: 0, member: m })))
    }
    const merged = lists.flat()
    const fedHits = await rescore(q.question, merged, embedder, TOP)
    const rrHits = roundRobin(lists, qi % MEMBERS.length, TOP)

    /** @type {Record<string, Hit[]>} */
    const byMode = { central: centralHits, federated: fedHits, 'federated-no-rescore': rrHits }
    const row = { id: q.id, question: q.question, gold: q.gold, crossMember: new Set(q.gold.map((g) => g.split('/')[0])).size > 1, modes: {} }
    for (const mode of MODES) {
      const ranked = byMode[mode].map((h) => goldKey(h.path))
      row.modes[mode] = {
        ...score(ranked, q.gold),
        topCosine: await topCosine(qv, byMode[mode]),
        top: byMode[mode].map((h) => ({ file: goldKey(h.path), startLine: h.startLine, endLine: h.endLine }))
      }
    }
    perQuestion.push(row)
    process.stderr.write(`${q.id} ${MODES.map((m) => `${m}=${row.modes[m].firstRank ?? '-'}`).join(' ')}\n`)
  }

  const answerable = perQuestion.filter((r) => r.gold.length > 0)
  const noAnswer = perQuestion.filter((r) => r.gold.length === 0)
  const cross = answerable.filter((r) => r.crossMember)

  /** @param {typeof perQuestion} rows @param {string} mode */
  const summarize = (rows, mode) => ({
    n: rows.length,
    recallAt5: mean(rows.map((r) => /** @type {number} */ (r.modes[mode].recall))),
    mrrAt5: mean(rows.map((r) => r.modes[mode].rr)),
    meanTopCosine: mean(rows.map((r) => /** @type {number} */ (r.modes[mode].topCosine)))
  })

  const summary = {}
  for (const mode of MODES) {
    summary[mode] = {
      all: summarize(answerable, mode),
      crossMember: summarize(cross, mode),
      noAnswer: { n: noAnswer.length, meanTopCosine: mean(noAnswer.map((r) => /** @type {number} */ (r.modes[mode].topCosine))) }
    }
  }

  const date = new Date().toISOString().slice(0, 10)
  const result = {
    date: new Date().toISOString(),
    embedModel: args.model,
    embedModelDigest: await modelDigest(args.model),
    url: args.url,
    k,
    top: TOP,
    node: process.version,
    corpus: {
      central: central.stats,
      members: Object.fromEntries(MEMBERS.map((m) => [m, members[m].stats]))
    },
    indexMs,
    totalMs: Date.now() - started,
    summary,
    questions: perQuestion
  }

  fs.mkdirSync(path.join(HERE, 'results'), { recursive: true })
  const outFile = path.join(HERE, 'results', `${date}-${args.model.replace(/[^A-Za-z0-9._-]/g, '-')}.json`)
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2) + '\n')

  const lines = []
  lines.push(`Embedding model: ${args.model}${result.embedModelDigest ? ` (${result.embedModelDigest.slice(0, 12)})` : ''}, per-member k=${k}, top ${TOP}`)
  lines.push(`Chunks: central ${central.stats.chunks}, ${MEMBERS.map((m) => `${m} ${members[m].stats.chunks}`).join(', ')}`)
  lines.push('')
  lines.push(`| Mode | Recall@5 (n=${answerable.length}) | MRR@5 | Recall@5 cross-member (n=${cross.length}) | MRR@5 cross-member | Top cosine, answerable | Top cosine, no answer (n=${noAnswer.length}) |`)
  lines.push('|---|---|---|---|---|---|---|')
  for (const mode of MODES) {
    const s = summary[mode]
    lines.push(`| ${mode} | ${fmt(s.all.recallAt5)} | ${fmt(s.all.mrrAt5)} | ${fmt(s.crossMember.recallAt5)} | ${fmt(s.crossMember.mrrAt5)} | ${fmt(s.all.meanTopCosine)} | ${fmt(s.noAnswer.meanTopCosine)} |`)
  }
  lines.push('')
  lines.push('Rank of the first gold snippet in the top 5 (- = not found):')
  lines.push('')
  lines.push(`| Id | Gold | ${MODES.join(' | ')} |`)
  lines.push(`|---|---|${MODES.map(() => '---').join('|')}|`)
  for (const r of answerable) {
    lines.push(`| ${r.id} | ${r.gold.join(', ')} | ${MODES.map((m) => r.modes[m].firstRank ?? '-').join(' | ')} |`)
  }
  lines.push('')
  lines.push(`JSON: ${path.relative(process.cwd(), outFile)}`)
  console.log(lines.join('\n'))

  await central.index.close()
  for (const m of MEMBERS) await members[m].index.close()
}

/**
 * Ollama-specific: look up the model digest for the record. Optional; other
 * OpenAI-compatible servers have no /api/tags and get null.
 *
 * @param {string} model
 */
async function modelDigest (model) {
  try {
    const res = await fetch(args.url.replace(/\/+$/, '') + '/api/tags', { signal: AbortSignal.timeout(5000) })
    if (!res.ok) return null
    const body = await res.json()
    const found = body?.models?.find((m) => m.name === model || m.model === model)
    return typeof found?.digest === 'string' ? found.digest : null
  } catch {
    return null
  }
}

try {
  await main()
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
