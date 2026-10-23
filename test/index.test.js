// @ts-check
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { EMBED_MODEL, startFakeUpstream } from '../src/fake-upstream.js'
import { chunkText } from '../src/index/chunk.js'
import { createEmbedder } from '../src/index/embed.js'
import { isIgnored, isIndexable } from '../src/index/ignore.js'
import { createIndex } from '../src/index/indexer.js'
import { hybridSearch } from '../src/index/search.js'
import { openStore } from '../src/index/store.js'

/** @type {Awaited<ReturnType<typeof startFakeUpstream>>} */
let fake
/** @type {string[]} */
const tmpDirs = []
/** @type {{ close: () => Promise<void> }[]} */
const indexes = []

beforeAll(async () => {
  fake = await startFakeUpstream()
})

afterAll(async () => {
  await fake.close()
})

afterEach(async () => {
  for (const index of indexes.splice(0)) await index.close()
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tmp () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'potluckrag-index-'))
  tmpDirs.push(dir)
  return dir
}

/**
 * @param {string} root
 * @param {Record<string, string>} files
 */
function writeFiles (root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }
}

/**
 * @param {string[]} dirs
 * @param {{ watch?: boolean }} [opts]
 */
function makeIndex (dirs, { watch = false } = {}) {
  /** @type {{ event: string, fields: Record<string, unknown> }[]} */
  const events = []
  const index = createIndex({
    dirs,
    dbFile: path.join(tmp(), 'index.db'),
    embedder: createEmbedder({ url: fake.url, model: EMBED_MODEL }),
    log: (event, fields = {}) => { events.push({ event, fields }) },
    watch
  })
  indexes.push(index)
  return { index, events }
}

/** All strings sent to the fake embeddings endpoint. */
function embeddedInputs () {
  return fake.bodies.filter((b) => b.input !== undefined).flatMap((b) => b.input)
}

/**
 * @param {() => Promise<boolean> | boolean} check
 * @param {number} [timeoutMs]
 */
async function waitFor (check, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('condition not met in time')
}

describe('chunkText', () => {
  test('splits by heading and paragraph with 1-based line ranges', () => {
    const text = [
      'intro line', //          1
      '', //                    2
      '# Setup', //             3
      'install the tool', //    4
      '', //                    5
      'run it', //              6
      '## Usage', //            7
      'call search' //          8
    ].join('\n')
    const chunks = chunkText(text)
    expect(chunks.map((c) => [c.startLine, c.endLine, c.title])).toEqual([
      [1, 1, ''],
      [3, 6, 'Setup'],
      [7, 8, 'Usage']
    ])
    expect(chunks[1].text).toBe('# Setup\ninstall the tool\n\nrun it')
  })

  test('packs paragraphs up to maxChars and splits overlong paragraphs and lines', () => {
    const paras = ['a'.repeat(30), 'b'.repeat(30), 'c'.repeat(30)].join('\n\n')
    const packed = chunkText(paras, { maxChars: 70 })
    expect(packed.map((c) => [c.startLine, c.endLine])).toEqual([[1, 3], [5, 5]])

    const longLine = 'x'.repeat(250)
    const split = chunkText(`# T\n${longLine}`, { maxChars: 100 })
    for (const c of split) expect(c.text.length).toBeLessThanOrEqual(100)
    expect(split.filter((c) => c.startLine === 2).map((c) => c.text).join('')).toBe(longLine)
    expect(split.every((c) => c.title === 'T')).toBe(true)

    const longPara = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n')
    const lines = chunkText(longPara, { maxChars: 80 })
    expect(lines.length).toBeGreaterThan(1)
    for (const c of lines) expect(c.text.length).toBeLessThanOrEqual(80)
    expect(lines[0].startLine).toBe(1)
    expect(lines[lines.length - 1].endLine).toBe(50)
  })

  test('does not treat # inside a code fence as a heading', () => {
    const chunks = chunkText('# Real\n```sh\n# comment\n\necho hi\n```')
    expect(chunks.map((c) => c.title)).toEqual(['Real'])
  })
})

describe('ignore rules', () => {
  test('deny list covers secrets, VCS, dependencies and databases', () => {
    for (const p of ['.env', '.env.local', 'config/.env.production', 'certs/server.pem', 'k/tls.key', 'a.p12', 'a.pfx',
      'id_rsa', 'id_rsa.pub', '.ssh/config', 'credentials.json', 'secrets.yaml', 'data.sqlite', 'app.db',
      '.git/HEAD', 'node_modules/x/readme.md', 'dist/out.js', 'build/x.md', 'sub/.cache/x.md']) {
      expect(isIgnored(p), p).toBe(true)
    }
    for (const p of ['notes.md', 'docs/build-guide.md', 'src/env.js', 'keys.md']) {
      expect(isIgnored(p), p).toBe(false)
    }
  })

  test('.potluckragignore globs', () => {
    const patterns = ['drafts/', '*.log.md', '/private/**', 'docs/**/secret-*.md']
    expect(isIgnored('drafts/a.md', patterns)).toBe(true)
    expect(isIgnored('x/drafts/a.md', patterns)).toBe(true)
    expect(isIgnored('drafts', patterns)).toBe(false)
    expect(isIgnored('run.log.md', patterns)).toBe(true)
    expect(isIgnored('private/a/b.md', patterns)).toBe(true)
    expect(isIgnored('x/private/b.md', patterns)).toBe(false)
    expect(isIgnored('docs/secret-plan.md', patterns)).toBe(true)
    expect(isIgnored('docs/a/b/secret-plan.md', patterns)).toBe(true)
    expect(isIgnored('docs/public.md', patterns)).toBe(false)
  })

  test('a negated pattern cannot re-expose a denied file', () => {
    expect(isIgnored('.env', ['!.env'])).toBe(true)
    expect(isIgnored('certs/server.pem', ['!*.pem', '!certs/server.pem'])).toBe(true)
  })

  test('isIndexable accepts text and code extensions only', () => {
    expect(isIndexable('a.md')).toBe(true)
    expect(isIndexable('a.PY')).toBe(true)
    expect(isIndexable('a.png')).toBe(false)
    expect(isIndexable('Makefile')).toBe(false)
  })

  test('a .env, a .pem and .potluckragignore matches in a shared folder are never indexed', async () => {
    const root = tmp()
    writeFiles(root, {
      'notes.md': '# Notes\nzebra migration plan',
      '.env': 'API_KEY=zebra-secret',
      '.env.md': 'zebra env markdown',
      'server.pem': '-----BEGIN zebra-----',
      'cert.pem.md': 'not a pem, but has pem in its name',
      'drafts/wip.md': 'zebra draft',
      '.potluckragignore': '# drafts are private\ndrafts/\n'
    })
    const { index } = makeIndex([root])
    await index.ready
    const before = fake.bodies.length
    const hits = await index.search('zebra secret draft env pem', 20)
    expect(fake.bodies.length).toBe(before + 1)
    const paths = hits.map((h) => h.path).sort()
    const rootName = path.basename(fs.realpathSync(root))
    expect(paths).toEqual([`${rootName}/cert.pem.md`, `${rootName}/notes.md`])
    for (const input of embeddedInputs()) {
      expect(input).not.toContain('API_KEY')
      expect(input).not.toContain('BEGIN zebra')
      expect(input).not.toContain('zebra draft')
    }
  })

  test('binary and oversized files are skipped', async () => {
    const root = tmp()
    writeFiles(root, { 'ok.md': 'fine' })
    fs.writeFileSync(path.join(root, 'bin.txt'), Buffer.from([0x61, 0x00, 0x62]))
    fs.writeFileSync(path.join(root, 'big.txt'), 'y'.repeat(1024 * 1024 + 1))
    const { index } = makeIndex([root])
    await index.ready
    expect(index.stats().files).toBe(1)
  })
})

describe('store', () => {
  test('keyword search does not throw on FTS syntax in user input', () => {
    const store = openStore(':memory:')
    const vector = new Float32Array([1, 0, 0])
    store.upsertFile({ path: 'r/a.md', hash: 'h', chunks: [{ startLine: 1, endLine: 1, title: 'a', text: 'near the auth-token flow', vector }] })
    for (const q of ['"unterminated', 'auth*', 'NEAR(a b)', '(auth OR', 'auth-token', '-auth', 'title:auth', '"', '***', '', 'AND OR NOT', '^auth', '{a b}: c']) {
      expect(() => store.keywordSearch(q, 5), q).not.toThrow()
    }
    expect(store.keywordSearch('auth-token "flow"', 5).length).toBe(1)
    expect(store.keywordSearch('NEAR', 5).length).toBe(1)
    store.close()
  })

  test('upsertFile replaces chunks; removeFile deletes them from both indexes', () => {
    const store = openStore(':memory:')
    const v = new Float32Array([3, 4])
    store.upsertFile({ path: 'r/a.md', hash: '1', chunks: [{ startLine: 1, endLine: 1, title: 't', text: 'apple', vector: v }, { startLine: 2, endLine: 2, title: 't', text: 'pear', vector: v }] })
    store.upsertFile({ path: 'r/a.md', hash: '2', chunks: [{ startLine: 1, endLine: 1, title: 't', text: 'banana', vector: v }] })
    expect(store.stats()).toEqual({ files: 1, chunks: 1 })
    expect(store.fileHash('r/a.md')).toBe('2')
    expect(store.keywordSearch('apple', 5)).toEqual([])
    const [top] = store.vectorSearch(new Float32Array([6, 8]), 5)
    expect(top.score).toBeCloseTo(1, 5)
    store.removeFile('r/a.md')
    expect(store.stats()).toEqual({ files: 0, chunks: 0 })
    expect(store.keywordSearch('banana', 5)).toEqual([])
    expect(store.listFiles()).toEqual([])
    store.close()
  })
})

describe('embedder', () => {
  test('batches, keeps order, and reports errors without the input text', async () => {
    const before = fake.bodies.length
    const embedder = createEmbedder({ url: fake.url, model: EMBED_MODEL, batchSize: 2 })
    const vectors = await embedder.embed(['alpha', 'beta', 'gamma'])
    expect(vectors.length).toBe(3)
    expect(fake.bodies.length - before).toBe(2)
    const [again] = await embedder.embed(['gamma'])
    expect(Array.from(vectors[2])).toEqual(Array.from(again))

    const broken = createEmbedder({ url: fake.url + '/nope', model: 'm1' })
    const err = await broken.embed(['private words']).catch((e) => e)
    expect(err.message).toContain(`${fake.url}/nope/v1/embeddings`)
    expect(err.message).toContain('m1')
    expect(err.message).not.toContain('private words')
  })
})

describe('indexer', () => {
  test('hybrid search ranks the file that shares words with the query first', async () => {
    const root = tmp()
    writeFiles(root, {
      'auth.md': '# Authentication\nTokens rotate every 24 hours. The refresh token flow uses OAuth.',
      'deploy.md': '# Deploy\nWe deploy with a blue green rollout on Fridays.',
      'cooking.txt': 'Braise the duck slowly with ginger and star anise.'
    })
    const { index } = makeIndex([root])
    await index.ready
    const hits = await index.search('how does the refresh token rotate', 3)
    const rootName = path.basename(fs.realpathSync(root))
    expect(hits[0].path).toBe(`${rootName}/auth.md`)
    expect(hits[0]).toMatchObject({ startLine: 1, endLine: 2, title: 'Authentication' })
    expect(hits[0].score).toBeGreaterThan(0)

    const cooking = (await index.search('duck ginger', 1))[0]
    expect(cooking.title).toBe('cooking.txt')
  })

  test('hybridSearch caps text and returns at most k hits', async () => {
    const store = openStore(':memory:')
    const embedder = createEmbedder({ url: fake.url, model: EMBED_MODEL })
    const text = 'kiwi '.repeat(1000)
    const [vector] = await embedder.embed([text])
    for (let i = 0; i < 5; i++) store.upsertFile({ path: `r/${i}.md`, hash: String(i), chunks: [{ startLine: 1, endLine: 1, title: 't', text, vector }] })
    const hits = await hybridSearch(store, embedder, 'kiwi', 3)
    expect(hits.length).toBe(3)
    for (const h of hits) expect(h.text.length).toBe(2000)
    store.close()
  })

  test('unchanged files are not re-embedded on restart', async () => {
    const root = tmp()
    writeFiles(root, { 'a.md': 'apples are red', 'b.md': 'bananas are yellow' })
    const dbFile = path.join(tmp(), 'index.db')
    const embedder = createEmbedder({ url: fake.url, model: EMBED_MODEL })
    const log = () => {}

    const first = createIndex({ dirs: [root], dbFile, embedder, log })
    await first.ready
    await first.close()

    writeFiles(root, { 'b.md': 'bananas are green' })
    const before = embeddedInputs().length
    const second = createIndex({ dirs: [root], dbFile, embedder, log })
    indexes.push(second)
    await second.ready
    const inputs = embeddedInputs().slice(before)
    expect(inputs.length).toBe(1)
    expect(inputs[0]).toContain('bananas are green')
    expect(second.stats()).toMatchObject({ files: 2, chunks: 2 })
  })

  test('removes files deleted while the index was not running', async () => {
    const root = tmp()
    writeFiles(root, { 'a.md': 'apples', 'b.md': 'bananas' })
    const dbFile = path.join(tmp(), 'index.db')
    const embedder = createEmbedder({ url: fake.url, model: EMBED_MODEL })
    const first = createIndex({ dirs: [root], dbFile, embedder, log: () => {} })
    await first.ready
    await first.close()
    fs.rmSync(path.join(root, 'b.md'))
    const second = createIndex({ dirs: [root], dbFile, embedder, log: () => {} })
    indexes.push(second)
    await second.ready
    expect(second.stats().files).toBe(1)
  })

  test('watch re-indexes changed files and drops deleted ones', async () => {
    const root = tmp()
    writeFiles(root, { 'a.md': 'apples are red', 'sub/b.md': 'bananas are yellow' })
    const { index, events } = makeIndex([root], { watch: true })
    await index.ready
    const rootName = path.basename(fs.realpathSync(root))

    writeFiles(root, { 'a.md': 'apples are purple mangosteen' })
    await waitFor(async () => (await index.search('mangosteen', 1))[0]?.text.includes('mangosteen') ?? false)

    writeFiles(root, { 'sub/c.md': 'cherries are dark' })
    await waitFor(() => index.stats().files === 3)

    fs.rmSync(path.join(root, 'sub/b.md'))
    await waitFor(() => index.stats().files === 2)
    const hits = await index.search('bananas yellow', 10)
    expect(hits.map((h) => h.path)).not.toContain(`${rootName}/sub/b.md`)

    fs.rmSync(path.join(root, 'sub'), { recursive: true })
    await waitFor(() => index.stats().files === 1)
    expect(events.some((e) => e.event === 'index-remove' && e.fields.path === `${rootName}/sub/c.md`)).toBe(true)
  })

  test('watch handles renaming and removing a folder with several files', async () => {
    const root = tmp()
    writeFiles(root, { 'keep.md': 'kept', 'd/x.md': 'xylophone', 'd/y.md': 'yak', 'd/e/z.md': 'zebra' })
    const { index } = makeIndex([root], { watch: true })
    await index.ready
    const rootName = path.basename(fs.realpathSync(root))
    const paths = async () => (await index.search('xylophone yak zebra kept', 10)).map((h) => h.path).sort()

    fs.renameSync(path.join(root, 'd'), path.join(root, 'd2'))
    await waitFor(async () => (await paths()).join() === ['d2/e/z.md', 'd2/x.md', 'd2/y.md', 'keep.md'].map((p) => `${rootName}/${p}`).join())
    expect(index.stats().files).toBe(4)

    fs.rmSync(path.join(root, 'd2'), { recursive: true })
    await waitFor(() => index.stats().files === 1)
    expect(await paths()).toEqual([`${rootName}/keep.md`])
  })

  test('vectors survive reopening the store and leave with their file', () => {
    const file = path.join(tmp(), 'index.db')
    const vector = new Float32Array([1, 0, 0])
    let store = openStore(file)
    store.upsertFile({ path: 'n/a.md', hash: 'h', chunks: [{ startLine: 1, endLine: 1, title: 'a', text: 'a', vector }] })
    store.upsertFile({ path: 'n/b.md', hash: 'h', chunks: [{ startLine: 1, endLine: 1, title: 'b', text: 'b', vector: new Float32Array([0, 1, 0]) }] })
    store.close()
    store = openStore(file)
    const [top] = store.vectorSearch(vector, 1)
    expect(store.getChunks([top.id])[0].path).toBe('n/a.md')
    store.removeFile('n/a.md')
    expect(store.vectorSearch(vector, 5).map((r) => store.getChunks([r.id])[0].path)).toEqual(['n/b.md'])
    store.upsertFile({ path: 'n/b.md', hash: 'h2', chunks: [{ startLine: 1, endLine: 1, title: 'b', text: 'b', vector }] })
    expect(store.vectorSearch(vector, 5)).toHaveLength(1)
    store.close()
  })

  test('a symlink that points outside the shared root is not indexed', async () => {
    const outside = tmp()
    writeFiles(outside, { 'secret.md': 'quokka outside secret', 'dir/inner.md': 'quokka in linked dir' })
    const root = tmp()
    writeFiles(root, { 'inside.md': 'quokka inside', 'target.md': 'wombat target' })
    fs.symlinkSync(path.join(outside, 'secret.md'), path.join(root, 'link.md'))
    fs.symlinkSync(path.join(outside, 'dir'), path.join(root, 'linkdir'))
    fs.symlinkSync(path.join(root, 'target.md'), path.join(root, 'internal-link.md'))
    const before = embeddedInputs().length

    const { index, events } = makeIndex([root])
    await index.ready
    const inputs = embeddedInputs().slice(before)
    expect(inputs.some((t) => t.includes('outside secret'))).toBe(false)
    expect(inputs.some((t) => t.includes('linked dir'))).toBe(false)
    const rootName = path.basename(fs.realpathSync(root))
    const paths = (await index.search('quokka wombat', 10)).map((h) => h.path).sort()
    expect(paths).toEqual([`${rootName}/inside.md`, `${rootName}/internal-link.md`, `${rootName}/target.md`])
    expect(events).toContainEqual({ event: 'index-skip', fields: { path: `${rootName}/link.md`, reason: 'outside-root' } })
  })

  test('paths are root-relative, roots get unique names, and logs carry no absolute paths or content', async () => {
    const a = path.join(tmp(), 'notes')
    const b = path.join(tmp(), 'notes')
    writeFiles(a, { 'specs/auth.md': '# Auth\nplatypus login' })
    writeFiles(b, { 'auth.md': '# Auth\nplatypus logout' })
    const { index, events } = makeIndex([a, b])
    await index.ready
    expect(index.stats().roots).toEqual(['notes', 'notes-2'])
    const hits = await index.search('platypus', 10)
    expect(hits.map((h) => h.path).sort()).toEqual(['notes-2/auth.md', 'notes/specs/auth.md'])
    for (const h of hits) expect(path.isAbsolute(h.path)).toBe(false)

    const logged = JSON.stringify(events)
    expect(logged).not.toContain(os.tmpdir())
    expect(logged).not.toContain('platypus')
    expect(events).toContainEqual({ event: 'index-file', fields: { path: 'notes/specs/auth.md', chunks: 1 } })
    const ready = events.find((e) => e.event === 'index-ready')
    expect(ready?.fields).toMatchObject({ files: 2, chunks: 2 })
    expect(typeof ready?.fields.ms).toBe('number')
  })

  test('changing the embedding model re-embeds everything', async () => {
    const root = tmp()
    writeFiles(root, { 'a.md': 'apples' })
    const dbFile = path.join(tmp(), 'index.db')
    const first = createIndex({ dirs: [root], dbFile, embedder: createEmbedder({ url: fake.url, model: 'm-a' }), log: () => {} })
    await first.ready
    await first.close()
    const before = embeddedInputs().length
    const second = createIndex({ dirs: [root], dbFile, embedder: createEmbedder({ url: fake.url, model: 'm-b' }), log: () => {} })
    indexes.push(second)
    await second.ready
    expect(embeddedInputs().length - before).toBe(1)
  })
})
