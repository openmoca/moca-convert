// Reads a PDF with pdf.js and returns its text as positioned lines, page by
// page, plus the page labels and the outline (bookmarks). No layout decisions
// are made here; lib/pdf/layout.js turns the lines into headings and
// paragraphs.
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { oneLine } from '../text.js';

/** Limits on one PDF: pages, and time to read it. */
export const PDF_LIMITS = Object.freeze({ maxPages: 2_000, timeoutMs: 10 * 60_000 });

export class PdfLimitError extends Error {}

/**
 * @typedef {object} PdfLine
 * @property {string} text
 * @property {number} x       left edge, PDF units
 * @property {number} y       baseline, PDF units from the bottom of the page
 * @property {number} size    font size, PDF units
 * @property {string} font    pdf.js font id of the line's first run
 * @property {boolean} [bold] most of the line is set in a bold face
 *
 * @typedef {object} PdfPage
 * @property {number} number  1-based physical page number (RFC 3778 `page=`)
 * @property {string} [label] printed page label, e.g. "4-12"
 * @property {number} height
 * @property {PdfLine[]} lines  in the order the page draws them
 *
 * @typedef {object} OutlineEntry
 * @property {string} title
 * @property {number} level   1 = top level
 * @property {number} [page]  1-based page the entry points at
 *
 * @typedef {object} PdfText
 * @property {PdfPage[]} pages
 * @property {OutlineEntry[]} outline  flattened, in document order
 * @property {string} [title]          the document's Title metadata
 */

/**
 * @param {Uint8Array} data
 * @param {{ maxPages?: number, timeoutMs?: number }} [limits]  PDF_LIMITS by default
 * @returns {Promise<PdfText>}  rejects with PdfLimitError over a limit
 */
export async function extractPdf(data, limits = {}) {
  const { maxPages, timeoutMs } = { ...PDF_LIMITS, ...limits };
  let timer;
  let task;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new PdfLimitError(`reading it took longer than ${Math.round(timeoutMs / 1000)} s`));
      task?.destroy();
    }, timeoutMs);
  });
  try {
    const deadline = Date.now() + timeoutMs;
    return await Promise.race([read(data, { maxPages, deadline, timeoutMs }, (t) => { task = t; }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function read(data, { maxPages, deadline, timeoutMs }, onTask) {
  const task = getDocument({
    data,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  onTask(task);
  const doc = await task.promise;
  try {
    if (doc.numPages > maxPages) throw new PdfLimitError(`it has ${doc.numPages} pages, over the ${maxPages}-page limit`);
    const labels = await doc.getPageLabels().catch(() => null);
    const pages = [];
    for (let n = 1; n <= doc.numPages; n++) {
      if (Date.now() >= deadline) throw new PdfLimitError(`reading it took longer than ${Math.round(timeoutMs / 1000)} s`);
      const page = await doc.getPage(n);
      const { items } = await page.getTextContent();
      const [, , , height] = page.view;
      const bold = await boldFonts(page, items);
      // A page label is the PDF's own text: kept short, on one line, with no control characters.
      const label = oneLine(labels?.[n - 1]);
      pages.push({ number: n, ...(label ? { label } : {}), height, lines: toLines(items, bold) });
      page.cleanup();
    }
    const meta = await doc.getMetadata().catch(() => null);
    const title = typeof meta?.info?.Title === 'string' ? meta.info.Title.trim() : '';
    return { pages, outline: await readOutline(doc), ...(title ? { title } : {}) };
  } finally {
    await task.destroy();
  }
}

/**
 * The ids of the page's bold fonts. pdf.js knows a font's PostScript name
 * ("Helvetica,Bold", "ABCDEE+Arial-BoldMT") only once the page's operators
 * have been loaded.
 */
async function boldFonts(page, items) {
  const bold = new Set();
  try {
    await page.getOperatorList();
  } catch {
    return bold;
  }
  for (const id of new Set(items.map((i) => i.fontName))) {
    try {
      const font = page.commonObjs.get(id);
      if (font?.bold || font?.black || /bold|black|heavy|semibold|demi/i.test(font?.name ?? '')) bold.add(id);
    } catch {
      // Not loaded: treat as regular.
    }
  }
  return bold;
}

/**
 * Joins pdf.js text runs into lines. Runs are taken in drawing order, which
 * follows the reading order of a column or text frame, so two columns are not
 * interleaved. A line ends where pdf.js marks one, or where the baseline moves
 * or the text goes back to the left.
 * @param {object[]} items  pdf.js text items
 * @param {Set<string>} [boldIds]  font ids set in a bold face
 */
export function toLines(items, boldIds = new Set()) {
  const lines = [];
  let line = null;
  for (const item of items) {
    if (typeof item.str !== 'string') continue;
    const [a, b, c, d, x, y] = item.transform;
    const size = Math.hypot(c, d) || Math.hypot(a, b) || item.height || 0;
    if (item.str.trim() !== '') {
      const sameLine = line && Math.abs(y - line.y) < Math.max(line.size, size) * 0.4 && x >= line.end - line.size;
      if (!sameLine) {
        if (line) lines.push(line);
        line = { text: '', x, y, size, font: item.fontName, end: x, chars: 0, boldChars: 0, sizes: new Map() };
      }
      const gap = x - line.end;
      if (line.text && !/\s$/.test(line.text) && !/^\s/.test(item.str) && gap > size * 0.15) line.text += ' ';
      line.text += item.str;
      line.end = x + (item.width ?? 0);
      const weight = item.str.trim().length;
      const key = Math.round(size * 2) / 2;
      line.sizes.set(key, (line.sizes.get(key) ?? 0) + weight);
      line.chars += weight;
      if (boldIds.has(item.fontName)) line.boldChars += weight;
    }
    if (item.hasEOL && line) {
      lines.push(line);
      line = null;
    }
  }
  if (line) lines.push(line);
  return lines
    .map((l) => ({
      text: l.text.replace(/\s+/g, ' ').trim(), x: round(l.x), y: round(l.y), size: dominant(l.sizes), font: l.font,
      ...(l.boldChars > l.chars * 0.8 ? { bold: true } : {}),
    }))
    .filter((l) => l.text !== '');
}

/** The size that covers the most characters in a line. */
function dominant(sizes) {
  let best = 0;
  let most = -1;
  for (const [size, n] of sizes) {
    if (n > most || (n === most && size > best)) {
      best = size;
      most = n;
    }
  }
  return best;
}

async function readOutline(doc) {
  const tree = await doc.getOutline().catch(() => null);
  if (!tree) return [];
  const out = [];
  const visit = async (entries, level) => {
    for (const entry of entries) {
      const title = String(entry.title ?? '').replace(/\s+/g, ' ').trim();
      const page = await destinationPage(doc, entry.dest);
      if (title) out.push({ title, level, ...(page ? { page } : {}) });
      if (entry.items?.length) await visit(entry.items, level + 1);
    }
  };
  await visit(tree, 1);
  return out;
}

async function destinationPage(doc, dest) {
  try {
    const explicit = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
    if (!Array.isArray(explicit) || explicit.length === 0) return undefined;
    const ref = explicit[0];
    const index = typeof ref === 'number' ? ref : await doc.getPageIndex(ref);
    return index + 1;
  } catch {
    return undefined;
  }
}

function round(n) {
  return Math.round(n * 100) / 100;
}
