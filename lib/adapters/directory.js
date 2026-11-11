// `directory` adapter: a folder of Markdown files (optionally nested) becomes
// one content node per file, at the same path under content/. The folders
// become the package's structure (package spec §5.6), as the pdf and youtube
// adapters write theirs: a concept per folder and per file, parts by
// dct:hasPart, and each folder's order (by name) as an ordered collection.
// Each file's node is bound to its own concept, unless its frontmatter already
// has a `moca` block. --no-structure leaves structure.ttl out.
import { existsSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { walkFiles } from '../walk.js';
import { readContentFile, ensureOkf, deriveTitle } from '../frontmatter.js';
import { buildManifest } from '../manifest.js';
import { UsageError } from '../target.js';
import { turtleString } from '../text.js';

export const name = 'directory';
export const DEFAULT_TYPE = 'Document';

// A folder's own page, whose title names the folder: OKF's index.md, or a README.
const FOLDER_PAGES = ['index.md', 'README.md', 'readme.md'];

/** @param {string} inputPath */
export function detect(inputPath) {
  if (!existsSync(inputPath) || !statSync(inputPath).isDirectory()) return false;
  return walkFiles(inputPath).some((f) => f.endsWith('.md'));
}

/**
 * @param {{ inputPath: string, options: object }} ctx
 * @returns {import('./index.js').PackageDraft}
 */
export function convert({ inputPath, options }) {
  const manifest = buildManifest(options);
  const files = walkFiles(inputPath).filter((f) => f.endsWith('.md'));
  if (files.length === 0) throw new UsageError(`No Markdown files found under ${inputPath}.`);
  const type = options.type ?? DEFAULT_TYPE;
  const withStructure = options.structure !== false;
  const iri = (fragment) => `${manifest.id}#${fragment}`;
  const warnings = [];
  const titles = new Map();

  const contentNodes = files.map((relPath) => {
    const { data, content, raw } = readContentFile(join(inputPath, relPath));
    const title = deriveTitle(data, content, basename(relPath, extname(relPath)));
    titles.set(relPath, title);
    let extra = {};
    if (withStructure && !isFolderPage(relPath)) {
      if (data.moca === undefined) {
        extra = { moca: { concepts: [{ iri: iri(fileFragment(relPath)), role: 'primary' }] } };
      } else {
        warnings.push({
          code: 'STRUCTURE_NOT_BOUND',
          message: 'has its own moca block, so it is not bound to its concept in structure.ttl',
          file: relPath,
        });
      }
    }
    return { path: `content/${relPath}`, body: ensureOkf(raw, data, { type, title }, extra) };
  });

  const result = { manifest, contentNodes, warnings };
  if (withStructure) {
    result.files = [{ path: 'structure.ttl', body: structure(manifest, files, titles, { iri, lang: options.language }) }];
  }
  return result;
}

/** A file's concept fragment: its path without .md. */
function fileFragment(relPath) {
  return relPath.replace(/\.md$/, '');
}

function isFolderPage(relPath) {
  return FOLDER_PAGES.includes(relPath.split('/').pop());
}

// Words that number a division of a document: "part-3-..." reads "Part 3: ...".
const NUMBERED = /^(part|chapter|section|schedule|module|unit|lesson|appendix|annex|article|volume) (\w+) (.+)$/i;

/**
 * A folder's label: the title of its index.md or README, else its name without
 * a leading order number, in sentence case ("011-resource-management" ->
 * "Resource management"), with a numbered division read as one
 * ("03-part-3-law-enforcement-processing" -> "Part 3: Law enforcement processing").
 */
export function folderLabel(folder, titles) {
  for (const page of FOLDER_PAGES) {
    const title = titles.get(`${folder}/${page}`);
    if (title) return title;
  }
  const last = folder.split('/').pop();
  const words = last.replace(/^\d+[-_. ]+/, '').replace(/[-_]+/g, ' ').trim();
  if (!words) return last;
  const sentence = (s) => s[0].toUpperCase() + s.slice(1);
  const numbered = NUMBERED.exec(words);
  return numbered ? `${sentence(numbered[1].toLowerCase())} ${numbered[2].toUpperCase()}: ${sentence(numbered[3])}` : sentence(words);
}

/**
 * The folders as structure: the package as a whole ("collection"), each
 * folder and each file a concept, parts by dct:hasPart, and each container's
 * children, folders and files together in name order, as an ordered collection.
 */
function structure(manifest, files, titles, { iri, lang }) {
  const label = (text) => `${turtleString(text)}${lang ? `@${lang}` : ''}`;
  const ref = (fragment) => `<${iri(fragment)}>`;
  const children = new Map([['', new Set()]]);
  for (const file of files) {
    if (isFolderPage(file)) continue;
    const parts = file.split('/');
    for (let i = 0; i < parts.length; i++) {
      const parent = parts.slice(0, i).join('/');
      const child = parts.slice(0, i + 1).join('/');
      if (!children.has(parent)) children.set(parent, new Set());
      children.get(parent).add(child);
    }
  }
  const fragment = (path) => (path === '' ? 'collection' : path.endsWith('.md') ? fileFragment(path) : path);
  const order = (path) => [...children.get(path)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const blocks = ['@prefix skos: <http://www.w3.org/2004/02/skos/core#> .\n@prefix dct: <http://purl.org/dc/terms/> .'];
  for (const container of [...children.keys()].sort()) {
    const members = order(container).map((c) => ref(fragment(c)));
    if (members.length === 0) continue;
    const name = container === '' ? manifest.title : folderLabel(container, titles);
    blocks.push(`${ref(fragment(container))} a skos:Concept ;\n  skos:prefLabel ${label(name)} ;\n  dct:hasPart ${members.join(',\n    ')} .`);
    blocks.push(
      `${ref(`${fragment(container)}-order`)} a skos:OrderedCollection ;\n  skos:prefLabel ${label(`${name} (folder order)`)} ;\n  skos:memberList (\n    ${members.join('\n    ')}\n  ) .`,
    );
  }
  for (const file of files) {
    if (!isFolderPage(file)) blocks.push(`${ref(fileFragment(file))} a skos:Concept ;\n  skos:prefLabel ${label(titles.get(file))} .`);
  }
  return `${blocks.join('\n\n')}\n`;
}
