import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { convert, folderLabel } from '../lib/adapters/directory.js';
import { UsageError } from '../lib/target.js';
import { writeDraft } from '../lib/write.js';
import { readPackage } from '@openmoca/moca-core';

const lintPackage = async ({ rootDir }) => ({ findings: (await readPackage(rootDir)).diagnostics });

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'directory');

test('converts a nested directory of Markdown files into content nodes at matching paths', () => {
  const draft = convert({
    inputPath: join(fixturesDir, 'basic-nested'),
    options: { id: 'https://example.com/test/basic-nested', title: 'Basic Nested' },
  });

  const paths = draft.contentNodes.map((n) => n.path).sort();
  assert.deepEqual(paths, ['content/guides/advanced.md', 'content/guides/setup.md', 'content/intro.md']);
  assert.deepEqual(draft.manifest, {
    $schema: 'https://w3id.org/moca/schemas/v1/manifest.schema.json',
    mocaVersion: '0.6',
    id: 'https://example.com/test/basic-nested',
    version: '1.0.0',
    title: 'Basic Nested',
  });
});

test('a file with no frontmatter gains the OKF type, a title from its heading, and its concept', () => {
  const draft = convert({
    inputPath: join(fixturesDir, 'basic-nested'),
    options: { id: 'https://example.com/test/basic-nested', title: 'Basic Nested' },
  });
  const intro = draft.contentNodes.find((n) => n.path === 'content/intro.md');
  assert.ok(intro.body.startsWith(
    '---\ntype: Document\ntitle: Introduction\nmoca:\n  concepts:\n    - iri: https://example.com/test/basic-nested#intro\n      role: primary\n---\n',
  ));
  assert.ok(intro.body.includes('# Introduction'));
});

test('with --no-structure, a file gains only the OKF type and title, and there is no structure.ttl', () => {
  const draft = convert({
    inputPath: join(fixturesDir, 'basic-nested'),
    options: { id: 'https://example.com/test/basic-nested', title: 'Basic Nested', structure: false },
  });
  const intro = draft.contentNodes.find((n) => n.path === 'content/intro.md');
  assert.ok(intro.body.startsWith('---\ntype: Document\ntitle: Introduction\n---\n'));
  assert.equal(draft.files, undefined);
});

test('the folders become structure: parts, folder order, and each node bound to its concept', async () => {
  const draft = convert({
    inputPath: join(fixturesDir, 'basic-nested'),
    options: { id: 'https://example.com/test/basic-nested', title: 'Basic Nested', language: 'en' },
  });
  const ttl = draft.files.find((f) => f.path === 'structure.ttl').body;
  assert.match(ttl, /<https:\/\/example\.com\/test\/basic-nested#collection> a skos:Concept ;\n  skos:prefLabel "Basic Nested"@en ;\n  dct:hasPart <https:\/\/example\.com\/test\/basic-nested#guides>,\n    <https:\/\/example\.com\/test\/basic-nested#intro> \./);
  assert.match(ttl, /#guides> a skos:Concept ;\n  skos:prefLabel "Guides"@en ;\n  dct:hasPart <[^>]+#guides\/advanced>,\n    <[^>]+#guides\/setup> \./);
  assert.match(ttl, /#guides-order> a skos:OrderedCollection/);

  // The Reader reads it: the folder's nodes are found below it.
  const out = mkdtempSync(join(tmpdir(), 'moca-dir-structure-'));
  try {
    await writeDraft({ draft, outDir: join(out, 'pkg'), lint: lintPackage });
    const pkg = await readPackage(join(out, 'pkg'));
    assert.equal(pkg.diagnostics.filter((d) => d.severity !== 'info').length, 0, JSON.stringify(pkg.diagnostics));
    assert.ok(pkg.capabilities.includes('structured'));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('a folder is labelled by its index page, else by its name without an order number', () => {
  assert.equal(folderLabel('003-concepts/011-resource-management', new Map()), 'Resource management');
  assert.equal(folderLabel('guides', new Map([['guides/index.md', 'The guides']])), 'The guides');
  assert.equal(folderLabel('a/02_getting_started', new Map()), 'Getting started');
  assert.equal(folderLabel('03-part-3-law-enforcement-processing', new Map()), 'Part 3: Law enforcement processing');
  assert.equal(folderLabel('x/104-schedule-12a-the-information-commission', new Map()), 'Schedule 12A: The information commission');
});

test('--type overrides the adapter default type', () => {
  const draft = convert({
    inputPath: join(fixturesDir, 'basic-nested'),
    options: { id: 'https://example.com/test/basic-nested', title: 'Basic Nested', type: 'Runbook' },
  });
  assert.ok(draft.contentNodes.every((n) => n.body.includes('type: Runbook')));
});

test('a package id that is not an absolute URI is refused', () => {
  assert.throws(
    () => convert({ inputPath: join(fixturesDir, 'basic-nested'), options: { id: 'basic-nested', title: 'X' } }),
    UsageError,
  );
});

test('existing frontmatter, including a custom id, is preserved', () => {
  const draft = convert({
    inputPath: join(fixturesDir, 'frontmatter-preserved'),
    options: { id: 'https://example.com/test/frontmatter-preserved', title: 'Frontmatter Preserved' },
  });
  const [node] = draft.contentNodes;
  assert.match(node.body, /^---/);
  // js-yaml quotes values containing ":" on re-serialization, so the id
  // survives but isn't necessarily byte-identical to the source's own
  // (unquoted) frontmatter style.
  assert.match(node.body, /id:\s*['"]?urn:node:custom-id['"]?/);
  assert.match(node.body, /title:\s*Custom Document/);
});

test('--id is required', () => {
  assert.throws(
    () => convert({ inputPath: join(fixturesDir, 'basic-nested'), options: { title: 'X' } }),
    UsageError
  );
});

test('--title is required', () => {
  assert.throws(
    () => convert({ inputPath: join(fixturesDir, 'basic-nested'), options: { id: 'https://example.com/x' } }),
    UsageError
  );
});

test('a directory with no Markdown files is a usage error', () => {
  assert.throws(
    () =>
      convert({
        inputPath: join(fixturesDir, 'no-markdown'),
        options: { id: 'https://example.com/test/no-markdown', title: 'No Markdown' },
      }),
    UsageError
  );
});

test('end-to-end: converted output passes moca-lint with zero error-severity findings', async () => {
  const draft = convert({
    inputPath: join(fixturesDir, 'basic-nested'),
    options: { id: 'https://example.com/test/basic-nested', title: 'Basic Nested' },
  });
  const outDir = mkdtempSync(join(tmpdir(), 'moca-convert-test-'));
  try {
    await writeDraft({ draft, outDir });
    const { findings } = await lintPackage({ rootDir: outDir });
    const errors = findings.filter((f) => f.severity === 'error');
    assert.deepEqual(errors, []);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
