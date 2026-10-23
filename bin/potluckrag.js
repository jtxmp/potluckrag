#!/usr/bin/env -S node --no-warnings=ExperimentalWarning
// @ts-check
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { loadOrCreateIdentity, defaultIdentityDir, publicKeyFromSeed } from '../src/identity.js'
import { addMember, createTeam, parseTeam, readTeam, readTeamFile, watchTeamFile, writeTeamFile } from '../src/team.js'
import { startDaemon } from '../src/daemon.js'
import { createAuditLog } from '../src/audit.js'
import { buildMessages, streamAnswer } from '../src/ask.js'
import { createLogger } from '../src/log.js'
import { CHAT_MODEL, EMBED_MODEL, startFakeUpstream } from '../src/fake-upstream.js'

const DEFAULT_PORT = 11600
const DEFAULT_EMBED_MODEL = 'nomic-embed-text'
const DEFAULT_CHAT_MODEL = 'llama3.2:3b'

const USAGE = `potluckrag: ask questions across your team's documents without moving them

Usage:
  potluckrag try                               Try it on one machine: two members with sample
                                               notes and a fake model, connected over the real DHT
  potluckrag id                                Print your public key (creates it on first run)
  potluckrag team init <team-name> [--member <name>]
                                               Create a team file with you as the first member
  potluckrag team add <name> <public-key>      Add a member to the team file
  potluckrag share <folder>...                 Index these folders and answer the team's searches
  potluckrag ask <question>                    Search every member's folders and answer with sources
  potluckrag status                            Show connected members and index size
  potluckrag log                               Show which files you sent to which member

Options:
  --team <file>          Team file (default: ./team.json). Same format as PotluckLLM's.
  --member <name>        Your name in a new team file (default: this machine's hostname)
  --port <n>             Local endpoint of 'share' (default: ${DEFAULT_PORT})
  --embed-url <url>      OpenAI-compatible embeddings server (default: http://127.0.0.1:11434)
  --embed-model <name>   Embedding model (default: ${DEFAULT_EMBED_MODEL})
  --chat-url <url>       OpenAI-compatible chat server for 'ask' (default: http://127.0.0.1:11434).
                         PotluckLLM's 'potluck use' endpoint works: http://127.0.0.1:11500
  --chat-model <name>    Chat model for 'ask' (default: ${DEFAULT_CHAT_MODEL})
  -k <n>                 Sources per answer (default: 8, at most 20)
  --deadline <s>         How long 'ask' waits for members (default: 3)
  --json                 'ask': print the sources as JSON and skip the answer
  --no-watch             'share': index once, do not watch the folders
  --bootstrap <list>     DHT bootstrap nodes as host:port,host:port (for local testing)
  -h, --help             Show this help
  -v, --version          Show the version

Environment:
  POTLUCKRAG_API_KEY     If set, the local endpoint requires it (Authorization: Bearer)
  POTLUCKRAG_CHAT_KEY    API key sent to --chat-url, if that server needs one

Your identity is PotluckLLM's (~/.potluck), so one team file serves both tools.
Index data and the audit log live in ~/.potluckrag.`

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    team: { type: 'string', default: 'team.json' },
    member: { type: 'string' },
    port: { type: 'string', default: String(DEFAULT_PORT) },
    'embed-url': { type: 'string', default: 'http://127.0.0.1:11434' },
    'embed-model': { type: 'string', default: DEFAULT_EMBED_MODEL },
    'chat-url': { type: 'string', default: 'http://127.0.0.1:11434' },
    'chat-model': { type: 'string', default: DEFAULT_CHAT_MODEL },
    k: { type: 'string', short: 'k', default: '8' },
    deadline: { type: 'string', default: '3' },
    json: { type: 'boolean', default: false },
    'no-watch': { type: 'boolean', default: false },
    bootstrap: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' }
  }
})

const log = createLogger()

async function main () {
  const [command, ...args] = positionals

  if (values.version) {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    console.log(pkg.version)
    return
  }
  if (values.help || !command) {
    console.log(USAGE)
    return
  }

  if (command === 'id') {
    const identity = loadOrCreateIdentity()
    if (identity.created) console.error(`Created a new identity in ${defaultIdentityDir()}`)
    console.log(identity.publicKey.toString('hex'))
    return
  }
  if (command === 'team') return teamCommand(args)
  if (command === 'share') return share(args)
  if (command === 'ask') return ask(args.join(' '))
  if (command === 'try') return tryLocally()

  if (command === 'status') {
    const status = await callLocal('GET', '/status')
    console.log(`${status.member} on team "${status.team}": ${status.index.files} files, ${status.index.chunks} chunks (${status.embedModel})`)
    if (!status.members.length) console.log('No other members connected.')
    for (const m of status.members) console.log(`  ${m.name} (${m.peer}): ${m.chunks} chunks, ${m.embedModel}`)
    return
  }

  if (command === 'log') {
    for (const entry of createAuditLog(path.join(dataDir(), 'audit.jsonl')).read()) {
      console.log(`${entry.time}  ${entry.member} (${entry.peer})  ${entry.paths.length ? entry.paths.join(', ') : '(no files)'}`)
    }
    return
  }

  throw new Error(`unknown command "${command}". Run: potluckrag --help`)
}

/** @param {string[]} dirs */
async function share (dirs) {
  if (!dirs.length) throw new Error('usage: potluckrag share <folder>...')
  for (const dir of dirs) {
    if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`${dir} is not a folder`)
  }
  const { seed } = loadOrCreateIdentity()
  const team = readTeam(values.team)
  const data = dataDir()

  const daemon = await startDaemon({
    seed,
    team,
    dirs: dirs.map((dir) => path.resolve(dir)),
    dbFile: path.join(data, 'index.db'),
    auditFile: path.join(data, 'audit.jsonl'),
    embedUrl: values['embed-url'],
    embedModel: values['embed-model'],
    port: parsePort(values.port),
    apiKey: process.env.POTLUCKRAG_API_KEY || undefined,
    deadlineMs: parseSeconds(values.deadline) * 1000,
    bootstrap: parseBootstrap(values.bootstrap),
    watch: !values['no-watch'],
    log
  })

  const stopWatching = watchTeamFile(values.team, (next) => {
    try {
      daemon.setTeam(next)
    } catch (err) {
      log('team-reload-error', { err: err.message })
    }
  }, (err) => log('team-reload-error', { err: err.message }))

  const shutdown = () => {
    log('shutdown')
    stopWatching()
    daemon.close().then(() => process.exit(0), () => process.exit(1))
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

/** @param {string} question */
async function ask (question) {
  if (!question.trim()) throw new Error('usage: potluckrag ask <question>')
  const result = await callLocal('POST', '/search', { q: question, k: parseCount(values.k) })
  if (values.json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  await answer(question, result, { url: values['chat-url'], model: values['chat-model'] })
}

/**
 * Streams the answer, then lists the sources and how many members answered.
 *
 * @param {string} question
 * @param {{ hits: any[], asked: number, answered: number }} result
 * @param {{ url: string, model: string }} chat
 */
async function answer (question, result, chat) {
  if (!result.hits.length) {
    console.log('No member has a document that matches this question.')
  } else {
    await streamAnswer({
      url: chat.url,
      model: chat.model,
      apiKey: process.env.POTLUCKRAG_CHAT_KEY || undefined,
      messages: buildMessages(question, result.hits),
      onToken: (token) => process.stdout.write(printable(token))
    })
    console.log('\n\nSources:')
    result.hits.forEach((hit, i) => console.log(`  [${i + 1}] ${hit.member}:${hit.path}#L${hit.startLine}-${hit.endLine}`))
  }
  const missing = result.asked - result.answered
  console.log(`\n${result.answered} of ${result.asked} other members answered${missing ? ` (${missing} did not answer in time)` : ''}.`)
}

/**
 * Model output can repeat text from a member's documents, so it must not be
 * able to send terminal escape sequences. Keeps newlines and tabs.
 *
 * @param {string} text
 */
function printable (text) {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
}

/**
 * Runs two members in this process with throwaway keys, sample notes and the
 * fake model. They still find each other through the public HyperDHT, so this
 * shows the real path with no GPU and no setup.
 */
async function tryLocally () {
  const fake = await startFakeUpstream(0)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'potluckrag-try-'))
  const members = ['alice', 'you'].map((name) => {
    const seed = crypto.randomBytes(32)
    const dir = path.join(root, name, 'notes')
    fs.mkdirSync(dir, { recursive: true })
    return { name, seed, dir, key: publicKeyFromSeed(seed).toString('hex') }
  })
  fs.writeFileSync(path.join(members[0].dir, 'release-runbook.md'), SAMPLE_ALICE)
  fs.writeFileSync(path.join(members[1].dir, 'onboarding.md'), SAMPLE_YOU)

  const team = parseTeam({ name: 'try', topic: crypto.randomBytes(32).toString('hex'), members: members.map(({ name, key }) => ({ name, key })) })
  const bootstrap = parseBootstrap(values.bootstrap)
  const daemons = []
  for (const member of members) {
    daemons.push(await startDaemon({
      seed: member.seed,
      team,
      dirs: [member.dir],
      dbFile: ':memory:',
      auditFile: path.join(root, member.name, 'audit.jsonl'),
      embedUrl: fake.url,
      embedModel: EMBED_MODEL,
      port: 0,
      bootstrap,
      watch: false,
      log: (event, fields) => log(event, { side: member.name, ...fields })
    }))
  }
  const close = () => Promise.all([...daemons.map((d) => d.close()), fake.close()])
    .finally(() => fs.rmSync(root, { recursive: true, force: true }))

  try {
    const you = daemons[1]
    const started = Date.now()
    while (!you.status().members.length) {
      if (Date.now() - started > 60000) throw new Error('alice did not connect within 60 s. Is UDP blocked on this network?')
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    console.log(`\nConnected to alice over the HyperDHT in ${((Date.now() - started) / 1000).toFixed(1)} s.`)
    const question = 'How do we roll back a release?'
    console.log(`Question: ${question}\n`)
    await answer(question, await you.search(question, 4), { url: fake.url, model: CHAT_MODEL })
    console.log(`
alice's runbook never left her folder until this search, and her audit log now
records that you received it. The answer above came from a fake model. To use
real documents and models, see: https://github.com/jtxmp/potluckrag#quickstart`)
  } finally {
    await close()
  }
}

const SAMPLE_ALICE = `# Release runbook

## Rolling back

If error rates rise after a release, roll back first and investigate later.
Run the deploy job with the previous release tag, then confirm the health
check passes on every region before closing the incident.

## Release freeze

No releases on Fridays after 14:00 or during a declared incident.
`

const SAMPLE_YOU = `# Onboarding

## First week

Get access to the issue tracker and the team calendar. Pair with a teammate
on one small bug fix before taking a feature.
`

/**
 * @param {'GET' | 'POST'} method
 * @param {string} pathname
 * @param {unknown} [body]
 */
async function callLocal (method, pathname, body) {
  const url = `http://127.0.0.1:${parsePort(values.port)}${pathname}`
  /** @type {Record<string, string>} */
  const headers = { 'content-type': 'application/json' }
  if (process.env.POTLUCKRAG_API_KEY) headers.authorization = `Bearer ${process.env.POTLUCKRAG_API_KEY}`
  let res
  try {
    res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60000) })
  } catch {
    throw new Error(`nothing is listening on ${url}. Start it first: potluckrag share <folder>`)
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data?.error?.message ?? `local endpoint answered ${res.status}`)
  return data
}

/** ~/.potluckrag, private to this user. */
function dataDir () {
  const dir = path.join(os.homedir(), '.potluckrag')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const mode = fs.statSync(dir).mode & 0o777
  if (mode & 0o077) throw new Error(`${dir} is accessible by other users (mode ${mode.toString(8)}). Run: chmod 700 ${dir}`)
  return dir
}

/** @param {string[]} args */
function teamCommand ([sub, ...args]) {
  if (sub === 'init') {
    const [teamName] = args
    if (!teamName) throw new Error('usage: potluckrag team init <team-name> [--member <name>]')
    const { publicKey } = loadOrCreateIdentity()
    const member = values.member ?? os.hostname()
    try {
      writeTeamFile(values.team, createTeam(teamName, { name: member, key: publicKey.toString('hex') }), { create: true })
    } catch (err) {
      if (err.code === 'EEXIST') throw new Error(`${values.team} already exists. Delete it first or pass --team <other file>.`)
      throw err
    }
    console.log(`Created ${values.team} for team "${teamName}" with you as "${member}".`)
    if (trackedByGit(values.team)) {
      console.error(`Warning: ${values.team} is inside a git repository and not ignored. Add it to .gitignore so the topic and member list are never committed.`)
    }
    console.log('Add members with: potluckrag team add <name> <public-key>')
    console.log('Then share the file with them over a private channel.')
    return
  }

  if (sub === 'add') {
    const [name, key] = args
    if (!name || !key) throw new Error('usage: potluckrag team add <name> <public-key>')
    writeTeamFile(values.team, addMember(readTeamFile(values.team), name, key.toLowerCase()))
    console.log(`Added "${name}" (${key.slice(0, 8)}) to ${values.team}. Share the updated file with the team.`)
    return
  }

  throw new Error('usage: potluckrag team init <team-name> | potluckrag team add <name> <public-key>')
}

/**
 * True when `file` is inside a git work tree and git would not ignore it.
 *
 * @param {string} file
 */
function trackedByGit (file) {
  try {
    execFileSync('git', ['check-ignore', '-q', file], { stdio: 'ignore' })
    return false
  } catch (err) {
    // check-ignore exits 1 for "not ignored" and 128 outside a repository.
    return err.status === 1
  }
}

/** @param {string} value */
function parseSeconds (value) {
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`invalid number of seconds "${value}"`)
  return seconds
}

/** @param {string} value */
function parseCount (value) {
  const count = Number(value)
  if (!Number.isInteger(count) || count <= 0) throw new Error(`invalid number "${value}"`)
  return count
}

/** @param {string | undefined} list */
function parseBootstrap (list) {
  if (!list) return undefined
  return list.split(',').map((entry) => {
    const [host, port] = entry.split(':')
    return { host, port: Number(port) }
  })
}

/** @param {string} value */
function parsePort (value) {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid port "${value}"`)
  return port
}

main().catch((err) => {
  console.error(`potluckrag: ${err.message}`)
  process.exit(1)
})
