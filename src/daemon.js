// @ts-check
import { createEmbedder } from './index/embed.js'
import { createIndex } from './index/indexer.js'
import { startPeer } from './peer.js'
import { createAuditLog } from './audit.js'
import { rescore } from './ask.js'
import { startHttp } from './http.js'

/**
 * What `potluckrag share` runs: the local index, the peer that answers and
 * sends searches, and the local HTTP endpoint that `ask` calls.
 *
 * A question is answered from this member's own index plus every connected
 * member's. Scores from different indexes are not comparable (members may use
 * different embedding models), so all snippets are re-scored here with this
 * member's embedder before the top k are returned.
 *
 * @param {{
 *   seed: Buffer,
 *   team: import('./team.js').Team,
 *   dirs: string[],
 *   dbFile: string,
 *   auditFile: string,
 *   embedUrl: string,
 *   embedModel: string,
 *   port: number,
 *   apiKey?: string,
 *   deadlineMs?: number,
 *   bootstrap?: { host: string, port: number }[],
 *   watch?: boolean,
 *   log: (event: string, fields?: Record<string, unknown>) => void
 * }} opts
 */
export async function startDaemon ({ seed, team, dirs, dbFile, auditFile, embedUrl, embedModel, port, apiKey, deadlineMs = 3000, bootstrap, watch = true, log }) {
  const embedder = createEmbedder({ url: embedUrl, model: embedModel })
  const index = createIndex({ dirs, dbFile, embedder, log, watch })
  await index.ready

  const audit = createAuditLog(auditFile)
  const peer = await startPeer({ seed, team, bootstrap, index, embedModel, audit, log })
  let currentTeam = team

  const selfName = () => currentTeam.memberName(peer.publicKey) ?? 'me'

  /**
   * @param {string} q
   * @param {number} k
   */
  async function search (q, k) {
    const started = Date.now()
    const [local, remote] = await Promise.all([
      index.search(q, k),
      peer.search(q, { k, deadlineMs })
    ])
    const own = local.map((hit) => ({ ...hit, member: selfName(), peer: 'local' }))
    const hits = await rescore(q, [...own, ...remote.hits], embedder, k)
    log('search', { k, local: own.length, remote: remote.hits.length, asked: remote.asked, answered: remote.answered, ms: Date.now() - started })
    return { hits, asked: remote.asked, answered: remote.answered }
  }

  function status () {
    return { member: selfName(), team: currentTeam.name, index: index.stats(), embedModel, members: peer.members() }
  }

  const http = await startHttp({ port, apiKey, search, status, log })
  log('listening', { url: `http://127.0.0.1:${http.port}`, team: team.name, ...index.stats(), roots: index.stats().roots.join(',') })

  return {
    port: http.port,
    search,
    status,
    /** @param {import('./team.js').Team} next */
    setTeam (next) {
      currentTeam = next
      peer.setTeam(next)
    },
    close: async () => {
      await http.close()
      await peer.close()
      await index.close()
    }
  }
}
