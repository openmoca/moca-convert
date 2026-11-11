// `obsidian` adapter: an Obsidian vault directory becomes one content node
// per note, preserving the vault's folder structure under content/ and
// rewriting [[wikilink]] syntax to relative Markdown links.
import { existsSync, statSync } from 'node:fs';
import { basename, join, posix } from 'node:path';
import { walkFiles } from '../walk.js';
import { readContentFile, ensureOkf, deriveTitle } from '../frontmatter.js';
import { buildManifest } from '../manifest.js';
import { matchesAny } from '../glob.js';
import { slugify } from '../slug.js';
import { UsageError } from '../target.js';

export const name = 'obsidian';
export const DEFAULT_TYPE = 'Note';

const WIKILINK = /(!?)\[\[([^\]|#]+)(#[^\]|]+)?(?:\|([^\]]+))?\]\]/g;

/**
 * @param {string} inputPath
 * @returns {boolean} true if `inputPath` is a directory containing a
 *   top-level `.obsidian/` folder -- Obsidian's own vault marker.
 */
export function detect(inputPath) {
  if (!existsSync(inputPath) || !statSync(inputPath).isDirectory()) return false;
  const obsidianDir = join(inputPath, '.obsidian');
  return existsSync(obsidianDir) && statSync(obsidianDir).isDirectory();
}

/**
 * @param {object} ctx
 * @param {string} ctx.inputPath
 * @param {{ id?: string, title?: string, version?: string, exclude?: string[] }} ctx.options
 * @returns {import('./index.js').PackageDraft}
 */
export function convert({ inputPath, options }) {
  const manifest = buildManifest({ ...options, title: options.title ?? basename(inputPath) });
  const type = options.type ?? DEFAULT_TYPE;
  const excludePatterns = options.exclude ?? [];
  const allNotePaths = walkFiles(inputPath)
    .filter((f) => f.endsWith('.md'))
    .filter((f) => f !== '.obsidian' && !f.startsWith('.obsidian/'));

  if (allNotePaths.length === 0) {
    throw new UsageError(`No notes found under ${inputPath}.`);
  }

  const allNotes = allNotePaths.map((relPath) => ({
    relPath,
    excluded: matchesAny(relPath, excludePatterns),
    ...readContentFile(join(inputPath, relPath)),
  }));

  const noteIndex = buildNoteIndex(allNotes);
  const warnings = [];
  const contentNodes = allNotes
    .filter((note) => !note.excluded)
    .map((note) => buildContentNode(note, noteIndex, warnings, type));

  return { manifest, contentNodes, warnings };
}

function buildContentNode(note, noteIndex, warnings, type) {
  const title = deriveTitle(note.data, note.content, basename(note.relPath, '.md'));
  const body = rewriteWikilinks(ensureOkf(note.raw, note.data, { type, title }), note, noteIndex, warnings);
  return { path: `content/${note.relPath}`, body };
}

/**
 * Rewrites [[wikilink]] syntax line-by-line, skipping lines inside fenced
 * (```) code blocks so link syntax that happens to appear in a code sample
 * is never touched.
 */
function rewriteWikilinks(text, sourceNote, noteIndex, warnings) {
  let inFence = false;
  return text
    .split('\n')
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      return line.replace(WIKILINK, (match, bang, rawTarget, heading, alias) =>
        rewriteMatch({ match, bang, rawTarget, heading, alias, sourceNote, noteIndex, warnings })
      );
    })
    .join('\n');
}

function rewriteMatch({ match, bang, rawTarget, heading, alias, sourceNote, noteIndex, warnings }) {
  const target = rawTarget.trim();

  if (bang === '!') {
    warnings.push({
      code: 'W_UNSUPPORTED_EMBED',
      file: sourceNote.relPath,
      message: `Embed "${match}" has no CommonMark equivalent; left as literal text.`,
    });
    return match;
  }

  const resolved = resolveNote(target, noteIndex);

  if (!resolved) {
    warnings.push({
      code: 'W_UNRESOLVED_WIKILINK',
      file: sourceNote.relPath,
      message: `Wikilink to "${target}" does not match any note in the vault; left as literal text.`,
    });
    return match;
  }

  if (resolved.excluded) {
    warnings.push({
      code: 'W_EXCLUDED_WIKILINK',
      file: sourceNote.relPath,
      message: `Wikilink to "${target}" points to an excluded note ("${resolved.relPath}"); left as literal text.`,
    });
    return match;
  }

  const displayText = alias ?? target;
  const relPath = relativeContentLink(sourceNote.relPath, resolved.relPath);
  const anchor = heading ? `#${slugify(heading.slice(1))}` : '';
  return `[${displayText}](${formatLinkDestination(relPath + anchor)})`;
}

/**
 * A CommonMark link destination containing an unescaped space is not
 * parsed as a link at all -- and vault filenames commonly contain spaces
 * (e.g. "Setup Guide.md") -- so wrap the destination in angle brackets
 * whenever it needs them, per the CommonMark link-destination grammar.
 * @param {string} destination
 */
function formatLinkDestination(destination) {
  if (!/[\s<>]/.test(destination)) return destination;
  return `<${destination.replace(/[<>]/g, '\\$&')}>`;
}

/**
 * @param {string} fromRelPath - the linking note's path, relative to content/
 * @param {string} toRelPath - the target note's path, relative to content/
 * @returns {string} a POSIX relative path from one to the other
 */
function relativeContentLink(fromRelPath, toRelPath) {
  const fromDir = posix.dirname(fromRelPath);
  const rel = posix.relative(fromDir === '.' ? '' : fromDir, toRelPath);
  return rel.startsWith('.') ? rel : `./${rel}`;
}

function buildNoteIndex(notes) {
  const byPath = new Map(); // path without extension, lowercased -> note
  const byBasename = new Map(); // basename without extension, lowercased -> note[] (sorted by relPath)
  const byAlias = new Map(); // alias, lowercased -> note

  for (const note of notes) {
    const withoutExt = note.relPath.replace(/\.md$/i, '');
    byPath.set(withoutExt.toLowerCase(), note);

    const baseKey = basename(withoutExt).toLowerCase();
    if (!byBasename.has(baseKey)) byBasename.set(baseKey, []);
    byBasename.get(baseKey).push(note);

    for (const alias of normalizeAliases(note.data.aliases)) {
      const aliasKey = alias.toLowerCase();
      if (!byAlias.has(aliasKey)) byAlias.set(aliasKey, note);
    }
  }

  for (const list of byBasename.values()) {
    list.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  }

  return { byPath, byBasename, byAlias };
}

function normalizeAliases(aliases) {
  if (Array.isArray(aliases)) return aliases.filter((a) => typeof a === 'string');
  if (typeof aliases === 'string') return [aliases];
  return [];
}

/**
 * Resolves a raw wikilink target to a note, preferring an exact
 * (possibly path-qualified) match, then an alias, then a basename match --
 * the same fallback order Obsidian itself uses. When multiple notes share a
 * basename, the lexicographically-first match is chosen deterministically.
 */
function resolveNote(target, noteIndex) {
  const normalized = target.replace(/\.md$/i, '');
  const key = normalized.toLowerCase();

  if (noteIndex.byPath.has(key)) return noteIndex.byPath.get(key);
  if (noteIndex.byAlias.has(key)) return noteIndex.byAlias.get(key);

  const baseKey = basename(normalized).toLowerCase();
  const candidates = noteIndex.byBasename.get(baseKey);
  return candidates ? candidates[0] : null;
}
