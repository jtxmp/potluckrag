// @ts-check
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import Hyperswarm from 'hyperswarm'
import createTestnet from 'hyperdht/testnet.js'
import { startPeer } from '../src/peer.js'
import { createAuditLog } from '../src/audit.js'
import { publicKeyFromSeed } from '../src/identity.js'
import { addMember, createTeam, parseTeam } from '../src/team.js'
import { onMessages, send } from '../src/protocol.js'

let testnet
let tmp
const cleanup = []

beforeAll(async () => {
  testnet = await createTestnet(3)
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'potluckrag-peer-'))
})

afterEach(async () => {
  while (cleanup.length) await cleanup.pop()()
})

afterAll(async () => {
  await testnet.destroy()
  fs.rmSync(tmp, { recursive: true, force: true })
})

function identity () {
  const seed = crypto.randomBytes(32)
  return { seed, key: publicKeyFromSeed(seed).toString('hex') }
}

// Teams built from the same `topic` find each other; each member list is
// that side's own allow-list. Members are named m0, m1, ... in order.
function team (members, topic = crypto.randomBytes(32).toString('hex')) {
  let file = { ...createTeam('test', { name: 'm0', key: members[0].key }), topic }
  members.slice(1).forEach((m, i) => { file = addMember(file, `m${i + 1}`, m.key) })
  return parseTeam(file)
}

function logger () {
  const events = []
  const log = (event, fields = {}) => events.push({ event, ...fields })
  return { log, events, has: (event) => events.some((e) => e.event === event) }
}

async function waitFor (check, timeout = 20000) {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error('timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function hit (p, extra = {}) {
  return { path: p, startLine: 1, endLine: 5, title: 'Title', text: `text of ${p}`, score: 0.9, ...extra }
}

// Stub of the index contract. `search` defaults to returning `hits`.
function stubIndex (hits = [], search) {
  const calls = []
  return {
    calls,
    search: async (q, k) => {
      calls.push({ q, k })
      return search ? search(q, k) : hits.slice(0, k)
    },
    stats: () => ({ files: 1, chunks: hits.length, roots: ['notes'] })
  }
}

async function peer (id, t, index = stubIndex(), extra = {}) {
  const logs = logger()
  const auditFile = path.join(tmp, `${crypto.randomBytes(4).toString('hex')}.jsonl`)
  const audit = createAuditLog(auditFile)
  const node = await startPeer({ seed: id.seed, team: t, bootstrap: testnet.bootstrap, index, embedModel: 'fake-embed', audit, log: logs.log, ...extra })
  let closed = false
  const close = async () => {
    if (!closed) { closed = true; await node.close() }
  }
  cleanup.push(close)
  return { node, logs, index, audit, auditFile, close }
}

// A member speaking the wire protocol directly, bypassing peer.js. `onSearch`
// returns the messages to answer a search with.
async function rawMember (id, t, onSearch = () => []) {
  const swarm = new Hyperswarm({ seed: id.seed, bootstrap: testnet.bootstrap })
  cleanup.push(() => swarm.destroy())
  const replies = []
  const conns = []
  swarm.on('connection', (conn) => {
    conn.on('error', () => {})
    conns.push(conn)
    send(conn, { t: 'hello', name: 'raw', chunks: 1, embedModel: 'fake-embed' })
    onMessages(conn, (msg) => {
      replies.push(msg)
      if (msg.t === 'search') for (const m of onSearch(msg)) conn.write(typeof m === 'string' ? m : JSON.stringify(m) + '\n')
    })
  })
  await swarm.join(t.topic, { server: true, client: true }).flushed()
  await waitFor(() => conns.some((c) => !c.destroyed))
  // With `key`, the live connection to that member; otherwise the newest.
  const conn = (key) => conns.filter((c) => !c.destroyed && (!key || c.remotePublicKey.toString('hex') === key)).at(-1)
  return { swarm, conn, replies }
}

async function request (raw, msg) {
  send(raw.conn(), msg)
  await waitFor(() => raw.replies.some((r) => r.id === msg.id && (r.t === 'hits' || r.t === 'err')))
  return raw.replies.find((r) => r.id === msg.id && (r.t === 'hits' || r.t === 'err'))
}

describe('federated search', () => {
  test('three members find each other; a search returns hits from both others', async () => {
    const [a, b, c] = [identity(), identity(), identity()]
    const t = team([a, b, c])
    const pa = await peer(a, t)
    const pb = await peer(b, t, stubIndex([hit('notes/b.md')]))
    const pc = await peer(c, t, stubIndex([hit('docs/c.md'), hit('docs/c2.md')]))
    await waitFor(() => [pa, pb, pc].every((p) => p.node.members().length === 2))

    expect(pa.node.members().map((m) => m.name).sort()).toEqual(['m1', 'm2'])
    expect(pa.node.members().find((m) => m.name === 'm2')).toMatchObject({ chunks: 2, embedModel: 'fake-embed', peer: c.key.slice(0, 8) })

    const result = await pa.node.search('how does auth work', { k: 5 })
    expect(result.asked).toBe(2)
    expect(result.answered).toBe(2)
    const byPath = Object.fromEntries(result.hits.map((h) => [h.path, h]))
    expect(Object.keys(byPath).sort()).toEqual(['docs/c.md', 'docs/c2.md', 'notes/b.md'])
    expect(byPath['notes/b.md']).toMatchObject({ member: 'm1', peer: b.key.slice(0, 8), startLine: 1, endLine: 5, title: 'Title' })
    expect(byPath['docs/c.md'].member).toBe('m2')
    // Scores never cross the wire.
    for (const h of result.hits) expect(h).not.toHaveProperty('score')
    // The asker's own index is not searched by peer.js.
    expect(pa.index.calls).toEqual([])
    expect(pb.index.calls).toEqual([{ q: 'how does auth work', k: 5 }])

    // No query or snippet text in any log line.
    for (const p of [pa, pb, pc]) {
      const text = JSON.stringify(p.logs.events)
      expect(text).not.toContain('auth work')
      expect(text).not.toContain('text of')
    }
  })

  test('a key outside the team is rejected and gets no hits', async () => {
    const [a, x] = [identity(), identity()]
    const topic = crypto.randomBytes(32).toString('hex')
    const pa = await peer(a, team([a], topic), stubIndex([hit('notes/secret.md')]))
    // The outsider's own allow-list includes a, so only a's firewall stops it.
    const px = await peer(x, team([x, a], topic))
    await waitFor(() => pa.logs.has('reject'))
    await sleep(500)
    expect(px.node.members()).toEqual([])
    const result = await px.node.search('secret')
    expect(result).toEqual({ hits: [], asked: 0, answered: 0 })
    expect(pa.index.calls).toEqual([])
  })

  test('a slow member yields a partial result at the deadline', async () => {
    const [a, b, c] = [identity(), identity(), identity()]
    const t = team([a, b, c])
    const pa = await peer(a, t)
    await peer(b, t, stubIndex([], async () => { await sleep(3000); return [hit('slow.md')] }))
    await peer(c, t, stubIndex([hit('fast.md')]))
    await waitFor(() => pa.node.members().length === 2)

    const started = Date.now()
    const result = await pa.node.search('q', { deadlineMs: 800 })
    expect(Date.now() - started).toBeLessThan(2500)
    expect(result.asked).toBe(2)
    expect(result.answered).toBe(1)
    expect(result.hits.map((h) => h.path)).toEqual(['fast.md'])
  })

  test('a member that disconnects mid-search counts as not answered', async () => {
    const [a, b, c] = [identity(), identity(), identity()]
    const t = team([a, b, c])
    const pa = await peer(a, t)
    const pb = await peer(b, t, stubIndex([], () => new Promise(() => {})))
    await peer(c, t, stubIndex([hit('fast.md')]))
    await waitFor(() => pa.node.members().length === 2)

    const started = Date.now()
    const searching = pa.node.search('q', { deadlineMs: 15000 })
    await waitFor(() => pb.index.calls.length === 1)
    await pb.close()
    const result = await searching
    expect(Date.now() - started).toBeLessThan(10000)
    expect(result).toMatchObject({ asked: 2, answered: 1 })
    expect(result.hits.map((h) => h.path)).toEqual(['fast.md'])
  })

  test('removed member is disconnected on setTeam', async () => {
    const [a, b, c] = [identity(), identity(), identity()]
    const topic = crypto.randomBytes(32).toString('hex')
    const t = team([a, b, c], topic)
    const pa = await peer(a, t)
    await peer(b, t)
    await peer(c, t)
    await waitFor(() => pa.node.members().length === 2)

    pa.node.setTeam(team([a, b], topic))
    await waitFor(() => pa.logs.has('removed'))
    await waitFor(() => pa.node.members().length === 1)
    await sleep(1000)
    expect(pa.node.members().map((m) => m.name)).toEqual(['m1'])
    const result = await pa.node.search('q')
    expect(result.asked).toBe(1)
  })

  test('the audit log records paths, member and peer but no query text', async () => {
    const [a, b] = [identity(), identity()]
    const t = team([a, b])
    const pa = await peer(a, t)
    const pb = await peer(b, t, stubIndex([hit('notes/b.md'), hit('notes/b2.md')]))
    await waitFor(() => pa.node.members().length === 1)

    await pa.node.search('the confidential question')
    const entries = pb.audit.read()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ member: 'm0', peer: a.key.slice(0, 8), paths: ['notes/b.md#L1-5', 'notes/b2.md#L1-5'] })
    expect(typeof entries[0].time).toBe('string')
    expect(fs.readFileSync(pb.auditFile, 'utf8')).not.toContain('confidential')
  })
})

describe('limits enforced by the answering member', () => {
  async function setup (index) {
    const [a, r] = [identity(), identity()]
    const t = team([a, r])
    const pa = await peer(a, t, index)
    const raw = await rawMember(r, t)
    return { pa, raw }
  }

  test('q over 2000 characters is rejected; k is clamped; text is truncated', async () => {
    const big = Array.from({ length: 30 }, (_, i) => hit(`n/${i}.md`, { text: 'x'.repeat(5000) }))
    const { pa, raw } = await setup(stubIndex(big))

    const tooLong = await request(raw, { t: 'search', id: 'long', q: 'q'.repeat(2001), k: 5 })
    expect(tooLong).toMatchObject({ t: 'err', status: 400 })
    expect(pa.index.calls).toEqual([])

    const exact = await request(raw, { t: 'search', id: 'exact', q: 'q'.repeat(2000), k: 1 })
    expect(exact.t).toBe('hits')
    expect(exact.hits).toHaveLength(1)

    const many = await request(raw, { t: 'search', id: 'many', q: 'q', k: 1000 })
    expect(pa.index.calls.at(-1).k).toBe(20)
    expect(many.hits).toHaveLength(20)
    for (const h of many.hits) {
      expect(h.text).toHaveLength(2000)
      expect(h).not.toHaveProperty('score')
    }

    await request(raw, { t: 'search', id: 'zero', q: 'q', k: 0 })
    expect(pa.index.calls.at(-1).k).toBe(1)
  })

  test('more than 10 searches in 10 s get 429', async () => {
    const { pa, raw } = await setup(stubIndex([hit('a.md')]))
    for (let i = 0; i < 10; i++) {
      const reply = await request(raw, { t: 'search', id: `r${i}`, q: 'q', k: 1 })
      expect(reply.t).toBe('hits')
    }
    const limited = await request(raw, { t: 'search', id: 'r10', q: 'q', k: 1 })
    expect(limited).toMatchObject({ t: 'err', status: 429 })
    expect(pa.index.calls).toHaveLength(10)
  })

  test('more than 4 concurrent searches from one member get 429', async () => {
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const { pa, raw } = await setup(stubIndex([], async () => { await gate; return [hit('a.md')] }))
    for (let i = 0; i < 5; i++) send(raw.conn(), { t: 'search', id: `c${i}`, q: 'q', k: 1 })
    await waitFor(() => raw.replies.some((r) => r.id === 'c4'))
    expect(raw.replies.find((r) => r.id === 'c4')).toMatchObject({ t: 'err', status: 429 })
    release()
    await waitFor(() => raw.replies.filter((r) => r.t === 'hits').length === 4)
    expect(pa.index.calls).toHaveLength(4)
  })
})

describe('misbehaving members', () => {
  test('malformed hits are dropped and garbage does not crash the asker', async () => {
    const [a, b, r] = [identity(), identity(), identity()]
    const t = team([a, b, r])
    const pa = await peer(a, t)
    await peer(b, t, stubIndex([hit('honest.md')]))
    const valid = { path: 'notes/ok.md', startLine: 3, endLine: 4, title: 'ok', text: 'fine' }
    const raw = await rawMember(r, t, (msg) => [
      { t: 'hello', name: { evil: true }, chunks: 'lots', embedModel: 'x'.repeat(10000) },
      { t: 'hits', id: 'unknown', hits: [valid] },
      {
        t: 'hits',
        id: msg.id,
        hits: [
          valid,
          null,
          'str',
          [1, 2],
          { ...valid, path: 5 },
          { ...valid, path: '' },
          { ...valid, path: 'p'.repeat(5000) },
          { ...valid, path: 'evil\u001b[2J.md' },
          { ...valid, startLine: -1 },
          { ...valid, startLine: 1.5 },
          { ...valid, startLine: 9, endLine: 2 },
          { ...valid, title: 7 },
          { ...valid, title: 't'.repeat(5000) },
          { ...valid, text: 'x'.repeat(2001) },
          { ...valid, text: undefined },
          { ...valid, path: 'extra.md', score: 99, member: 'm1' }
        ]
      },
      // A second answer to the same search is ignored.
      { t: 'hits', id: msg.id, hits: [{ ...valid, path: 'second.md' }] }
    ])
    await waitFor(() => pa.node.members().length === 2)

    const result = await pa.node.search('q', { k: 8 })
    expect(result.asked).toBe(2)
    expect(result.answered).toBe(2)
    const fromRaw = result.hits.filter((h) => h.member === 'm2')
    expect(fromRaw.map((h) => h.path)).toEqual(['notes/ok.md', 'extra.md'])
    // The malicious member can't claim another member's name or send a score.
    expect(fromRaw[1]).not.toHaveProperty('score')
    expect(fromRaw[1].member).toBe('m2')
    expect(pa.logs.has('hits-dropped')).toBe(true)
    const rawMemberInfo = pa.node.members().find((m) => m.name === 'm2')
    expect(rawMemberInfo).toMatchObject({ chunks: 0, embedModel: '' })

    // Hits beyond k are dropped too.
    const one = await pa.node.search('q', { k: 1 })
    expect(one.hits.filter((h) => h.member === 'm2')).toHaveLength(1)

    // Non-JSON garbage ends that connection, not the process.
    raw.conn(a.key).write('this is not json\n')
    await waitFor(() => pa.logs.has('disconnect'))
    const after = await pa.node.search('q', { deadlineMs: 1000 })
    expect(after.hits.some((h) => h.path === 'honest.md')).toBe(true)
  })

  test('a malformed search request is ignored, not answered or fatal', async () => {
    const [a, r] = [identity(), identity()]
    const t = team([a, r])
    const pa = await peer(a, t, stubIndex([hit('a.md')]))
    const raw = await rawMember(r, t)
    send(raw.conn(), { t: 'search', id: { nested: 1 }, q: 'q', k: 1 })
    send(raw.conn(), { t: 'search', id: 'x'.repeat(100), q: 'q', k: 1 })
    const bad = await request(raw, { t: 'search', id: 'noq', q: 42, k: 1 })
    expect(bad).toMatchObject({ t: 'err', status: 400 })
    const ok = await request(raw, { t: 'search', id: 'ok', q: 'q', k: 'many' })
    expect(ok.t).toBe('hits')
    expect(pa.index.calls).toEqual([{ q: 'q', k: 8 }])
    expect(pa.logs.events.filter((e) => e.event === 'bad-message')).toHaveLength(2)
  })
})

describe('audit log file', () => {
  test('read skips malformed lines', () => {
    const file = path.join(tmp, 'sub', 'audit.jsonl')
    const audit = createAuditLog(file)
    expect(audit.read()).toEqual([])
    audit.record({ member: 'alice', peer: 'abcd1234', paths: ['notes/a.md'] })
    fs.appendFileSync(file, '{"torn": \n[1,2]\nnull\n')
    audit.record({ member: 'bob', peer: 'ef567890', paths: [] })
    const entries = audit.read()
    expect(entries.map((e) => e.member)).toEqual(['alice', 'bob'])
    expect(entries[0].paths).toEqual(['notes/a.md'])
  })
})
