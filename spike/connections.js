// Spike: how many Hyperswarm connections form when every member joins one
// topic as both server and client. Measures 'connection' events per member,
// live connections per pair after settling, and time to full mesh.
//
// Join modes:
//   simultaneous  all members call join() at the same moment
//   staggered     each member joins after the previous one's join().flushed()
//   refresh       simultaneous, then every member calls discovery.refresh() once
//
// Usage:
//   node --no-warnings spike/connections.js            # testnet, 2/3/5 members, 3 runs per mode
//   node --no-warnings spike/connections.js public     # public DHT, 2 members, 3 runs per mode
//   node --no-warnings spike/connections.js testnet refresh   # one network, one mode
import crypto from 'node:crypto'
import Hyperswarm from 'hyperswarm'
import createTestnet from 'hyperdht/testnet.js'

const SETTLE_MS = 5000
const MESH_TIMEOUT_MS = 30000
const RUNS = 3
const MODES = process.argv[3] ? [process.argv[3]] : ['simultaneous', 'staggered', 'refresh']

/**
 * @param {number} n
 * @param {string} mode
 * @param {{ bootstrap?: any[] }} opts
 */
async function runOnce (n, mode, opts) {
  const topic = crypto.randomBytes(32)
  const swarms = []
  for (let i = 0; i < n; i++) swarms.push(new Hyperswarm(opts.bootstrap ? { bootstrap: opts.bootstrap } : {}))

  const keys = swarms.map((s) => s.keyPair.publicKey.toString('hex'))
  // per member: connection event count, and per remote key { opens, closes }
  const stats = swarms.map(() => ({ events: 0, byRemote: new Map() }))

  const start = Date.now()
  let meshAt = -1
  /** @type {() => void} */
  let onMesh = () => {}
  const meshReached = new Promise((resolve) => { onMesh = () => resolve(undefined) })

  const isMesh = () => stats.every((s, i) => keys.every((k, j) => {
    if (i === j) return true
    const r = s.byRemote.get(k)
    return r && r.opens - r.closes >= 1
  }))

  swarms.forEach((swarm, i) => {
    swarm.on('connection', (conn) => {
      conn.on('error', () => {})
      const remote = conn.remotePublicKey.toString('hex')
      const s = stats[i]
      s.events++
      let r = s.byRemote.get(remote)
      if (!r) { r = { opens: 0, closes: 0, firstAt: Date.now() - start, closedOrder: [] }; s.byRemote.set(remote, r) }
      const nth = ++r.opens
      // which connection (1st, 2nd, ...) to this remote closed, so code knows whether old or new survives
      conn.on('close', () => { r.closes++; r.closedOrder.push(nth) })
      if (meshAt < 0 && isMesh()) { meshAt = Date.now() - start; onMesh() }
    })
  })

  /** @type {number[]} ms after start at which each member called join() */
  const joinStartsMs = []
  if (mode === 'staggered') {
    for (const s of swarms) {
      joinStartsMs.push(Date.now() - start)
      await s.join(topic, { server: true, client: true }).flushed()
    }
  } else {
    const sessions = swarms.map((s) => { joinStartsMs.push(Date.now() - start); return s.join(topic, { server: true, client: true }) })
    await Promise.all(sessions.map((d) => d.flushed()))
    if (mode === 'refresh') await Promise.all(sessions.map((d) => d.refresh()))
  }
  const announcedAt = Date.now() - start

  const timeout = new Promise((resolve) => setTimeout(resolve, MESH_TIMEOUT_MS))
  await Promise.race([meshReached, timeout])
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))

  const members = stats.map((s, i) => {
    const pairs = {}
    for (const [k, r] of s.byRemote) {
      const j = keys.indexOf(k)
      pairs[`m${j}`] = { opens: r.opens, closes: r.closes, closedOrder: [...r.closedOrder], live: r.opens - r.closes, firstAtMs: r.firstAt }
    }
    return { member: `m${i}`, connectionEvents: s.events, swarmConnections: swarms[i].connections.size, pairs }
  })

  // a pair is "exactly one" when both sides see exactly one live connection to each other
  let pairsTotal = 0
  let pairsExactlyOne = 0
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      pairsTotal++
      const a = stats[i].byRemote.get(keys[j])
      const b = stats[j].byRemote.get(keys[i])
      if (a && b && a.opens - a.closes === 1 && b.opens - b.closes === 1) pairsExactlyOne++
    }
  }

  await Promise.all(swarms.map((s) => s.destroy()))
  return { n, joinMode: mode, joinStartsMs, announcedMs: announcedAt, meshMs: meshAt, meshAfterLastJoinMs: meshAt < 0 ? -1 : meshAt - joinStartsMs[joinStartsMs.length - 1], pairsTotal, pairsExactlyOne, members }
}

async function testnetMode () {
  const testnet = await createTestnet(3)
  try {
    for (const mode of MODES) for (const n of [2, 3, 5]) {
      for (let run = 1; run <= RUNS; run++) {
        const r = await runOnce(n, mode, { bootstrap: testnet.bootstrap })
        console.log(JSON.stringify({ mode: 'testnet', run, ...r }))
      }
    }
  } finally {
    await testnet.destroy()
  }
}

async function publicMode () {
  for (const mode of MODES) for (let run = 1; run <= RUNS; run++) {
    const r = await runOnce(2, mode, {})
    console.log(JSON.stringify({ mode: 'public', run, ...r }))
  }
}

if (process.argv[2] === 'public') await publicMode()
else await testnetMode()
