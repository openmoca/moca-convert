/**
 * Deterministic, filesystem-safe, ASCII-only slug from a title string.
 * NFKD-normalizing first turns an accented character into a base letter
 * plus a separate combining-mark codepoint (e.g. "é" -> "e" + U+0301), so
 * simply dropping every non-ASCII codepoint afterward strips diacritics
 * while keeping the underlying letters.
 * @param {string} text
 * @returns {string}
 */
export function slugify(text) {
  return (
    text
      .normalize('NFKD')
      .replace(/[^\x00-\x7F]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'untitled'
  );
}
