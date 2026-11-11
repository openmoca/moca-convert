// Shared read helper for adapters that turn an existing Markdown file into a
// content node. OKF requires every concept document to carry frontmatter with
// a non-empty `type`; a file that already has one is kept byte for byte, and
// one that lacks it gets `type` (and a `title` when it has none) added at the
// top of its frontmatter, leaving the rest untouched.
import { readFileSync } from 'node:fs';
import { splitFrontmatter, prependFrontmatterKeys } from '@openmoca/moca-core';

/**
 * @param {string} absPath
 * @returns {{ data: object, content: string, raw: string }}
 */
export function readContentFile(absPath) {
  const raw = readFileSync(absPath, 'utf8').replace(/\r\n/g, '\n');
  const split = splitFrontmatter(raw);
  const data = split.present && !split.error ? split.data : {};
  return { data, content: split.body, raw };
}

/**
 * @param {string} raw  full file text
 * @param {object} data  parsed frontmatter ({} when none)
 * @param {{ type: string, title?: string }} defaults
 * @param {object} [extra]  further keys to add after type and title, such as a `moca` block
 * @returns {string}
 */
export function ensureOkf(raw, data, { type, title }, extra = {}) {
  const additions = {};
  if (typeof data.type !== 'string' || data.type.trim() === '') additions.type = type;
  if (title && typeof data.title !== 'string') additions.title = title;
  Object.assign(additions, extra);
  return Object.keys(additions).length === 0 ? raw : prependFrontmatterKeys(raw, additions);
}

const H1 = /^#\s+(.+)$/m;

/** Title from frontmatter, first H1, or file name, in that order. */
export function deriveTitle(data, content, fallback) {
  if (typeof data.title === 'string' && data.title.trim()) return data.title.trim();
  const heading = content.match(H1);
  return heading ? heading[1].trim() : fallback;
}
