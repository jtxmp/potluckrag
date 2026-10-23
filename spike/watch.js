// Spike: does fs.watch(dir, { recursive: true }) on Linux report
// files created inside a newly created subdirectory, renames and deletions?
//
// Usage: node --no-warnings spike/watch.js
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PAUSE_MS = 300
const REPEATS = 20

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'potluckrag-watch-'))
const p = (...xs) => path.join(base, ...xs)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** @type {{ step: string, type: string, file: string }[]} */
const events = []
let step = 'setup'
const watcher = fs.watch(base, { recursive: true }, (type, file) => {
  events.push({ step, type, file: String(file) })
})
watcher.on('error', (err) => { events.push({ step, type: 'error', file: String(err) }) })

/**
 * Runs one action, waits, and reports which events arrived for it.
 * @param {string} name
 * @param {string[]} expect  relative paths that should appear in some event
 * @param {() => void} fn
 */
async function run (name, expect, fn) {
  step = name
  fn()
  await sleep(PAUSE_MS)
  const got = events.filter((e) => e.step === name)
  const seen = expect.map((f) => ({ file: f, reported: got.some((e) => e.file === f) }))
  console.log(JSON.stringify({ step: name, events: got.map((e) => `${e.type}:${e.file}`), expect: seen }))
  return seen.every((s) => s.reported)
}

await sleep(PAUSE_MS) // let the watcher attach

await run('create top-level file', ['a.txt'], () => fs.writeFileSync(p('a.txt'), 'a'))
await run('modify file', ['a.txt'], () => fs.appendFileSync(p('a.txt'), 'more'))
await run('mkdir + write file immediately', ['sub', 'sub/b.txt'], () => {
  fs.mkdirSync(p('sub'))
  fs.writeFileSync(p('sub', 'b.txt'), 'b')
})
await run('mkdir, then (after pause) write file', ['sub2'], () => fs.mkdirSync(p('sub2')))
await run('  write file in sub2', ['sub2/c.txt'], () => fs.writeFileSync(p('sub2', 'c.txt'), 'c'))
await run('mkdir -p 3 levels + write file immediately', ['deep/x/y/d.txt'], () => {
  fs.mkdirSync(p('deep', 'x', 'y'), { recursive: true })
  fs.writeFileSync(p('deep', 'x', 'y', 'd.txt'), 'd')
})
await run('write file in deep/x/y after pause', ['deep/x/y/d2.txt'], () => fs.writeFileSync(p('deep', 'x', 'y', 'd2.txt'), 'd'))
await run('rename top-level file', ['a.txt', 'a2.txt'], () => fs.renameSync(p('a.txt'), p('a2.txt')))
await run('rename file in subdir', ['sub/b.txt', 'sub/b2.txt'], () => fs.renameSync(p('sub', 'b.txt'), p('sub', 'b2.txt')))
await run('rename directory sub2 -> sub3', ['sub2', 'sub3'], () => fs.renameSync(p('sub2'), p('sub3')))
await run('  write file in renamed dir sub3', ['sub3/e.txt'], () => fs.writeFileSync(p('sub3', 'e.txt'), 'e'))
await run('move file across dirs sub3/c.txt -> sub/c.txt', ['sub3/c.txt', 'sub/c.txt'], () => fs.renameSync(p('sub3', 'c.txt'), p('sub', 'c.txt')))
await run('delete top-level file', ['a2.txt'], () => fs.unlinkSync(p('a2.txt')))
await run('delete file in subdir', ['sub/b2.txt'], () => fs.unlinkSync(p('sub', 'b2.txt')))
await run('rm -r deep (contains d.txt, d2.txt)', ['deep/x/y/d.txt', 'deep/x/y/d2.txt', 'deep'], () => fs.rmSync(p('deep'), { recursive: true }))
await run('recreate deep/x after rm, write file after pause', ['deep'], () => fs.mkdirSync(p('deep', 'x'), { recursive: true }))
await run('  write deep/x/f.txt', ['deep/x/f.txt'], () => fs.writeFileSync(p('deep', 'x', 'f.txt'), 'f'))

// race check: how often is a file written right after mkdir missed?
let missed = 0
for (let i = 0; i < REPEATS; i++) {
  const name = `race-${i}`
  step = name
  fs.mkdirSync(p(name))
  fs.writeFileSync(p(name, 'r.txt'), 'r')
  await sleep(PAUSE_MS)
  if (!events.some((e) => e.step === name && e.file === `${name}/r.txt`)) missed++
}
console.log(JSON.stringify({ step: 'race: mkdir + immediate write', repeats: REPEATS, fileEventsMissed: missed }))

watcher.close()
fs.rmSync(base, { recursive: true, force: true })
console.log(JSON.stringify({ node: process.version, platform: process.platform, kernel: os.release() }))
