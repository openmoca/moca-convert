// `markdown` adapter: a single Markdown file, or a glob of files with no
// directory structure worth preserving. Each becomes content/<slug>.md,
// where the slug is derived from the file's title, not its source path.
import { existsSync, globSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { readContentFile, ensureOkf, deriveTitle } from '../frontmatter.js';
import { buildManifest } from '../manifest.js';
import { slugify } from '../slug.js';
import { UsageError, isGlobPattern } from '../target.js';

export const name = 'markdown';
export const DEFAULT_TYPE = 'Document';


/**
 * @param {string} inputPath
 * @returns {boolean} true for a single .md/.markdown file (a directory or
 *   glob input is handled by the `directory` adapter or requires an
 *   explicit --from, respectively -- see lib/detect.js).
 */
export function detect(inputPath) {
  if (isGlobPattern(inputPath)) return false;
  if (!existsSync(inputPath) || !statSync(inputPath).isFile()) return false;
  return /\.(md|markdown)$/i.test(inputPath);
}

/**
 * @param {object} ctx
 * @param {string} ctx.inputPath
 * @param {{ id?: string, title?: string, version?: string }} ctx.options
 * @returns {import('./index.js').PackageDraft}
 */
export function convert({ inputPath, options }) {
  const manifest = buildManifest(options);
  const files = resolveFiles(inputPath);
  if (files.length === 0) {
    throw new UsageError(`No Markdown files matched "${inputPath}".`);
  }

  const usedSlugs = new Map(); // slug -> count seen so far, for deterministic -2/-3 suffixes
  const type = options.type ?? DEFAULT_TYPE;
  const contentNodes = files.map((absPath) => buildContentNode(absPath, usedSlugs, type));

  return { manifest, contentNodes, warnings: [] };
}

function resolveFiles(inputPath) {
  const paths = isGlobPattern(inputPath) ? [...globSync(inputPath)] : [inputPath];
  return paths
    .filter((p) => statSync(p).isFile())
    .sort();
}

function buildContentNode(absPath, usedSlugs, type) {
  const { data, content, raw } = readContentFile(absPath);
  const title = deriveTitle(data, content, basename(absPath, extname(absPath)));
  const slug = uniqueSlug(slugify(title), usedSlugs);
  return { path: `content/${slug}.md`, body: ensureOkf(raw, data, { type, title }) };
}

function uniqueSlug(baseSlug, usedSlugs) {
  const count = usedSlugs.get(baseSlug) ?? 0;
  usedSlugs.set(baseSlug, count + 1);
  return count === 0 ? baseSlug : `${baseSlug}-${count + 1}`;
}
