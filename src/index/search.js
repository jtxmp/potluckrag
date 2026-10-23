// @ts-check

/**
 * @typedef {{ path: string, startLine: number, endLine: number, title: string, text: string, score: number }} Hit
 */

export const MAX_HIT_TEXT = 2000
const RRF_K = 60

/**
 * Vector and BM25 search, merged with reciprocal rank fusion. RRF needs only
 * ranks, so the two incomparable score scales never have to be calibrated.
 *
 * @param {import('./store.js').Store} store
 * @param {import('./embed.js').Embedder} embedder
 * @param {string} query
 * @param {number} k
 * @returns {Promise<Hit[]>}
 */
export async function hybridSearch (store, embedder, query, k) {
  k = Math.floor(k)
  if (typeof query !== 'string' || query.trim() === '' || !(k > 0)) return []
  const n = Math.max(4 * k, 20)

  const [vector] = await embedder.embed([query])
  const lists = [store.vectorSearch(vector, n), store.keywordSearch(query, n)]

  /** @type {Map<number, number>} */
  const fused = new Map()
  for (const list of lists) {
    list.forEach(({ id }, rank) => {
      fused.set(id, (fused.get(id) ?? 0) + 1 / (RRF_K + rank + 1))
    })
  }
  const top = [...fused].sort((a, b) => b[1] - a[1]).slice(0, k)
  const scores = new Map(top)

  return store.getChunks(top.map(([id]) => id)).map((c) => ({
    path: c.path,
    startLine: c.startLine,
    endLine: c.endLine,
    title: c.title,
    text: c.text.slice(0, MAX_HIT_TEXT),
    score: scores.get(c.id) ?? 0
  }))
}
