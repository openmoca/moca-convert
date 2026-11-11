// Minimal glob-to-RegExp for matching already-known relative paths in
// memory (e.g. --exclude patterns against a vault's note list), as opposed
// to expanding a glob against the filesystem (see lib/adapters/markdown.js,
// which uses fs.globSync for that). Same small hand-rolled approach as
// moca-lint's lib/pack.js --exclude handling, but using a NUL-byte
// placeholder (rather than a space) for "**" so a pattern that legitimately
// contains a literal space isn't mis-expanded.
const DOUBLE_STAR_PLACEHOLDER = String.fromCharCode(0);

/**
 * @param {string} pattern
 * @returns {RegExp}
 */
export function globToRegExp(pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .split('**')
    .join(DOUBLE_STAR_PLACEHOLDER)
    .replace(/\*/g, '[^/]*')
    .split(DOUBLE_STAR_PLACEHOLDER)
    .join('.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

/**
 * @param {string} relPath
 * @param {string[]} patterns
 * @returns {boolean}
 */
export function matchesAny(relPath, patterns) {
  return patterns.some((pattern) => globToRegExp(pattern).test(relPath));
}
