// Turns the positioned lines from lib/pdf/extract.js into a flat list of
// headings and paragraphs. Pure functions: no pdf.js here, so the rules can be
// tested with hand-made pages.
//
// - Running headers and footers (lines in the page margins that repeat across
//   pages, numbers aside) and bare page numbers are dropped.
// - Headings come from the outline when the PDF has one, otherwise from type
//   noticeably larger than the body text.
// - Body lines are joined into paragraphs; a paragraph may run on across a
//   column or a page break. Words hyphenated at a line end are rejoined.

const MARGIN = 0.08;
const HEADING_RATIO = 1.12;
const SMALL_RATIO = 0.8;
const MAX_HEADING_CHARS = 150;
// Bullet glyphs, including the private-use ones Symbol and Wingdings map to.
const BULLET = /^[•▪■●◦‣∙·–⦁○□➢➤►]\s*/u;
// "1. Power", "12.Loss of control", "3) Configuration"; not "91.417 requires…".
const NUMBERED = /^(\d{1,2})[.)](?:\s+(?=\S)|(?=\p{L}))/u;
// "Figure 4-6. The…", "Table 2: …", "Figure 4-1 A-F. …"; not "Figure 1-5 shows…".
const CAPTION = /^(figure|table|fig\.)\s+\d+(?:[-–.]\d+)*(?:\s*[A-Z](?:[-–][A-Z])?)?[.:]/i;

/**
 * @typedef {{ kind: 'heading', level: number, text: string, page: number }} HeadingBlock
 * @typedef {{ kind: 'paragraph' | 'item' | 'caption', text: string, page: number, lastPage?: number, number?: number }} TextBlock
 *   `lastPage` is set when the text runs on to a later page; an item with
 *   `number` is from a numbered list
 * @typedef {HeadingBlock | TextBlock} Block
 */

/**
 * @param {import('./extract.js').PdfText} pdf
 * @returns {{ blocks: Block[], bodySize: number, labels: Map<number, string> }}
 *   labels: printed page label by physical page number, where one is known
 */
export function layoutPdf(pdf) {
  const pages = dropRunningLines(pdf.pages);
  const bodySize = bodyFontSize(pages);
  const lines = pages.flatMap((page) => page.lines.map((line) => ({ ...line, page: page.number })));
  const levels = usefulOutline(pdf.outline, pages.length) ? outlineHeadings(lines, pdf.outline) : fontHeadings(lines, bodySize);
  const labels = new Map(pages.filter((p) => p.label).map((p) => [p.number, p.label]));
  return { blocks: toBlocks(lines, levels, bodySize), bodySize, labels };
}

/**
 * Removes lines in the top and bottom margins that repeat on at least a third
 * of the pages (digits ignored, so "4-12" and "4-13" match), and margin lines
 * that are only a page number. A page without a label in the PDF takes the
 * printed page number it drops ("4-12").
 * @param {import('./extract.js').PdfPage[]} pages
 */
export function dropRunningLines(pages) {
  const inMargin = (page, line) => line.y > page.height * (1 - MARGIN) || line.y < page.height * MARGIN;
  const key = (text) => text.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ');
  const seen = new Map();
  for (const page of pages) {
    const keys = new Set(page.lines.filter((l) => inMargin(page, l)).map((l) => key(l.text)));
    for (const k of keys) seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  const repeats = Math.max(2, Math.ceil(pages.length / 3));
  return pages.map((page) => {
    let label = page.label;
    const lines = page.lines.filter((l) => {
      if (!inMargin(page, l)) return true;
      if (isPageNumber(l.text, page.label)) {
        if (!label && /\d/.test(l.text)) label = l.text.trim().replace(/^page\s+/i, '');
        return false;
      }
      return !(pages.length > 2 && seen.get(key(l.text)) >= repeats);
    });
    return { ...page, ...(label ? { label } : {}), lines };
  });
}

function isPageNumber(text, label) {
  const t = text.trim();
  return t === label || /^(page\s+)?[\dA-Z]{0,3}[-–.]?\d{1,4}$/i.test(t) || /^[ivxlc]+$/i.test(t);
}

/** The size of most of the text, weighted by characters. */
export function bodyFontSize(pages) {
  const weight = new Map();
  for (const page of pages) {
    for (const line of page.lines) weight.set(line.size, (weight.get(line.size) ?? 0) + line.text.length);
  }
  let best = 0;
  let most = -1;
  for (const [size, n] of weight) {
    if (n > most) {
      best = size;
      most = n;
    }
  }
  return best;
}

/**
 * Heading levels from type size: every size clearly larger than the body is
 * a level, largest first.
 * @returns {Map<number, number>} line index -> level
 */
export function fontHeadings(lines, bodySize) {
  const headingText = (line) => line.text.length <= MAX_HEADING_CHARS && /\p{L}/u.test(line.text) && !CAPTION.test(line.text);
  // Large type may be a single letter (a glossary's "A", "B", …).
  const large = (line) => line.size >= bodySize * HEADING_RATIO && headingText(line) && !/[,;]$/.test(line.text);
  // A whole line in bold at body size, not ending like a sentence, is a
  // run-in heading one level below the smallest large heading. It needs two
  // letters in a row, so bold figure callouts ("A", "1a") are not headings.
  const bold = (line) => line.bold && !large(line) && line.size >= bodySize * 0.95 && headingText(line)
    && /\p{L}{2}/u.test(line.text) && !/[.,;:]$/.test(line.text);
  const sizes = [...new Set(lines.filter(large).map((l) => l.size))].sort((a, b) => b - a).slice(0, 5);
  const out = new Map();
  lines.forEach((line, i) => {
    if (large(line)) out.set(i, sizes.indexOf(line.size) + 1);
    else if (bold(line)) out.set(i, sizes.length + 1);
  });
  return out;
}

/**
 * Whether the outline describes the whole document. Some tools export only a
 * "Structure Bookmarks" placeholder and the title, or bookmarks for a few
 * sections near the end; the type sizes are a better guide then.
 */
export function usefulOutline(outline, pageCount) {
  const placed = (outline ?? []).filter((e) => e.page);
  if (placed.length < 3 || new Set(placed.map((e) => e.page)).size < 2) return false;
  return Math.min(...placed.map((e) => e.page)) <= Math.max(2, Math.ceil(pageCount * 0.1));
}

/**
 * Heading levels from the outline: each entry marks the first line on its
 * page, or a later page, whose text starts the entry's title. An entry whose
 * title is not found marks the first line of its page.
 * @param {Array<{ page: number, text: string }>} lines
 * @param {import('./extract.js').OutlineEntry[]} outline
 * @returns {Map<number, number>} line index -> level
 */
export function outlineHeadings(lines, outline) {
  const out = new Map();
  const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  let from = 0;
  for (const entry of outline) {
    if (!entry.page) continue;
    const title = norm(entry.title);
    const start = Math.max(from, lines.findIndex((l) => l.page >= entry.page));
    if (start < 0 || start >= lines.length) continue;
    let hit = -1;
    for (let i = start; i < lines.length && lines[i].page <= entry.page + 1; i++) {
      const text = norm(lines[i].text);
      if (text && (title.startsWith(text) || text.startsWith(title)) && text.length >= Math.min(4, title.length)) {
        hit = i;
        break;
      }
    }
    const at = hit >= 0 ? hit : start;
    if (!out.has(at)) out.set(at, Math.min(entry.level, 6));
    from = at + 1;
  }
  return out;
}

/**
 * @param {Array<import('./extract.js').PdfLine & { page: number }>} lines
 * @param {Map<number, number>} levels
 * @param {number} bodySize
 * @returns {Block[]}
 */
export function toBlocks(lines, levels, bodySize) {
  const pitch = linePitch(lines, bodySize) / (bodySize || 1);
  const blocks = [];
  let para = null;
  let prev = null;
  const flush = () => {
    if (para && para.text.trim()) {
      blocks.push({
        kind: para.kind, text: para.text.trim(), page: para.page,
        ...(para.lastPage > para.page ? { lastPage: para.lastPage } : {}),
        ...(para.number ? { number: para.number } : {}),
      });
    }
    para = null;
  };

  lines.forEach((line, i) => {
    const level = levels.get(i);
    if (level) {
      flush();
      const last = blocks.at(-1);
      // A heading set on two lines is one heading.
      if (last?.kind === 'heading' && last.level === level && prev && levels.get(i - 1) === level
          && last.page === line.page && prev.y - line.y < line.size * 2 && prev.y > line.y) {
        last.text = joinLine(last.text, line.text);
      } else {
        blocks.push({ kind: 'heading', level, text: line.text, page: line.page });
      }
      prev = line;
      return;
    }
    if (line.size < bodySize * SMALL_RATIO && !CAPTION.test(line.text)) {
      // Small type is figure labelling or a footnote marker; left out.
      return;
    }
    const numbered = NUMBERED.exec(line.text);
    const kind = CAPTION.test(line.text) ? 'caption' : BULLET.test(line.text) || numbered ? 'item' : 'paragraph';
    const text = kind !== 'item' ? line.text : numbered ? line.text.slice(numbered[0].length) : line.text.replace(BULLET, '');
    if (!para || kind !== 'paragraph' || breaksParagraph(prev, line, para, pitch)) {
      flush();
      para = { kind, text, page: line.page, ...(numbered && kind === 'item' ? { number: Number(numbered[1]) } : {}) };
    } else {
      para.text = joinLine(para.text, text);
      para.lastPage = line.page;
    }
    prev = line;
  });
  flush();
  return blocks;
}

/**
 * The usual distance between baselines of body text: the most common gap
 * between consecutive body-size lines on a page.
 */
export function linePitch(lines, bodySize) {
  const counts = new Map();
  for (let i = 1; i < lines.length; i++) {
    const [a, b] = [lines[i - 1], lines[i]];
    if (a.page !== b.page || Math.abs(a.size - bodySize) > 0.5 || Math.abs(b.size - bodySize) > 0.5) continue;
    const gap = Math.round((a.y - b.y) * 2) / 2;
    if (gap > 0 && gap < bodySize * 3) counts.set(gap, (counts.get(gap) ?? 0) + 1);
  }
  let best = bodySize * 1.2;
  let most = 0;
  for (const [gap, n] of counts) {
    if (n > most) {
      best = gap;
      most = n;
    }
  }
  return best;
}

/**
 * Whether `line` starts a new paragraph after `prev`.
 * @param {number} pitch  line pitch as a multiple of the font size
 */
function breaksParagraph(prev, line, para, pitch) {
  if (!prev) return true;
  const ended = /[.!?:"”)]$/.test(para.text);
  if (Math.abs(line.size - prev.size) > prev.size * 0.15) return true;
  if (line.page !== prev.page || line.y > prev.y + prev.size) {
    // A new page or a new column: carry on unless the text had finished.
    return ended;
  }
  // More space between the lines than the usual line pitch, scaled to the
  // size of this text.
  return prev.y - line.y > pitch * prev.size * 1.25;
}

/**
 * Joins two lines, rejoining a word hyphenated at the break ("encap-" +
 * "sulating"). A hyphen after anything but a lowercase letter ("U.S.-" +
 * "registered") and a slash ("accelerate/" + "decelerate") are kept, with no
 * space added.
 */
export function joinLine(a, b) {
  if (/\p{Ll}-$/u.test(a) && /^\p{Ll}/u.test(b)) return a.slice(0, -1) + b;
  if (/[-/]$/.test(a) && /^\p{L}/u.test(b)) return a + b;
  return `${a} ${b}`;
}
