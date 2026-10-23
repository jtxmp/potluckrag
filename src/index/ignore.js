// @ts-check
import fs from 'node:fs'
import path from 'node:path'

export const IGNORE_FILE = '.potluckragignore'
export const MAX_FILE_BYTES = 1024 * 1024

// Directories that hold dependencies, build output or VCS data: never worth
// sharing and often large.
const DENY_DIRS = new Set([
  'node_modules', 'bower_components', 'vendor', 'dist', 'build', 'target',
  '__pycache__', 'coverage', 'venv', 'site-packages'
])

// File names that commonly hold secrets or databases. Matched case-insensitively
// against the base name. Hidden files and directories (.env, .git, .ssh, .aws)
// are denied separately.
const DENY_FILES = [
  /\.(pem|key|p12|pfx|jks|keystore|kdbx|asc|gpg|crt|cer|der|secret)$/,
  /^id_(rsa|dsa|ecdsa|ed25519)/,
  /^(credentials|serviceaccountkey|token|auth|client_secret.*)\.json$/,
  /^secrets?\./,
  /^config\.local\./,
  /\.(sqlite|sqlite3|db|db3)$/,
  /\.env$/
]

const INDEXABLE = new Set([
  '.md', '.markdown', '.txt', '.rst', '.adoc',
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.rs', '.go', '.java', '.kt',
  '.c', '.h', '.cpp', '.hpp', '.cc', '.cs', '.rb', '.php', '.swift', '.sh', '.bash', '.zsh',
  '.yaml', '.yml', '.toml', '.json', '.html', '.htm', '.css', '.scss', '.sql', '.dart',
  '.ini', '.cfg', '.xml', '.csv', '.tex', '.org'
])

const MARKDOWN = new Set(['.md', '.markdown', '.txt', '.rst', '.adoc', '.org', '.tex'])

/** @type {Map<string, { regex: RegExp, anchored: boolean, dirOnly: boolean } | null>} */
const compiled = new Map()

/**
 * True for paths that must never be indexed. `relPath` is relative to the
 * shared root, with forward slashes. `extraPatterns` are lines from the
 * root's `.potluckragignore`.
 *
 * @param {string} relPath
 * @param {string[]} [extraPatterns]
 */
export function isIgnored (relPath, extraPatterns = []) {
  const parts = relPath.split('/').filter((p) => p !== '' && p !== '.')
  if (parts.length === 0) return false
  if (parts.includes('..')) return true

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i].toLowerCase()
    if (part.startsWith('.')) return true
    if (i < parts.length - 1 && DENY_DIRS.has(part)) return true
  }
  const base = parts[parts.length - 1].toLowerCase()
  if (DENY_FILES.some((re) => re.test(base))) return true

  for (const line of extraPatterns) {
    const rule = compile(line)
    if (rule && matches(rule, parts)) return true
  }
  return false
}

/**
 * True for files whose extension marks them as text worth indexing.
 *
 * @param {string} relPath
 */
export function isIndexable (relPath) {
  return INDEXABLE.has(path.posix.extname(relPath).toLowerCase())
}

/**
 * True for prose formats where `#` lines are headings rather than comments.
 *
 * @param {string} relPath
 */
export function isProse (relPath) {
  return MARKDOWN.has(path.posix.extname(relPath).toLowerCase())
}

/**
 * Reads `.potluckragignore` from a shared root. Missing file means no extra
 * patterns.
 *
 * @param {string} root absolute path of the shared folder
 * @returns {string[]}
 */
export function readIgnoreFile (root) {
  let text
  try {
    text = fs.readFileSync(path.join(root, IGNORE_FILE), 'utf8')
  } catch {
    return []
  }
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'))
}

/**
 * Gitignore-style subset: `*` within a segment, `**` across segments, `?`,
 * a trailing `/` for directories only, and a `/` elsewhere anchors the
 * pattern at the root. Negation (`!`) is not supported and such lines are
 * skipped, since un-ignoring could re-expose a denied file.
 *
 * @param {string} line
 */
function compile (line) {
  if (compiled.has(line)) return compiled.get(line) ?? null
  let pattern = line.trim()
  let rule = null
  if (pattern !== '' && !pattern.startsWith('#') && !pattern.startsWith('!')) {
    const dirOnly = pattern.endsWith('/')
    pattern = pattern.replace(/\/+$/, '')
    const anchored = pattern.includes('/')
    pattern = pattern.replace(/^\/+/, '')
    if (pattern !== '') rule = { regex: new RegExp('^' + globToRegex(pattern) + '$', 'i'), anchored, dirOnly }
  }
  compiled.set(line, rule)
  return rule
}

/** @param {string} glob */
function globToRegex (glob) {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        out += '(?:.*/)?'
        i += 2
      } else {
        out += '.*'
        i += 1
      }
    } else if (c === '*') {
      out += '[^/]*'
    } else if (c === '?') {
      out += '[^/]'
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return out
}

/**
 * @param {{ regex: RegExp, anchored: boolean, dirOnly: boolean }} rule
 * @param {string[]} parts
 */
function matches (rule, parts) {
  // A directory rule matches any proper prefix of the path; a plain rule
  // matches the path itself or any prefix (everything under a match).
  const last = rule.dirOnly ? parts.length - 1 : parts.length
  for (let n = 1; n <= last; n++) {
    const candidate = rule.anchored ? parts.slice(0, n).join('/') : parts[n - 1]
    if (rule.regex.test(candidate)) return true
  }
  return false
}
