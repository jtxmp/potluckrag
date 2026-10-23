// @ts-check

/**
 * @typedef {{ startLine: number, endLine: number, title: string, text: string }} Chunk
 * @typedef {{ start: number, end: number, title: string, heading: boolean }} Unit
 */

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t#]*$/
const FENCE = /^ {0,3}(`{3,}|~{3,})/

/**
 * Splits Markdown or plain text into chunks of at most `maxChars`
 * characters. A heading starts a new chunk; paragraphs (blank-line separated)
 * are packed together until the next one would not fit. Line numbers are
 * 1-based and inclusive. `title` is the nearest heading above, or ''.
 *
 * `headings: false` treats `#` lines as text, for code files where `#` starts
 * a comment.
 *
 * @param {string} text
 * @param {{ maxChars?: number, headings?: boolean }} [opts]
 * @returns {Chunk[]}
 */
export function chunkText (text, { maxChars = 1600, headings = true } = {}) {
  if (!Number.isInteger(maxChars) || maxChars < 1) throw new Error('chunkText: maxChars must be a positive integer')
  const lines = text.split(/\r?\n/)

  /** @type {Unit[]} */
  const units = []
  let title = ''
  let fence = ''
  /** @type {Unit | null} */
  let para = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineNo = i + 1
    const fenceMatch = headings ? FENCE.exec(line) : null
    if (fenceMatch) {
      const marker = fenceMatch[1]
      if (!fence) fence = marker
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = ''
    }
    const heading = headings && !fence && !fenceMatch ? HEADING.exec(line) : null

    if (heading) {
      if (para) units.push(para)
      para = null
      title = heading[2].trim()
      units.push({ start: lineNo, end: lineNo, title, heading: true })
      continue
    }
    // Blank lines inside a code fence don't end the paragraph, so a code
    // block stays together when it fits.
    if (line.trim() === '' && !fence) {
      if (para) units.push(para)
      para = null
      continue
    }
    if (para) para.end = lineNo
    else para = { start: lineNo, end: lineNo, title, heading: false }
  }
  if (para) units.push(para)

  const slice = (/** @type {number} */ start, /** @type {number} */ end) => lines.slice(start - 1, end).join('\n')

  /** @type {Chunk[]} */
  const chunks = []
  /** @type {Unit | null} */
  let current = null

  const flush = () => {
    if (current) chunks.push({ startLine: current.start, endLine: current.end, title: current.title, text: slice(current.start, current.end) })
    current = null
  }

  for (const unit of units) {
    if (unit.heading) flush()
    for (const piece of splitUnit(unit, lines, maxChars)) {
      if (current && slice(current.start, piece.end).length <= maxChars) {
        current.end = piece.end
        continue
      }
      flush()
      if (piece.text !== undefined) {
        // Part of one overlong line: emit it as is.
        chunks.push({ startLine: piece.start, endLine: piece.end, title: piece.title, text: piece.text })
      } else {
        current = { start: piece.start, end: piece.end, title: piece.title, heading: false }
      }
    }
  }
  flush()
  return chunks
}

/**
 * Breaks a unit that is too long into line runs, and a line that is too long
 * into character slices (carried in `text`).
 *
 * @param {Unit} unit
 * @param {string[]} lines
 * @param {number} maxChars
 * @returns {(Unit & { text?: string })[]}
 */
function splitUnit (unit, lines, maxChars) {
  const whole = lines.slice(unit.start - 1, unit.end).join('\n')
  if (whole.length <= maxChars) return [unit]

  /** @type {(Unit & { text?: string })[]} */
  const pieces = []
  /** @type {Unit | null} */
  let run = null
  let runLength = 0
  for (let lineNo = unit.start; lineNo <= unit.end; lineNo++) {
    const line = lines[lineNo - 1]
    if (line.length > maxChars) {
      if (run) pieces.push(run)
      run = null
      for (let at = 0; at < line.length; at += maxChars) {
        pieces.push({ start: lineNo, end: lineNo, title: unit.title, heading: false, text: line.slice(at, at + maxChars) })
      }
      continue
    }
    if (run && runLength + 1 + line.length <= maxChars) {
      run.end = lineNo
      runLength += 1 + line.length
      continue
    }
    if (run) pieces.push(run)
    run = { start: lineNo, end: lineNo, title: unit.title, heading: false }
    runLength = line.length
  }
  if (run) pieces.push(run)
  return pieces
}
