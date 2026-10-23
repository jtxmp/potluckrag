// @ts-check
// Paired bootstrap over questions: the difference in recall@5 and MRR@5
// between two modes of one eval run, with a 95% interval. Seeded, so the
// same results file always gives the same interval.
//
//   node eval/compare.js eval/results/<file>.json [central] [federated]
import fs from 'node:fs'

const [file, a = 'central', b = 'federated'] = process.argv.slice(2)
if (!file) {
  console.error('usage: node eval/compare.js <results.json> [mode-a] [mode-b]')
  process.exit(1)
}

const RESAMPLES = 10000
const run = JSON.parse(fs.readFileSync(file, 'utf8'))
// No-answer questions have no gold files and carry no recall.
const questions = run.questions.filter((q) => q.gold.length)

// mulberry32: small, seeded, good enough for resampling indices.
let seed = 42
function random () {
  seed = (seed + 0x6d2b79f5) | 0
  let t = seed
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

/** @param {'recall' | 'rr'} metric */
function compare (metric) {
  const diffs = questions.map((q) => q.modes[a][metric] - q.modes[b][metric])
  const mean = (xs) => xs.reduce((sum, x) => sum + x, 0) / xs.length
  const samples = []
  for (let i = 0; i < RESAMPLES; i++) {
    samples.push(mean(diffs.map(() => diffs[Math.floor(random() * diffs.length)])))
  }
  samples.sort((x, y) => x - y)
  return {
    diff: mean(diffs),
    low: samples[Math.floor(RESAMPLES * 0.025)],
    high: samples[Math.floor(RESAMPLES * 0.975)],
    aBetter: diffs.filter((d) => d > 0).length,
    bBetter: diffs.filter((d) => d < 0).length
  }
}

const f = (x) => (x >= 0 ? '+' : '') + x.toFixed(3)
console.log(`${a} minus ${b}, n=${questions.length}, paired bootstrap, ${RESAMPLES} resamples, 95% interval`)
console.log('| Metric | Difference | Interval | Questions where a > b | a < b |')
console.log('|---|---|---|---|---|')
for (const [label, metric] of [['recall@5', 'recall'], ['MRR@5', 'rr']]) {
  const r = compare(/** @type {'recall' | 'rr'} */ (metric))
  console.log(`| ${label} | ${f(r.diff)} | ${f(r.low)} to ${f(r.high)} | ${r.aBetter} | ${r.bBetter} |`)
}
