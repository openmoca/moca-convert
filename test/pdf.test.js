import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { readPackage, splitFrontmatter } from '@openmoca/moca-core';
import { convert, detect, splitSections } from '../lib/adapters/pdf.js';
import { resolveAdapterName } from '../lib/detect.js';
import { resolveInputTarget, UsageError } from '../lib/target.js';
import { writeDraft } from '../lib/write.js';
import { dropRunningLines, fontHeadings, joinLine, outlineHeadings, toBlocks, usefulOutline } from '../lib/pdf/layout.js';
import { makePdf } from './make-pdf.js';

const ID = 'https://example.com/test/brakes';
const URL_BASE = 'https://example.com/manuals/';

// A three-page chapter: a running header,
// a bullet (WinAnsi 0x95), printed page numbers in the
// footer, headings at 18pt and 13pt, a bold run-in heading, lists, a caption
// and a paragraph that runs on across a page break.
const header = (y = 760) => ({ text: 'Workshop Manual', size: 9, y });
const CHAPTER = [
  [
    header(),
    { text: 'Chapter 7: Brakes', size: 18, y: 700 },
    { text: 'Introduction', size: 13, y: 670 },
    { text: 'Brakes stop the car. This para-', y: 650 },
    { text: 'graph continues on a second', y: 638 },
    { text: 'line and a third.', y: 626 },
    { text: 'A second paragraph starts after a gap.', y: 602 },
    { text: 'Checks', size: 13, y: 580 },
    { text: '\x95 Check the fluid level.', y: 560 },
    { text: '\x95 Check the pads.', y: 548 },
    { text: '1. Pump the pedal.', y: 530 },
    { text: '2. Listen for noise.', y: 518 },
    { text: 'Figure 7-1. A brake disc.', y: 494 },
    { text: 'Figure 7-2 shows the caliper, which is not a caption.', y: 470 },
    { text: '7-1', size: 9, x: 300, y: 30 },
  ],
  [
    header(),
    { text: 'Pads', bold: true, y: 700 },
    { text: 'Pads wear over time and must be replaced.', y: 680 },
    { text: 'Rotors', size: 13, y: 640 },
    { text: 'Rotors can warp when they get too hot, and a warped', y: 620 },
    { text: '7-2', size: 9, x: 300, y: 30 },
  ],
  [
    header(),
    { text: 'rotor makes the pedal pulse.', y: 700 },
    { text: '7-3', size: 9, x: 300, y: 30 },
  ],
];
// One page: too short for a running header to be recognised, so it has none.
const APPENDIX = [
  [
    { text: 'Appendix: Torque', size: 18, y: 700 },
    { text: 'Wheel nuts', size: 13, y: 670 },
    { text: 'Tighten wheel nuts to 110 Nm.', y: 650 },
    { text: 'Caliper bolts', size: 13, y: 620 },
    { text: 'Tighten caliper bolts to 30 Nm.', y: 600 },
  ],
];

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'moca-convert-pdf-'));
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** A folder with the two PDFs and a pdfs.json that lists them. */
function corpus({ descriptor = true, pin = true } = {}) {
  const dir = tempDir();
  const chapter = makePdf(CHAPTER, { title: 'Brakes (metadata title)' });
  const appendix = makePdf(APPENDIX);
  writeFileSync(join(dir, 'ch7.pdf'), chapter);
  writeFileSync(join(dir, 'appendix.pdf'), appendix);
  if (descriptor) {
    writeFileSync(join(dir, 'pdfs.json'), JSON.stringify({
      title: 'Workshop Manual',
      description: 'Brakes and torque settings.',
      documents: [
        { file: 'ch7.pdf', title: 'Chapter 7: Brakes', url: `${URL_BASE}ch7.pdf`, ...(pin ? { sha256: sha256(chapter) } : {}) },
        { file: 'appendix.pdf', title: 'Appendix: Torque', url: `${URL_BASE}appendix.pdf` },
      ],
    }));
  }
  return dir;
}

async function written(draft) {
  const outDir = join(tempDir(), 'pkg');
  await writeDraft({ draft, outDir });
  const result = await readPackage(outDir);
  return { result, cleanup: () => rmSync(dirname(outDir), { recursive: true, force: true }) };
}

function node(draft, path) {
  const found = draft.contentNodes.find((n) => n.path === path);
  assert.ok(found, `no node ${path}; have ${draft.contentNodes.map((n) => n.path).join(', ')}`);
  return { ...splitFrontmatter(found.body), text: found.body };
}

test('PDFs, a folder of them, or a pdfs.json folder are detected as pdf', () => {
  const dir = corpus();
  const bare = corpus({ descriptor: false });
  try {
    assert.equal(detect(dir), true);
    assert.equal(detect(join(dir, 'ch7.pdf')), true);
    assert.equal(detect(bare), true);
    assert.equal(resolveAdapterName(resolveInputTarget(dir)), 'pdf');
    assert.equal(resolveAdapterName(resolveInputTarget(join(dir, 'ch7.pdf'))), 'pdf');
    writeFileSync(join(bare, 'notes.md'), '# Notes\n');
    assert.equal(detect(bare), false, 'a folder with Markdown is a directory, not a PDF corpus');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
  }
});

test('each document is split into sections that cite their pages', async () => {
  const dir = corpus();
  try {
    const draft = await convert({ inputPath: dir, options: { id: ID, language: 'en', sources: 'link' } });
    assert.equal(draft.manifest.title, 'Workshop Manual');
    assert.equal(draft.manifest.description, 'Brakes and torque settings.');
    assert.deepEqual(draft.contentNodes.map((n) => n.path), [
      'content/chapter-7-brakes/introduction.md',
      'content/chapter-7-brakes/checks.md',
      'content/chapter-7-brakes/rotors.md',
      'content/chapter-7-brakes/index.md',
      'content/appendix-torque/wheel-nuts.md',
      'content/appendix-torque/caliper-bolts.md',
      'content/appendix-torque/index.md',
      'content/index.md',
    ]);
    assert.deepEqual(draft.files.map((f) => f.path), ['structure.ttl'], 'link mode copies no PDFs');

    const rotors = node(draft, 'content/chapter-7-brakes/rotors.md');
    assert.equal(rotors.data.type, 'Document');
    assert.equal(rotors.data.title, 'Rotors');
    assert.equal(rotors.data.resource, `${URL_BASE}ch7.pdf#page=2`);
    assert.deepEqual(rotors.data.sources, [{ id: 'pdf', resource: `${URL_BASE}ch7.pdf`, title: 'Chapter 7: Brakes (PDF)' }]);
    assert.deepEqual(rotors.data.moca.evidence, [
      { source: 'pdf', selector: { type: 'FragmentSelector', conformsTo: 'http://tools.ietf.org/rfc/rfc3778', value: 'page=2' }, note: 'p. 7-2' },
      { source: 'pdf', selector: { type: 'FragmentSelector', conformsTo: 'http://tools.ietf.org/rfc/rfc3778', value: 'page=3' }, note: 'p. 7-3' },
    ]);
    assert.deepEqual(rotors.data.moca.concepts, [{ iri: `${ID}#chapter-7-brakes/rotors`, role: 'primary' }]);
    assert.match(rotors.body, /From Chapter 7: Brakes, pages 7-2 to 7-3/);
    assert.match(rotors.body, /Rotors can warp when they get too hot, and a warped rotor makes the pedal pulse\./, 'a paragraph runs on across the page break');
    assert.doesNotMatch(draft.contentNodes.filter((n) => !n.path.endsWith('index.md')).map((n) => splitFrontmatter(n.body).body).join('\n'), /Workshop Manual\n|\b7-[123]\n/, 'running headers and page numbers are dropped');

    const { result, cleanup } = await written(draft);
    try {
      assert.equal(result.valid, true);
      assert.deepEqual(result.diagnostics.filter((d) => d.severity !== 'info'), []);
      assert.deepEqual(result.capabilities, ['core', 'located-evidence', 'structured']);
      const graph = result.structure.graph;
      assert.deepEqual([...graph.collections.get(`${ID}#chapter-7-brakes/order`).members], ['introduction', 'checks', 'rotors'].map((s) => `${ID}#chapter-7-brakes/${s}`));
      assert.deepEqual([...graph.collections.get(`${ID}#collection-order`).members], [`${ID}#chapter-7-brakes`, `${ID}#appendix-torque`]);
    } finally {
      cleanup();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('paragraphs, hyphenation, lists, captions and bold run-in headings come through as Markdown', async () => {
  const dir = corpus();
  try {
    const draft = await convert({ inputPath: dir, options: { id: ID, sources: 'link' } });
    const intro = node(draft, 'content/chapter-7-brakes/introduction.md');
    assert.match(intro.body, /\n\nBrakes stop the car\. This paragraph continues on a second line and a third\.\n\nA second paragraph starts after a gap\.\n/);
    assert.equal(intro.data.description, 'Brakes stop the car. This paragraph continues on a second line and a third.');

    const checks = node(draft, 'content/chapter-7-brakes/checks.md');
    assert.match(checks.body, /\n\n- Check the fluid level\.\n- Check the pads\.\n\n1\. Pump the pedal\.\n2\. Listen for noise\.\n\n\*Figure 7-1\. A brake disc\.\*\n\nFigure 7-2 shows the caliper/);
    assert.match(checks.body, /\n## Pads\n\nPads wear over time/, 'a bold line at body size is a subheading');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('copy mode carries the PDFs in sources/, so the evidence is self-contained', async () => {
  const dir = corpus();
  try {
    const draft = await convert({ inputPath: dir, options: { id: ID } });
    assert.deepEqual(draft.files.map((f) => f.path), ['sources/chapter-7-brakes.pdf', 'sources/appendix-torque.pdf', 'structure.ttl']);
    const checks = node(draft, 'content/chapter-7-brakes/checks.md');
    assert.equal(checks.data.sources[0].resource, '../../sources/chapter-7-brakes.pdf');
    const { result, cleanup } = await written(draft);
    try {
      assert.equal(result.valid, true);
      assert.deepEqual(result.diagnostics.filter((d) => d.severity !== 'info'), []);
      assert.ok(result.capabilities.includes('self-contained-evidence'));
    } finally {
      cleanup();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a single PDF becomes a package titled from the document, with nodes directly under content/', async () => {
  const dir = corpus({ descriptor: false });
  try {
    const draft = await convert({ inputPath: join(dir, 'appendix.pdf'), options: { id: ID } });
    assert.equal(draft.manifest.title, 'Appendix: Torque');
    assert.deepEqual(draft.contentNodes.map((n) => n.path), ['content/wheel-nuts.md', 'content/caliper-bolts.md', 'content/index.md']);
    const nuts = node(draft, 'content/wheel-nuts.md');
    assert.equal(nuts.data.sources[0].resource, '../sources/appendix-torque.pdf');
    assert.match(nuts.body, /From Appendix: Torque, PDF page 1 /, 'without a printed number, the PDF page is named as such');
    const { result, cleanup } = await written(draft);
    try {
      assert.equal(result.valid, true);
    } finally {
      cleanup();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a changed or missing PDF, or link mode without urls, is refused', async () => {
  const dir = corpus();
  const bare = corpus({ descriptor: false });
  try {
    writeFileSync(join(dir, 'ch7.pdf'), makePdf(APPENDIX));
    await assert.rejects(convert({ inputPath: dir, options: { id: ID } }), (err) => err instanceof UsageError && /SHA-256/.test(err.message));
    rmSync(join(dir, 'ch7.pdf'));
    await assert.rejects(convert({ inputPath: dir, options: { id: ID } }), (err) => err instanceof UsageError && /missing; download it from https:\/\/example\.com\/manuals\/ch7\.pdf/.test(err.message));
    await assert.rejects(convert({ inputPath: bare, options: { id: ID, title: 'T', sources: 'link' } }), (err) => err instanceof UsageError && /needs a url/.test(err.message));
    await assert.rejects(convert({ inputPath: bare, options: { id: ID } }), (err) => err instanceof UsageError && /--title is required/.test(err.message));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
  }
});

test('running headers repeat across pages and are dropped; the footer number becomes the page label', () => {
  const line = (text, y) => ({ text, y, x: 72, size: 10 });
  const pages = [1, 2, 3].map((n) => ({ number: n, height: 792, lines: [line('Manual', 770), line(`Body ${n}`, 400), line(`${n + 10}`, 20)] }));
  const out = dropRunningLines(pages);
  assert.deepEqual(out.map((p) => p.lines.map((l) => l.text)), [['Body 1'], ['Body 2'], ['Body 3']]);
  assert.deepEqual(out.map((p) => p.label), ['11', '12', '13']);
});

test('heading levels come from type size, with bold body-size lines one level below', () => {
  const lines = [
    { text: 'Title', size: 18 },
    { text: 'Section', size: 13 },
    { text: 'Run-in heading', size: 10, bold: true },
    { text: 'Body text.', size: 10 },
    { text: 'Bold sentence.', size: 10, bold: true },
    { text: 'A', size: 10, bold: true },
    { text: 'B', size: 13 },
  ];
  assert.deepEqual([...fontHeadings(lines, 10)], [[0, 1], [1, 2], [2, 3], [6, 2]]);
});

test('an outline is used only when it covers the document', () => {
  assert.equal(usefulOutline([{ title: 'Structure Bookmarks', level: 1 }, { title: 'Title', level: 2, page: 1 }], 20), false);
  assert.equal(usefulOutline([{ title: 'A', level: 1, page: 13 }, { title: 'B', level: 1, page: 13 }, { title: 'C', level: 1, page: 14 }], 24), false);
  assert.equal(usefulOutline([{ title: 'A', level: 1, page: 1 }, { title: 'B', level: 2, page: 3 }, { title: 'C', level: 1, page: 9 }], 24), true);
  const lines = [{ page: 1, text: 'Intro text' }, { page: 3, text: 'Brake Pads' }, { page: 3, text: 'body' }, { page: 9, text: 'body' }];
  assert.deepEqual([...outlineHeadings(lines, [{ title: 'Brake pads', level: 2, page: 3 }, { title: 'Not on the page', level: 1, page: 9 }])], [[1, 2], [3, 1]]);
});

test('lines join into words and paragraphs as they were set', () => {
  assert.equal(joinLine('encap-', 'sulating'), 'encapsulating');
  assert.equal(joinLine('U.S.-', 'registered'), 'U.S.-registered');
  assert.equal(joinLine('accelerate/', 'decelerate'), 'accelerate/decelerate');
  assert.equal(joinLine('the', 'airplane'), 'the airplane');
  const at = (text, y, page = 1) => ({ text, y, page, x: 72, size: 10 });
  const blocks = toBlocks([at('91.417 requires records.', 700), at('12.Loss of control.', 680)], new Map(), 10);
  assert.deepEqual(blocks.map((b) => [b.kind, b.number ?? null, b.text]), [['paragraph', null, '91.417 requires records.'], ['item', 12, 'Loss of control.']]);
});

test('text before the first section is an opening section named by the headings above it', () => {
  const blocks = [
    { kind: 'heading', level: 1, text: 'Chapter 2', page: 1 },
    { kind: 'paragraph', text: 'Opening words.', page: 1 },
    { kind: 'heading', level: 2, text: 'First', page: 1 },
    { kind: 'paragraph', text: 'One.', page: 2 },
    { kind: 'heading', level: 2, text: 'Second', page: 3 },
    { kind: 'heading', level: 3, text: 'Detail', page: 3 },
    { kind: 'paragraph', text: 'Two.', page: 4 },
  ];
  assert.deepEqual(splitSections(blocks, 'Doc').map((s) => [s.title, s.pages, s.blocks.length]), [
    ['Chapter 2', [1], 1],
    ['First', [1, 2], 1],
    ['Second', [3, 4], 2],
  ]);
  assert.deepEqual(splitSections([{ kind: 'paragraph', text: 'Only text.', page: 1 }], 'Doc').map((s) => s.title), ['Doc']);
});

test('a PDF with no text layer is reported and left out', async () => {
  const dir = tempDir();
  try {
    mkdirSync(join(dir, 'in'));
    writeFileSync(join(dir, 'in', 'scan.pdf'), makePdf([[]]));
    writeFileSync(join(dir, 'in', 'text.pdf'), makePdf(APPENDIX));
    const draft = await convert({ inputPath: join(dir, 'in'), options: { id: ID, title: 'Mixed' } });
    assert.deepEqual(draft.warnings.map((w) => [w.code, w.file]), [['PDF_NO_TEXT', 'scan.pdf']]);
    assert.ok(draft.contentNodes.some((n) => n.path === 'content/wheel-nuts.md'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
