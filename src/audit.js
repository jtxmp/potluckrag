// @ts-check
import fs from 'node:fs'
import path from 'node:path'

/**
 * Append-only record of which files this member's index served to whom.
 * One JSON object per line. Query text is never written: the log exists so a
 * member can see what left the machine, not what others asked.
 *
 * @param {string} file
 */
export function createAuditLog (file) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })

  return {
    /** @param {{ member: string, peer: string, paths: string[] }} entry */
    record ({ member, peer, paths }) {
      const line = JSON.stringify({
        time: new Date().toISOString(),
        member: String(member),
        peer: String(peer),
        paths: Array.isArray(paths) ? paths.map(String) : []
      })
      fs.appendFileSync(file, line + '\n', { mode: 0o600 })
    },

    /** @returns {{ time: string, member: string, peer: string, paths: string[] }[]} */
    read () {
      let text
      try {
        text = fs.readFileSync(file, 'utf8')
      } catch (err) {
        if (err.code === 'ENOENT') return []
        throw err
      }
      const entries = []
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        try {
          const entry = JSON.parse(line)
          if (entry && typeof entry === 'object' && !Array.isArray(entry)) entries.push(entry)
        } catch {
          // A torn write from a crash leaves a partial last line; skip it.
        }
      }
      return entries
    }
  }
}
