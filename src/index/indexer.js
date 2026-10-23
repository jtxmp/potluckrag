// @ts-check
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { chunkText } from './chunk.js'
import { IGNORE_FILE, MAX_FILE_BYTES, isIgnored, isIndexable, isProse, readIgnoreFile } from './ignore.js'
import { hybridSearch } from './search.js'
import { openStore } from './store.js'

/**
 * @typedef {{ name: string, abs: string, real: string, patterns: string[] }} Root
 * @typedef {(event: string, fields?: Record<string, unknown>) => void} Log
 * @typedef {{
 *   ready: Promise<void>,
 *   search: (query: string, k: number) => Promise<import('./search.js').Hit[]>,
 *   stats: () => { files: number, chunks: number, roots: string[] },
 *   close: () => Promise<void>
 * }} Index
 */

const DEBOUNCE_MS = 300

/**
 * Indexes the shared folders into one SQLite file and keeps it current.
 * Every path that leaves this module, in results or logs, is
 * `<root name>/<relative path>`; absolute paths and file content are never
 * logged.
 *
 * @param {{
 *   dirs: string[],
 *   dbFile: string,
 *   embedder: import('./embed.js').Embedder,
 *   log: Log,
 *   watch?: boolean
 * }} opts
 * @returns {Index}
 */
export function createIndex ({ dirs, dbFile, embedder, log, watch = false }) {
  const roots = assignRoots(dirs)
  const store = openStore(dbFile)
  /** @type {fs.FSWatcher[]} */
  const watchers = []
  /** @type {Map<Root, Set<string>>} */
  const pending = new Map()
  /** @type {NodeJS.Timeout | null} */
  let timer = null
  let closed = false

  // All store writes go through one queue so a watch batch never interleaves
  // with the initial scan or another batch.
  /** @type {Promise<unknown>} */
  let chain = Promise.resolve()
  /**
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T | undefined>}
   */
  const enqueue = (fn) => {
    const next = chain.then(() => (closed ? undefined : fn()))
    chain = next.catch(() => {})
    return next
  }

  /** @param {unknown} err */
  const describe = (err) => {
    const e = /** @type {any} */ (err)
    if (e?.code) return String(e.code)
    let message = String(e?.message ?? e)
    for (const root of roots) message = message.split(root.real).join(root.name).split(root.abs).join(root.name)
    return message
  }

  /**
   * Reads a file only if its real location is inside the root and is not a
   * denied name, so a symlink can't expose `~/.ssh` or an ignored secret.
   *
   * @param {Root} root
   * @param {string} rel
   * @returns {Promise<{ data: Buffer } | { skip: string }>}
   */
  async function readSafe (root, rel) {
    const real = await fsp.realpath(path.join(root.real, ...rel.split('/')))
    const realRel = path.relative(root.real, real)
    if (realRel === '' || realRel.startsWith('..') || path.isAbsolute(realRel)) return { skip: 'outside-root' }
    if (isIgnored(realRel.split(path.sep).join('/'), root.patterns)) return { skip: 'ignored-target' }

    const handle = await fsp.open(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
    try {
      const stat = await handle.stat()
      if (!stat.isFile()) return { skip: 'not-a-file' }
      if (stat.size > MAX_FILE_BYTES) return { skip: 'too-large' }
      const data = await handle.readFile()
      if (data.length > MAX_FILE_BYTES) return { skip: 'too-large' }
      if (data.includes(0)) return { skip: 'binary' }
      return { data }
    } finally {
      await handle.close()
    }
  }

  /**
   * Indexes one file if it changed. Adds its key to `seen` when the file
   * should stay in the index (including when embedding failed, so the old
   * chunks are kept and the next pass retries).
   *
   * @param {Root} root
   * @param {string} rel
   * @param {Set<string>} seen
   */
  async function indexFile (root, rel, seen) {
    const key = `${root.name}/${rel}`
    let result
    try {
      result = await readSafe(root, rel)
    } catch (err) {
      if (/** @type {any} */ (err)?.code !== 'ENOENT') log('index-error', { path: key, error: describe(err) })
      return
    }
    if ('skip' in result) {
      log('index-skip', { path: key, reason: result.skip })
      return
    }
    seen.add(key)

    const hash = crypto.createHash('sha256').update(result.data).digest('hex')
    if (store.fileHash(key) === hash) return

    const fileName = path.posix.basename(rel)
    const chunks = chunkText(result.data.toString('utf8'), { headings: isProse(rel) })
      .map((c) => ({ ...c, title: c.title || fileName }))
    let vectors = []
    try {
      if (chunks.length > 0) vectors = await embedder.embed(chunks.map((c) => `${c.title}\n${c.text}`))
    } catch (err) {
      log('index-error', { path: key, error: describe(err) })
      return
    }
    if (closed) return
    store.upsertFile({ path: key, hash, chunks: chunks.map((c, i) => ({ ...c, vector: vectors[i] })) })
    log('index-file', { path: key, chunks: chunks.length })
  }

  /**
   * @param {Root} root
   * @param {string} relDir '' for the root itself
   * @param {Set<string>} seen
   */
  async function walk (root, relDir, seen) {
    let entries
    try {
      entries = await fsp.readdir(path.join(root.real, ...relDir.split('/')), { withFileTypes: true })
    } catch (err) {
      if (/** @type {any} */ (err)?.code !== 'ENOENT') log('index-error', { path: `${root.name}/${relDir}`, error: describe(err) })
      return
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      if (closed) return
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name
      if (isIgnored(rel, root.patterns)) continue
      // Symlinked directories are not followed: they can loop or lead out of
      // the root, and anything inside the root is reached directly anyway.
      if (entry.isDirectory()) await walk(root, rel, seen)
      else if ((entry.isFile() || entry.isSymbolicLink()) && isIndexable(rel)) await indexFile(root, rel, seen)
    }
  }

  /** @param {string} prefix remove every file under this key prefix not in `keep` */
  function removeStale (prefix, keep = new Set()) {
    for (const file of store.listFiles()) {
      if ((prefix === '' || file === prefix || file.startsWith(prefix + '/')) && !keep.has(file)) {
        store.removeFile(file)
        log('index-remove', { path: file })
      }
    }
  }

  async function initialScan () {
    const start = Date.now()
    const previous = store.getMeta('embedModel')
    if (previous !== embedder.model) {
      // Vectors from another model are not comparable; start over.
      if (previous !== undefined) log('index-model-changed', { model: embedder.model })
      for (const file of store.listFiles()) store.removeFile(file)
      store.setMeta('embedModel', embedder.model)
    }
    const seen = new Set()
    for (const root of roots) await walk(root, '', seen)
    if (closed) return
    removeStale('', seen)
    const { files, chunks } = store.stats()
    log('index-ready', { files, chunks, ms: Date.now() - start })
  }

  /**
   * @param {Root} root
   * @param {string} rel
   */
  async function updatePath (root, rel) {
    const key = `${root.name}/${rel}`
    if (isIgnored(rel, root.patterns)) {
      if (store.fileHash(key) !== undefined) removeStale(key)
      return
    }
    let stat
    try {
      stat = await fsp.lstat(path.join(root.real, ...rel.split('/')))
    } catch {
      removeStale(key)
      return
    }
    const seen = new Set()
    if (stat.isDirectory()) await walk(root, rel, seen)
    else if ((stat.isFile() || stat.isSymbolicLink()) && isIndexable(rel)) await indexFile(root, rel, seen)
    removeStale(key, seen)
  }

  /** @param {Map<Root, Set<string>>} batch */
  async function processBatch (batch) {
    for (const [root, rels] of batch) {
      if (rels.has('') || rels.has(IGNORE_FILE)) {
        root.patterns = readIgnoreFile(root.real)
        const seen = new Set()
        await walk(root, '', seen)
        if (!closed) removeStale(root.name, seen)
        continue
      }
      for (const rel of rels) {
        if (closed) return
        await updatePath(root, rel)
      }
    }
  }

  function flush () {
    timer = null
    const batch = new Map(pending)
    pending.clear()
    enqueue(() => processBatch(batch)).catch((err) => log('index-error', { error: describe(err) }))
  }

  /**
   * @param {Root} root
   * @param {string | Buffer | null} filename
   */
  function onChange (root, filename) {
    if (closed) return
    // A null filename means the platform could not say what changed.
    const rel = filename ? String(filename).split(path.sep).join('/') : ''
    let set = pending.get(root)
    if (!set) pending.set(root, (set = new Set()))
    set.add(rel)
    if (timer) clearTimeout(timer)
    timer = setTimeout(flush, DEBOUNCE_MS)
  }

  const ready = enqueue(initialScan).then(() => {
    if (!watch || closed) return
    for (const root of roots) {
      try {
        const watcher = fs.watch(root.real, { recursive: true }, (_event, filename) => onChange(root, filename))
        watcher.on('error', (err) => log('index-watch-error', { root: root.name, error: describe(err) }))
        watchers.push(watcher)
      } catch (err) {
        log('index-watch-error', { root: root.name, error: describe(err) })
      }
    }
  })
  ready.catch(() => {})

  return {
    ready,

    async search (query, k) {
      await ready
      if (closed) return []
      return hybridSearch(store, embedder, query, k)
    },

    stats () {
      return { ...store.stats(), roots: roots.map((r) => r.name) }
    },

    async close () {
      if (closed) return
      closed = true
      if (timer) clearTimeout(timer)
      for (const watcher of watchers) watcher.close()
      await chain
      store.close()
    }
  }
}

/**
 * Names each shared folder by its base name, adding -2, -3 on collision.
 *
 * @param {string[]} dirs
 * @returns {Root[]}
 */
function assignRoots (dirs) {
  if (!Array.isArray(dirs) || dirs.length === 0) throw new Error('index: no shared folders given')
  const used = new Set()
  return dirs.map((dir) => {
    const abs = path.resolve(dir)
    let real
    try {
      real = fs.realpathSync(abs)
    } catch {
      throw new Error(`shared folder not found: ${dir}`)
    }
    if (!fs.statSync(real).isDirectory()) throw new Error(`shared folder is not a directory: ${dir}`)
    const base = path.basename(real) || 'root'
    let name = base
    for (let n = 2; used.has(name); n++) name = `${base}-${n}`
    used.add(name)
    return { name, abs, real, patterns: readIgnoreFile(real) }
  })
}
