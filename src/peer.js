// @ts-check
import Hyperswarm from 'hyperswarm'
import { onMessages, send } from './protocol.js'
import { createRejectLogger, shortKey } from './log.js'

const MIN_LOOKUP_MS = 5000
const MAX_LOOKUP_MS = 60000

export const DEFAULT_LIMITS = Object.freeze({
  maxQuery: 2000,
  maxK: 20,
  maxText: 2000,
  rateCount: 10,
  rateWindowMs: 10000,
  maxConcurrent: 4
})

// Field limits for what other members send. A hit outside them is dropped
// rather than trimmed, since an honest member never produces one.
const MAX_PATH = 1024
const MAX_TITLE = 1000
const MAX_LINE = 1e9
const MAX_ID = 64
const MAX_NAME = 200
const MAX_ERROR_MESSAGE = 500
// Paths and titles end up on a terminal; control characters could rewrite it.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/

/**
 * Remote hits carry no `score`: scores are only comparable within one index.
 *
 * @typedef {{ path: string, startLine: number, endLine: number, title: string, text: string, score?: number }} WireHit
 * @typedef {WireHit & { member: string, peer: string }} RemoteHit
 * @typedef {{ search: (query: string, k: number) => Promise<WireHit[]>, stats: () => { files: number, chunks: number, roots: string[] } }} SearchIndex
 * @typedef {{ record: (entry: { member: string, peer: string, paths: string[] }) => void }} Audit
 * @typedef {{
 *   key: string,
 *   peer: string,
 *   name: string,
 *   conn: any,
 *   hello: { chunks: number, embedModel: string } | null
 * }} Remote
 * @typedef {{
 *   k: number,
 *   sentOn: Map<string, any>,
 *   hits: RemoteHit[],
 *   answered: number,
 *   check: () => void
 * }} PendingSearch
 */

/**
 * Joins the team topic, answers other members' searches from the local index
 * and sends this member's searches to every connected member.
 *
 * @param {{
 *   seed: Buffer,
 *   team: import('./team.js').Team,
 *   bootstrap?: { host: string, port: number }[],
 *   index: SearchIndex,
 *   embedModel: string,
 *   audit?: Audit,
 *   log: (event: string, fields?: Record<string, unknown>) => void,
 *   limits?: Partial<typeof DEFAULT_LIMITS>
 * }} opts
 */
export async function startPeer ({ seed, team, bootstrap, index, embedModel, audit, log, limits = {} }) {
  const lim = { ...DEFAULT_LIMITS, ...limits }
  /** @type {Map<string, Remote>} keyed by remote public key (hex) */
  const remotes = new Map()
  /** @type {Map<string, PendingSearch>} */
  const pending = new Map()
  // Per member key, not per connection, so a duplicate connection from the
  // same member doesn't double its allowance.
  /** @type {Map<string, number[]>} */
  const recent = new Map()
  /** @type {Map<string, number>} */
  const active = new Map()
  const logReject = createRejectLogger(log)
  let nextId = 0
  let closed = false

  const swarm = new Hyperswarm({
    seed,
    bootstrap,
    firewall: (remoteKey) => {
      if (team.isMember(remoteKey)) return false
      logReject(remoteKey)
      return true
    }
  })
  const publicKey = swarm.keyPair.publicKey

  swarm.on('connection', (conn) => {
    const key = conn.remotePublicKey.toString('hex')
    const peer = key.slice(0, 8)
    /** @type {Remote} */
    const remote = { key, peer, name: team.memberName(conn.remotePublicKey) ?? peer, conn, hello: null }
    // Hyperswarm can briefly hold two connections to one member while it
    // settles on one. The newest wins; the old one's close handler below
    // leaves the new entry alone.
    if (remotes.has(key)) log('replaced', { peer })
    remotes.set(key, remote)
    log('connect', { peer, member: remote.name })

    // A peer that exits resets the stream. The 'disconnect' line covers it.
    conn.on('error', (err) => {
      if (err.code !== 'ECONNRESET') log('conn-error', { peer, err: err.code || err.message })
    })
    conn.on('close', () => {
      // Searches sent on this connection can no longer be answered on it.
      for (const search of pending.values()) {
        if (search.sentOn.get(key) === conn) {
          search.sentOn.delete(key)
          search.check()
        }
      }
      if (remotes.get(key) === remote) remotes.delete(key)
      log('disconnect', { peer })
    })

    send(conn, { t: 'hello', name: team.memberName(publicKey) ?? shortKey(publicKey), chunks: localChunks(), embedModel })

    onMessages(conn, (msg) => {
      if (msg.t === 'hello') onHello(remote, msg)
      else if (msg.t === 'search') onSearch(remote, msg)
      else if (msg.t === 'hits' || msg.t === 'err') onReply(remote, msg)
    })
  })

  function localChunks () {
    try {
      const chunks = index.stats().chunks
      return Number.isInteger(chunks) && chunks >= 0 ? chunks : 0
    } catch {
      return 0
    }
  }

  /**
   * @param {Remote} remote
   * @param {any} msg
   */
  function onHello (remote, msg) {
    const chunks = Number.isInteger(msg.chunks) && msg.chunks >= 0 ? msg.chunks : 0
    const embedModel = typeof msg.embedModel === 'string' && msg.embedModel.length <= MAX_NAME && !CONTROL.test(msg.embedModel) ? msg.embedModel : ''
    remote.hello = { chunks, embedModel }
    log('hello', { peer: remote.peer, member: remote.name, chunks, embedModel })
  }

  /**
   * Answers one search from another member, within the contract's limits.
   *
   * @param {Remote} remote
   * @param {any} msg
   */
  async function onSearch (remote, msg) {
    const { conn, key, peer, name } = remote
    if (!isId(msg.id)) {
      log('bad-message', { peer, t: 'search' })
      return
    }
    const id = String(msg.id)
    const refuse = (/** @type {number} */ status, /** @type {string} */ message, /** @type {string} */ reason) => {
      log('search-refused', { peer, member: name, id, status, reason })
      send(conn, { t: 'err', id, status, message })
    }

    const now = Date.now()
    const times = (recent.get(key) ?? []).filter((t) => now - t < lim.rateWindowMs)
    if (times.length >= lim.rateCount) {
      recent.set(key, times)
      return refuse(429, `at most ${lim.rateCount} searches per ${lim.rateWindowMs / 1000} s`, 'rate')
    }
    times.push(now)
    recent.set(key, times)

    if (typeof msg.q !== 'string' || msg.q.length === 0) return refuse(400, 'q must be a non-empty string', 'query')
    if (msg.q.length > lim.maxQuery) return refuse(400, `q exceeds ${lim.maxQuery} characters`, 'query-length')
    const running = active.get(key) ?? 0
    if (running >= lim.maxConcurrent) return refuse(429, `at most ${lim.maxConcurrent} searches at once`, 'concurrent')

    const k = clampK(msg.k, lim.maxK)
    active.set(key, running + 1)
    const started = Date.now()
    try {
      const found = await index.search(msg.q, k)
      const hits = []
      for (const hit of Array.isArray(found) ? found.slice(0, k) : []) {
        // Scores stay here: they only mean something within this index.
        hits.push({
          path: String(hit.path),
          startLine: hit.startLine,
          endLine: hit.endLine,
          title: String(hit.title ?? ''),
          text: String(hit.text ?? '').slice(0, lim.maxText)
        })
      }
      send(conn, { t: 'hits', id, hits })
      try {
        // Line ranges, so the owner can see exactly which passages left.
        audit?.record({ member: name, peer, paths: hits.map((h) => `${h.path}#L${h.startLine}-${h.endLine}`) })
      } catch (err) {
        log('audit-error', { err: err.code || err.message })
      }
      log('answered', { peer, member: name, id, k, hits: hits.length, ms: Date.now() - started })
    } catch (err) {
      log('search-error', { peer, id, err: err.code || err.message })
      send(conn, { t: 'err', id, status: 500, message: 'search failed' })
    } finally {
      const left = (active.get(key) ?? 1) - 1
      if (left > 0) active.set(key, left)
      else active.delete(key)
    }
  }

  /**
   * @param {Remote} remote
   * @param {any} msg
   */
  function onReply (remote, msg) {
    const search = isId(msg.id) ? pending.get(String(msg.id)) : undefined
    // Only the connection the search went out on may answer it, once.
    if (!search || search.sentOn.get(remote.key) !== remote.conn) return
    search.sentOn.delete(remote.key)

    if (msg.t === 'err') {
      const status = Number.isInteger(msg.status) ? msg.status : 0
      const message = typeof msg.message === 'string' ? msg.message.slice(0, MAX_ERROR_MESSAGE) : ''
      log('search-failed', { peer: remote.peer, member: remote.name, id: msg.id, status, message })
    } else if (!Array.isArray(msg.hits)) {
      log('bad-message', { peer: remote.peer, t: 'hits' })
    } else {
      let dropped = 0
      let kept = 0
      for (const hit of msg.hits) {
        if (kept >= search.k || !isWireHit(hit, lim.maxText)) {
          dropped++
          continue
        }
        kept++
        search.hits.push({
          path: hit.path,
          startLine: hit.startLine,
          endLine: hit.endLine,
          title: hit.title,
          text: hit.text,
          member: remote.name,
          peer: remote.peer
        })
      }
      search.answered++
      if (dropped) log('hits-dropped', { peer: remote.peer, member: remote.name, dropped })
    }
    search.check()
  }

  /**
   * Sends the query to every connected member and collects their hits until
   * all have answered or the deadline passes. It does not search this
   * member's own index: the caller (daemon.js) runs that in parallel and
   * merges, so local results never wait on the network.
   *
   * @param {string} query
   * @param {{ k?: number, deadlineMs?: number }} [opts]
   * @returns {Promise<{ hits: RemoteHit[], asked: number, answered: number }>}
   */
  function search (query, { k = 8, deadlineMs = 3000 } = {}) {
    if (typeof query !== 'string' || query.length === 0) throw new TypeError('query must be a non-empty string')
    if (query.length > lim.maxQuery) throw new RangeError(`query exceeds ${lim.maxQuery} characters`)
    const kk = clampK(k, lim.maxK)
    const id = String(++nextId)
    const started = Date.now()

    return new Promise((resolve) => {
      /** @type {PendingSearch} */
      const entry = {
        k: kk,
        sentOn: new Map(),
        hits: [],
        answered: 0,
        check () {
          if (entry.sentOn.size === 0) finish()
        }
      }
      const timer = setTimeout(finish, deadlineMs)
      let asked = 0
      function finish () {
        if (!pending.has(id)) return
        clearTimeout(timer)
        pending.delete(id)
        log('search-done', { id, asked, answered: entry.answered, hits: entry.hits.length, ms: Date.now() - started })
        resolve({ hits: entry.hits, asked, answered: entry.answered })
      }

      pending.set(id, entry)
      for (const remote of remotes.values()) {
        if (remote.conn.destroyed) continue
        entry.sentOn.set(remote.key, remote.conn)
        send(remote.conn, { t: 'search', id, q: query, k: kk })
      }
      asked = entry.sentOn.size
      log('search-sent', { id, k: kk, asked })
      entry.check()
    })
  }

  function members () {
    const list = []
    for (const remote of remotes.values()) {
      if (!remote.hello) continue
      list.push({ name: remote.name, peer: remote.peer, chunks: remote.hello.chunks, embedModel: remote.hello.embedModel })
    }
    return list
  }

  /**
   * Applies an edited team file without a restart. Removed members are
   * disconnected at once; added members can connect, even if they were
   * rejected earlier.
   *
   * @param {import('./team.js').Team} next
   */
  function setTeam (next) {
    if (!next.topic.equals(team.topic)) throw new Error('the team topic changed; restart to use the new topic')
    const before = team
    team = next
    for (const conn of swarm.connections) {
      if (!team.isMember(conn.remotePublicKey)) {
        log('removed', { peer: shortKey(conn.remotePublicKey) })
        conn.destroy()
      }
    }
    for (const remote of remotes.values()) {
      remote.name = team.memberName(Buffer.from(remote.key, 'hex')) ?? remote.peer
    }
    for (const key of recent.keys()) {
      if (!team.isMember(Buffer.from(key, 'hex'))) recent.delete(key)
    }
    let added = false
    for (const member of team.members) {
      if (before.isMember(Buffer.from(member.key, 'hex'))) continue
      swarm.peers.get(member.key)?.ban(false)
      added = true
    }
    log('team-updated', { members: team.members.length })
    if (added) discovery.refresh().catch((err) => log('lookup-error', { err: err.message }))
  }

  const discovery = swarm.join(team.topic, { server: true, client: true })

  // Hyperswarm repeats its topic lookup only every 10 minutes, so a member
  // that starts before the others have announced would wait that long. While
  // nobody is connected, look up again with backoff.
  let lookupDelay = MIN_LOOKUP_MS
  /** @type {NodeJS.Timeout | undefined} */
  let lookupTimer
  function lookupAgain () {
    if (closed) return
    if (remotes.size === 0) {
      discovery.refresh().catch((err) => log('lookup-error', { err: err.message }))
      lookupDelay = Math.min(lookupDelay * 2, MAX_LOOKUP_MS)
    } else {
      lookupDelay = MIN_LOOKUP_MS
    }
    lookupTimer = setTimeout(lookupAgain, lookupDelay)
  }
  lookupTimer = setTimeout(lookupAgain, lookupDelay)

  await discovery.flushed()
  log('joined', { team: team.name, key: shortKey(publicKey) })

  return {
    publicKey,
    search,
    members,
    setTeam,
    close: async () => {
      closed = true
      clearTimeout(lookupTimer)
      await swarm.destroy()
    }
  }
}

/**
 * @param {unknown} k
 * @param {number} max
 */
function clampK (k, max) {
  const n = Math.trunc(Number(k))
  if (!Number.isFinite(n)) return Math.min(8, max)
  return Math.min(max, Math.max(1, n))
}

/** @param {unknown} id */
function isId (id) {
  return (typeof id === 'string' && id.length > 0 && id.length <= MAX_ID) || Number.isSafeInteger(id)
}

/** @param {unknown} n */
function isLine (n) {
  return Number.isInteger(n) && /** @type {number} */ (n) >= 1 && /** @type {number} */ (n) <= MAX_LINE
}

/**
 * @param {any} hit
 * @param {number} maxText
 * @returns {hit is WireHit}
 */
export function isWireHit (hit, maxText) {
  return hit !== null && typeof hit === 'object' && !Array.isArray(hit) &&
    typeof hit.path === 'string' && hit.path.length > 0 && hit.path.length <= MAX_PATH && !CONTROL.test(hit.path) &&
    isLine(hit.startLine) && isLine(hit.endLine) && hit.endLine >= hit.startLine &&
    typeof hit.title === 'string' && hit.title.length <= MAX_TITLE && !CONTROL.test(hit.title) &&
    typeof hit.text === 'string' && hit.text.length <= maxText
}
