// @ts-check
// Fake OpenAI-compatible upstream for `potluckrag try`, development and tests.
// Lets anyone see potluckrag work without a GPU or Ollama.
//
//   POST /v1/embeddings         fake-embed: hashed bag of words, 256 dims,
//                               L2-normalised. Texts that share words get
//                               similar vectors, so retrieval tests mean
//                               something.
//   POST /v1/chat/completions   fake-1b: replies REPLY, streamed one word per
//                               SSE event when `stream` is set.
import crypto from 'node:crypto'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

export const REPLY = 'The answer is in the shared notes [1].'
export const EMBED_MODEL = 'fake-embed'
export const CHAT_MODEL = 'fake-1b'
export const DIMS = 256

/** @param {string} text */
export function fakeEmbedding (text) {
  const vector = new Float32Array(DIMS)
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    const hash = crypto.createHash('sha256').update(word).digest()
    vector[hash.readUInt16BE(0) % DIMS] += 1
  }
  let norm = 0
  for (const v of vector) norm += v * v
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < DIMS; i++) vector[i] /= norm
  return vector
}

/** @param {number} [port] */
export async function startFakeUpstream (port = 0) {
  const calls = []
  // Parsed request bodies, to check prompts and embedding inputs.
  const bodies = []

  const server = http.createServer(async (req, res) => {
    calls.push(`${req.method} ${req.url}`)
    let raw = ''
    for await (const chunk of req) raw += chunk

    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: [EMBED_MODEL, CHAT_MODEL].map((id) => ({ id, object: 'model' })) }))
      return
    }

    if (req.method === 'POST' && req.url === '/v1/embeddings') {
      const body = JSON.parse(raw)
      bodies.push(body)
      const inputs = Array.isArray(body.input) ? body.input : [body.input]
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        object: 'list',
        model: body.model,
        data: inputs.map((text, index) => ({ object: 'embedding', index, embedding: Array.from(fakeEmbedding(String(text))) }))
      }))
      return
    }

    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      const body = JSON.parse(raw)
      bodies.push(body)
      const { model, stream } = body
      if (!stream) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ model, choices: [{ index: 0, message: { role: 'assistant', content: REPLY } }] }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const word of REPLY.split(/(?<= )/)) {
        if (res.destroyed) return
        res.write(`data: ${JSON.stringify({ model, choices: [{ index: 0, delta: { content: word } }] })}\n\n`)
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      res.end('data: [DONE]\n\n')
      return
    }

    res.writeHead(404).end()
  })

  await new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(undefined)))
  const address = /** @type {import('node:net').AddressInfo} */ (server.address())

  return {
    url: `http://127.0.0.1:${address.port}`,
    calls,
    bodies,
    close: () => new Promise((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve(undefined))
    })
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fake = await startFakeUpstream(Number(process.argv[2] ?? 11434))
  console.error(`fake upstream on ${fake.url} (models: ${EMBED_MODEL}, ${CHAT_MODEL})`)
}
