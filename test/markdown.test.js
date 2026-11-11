import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { convert } from '../lib/adapters/markdown.js';
import { UsageError } from '../lib/target.js';
import { writeDraft } from '../lib/write.js';
import { readPackage } from '@openmoca/moca-core';

const lintPackage = async ({ rootDir }) => ({ findings: (await readPackage(rootDir)).diagnostics });

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'markdown');

test('a single file input converts to one content node slugified from its title', () => {
  const draft = convert({
    inputPath: join(fixturesDir, 'loose-files', 'from-heading.md'),
    options: { id: 'https://example.com/test/single-file', title: 'Single File' },
  });
  assert.equal(draft.contentNodes.length, 1);
  assert.equal(draft.contentNodes[0].path, 'content/title-from-heading.md');
});

test('title precedence: frontmatter title wins over an H1 heading', () => {
  const draft = convert({
    inputPath: join(fixturesDir, 'loose-files', 'from-frontmatter.md'),
    options: { id: 'https://example.com/test/precedence', title: 'Precedence' },
  });
  assert.equal(draft.contentNodes[0].path, 'content/title-from-frontmatter.md');
});

test('title falls back to the H1 heading when there is no frontmatter title', () => {
  const draft = convert({
    inputPath: join(fixturesDir, 'loose-files', 'from-heading.md'),
    options: { id: 'https://example.com/test/heading', title: 'Heading' },
  });
  assert.equal(draft.contentNodes[0].path, 'content/title-from-heading.md');
});

test('title falls back to the filename when there is neither frontmatter title nor H1', () => {
  const draft = convert({
    inputPath: join(fixturesDir, 'loose-files', 'z-no-title-or-heading.md'),
    options: { id: 'https://example.com/test/filename-fallback', title: 'Filename Fallback' },
  });
  assert.equal(draft.contentNodes[0].path, 'content/z-no-title-or-heading.md');
});

test('a glob of multiple files converts each into a separate, sorted content node', () => {
  const draft = convert({
    inputPath: join(fixturesDir, 'loose-files', '*.md'),
    options: { id: 'https://example.com/test/glob', title: 'Glob' },
  });
  assert.equal(draft.contentNodes.length, 3);
});

test('duplicate slugs collide deterministically in sorted-input order (-2, -3, ...)', () => {
  const draft = convert({
    inputPath: join(fixturesDir, 'duplicate-titles', '*.md'),
    options: { id: 'https://example.com/test/duplicate-titles', title: 'Duplicate Titles' },
  });
  const paths = draft.contentNodes.map((n) => n.path).sort();
  assert.deepEqual(paths, ['content/getting-started-2.md', 'content/getting-started.md']);
});

test('--id is required', () => {
  assert.throws(
    () =>
      convert({
        inputPath: join(fixturesDir, 'loose-files', 'from-heading.md'),
        options: { title: 'X' },
      }),
    UsageError
  );
});

test('--title is required', () => {
  assert.throws(
    () =>
      convert({
        inputPath: join(fixturesDir, 'loose-files', 'from-heading.md'),
        options: { id: 'https://example.com/x' },
      }),
    UsageError
  );
});

test('a glob that matches nothing is a usage error', () => {
  assert.throws(
    () =>
      convert({
        inputPath: join(fixturesDir, 'loose-files', 'no-such-*.md'),
        options: { id: 'https://example.com/x', title: 'X' },
      }),
    UsageError
  );
});

test('end-to-end: converted output passes moca-lint with zero error-severity findings', async () => {
  const draft = convert({
    inputPath: join(fixturesDir, 'loose-files', '*.md'),
    options: { id: 'https://example.com/test/markdown-e2e', title: 'Markdown E2E' },
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
