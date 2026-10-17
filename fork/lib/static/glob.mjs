// Path matching for the static gate: the policy expresses inspection scopes and
// build-output roots as repository-relative globs so a reader can audit exactly
// which paths a rule covers without reading gate code.

const REGEXP_SPECIALS = new Set(['.', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\'])

/**
 * Translate one glob into an anchored matcher over repository-relative POSIX paths.
 * A double star spans any depth, and a trailing double star followed by a slash
 * also matches zero directories; a single star spans one path segment, and `?`
 * matches one character.
 * @param {string} glob Glob as written in fork/policy/rules-static.json.
 * @returns {RegExp} Matcher anchored at both ends of the relative path.
 */
export function globToRegExp(glob) {
  let source = ''
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]
    if (char === '*') {
      if (glob[index + 1] !== '*') {
        source += '[^/]*'
        continue
      }
      if (glob[index + 2] === '/') {
        source += '(?:[^/]+/)*'
        index += 2
      } else {
        source += '.*'
        index += 1
      }
      continue
    }
    if (char === '?') {
      source += '[^/]'
      continue
    }
    source += REGEXP_SPECIALS.has(char) ? `\\${char}` : char
  }
  return new RegExp(`^${source}$`)
}

/**
 * Whether one repository-relative path matches any of the globs.
 * @param {string} path Repository-relative POSIX path.
 * @param {readonly RegExp[]} matchers Compiled globs.
 * @returns {boolean} True when at least one matcher accepts the path.
 */
export function matchesAny(path, matchers) {
  return matchers.some(matcher => matcher.test(path))
}
