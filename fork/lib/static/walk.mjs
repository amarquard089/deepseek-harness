// Deterministic filesystem traversal and text reading for the static gate.
// The walker never follows symlinks, sorts every directory, and reports POSIX
// paths relative to the scanned root so two runs on the same tree agree.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

/** Byte value that marks a file as binary rather than text. */
const NUL = 0

/**
 * Convert an absolute path to the POSIX form used throughout the policy.
 * @param {string} absolute Absolute path.
 * @param {string} root Scan root.
 * @returns {string} Repository-relative POSIX path.
 */
export function toPosixRelative(absolute, root) {
  return relative(root, absolute).split(sep).join('/')
}

/**
 * List every regular file under a root, in a stable order.
 * @param {string} root Absolute directory to scan.
 * @param {object} options Traversal options.
 * @param {readonly string[]} options.excludeDirectories Directory names or
 *   root-relative directory paths to skip, such as `.git` or `fork/reports`.
 * @returns {string[]} Repository-relative POSIX paths, sorted.
 */
export function walkFiles(root, options) {
  const excludedNames = new Set()
  const excludedPaths = new Set()
  for (const entry of options.excludeDirectories) {
    if (entry.includes('/')) excludedPaths.add(entry)
    else excludedNames.add(entry)
  }
  const files = []
  const visit = (absoluteDirectory) => {
    let entries
    try {
      entries = readdirSync(absoluteDirectory, { withFileTypes: true })
    } catch {
      // An unreadable directory cannot hide a stripped surface from the other
      // checks; report nothing here and let the caller's coverage notes stand.
      return
    }
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const absolute = join(absoluteDirectory, entry.name)
      if (entry.isDirectory()) {
        if (excludedNames.has(entry.name)) continue
        if (excludedPaths.has(toPosixRelative(absolute, root))) continue
        visit(absolute)
        continue
      }
      if (entry.isFile()) files.push(toPosixRelative(absolute, root))
    }
  }
  visit(root)
  return files
}

/**
 * Read one file as text, refusing only files the policy excludes from scanning.
 * A file that contains a NUL byte is still decoded and scanned: allowlisted
 * extensions are text by construction, and an embedded U+0000 must not hide a
 * marker. The flag lets the caller report the lossy decode.
 * @param {string} root Absolute scan root.
 * @param {string} relativePath Repository-relative POSIX path.
 * @param {number} maxBytes Largest file this scan reads.
 * @returns {{text: string, size: number, hasNul: boolean} | {skipped: string, size: number}}
 *   Text, or why the file was not scanned.
 */
export function readTextFile(root, relativePath, maxBytes) {
  const absolute = join(root, relativePath)
  let stats
  try {
    stats = statSync(absolute)
  } catch {
    return { skipped: 'unreadable', size: 0 }
  }
  if (!stats.isFile()) return { skipped: 'not-a-file', size: stats.size }
  if (stats.size > maxBytes) return { skipped: 'too-large', size: stats.size }
  const buffer = readFileSync(absolute)
  return { text: buffer.toString('utf8'), size: stats.size, hasNul: buffer.includes(NUL) }
}

/**
 * One-based line number of a character offset.
 * @param {string} text Full file text.
 * @param {number} offset Character offset inside the text.
 * @returns {number} One-based line number.
 */
export function lineNumberAt(text, offset) {
  let line = 1
  for (let index = 0; index < offset; index += 1) {
    if (text.charCodeAt(index) === 10) line += 1
  }
  return line
}

/**
 * File extension used for the policy's extension filters, with compressed
 * TypeScript declaration files treated as TypeScript.
 * @param {string} relativePath Repository-relative POSIX path.
 * @returns {string} Lowercase extension including the dot, or an empty string.
 */
export function extensionOf(relativePath) {
  const name = relativePath.slice(relativePath.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot).toLowerCase()
}

/**
 * Async twin of {@link readTextFile} for the bulk scans. The gate reads tens of
 * thousands of files, so the scans overlap their I/O instead of serializing it.
 * @param {string} root Absolute scan root.
 * @param {string} relativePath Repository-relative POSIX path.
 * @param {number} maxBytes Largest file this scan reads.
 * @returns {Promise<{text: string, size: number, hasNul: boolean} | {skipped: string, size: number}>}
 *   Text, or why the file was not scanned.
 */
export async function readTextFileAsync(root, relativePath, maxBytes) {
  const absolute = join(root, relativePath)
  let stats
  try {
    stats = await stat(absolute)
  } catch {
    return { skipped: 'unreadable', size: 0 }
  }
  if (!stats.isFile()) return { skipped: 'not-a-file', size: stats.size }
  if (stats.size > maxBytes) return { skipped: 'too-large', size: stats.size }
  const buffer = await readFile(absolute)
  return { text: buffer.toString('utf8'), size: stats.size, hasNul: buffer.includes(NUL) }
}

/**
 * Search one file for literal byte sequences without decoding it.
 * @param {string} root Absolute scan root.
 * @param {string} relativePath Repository-relative POSIX path.
 * @param {readonly string[]} needles Literal byte sequences to look for.
 * @param {number} maxBytes Largest file this scan reads.
 * @returns {Promise<{matches: {needle: string, line: number}[], size: number} | {skipped: string, size: number}>}
 *   Marker locations, or why the file was not scanned.
 */
export async function scanFileForNeedlesAsync(root, relativePath, needles, maxBytes) {
  const absolute = join(root, relativePath)
  let stats
  try {
    stats = await stat(absolute)
  } catch {
    return { skipped: 'unreadable', size: 0 }
  }
  if (!stats.isFile()) return { skipped: 'not-a-file', size: stats.size }
  if (stats.size > maxBytes) return { skipped: 'too-large', size: stats.size }
  const buffer = await readFile(absolute)
  const present = needles.filter(needle => buffer.includes(needle))
  if (present.length === 0) return { matches: [], size: stats.size }
  const text = buffer.toString('utf8')
  return {
    matches: present.map(needle => ({ needle, line: lineNumberAt(text, Math.max(0, text.indexOf(needle))) })),
    size: stats.size,
  }
}

/**
 * Every match of one regular expression, as offset and text.
 * @param {string} text Full file text.
 * @param {RegExp} pattern Matcher; the caller supplies the `g` flag.
 * @returns {{offset: number, text: string}[]} Matches in document order.
 */
export function collectMatches(text, pattern) {
  const matches = []
  pattern.lastIndex = 0
  let match = pattern.exec(text)
  while (match !== null) {
    matches.push({ offset: match.index, text: match[0] })
    if (match[0].length === 0) pattern.lastIndex += 1
    match = pattern.exec(text)
  }
  return matches
}
