// @ts-check

/**
 * @typedef {{ model: string, embed: (texts: string[]) => Promise<Float32Array[]> }} Embedder
 */

/**
 * Client for an OpenAI-compatible `/v1/embeddings` endpoint (Ollama,
 * llama.cpp server, vLLM). Error messages name the endpoint and model so a
 * misconfiguration is easy to spot, and never include the input text, which
 * may come from private files.
 *
 * @param {{ url?: string, model: string, timeoutMs?: number, batchSize?: number }} opts
 * @returns {Embedder}
 */
export function createEmbedder ({ url = 'http://127.0.0.1:11434', model, timeoutMs = 60000, batchSize = 32 }) {
  if (typeof model !== 'string' || model === '') throw new Error('embedder: model is required')
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error('embedder: batchSize must be a positive integer')
  const endpoint = url.replace(/\/+$/, '') + '/v1/embeddings'
  const where = `${endpoint} (model ${model})`

  /** @param {string[]} input */
  async function embedBatch (input) {
    let res
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, input }),
        signal: AbortSignal.timeout(timeoutMs)
      })
    } catch (err) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        throw new Error(`embeddings request to ${where} timed out after ${timeoutMs} ms`)
      }
      throw new Error(`embeddings request to ${where} failed: ${err.cause?.code ?? err.message}`)
    }
    // The body is not quoted in errors: some servers echo the input back.
    if (!res.ok) {
      await res.body?.cancel()
      throw new Error(`embeddings request to ${where} returned HTTP ${res.status}`)
    }
    let body
    try {
      body = await res.json()
    } catch {
      throw new Error(`embeddings response from ${where} is not valid JSON`)
    }
    const data = body?.data
    if (!Array.isArray(data) || data.length !== input.length) {
      throw new Error(`embeddings response from ${where} has ${Array.isArray(data) ? data.length : 'no'} vectors for ${input.length} inputs`)
    }
    /** @type {Float32Array[]} */
    const out = new Array(input.length)
    for (let i = 0; i < data.length; i++) {
      const item = data[i]
      const index = Number.isInteger(item?.index) ? item.index : i
      const vector = item?.embedding
      if (index < 0 || index >= input.length || out[index] || !Array.isArray(vector) || vector.length === 0 || !vector.every(Number.isFinite)) {
        throw new Error(`embeddings response from ${where} has a malformed vector at position ${i}`)
      }
      out[index] = Float32Array.from(vector)
    }
    return out
  }

  return {
    model,
    async embed (texts) {
      /** @type {Float32Array[]} */
      const vectors = []
      for (let i = 0; i < texts.length; i += batchSize) {
        vectors.push(...await embedBatch(texts.slice(i, i + batchSize)))
      }
      return vectors
    }
  }
}
