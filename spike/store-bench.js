// @ts-check
// Vector search through the real Store (vectors held in memory since the M0 fix).
// Run: node --no-warnings --max-old-space-size=4096 spike/store-bench.js
const { openStore } = await import('../src/index/store.js')
const D = 768
const rand = () => { const v = new Float32Array(D); for (let i = 0; i < D; i++) v[i] = Math.random() - 0.5; return v }
for (const N of [10000, 50000, 100000]) {
  const store = openStore(':memory:')
  const per = 50
  for (let f = 0; f < N / per; f++) store.upsertFile({ path: `f${f}.md`, hash: 'h', chunks: Array.from({ length: per }, (_, i) => ({ startLine: i + 1, endLine: i + 1, title: 't', text: 'x'.repeat(200), vector: rand() })) })
  const times = []
  for (let i = 0; i < 21; i++) { const q = rand(); const t = performance.now(); store.vectorSearch(q, 40); times.push(performance.now() - t) }
  times.shift(); times.sort((a, b) => a - b)
  console.log(JSON.stringify({ N, medianMs: +((times[9] + times[10]) / 2).toFixed(2), heapMiB: +(process.memoryUsage().arrayBuffers / 1048576).toFixed(1) }))
  store.close()
}
