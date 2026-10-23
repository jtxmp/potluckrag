// @ts-check
import crypto from 'node:crypto'
import http from 'node:http'

const MAX_BODY_BYTES = 64 * 1024

/**
 * Local endpoint for `potluckrag ask` and other tools on this machine.
 *
 *   GET  /status   connected members and index size
 *   POST /search   { q, k? } -> { hits, asked, answered }
 *
 * Binds to 127.0.0.1 only. Refuses what a web page could send: a Host other
 * than this endpoint (DNS rebinding), any Origin header (cross-site requests;
 * there is no browser client) and POST bodies that are not JSON (a simple
 * cross-site form post). With `apiKey` set, requests also need
 * `Authorization: Bearer <apiKey>`.
 *
 * @param {{
 *   port: number,
 *   apiKey?: string,
 *   search: (q: string, k: number) => Promise<unknown>,
 *   status: () => unknown,
 *   log: (event: string, fields?: Record<string, unknown>) => void
 * }} opts
 */
export async function startHttp ({ port, apiKey, search, status, log }) {
  const hosts = new Set()
  const expectedKey = apiKey ? sha256(apiKey) : null

  const server = http.createServer((req, res) => {
    res.setHeader('x-content-type-options', 'nosniff')
    handle(req, res).catch((err) => {
      log('http-error', { err: err.message })
      fail(res, 500, 'internal error')
    })
  })

  /**
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   */
  async function handle (req, res) {
    if (!hosts.has(String(req.headers.host))) {
      log('refused', { reason: 'host' })
      return fail(res, 421, 'this endpoint only answers requests for 127.0.0.1 or localhost')
    }
    if (req.headers.origin !== undefined) {
      log('refused', { reason: 'origin' })
      return fail(res, 403, 'requests from web pages are refused')
    }
    if (expectedKey && !keyMatches(req.headers.authorization, expectedKey)) {
      log('refused', { reason: 'api-key' })
      res.setHeader('www-authenticate', 'Bearer')
      return fail(res, 401, 'missing or wrong API key')
    }

    const { pathname } = new URL(req.url ?? '/', 'http://localhost')

    if (req.method === 'GET' && pathname === '/status') return json(res, 200, status())

    if (req.method === 'POST' && pathname === '/search') {
      if (mediaType(req.headers['content-type']) !== 'application/json') {
        return fail(res, 415, 'content-type must be application/json')
      }
      const body = await readBody(req)
      if (body === null) return fail(res, 413, `request body exceeds ${MAX_BODY_BYTES} bytes`)
      let parsed
      try {
        parsed = JSON.parse(body)
      } catch {
        return fail(res, 400, 'request body is not valid JSON')
      }
      const q = parsed?.q
      if (typeof q !== 'string' || !q.trim()) return fail(res, 400, '"q" must be a non-empty string')
      if (q.length > 2000) return fail(res, 400, '"q" is longer than 2000 characters')
      const k = Number.isInteger(parsed.k) ? Math.min(Math.max(parsed.k, 1), 20) : 8
      return json(res, 200, await search(q, k))
    }

    fail(res, 404, 'not found')
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(undefined))
  })
  const address = /** @type {import('node:net').AddressInfo} */ (server.address())
  for (const name of ['127.0.0.1', 'localhost', '[::1]']) hosts.add(`${name}:${address.port}`)

  return {
    port: address.port,
    close: async () => {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(() => resolve(undefined)))
    }
  }
}

/**
 * @param {http.IncomingMessage} req
 * @returns {Promise<string | null>} null when the body is too large
 */
async function readBody (req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) return null
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** @param {unknown} value */
function mediaType (value) {
  return typeof value === 'string' ? value.split(';')[0].trim().toLowerCase() : ''
}

/** @param {string} value */
function sha256 (value) {
  return crypto.createHash('sha256').update(value).digest()
}

/**
 * Constant-time comparison of a `Bearer` token against the expected key.
 *
 * @param {string | undefined} header
 * @param {Buffer} expected sha256 of the key
 */
function keyMatches (header, expected) {
  const match = /^Bearer (.+)$/.exec(header ?? '')
  return match !== null && crypto.timingSafeEqual(sha256(match[1]), expected)
}

/**
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function json (res, status, body) {
  res.setHeader('content-type', 'application/json')
  res.writeHead(status)
  res.end(JSON.stringify(body))
}

/**
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {string} message
 */
function fail (res, status, message) {
  if (res.headersSent) return res.destroy()
  json(res, status, { error: { message } })
}
