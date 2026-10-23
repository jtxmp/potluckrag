// @ts-check
// End to end: daemons with real indexes, peers on a local DHT testnet, the
// fake upstream for embeddings and chat, and the local HTTP endpoint.
import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import createTestnet from 'hyperdht/testnet.js'
import { startDaemon } from '../src/daemon.js'
import { publicKeyFromSeed } from '../src/identity.js'
import { parseTeam } from '../src/team.js'
import { EMBED_MODEL, startFakeUpstream } from '../src/fake-upstream.js'

let testnet
let fake
const cleanup = []

beforeAll(async () => {
  testnet = await createTestnet(3)
  fake = await startFakeUpstream()
})

afterEach(async () => {
  while (cleanup.length) await cleanup.pop()()
})

afterAll(async () => {
  await fake.close()
  await testnet.destroy()
})

/**
 * @param {Record<string, Record<string, string>>} docs member name -> file name -> content
 */
async function startTeam (docs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'potluckrag-test-'))
  cleanup.push(async () => fs.rmSync(root, { recursive: true, force: true }))
  const members = Object.keys(docs).map((name) => {
    const seed = crypto.randomBytes(32)
    const dir = path.join(root, name, 'notes')
    fs.mkdirSync(dir, { recursive: true })
    for (const [file, content] of Object.entries(docs[name])) fs.writeFileSync(path.join(dir, file), content)
    return { name, seed, dir, key: publicKeyFromSeed(seed).toString('hex') }
  })
  const team = parseTeam({ name: 'test', topic: crypto.randomBytes(32).toString('hex'), members: members.map(({ name, key }) => ({ name, key })) })

  const daemons = {}
  for (const member of members) {
    const daemon = await startDaemon({
      seed: member.seed,
      team,
      dirs: [member.dir],
      dbFile: ':memory:',
      auditFile: path.join(root, member.name, 'audit.jsonl'),
      embedUrl: fake.url,
      embedModel: EMBED_MODEL,
      port: 0,
      bootstrap: testnet.bootstrap,
      watch: false,
      log: () => {}
    })
    cleanup.push(() => daemon.close())
    daemons[member.name] = daemon
  }
  return { daemons, root }
}

async function waitFor (check, timeout = 15000) {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error('timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

const DOCS = {
  alice: { 'runbook.md': '# Runbook\n\n## Rollback\n\nRoll back the release with the previous tag, then check health in every region.\n' },
  bob: { 'pricing.md': '# Pricing\n\nThe team plan costs the same per seat for every region.\n' },
  carol: { 'onboarding.md': '# Onboarding\n\nPair with a teammate on a small bug in your first week.\n' }
}

describe('search across members', () => {
  test('merges local and remote hits, labelled by member, best match first', async () => {
    const { daemons } = await startTeam(DOCS)
    await waitFor(() => daemons.carol.status().members.length === 2)

    const result = await daemons.carol.search('how do we roll back a release', 3)
    expect(result.asked).toBe(2)
    expect(result.answered).toBe(2)
    expect(result.hits[0]).toMatchObject({ member: 'alice', path: 'notes/runbook.md' })
    expect(result.hits.map((h) => h.member)).toContain('carol')
    for (const hit of result.hits) expect(path.isAbsolute(hit.path)).toBe(false)
  })

  test('the answering member records what it sent, without the question', async () => {
    const { daemons, root } = await startTeam(DOCS)
    await waitFor(() => daemons.carol.status().members.length === 2)
    await daemons.carol.search('roll back a release', 3)

    const audit = fs.readFileSync(path.join(root, 'alice', 'audit.jsonl'), 'utf8')
    expect(audit).toContain('notes/runbook.md')
    expect(audit).toContain('carol')
    expect(audit).not.toContain('roll back a release')
  })
})

describe('local endpoint', () => {
  test('answers /search and /status', async () => {
    const { daemons } = await startTeam({ alice: DOCS.alice, bob: DOCS.bob })
    await waitFor(() => daemons.bob.status().members.length === 1)
    const base = `http://127.0.0.1:${daemons.bob.port}`

    const status = await (await fetch(`${base}/status`)).json()
    expect(status).toMatchObject({ member: 'bob', team: 'test' })
    expect(status.members[0].name).toBe('alice')

    const res = await fetch(`${base}/search`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ q: 'roll back release', k: 2 }) })
    expect(res.status).toBe(200)
    expect((await res.json()).hits[0].member).toBe('alice')
  })

  test('refuses web pages, foreign hosts, non-JSON bodies and long queries', async () => {
    const { daemons } = await startTeam({ alice: DOCS.alice })
    const port = daemons.alice.port
    const post = (headers, body = '{"q":"x"}') => fetch(`http://127.0.0.1:${port}/search`, { method: 'POST', headers, body })

    expect((await post({ 'content-type': 'application/json', origin: 'https://evil.example' })).status).toBe(403)
    expect((await post({ 'content-type': 'text/plain' })).status).toBe(415)
    expect((await post({ 'content-type': 'application/json' }, JSON.stringify({ q: 'x'.repeat(2001) }))).status).toBe(400)
    expect(await rawStatus(port, 'evil.example')).toBe(421)
  })
})

describe('cli', () => {
  test('potluckrag try finds the runbook through the testnet', async () => {
    const bootstrap = testnet.bootstrap.map((b) => `${b.host}:${b.port}`).join(',')
    const { stdout } = await new Promise((resolve, reject) => {
      execFile('node', ['bin/potluckrag.js', 'try', '--bootstrap', bootstrap], { timeout: 60000 }, (err, stdout, stderr) => err ? reject(Object.assign(err, { stderr })) : resolve({ stdout }))
    })
    expect(stdout).toContain('alice:notes/release-runbook.md')
    expect(stdout).toContain('1 of 1 other members answered')
  }, 70000)
})

/**
 * Status of a request with a forged Host header, which fetch does not allow.
 *
 * @param {number} port
 * @param {string} host
 */
async function rawStatus (port, host) {
  const http = await import('node:http')
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/status', headers: { host } }, (res) => {
      res.resume()
      resolve(res.statusCode)
    }).on('error', reject)
  })
}
