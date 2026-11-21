import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { convert } from '../lib/adapters/obsidian.js';
import { UsageError } from '../lib/target.js';
import { writeDraft } from '../lib/write.js';
import { readPackage } from '@openmoca/moca-core';

const lintPackage = async ({ rootDir }) => ({ findings: (await readPackage(rootDir)).diagnostics });

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'obsidian');

function node(draft, relPath) {
  const found = draft.contentNodes.find((n) => n.path === `content/notes/${relPath}`);
  assert.ok(found, `expected content/notes/${relPath} to exist`);
  return found;
}

test('.obsidian/ itself is not converted into a content node', () => {
  const draft = convert({
    inputPath: join(fixturesDir, 'vault-basic'),
    options: { id: 'https://example.com/test/vault-basic' },
  });
  assert.ok(!draft.contentNodes.some((n) => n.path.includes('.obsidian')));
  assert.equal(draft.contentNodes.length, 3);
});

test('--title defaults to the vault directory basename when omitted', () => {
  const draft = convert({
    inputPath: join(fixturesDir, 'vault-basic'),
    options: { id: 'https://example.com/test/vault-basic' },
  });
  assert.equal(draft.manifest.title, 'vault-basic');
});

test('a wikilink resolves via an alias to a relative Markdown link', () => {
  const draft = convert({
    inputPath: join(fixturesDir, 'vault-basic'),
    options: { id: 'https://example.com/test/vault-basic', title: 'Vault Basic' },
  });
  const reference = node(draft, 'Reference.md');
  assert.match(reference.body, /\[Getting Started\]\(\.\/Setup%20Guide\.md\)/);
});

test('a wikilink with a #heading anchor resolves and appends a slugified anchor', () => {
  const draft = convert({
    inputPath: join(fixturesDir, 'vault-basic'),
    options: { id: 'https://example.com/test/vault-basic', title: 'Vault Basic' },
  });
  const reference = node(draft, 'Reference.md');
  assert.match(reference.body, /\[Setup Guide\]\(\.\/Setup%20Guide\.md#installation\)/);
});

test('a wikilink with a |displayText alias renders that text as the link label', () => {
  const draft = convert({
    inputPath: join(fixturesDir, 'vault-basic'),
    options: { id: 'https://example.com/test/vault-basic', title: 'Vault Basic' },
  });
  const intro = node(draft, 'Introduction.md');
  assert.match(intro.body, /\[Get Started Here\]\(\.\/Setup%20Guide\.md\)/);
});

test('a link destination containing a space is percent-encoded so it stays one CommonMark link', () => {
  // "Setup Guide.md" (used by every fixture above) already exercises this;
  // assert the rule directly: a raw space never appears in a destination.
  const draft = convert({
    inputPath: join(fixturesDir, 'vault-basic'),
    options: { id: 'https://example.com/test/vault-basic', title: 'Vault Basic' },
  });
  const reference = node(draft, 'Reference.md');
  assert.doesNotMatch(reference.body, /\]\(Setup Guide\.md\)/, 'an unwrapped destination with a space must never appear');
});

test('wikilink syntax inside a fenced code block is left untouched', () => {
  const draft = convert({
    inputPath: join(fixturesDir, 'vault-basic'),
    options: { id: 'https://example.com/test/vault-basic', title: 'Vault Basic' },
  });
  const intro = node(draft, 'Introduction.md');
  assert.match(intro.body, /\[\[Should Not Rewrite\]\]/);
});

test('all frontmatter keys, including aliases, are preserved verbatim', () => {
  const draft = convert({
    inputPath: join(fixturesDir, 'vault-basic'),
    options: { id: 'https://example.com/test/vault-basic', title: 'Vault Basic' },
  });
  const setup = node(draft, 'Setup Guide.md');
  assert.match(setup.body, /aliases:/);
  assert.match(setup.body, /Getting Started/);
});

test('an unresolvable wikilink is left as literal text and produces a W_UNRESOLVED_WIKILINK warning', () => {
  const draft = convert({
    inputPath: join(fixturesDir, 'vault-unresolvable-link'),
    options: { id: 'https://example.com/test/unresolvable' },
  });
  const a = draft.contentNodes.find((n) => n.path === 'content/notes/A.md');
  assert.match(a.body, /\[\[Does Not Exist\]\]/);
  assert.ok(draft.warnings.some((w) => w.code === 'W_UNRESOLVED_WIKILINK'));
});

test('an embed (![[...]]) is left as literal text and produces a W_UNSUPPORTED_EMBED warning', () => {
  const draft = convert({
    inputPath: join(fixturesDir, 'vault-unresolvable-link'),
    options: { id: 'https://example.com/test/unresolvable' },
  });
  const a = draft.contentNodes.find((n) => n.path === 'content/notes/A.md');
  assert.match(a.body, /!\[\[diagram\.png\]\]/);
  assert.ok(draft.warnings.some((w) => w.code === 'W_UNSUPPORTED_EMBED'));
});

test('a wikilink to a note excluded via --exclude is left as literal text with a W_EXCLUDED_WIKILINK warning, and the excluded note produces no content node', () => {
  const draft = convert({
    inputPath: join(fixturesDir, 'vault-unresolvable-link'),
    options: { id: 'https://example.com/test/unresolvable', exclude: ['notes/Excluded Note.md'] },
  });
  assert.ok(!draft.contentNodes.some((n) => n.path === 'content/notes/Excluded Note.md'));
  const a = draft.contentNodes.find((n) => n.path === 'content/notes/A.md');
  assert.match(a.body, /\[\[Excluded Note\]\]/);
  assert.ok(draft.warnings.some((w) => w.code === 'W_EXCLUDED_WIKILINK'));
});

test('--id is required', () => {
  assert.throws(
    () => convert({ inputPath: join(fixturesDir, 'vault-basic'), options: {} }),
    UsageError
  );
});

test('a vault with no notes is a usage error', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'moca-convert-empty-vault-'));
  try {
    mkdirSync(join(outDir, '.obsidian'));
    assert.throws(
      () => convert({ inputPath: outDir, options: { id: 'https://example.com/x' } }),
      UsageError
    );
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('end-to-end: converted output passes moca-lint with zero error-severity findings', async () => {
  const draft = convert({
    inputPath: join(fixturesDir, 'vault-basic'),
    options: { id: 'https://example.com/test/vault-basic-e2e', title: 'Vault Basic E2E' },
  });
  const outDir = mkdtempSync(join(tmpdir(), 'moca-convert-test-'));
  try {
    await writeDraft({ draft, outDir });
    const { findings } = await lintPackage({ rootDir: outDir });
    assert.deepEqual(
      findings.filter((f) => f.severity === 'error'),
      []
    );
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('hidden folders such as .trash/ are not read, wikilinks in front matter are left alone, and every target is percent-encoded', async () => {
  const { cpSync, writeFileSync } = await import('node:fs');
  const vault = mkdtempSync(join(tmpdir(), 'moca-vault-'));
  try {
    cpSync(join(fixturesDir, 'vault-basic'), vault, { recursive: true });
    mkdirSync(join(vault, '.trash'));
    writeFileSync(join(vault, '.trash', 'Deleted.md'), '# Deleted\n');
    mkdirSync(join(vault, '.git'));
    writeFileSync(join(vault, '.git', 'note.md'), '# Not a note\n');
    writeFileSync(join(vault, 'notes', 'Odd (y & z.md'), '# Odd\n');
    writeFileSync(join(vault, 'notes', 'Linker.md'), '---\nrelated: "[[Setup Guide]]"\n---\n# Linker\n\nSee [[Odd (y & z]] and [[Setup Guide]].\n');
    const draft = convert({ inputPath: vault, options: { id: 'https://example.com/test/vault', title: 'Vault' } });
    assert.ok(draft.contentNodes.every((n) => !/\/\./.test(n.path)), draft.contentNodes.map((n) => n.path).join(', '));
    const linker = draft.contentNodes.find((n) => n.path.endsWith('Linker.md')).body;
    assert.match(linker, /related: "\[\[Setup Guide\]\]"/);
    assert.match(linker, /\[Setup Guide\]\(\.\/Setup%20Guide\.md\)/);
    assert.match(linker, /\[Odd \(y & z\]\(\.\/Odd%20%28y%20%26%20z\.md\)/);
    const out = join(mkdtempSync(join(tmpdir(), 'moca-vault-out-')), 'pkg');
    await writeDraft({ draft, outDir: out });
    const pkg = await readPackage(out);
    assert.deepEqual(pkg.diagnostics.filter((d) => d.severity !== 'info'), []);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});
