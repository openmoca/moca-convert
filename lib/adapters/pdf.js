// `pdf` adapter: one or more PDFs become content nodes, one per section. A
// section starts at a heading of the first level that occurs more than once
// in the document (chapters in a book, sections in a chapter); deeper headings
// stay inside the node. Every node cites the pages it came from as RFC 3778
// `page=` fragments, and structure.ttl keeps the documents and their sections
// in order.
//
// Input is a PDF file, a folder of PDFs, or a folder with a `pdfs.json`
// that lists the documents in order, with an optional title, source URL and
// SHA-256 for each (see README).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { joinFrontmatter } from '@openmoca/moca-core';
import { buildManifest } from '../manifest.js';
import { slugify } from '../slug.js';
import { UsageError } from '../target.js';
import { walkFiles } from '../walk.js';
import { escapeInline, escapeLineStart, summary, turtleString, uniqueSlug } from '../text.js';
import { extractPdf } from '../pdf/extract.js';
import { layoutPdf } from '../pdf/layout.js';

export const name = 'pdf';
export const DEFAULT_TYPE = 'Document';
export const DESCRIPTOR = 'pdfs.json';

const RFC3778 = 'http://tools.ietf.org/rfc/rfc3778';
const SOURCE_MODES = ['copy', 'link'];

/** @param {string} inputPath */
export function detect(inputPath) {
  if (!existsSync(inputPath)) return false;
  const st = statSync(inputPath);
  if (st.isFile()) return /\.pdf$/i.test(inputPath);
  if (!st.isDirectory()) return false;
  if (existsSync(join(inputPath, DESCRIPTOR))) return true;
  const files = walkFiles(inputPath);
  return files.some((f) => /\.pdf$/i.test(f)) && !files.some((f) => f.endsWith('.md'));
}

/**
 * @param {{ inputPath: string, options: object }} ctx
 * @returns {Promise<import('./index.js').PackageDraft>}
 */
export async function convert({ inputPath, options }) {
  const sourcesMode = options.sources ?? 'copy';
  if (!SOURCE_MODES.includes(sourcesMode)) throw new UsageError(`--sources must be one of: ${SOURCE_MODES.join(', ')}.`);
  const listing = listDocuments(inputPath);
  if (sourcesMode === 'link') {
    const missing = listing.documents.filter((d) => !d.url);
    if (missing.length > 0) throw new UsageError(`--sources link needs a url for every document in ${DESCRIPTOR}; ${missing[0].file} has none.`);
  }

  const warnings = [];
  const docs = [];
  const docSlugs = new Set(['index']);
  for (const entry of listing.documents) {
    const bytes = readPdf(entry);
    const pdf = await extractPdf(new Uint8Array(bytes));
    const { blocks, labels } = layoutPdf(pdf);
    const title = entry.title ?? pdf.title ?? firstHeading(blocks) ?? basename(entry.file, '.pdf');
    if (!blocks.some((b) => b.kind !== 'heading')) {
      warnings.push({ code: 'PDF_NO_TEXT', message: `${entry.file} has no text layer (a scan?); it was left out. Run OCR on it first.`, file: entry.file });
      continue;
    }
    const slug = uniqueSlug(slugify(title), docSlugs);
    docs.push({ entry, bytes, title, slug, labels, sections: splitSections(blocks, title) });
  }
  if (docs.length === 0) throw new UsageError(`${inputPath}: none of the PDFs has any text.`);

  const multi = docs.length > 1;
  const manifest = buildManifest({
    ...options,
    title: options.title ?? listing.title ?? (multi ? undefined : docs[0].title),
    description: options.description ?? listing.description,
  });
  const iri = (fragment) => `${manifest.id}#${fragment}`;
  const type = options.type ?? DEFAULT_TYPE;
  const contentNodes = [];
  const files = [];

  for (const doc of docs) {
    const dir = multi ? `content/${doc.slug}` : 'content';
    const up = multi ? '../../' : '../';
    const pdfPath = `sources/${doc.slug}.pdf`;
    if (sourcesMode === 'copy') files.push({ path: pdfPath, body: doc.bytes });
    const pdfRef = sourcesMode === 'copy' ? `${up}${pdfPath}` : doc.entry.url;
    const sectionSlugs = new Set(['index']);
    for (const section of doc.sections) {
      section.slug = uniqueSlug(slugify(section.title), sectionSlugs);
      const pageList = section.pages;
      const evidence = pageList.map((n) => ({
        source: 'pdf',
        selector: { type: 'FragmentSelector', conformsTo: RFC3778, value: `page=${n}` },
        ...(doc.labels.get(n) ? { note: `p. ${doc.labels.get(n)}` } : {}),
      }));
      const firstText = section.blocks.find((b) => b.kind === 'paragraph');
      const data = {
        type,
        title: section.title,
        ...(firstText ? { description: summary(firstText.text) } : {}),
        ...(doc.entry.url ? { resource: `${doc.entry.url}#page=${pageList[0]}` } : {}),
        sources: [{ id: 'pdf', resource: pdfRef, title: `${doc.title} (PDF)` }],
        moca: {
          concepts: [{ iri: iri(`${doc.slug}/${section.slug}`), role: 'primary' }],
          evidence,
        },
      };
      contentNodes.push({ path: `${dir}/${section.slug}.md`, body: joinFrontmatter(data, sectionBody(section, doc, pdfRef)) });
    }
    if (multi) contentNodes.push({ path: `${dir}/index.md`, body: documentIndex(doc, pdfRef) });
  }
  contentNodes.push({ path: 'content/index.md', body: multi ? collectionIndex(manifest, docs) : documentIndex(docs[0], sourcesMode === 'copy' ? `../sources/${docs[0].slug}.pdf` : docs[0].entry.url) });
  files.push({ path: 'structure.ttl', body: structure(manifest, docs, { iri, lang: options.language }) });
  return { manifest, contentNodes, files, warnings };
}

/**
 * The documents to convert, in order.
 * @returns {{ title?: string, description?: string, documents: Array<{ file: string, abs: string, url?: string, sha256?: string, title?: string }> }}
 */
export function listDocuments(inputPath) {
  if (!existsSync(inputPath)) throw new UsageError(`Input does not exist: ${inputPath}`);
  if (statSync(inputPath).isFile()) {
    if (!/\.pdf$/i.test(inputPath)) throw new UsageError(`${inputPath} is not a PDF.`);
    return { documents: [{ file: basename(inputPath), abs: inputPath }] };
  }
  const descriptor = join(inputPath, DESCRIPTOR);
  if (!existsSync(descriptor)) {
    const found = walkFiles(inputPath).filter((f) => /\.pdf$/i.test(f)).sort();
    if (found.length === 0) throw new UsageError(`${inputPath} holds no PDFs.`);
    return { documents: found.map((file) => ({ file, abs: join(inputPath, file) })) };
  }
  let spec;
  try {
    spec = JSON.parse(readFileSync(descriptor, 'utf8'));
  } catch (err) {
    throw new UsageError(`${descriptor} is not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(spec?.documents) || spec.documents.length === 0) throw new UsageError(`${descriptor} needs a non-empty "documents" list.`);
  const documents = spec.documents.map((d, i) => {
    if (typeof d?.file !== 'string' || d.file.split(/[\\/]/).includes('..')) throw new UsageError(`${descriptor}: documents[${i}] needs a "file" inside the folder.`);
    if (d.url !== undefined && !/^https?:\/\/\S+$/.test(d.url)) throw new UsageError(`${descriptor}: documents[${i}].url must be an http(s) URL.`);
    if (d.sha256 !== undefined && !/^[0-9a-f]{64}$/.test(d.sha256)) throw new UsageError(`${descriptor}: documents[${i}].sha256 must be 64 lowercase hex digits.`);
    return { file: d.file, abs: join(inputPath, d.file), ...pick(d, ['url', 'sha256', 'title']) };
  });
  return { ...pick(spec, ['title', 'description']), documents };
}

function readPdf(entry) {
  if (!existsSync(entry.abs)) {
    throw new UsageError(`${entry.file} is missing${entry.url ? `; download it from ${entry.url}` : ''}.`);
  }
  const bytes = readFileSync(entry.abs);
  if (entry.sha256) {
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== entry.sha256) throw new UsageError(`${entry.file} has SHA-256 ${actual}, but ${DESCRIPTOR} expects ${entry.sha256}.`);
  }
  return bytes;
}

/**
 * Splits blocks into sections at the first heading level that occurs more
 * than once. Text before the first such heading is an opening section, named
 * by the headings above it or by the document title.
 * @param {import('../pdf/layout.js').Block[]} blocks
 * @returns {Array<{ title: string, level: number, blocks: import('../pdf/layout.js').Block[], pages: number[] }>}
 */
export function splitSections(blocks, docTitle) {
  const counts = new Map();
  for (const b of blocks) if (b.kind === 'heading') counts.set(b.level, (counts.get(b.level) ?? 0) + 1);
  const splitLevel = [...counts.keys()].sort((a, b) => a - b).find((l) => counts.get(l) > 1);

  const sections = [];
  let current = { title: null, level: splitLevel ?? 1, blocks: [], pages: new Set() };
  const push = () => {
    if (current.blocks.some((b) => b.kind !== 'heading')) sections.push(current);
  };
  for (const block of blocks) {
    if (splitLevel && block.kind === 'heading' && block.level <= splitLevel) {
      if (block.level === splitLevel || current.blocks.some((b) => b.kind !== 'heading')) {
        push();
        current = { title: block.text, level: splitLevel, blocks: [], pages: new Set([block.page]) };
        continue;
      }
      // A heading above the split level before any text (a chapter title)
      // names the opening section.
      current.title = current.title ? `${current.title}: ${block.text}` : block.text;
      current.pages.add(block.page);
      continue;
    }
    current.blocks.push(block);
    for (let p = block.page; p <= (block.lastPage ?? block.page); p++) current.pages.add(p);
  }
  push();
  return sections.map((s) => ({ ...s, title: s.title ?? docTitle, pages: [...s.pages].sort((a, b) => a - b) }));
}

function sectionBody(section, doc, pdfRef) {
  const range = pageRange(section.pages, doc.labels);
  const out = [`# ${escapeInline(section.title)}`, `From ${escapeInline(doc.title)}, ${range} ([PDF](<${pdfRef}#page=${section.pages[0]}>)).`];
  for (const block of section.blocks) {
    if (block.kind === 'heading') out.push(`${'#'.repeat(Math.min(6, Math.max(2, block.level - section.level + 1)))} ${escapeInline(block.text)}`);
    else if (block.kind === 'item') out.push(`${block.number ? `${block.number}.` : '-'} ${escapeInline(block.text)}`);
    else if (block.kind === 'caption') out.push(`*${escapeInline(block.text)}*`);
    else out.push(escapeLineStart(escapeInline(block.text)));
  }
  return `\n${joinBlocks(out, section.blocks)}\n`;
}

// List items that follow each other form one list; everything else is
// separated by a blank line.
function joinBlocks(lines, blocks) {
  const kinds = [null, null, ...blocks.map((b) => (b.kind === 'item' ? (b.number ? 'ol' : 'ul') : b.kind))];
  const listed = (k) => k === 'ol' || k === 'ul';
  return lines.reduce((acc, line, i) => (i === 0 ? line : `${acc}${listed(kinds[i]) && kinds[i] === kinds[i - 1] ? '\n' : '\n\n'}${line}`), '');
}

// Printed page numbers when both ends have one, otherwise the PDF's own page
// numbers, said as such so they are not mistaken for printed ones.
function pageRange(pages, labels) {
  const first = pages[0];
  const last = pages.at(-1);
  const printed = labels.has(first) && labels.has(last);
  const show = (n) => (printed ? labels.get(n) : String(n));
  const noun = `${printed ? '' : 'PDF '}page${first === last ? '' : 's'}`;
  return first === last ? `${noun} ${show(first)}` : `${noun} ${show(first)} to ${show(last)}`;
}

function documentIndex(doc, pdfRef) {
  const lines = [`# ${escapeInline(doc.title)}`, '', `Sections of [the PDF](<${pdfRef}>) in order:`, ''];
  doc.sections.forEach((s, i) => lines.push(`${i + 1}. [${escapeInline(s.title)}](${s.slug}.md)`));
  return `${lines.join('\n')}\n`;
}

function collectionIndex(manifest, docs) {
  const lines = [`# ${escapeInline(manifest.title)}`, ''];
  if (manifest.description) lines.push(escapeInline(manifest.description), '');
  lines.push('Documents in order:', '');
  docs.forEach((d, i) => lines.push(`${i + 1}. [${escapeInline(d.title)}](${d.slug}/index.md)`));
  return `${lines.join('\n')}\n`;
}

function structure(manifest, docs, { iri, lang }) {
  const label = (text) => `${turtleString(text)}${lang ? `@${lang}` : ''}`;
  const ref = (fragment) => `<${iri(fragment)}>`;
  const blocks = ['@prefix skos: <http://www.w3.org/2004/02/skos/core#> .\n@prefix dct: <http://purl.org/dc/terms/> .'];
  const ordered = (fragment, text, members) =>
    `${ref(fragment)} a skos:OrderedCollection ;\n  skos:prefLabel ${label(text)} ;\n  skos:memberList (\n    ${members.join('\n    ')}\n  ) .`;
  if (docs.length > 1) {
    const members = docs.map((d) => ref(d.slug));
    blocks.push(`${ref('collection')} a skos:Concept ;\n  skos:prefLabel ${label(manifest.title)} ;\n  dct:hasPart ${members.join(',\n    ')} .`);
    blocks.push(ordered('collection-order', `${manifest.title} (document order)`, members));
  }
  for (const doc of docs) {
    const members = doc.sections.map((s) => ref(`${doc.slug}/${s.slug}`));
    blocks.push(`${ref(doc.slug)} a skos:Concept ;\n  skos:prefLabel ${label(doc.title)} ;\n  dct:hasPart ${members.join(',\n    ')} .`);
    blocks.push(ordered(`${doc.slug}/order`, `${doc.title} (section order)`, members));
    for (const s of doc.sections) blocks.push(`${ref(`${doc.slug}/${s.slug}`)} a skos:Concept ;\n  skos:prefLabel ${label(s.title)} .`);
  }
  return `${blocks.join('\n\n')}\n`;
}

function firstHeading(blocks) {
  return blocks.find((b) => b.kind === 'heading')?.text;
}

function pick(obj, keys) {
  return Object.fromEntries(keys.filter((k) => typeof obj?.[k] === 'string' && obj[k].trim()).map((k) => [k, obj[k].trim()]));
}
