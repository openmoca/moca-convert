import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeDraft, ConversionFailedError, UsageError } from '../lib/write.js';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'moca-convert-test-'));
}

const VALID_DRAFT = {
  manifest: { id: 'https://example.com/test/write', version: '1.0.0', title: 'Write Test' },
  contentNodes: [{ path: 'content/intro.md', body: '---\ntype: Note\n---\n# Intro\n' }],
  warnings: [],
};

const INVALID_DRAFT = {
  // Missing required "title" -> schema-invalid manifest -> lintPackage error finding.
  manifest: { id: 'https://example.com/test/write-invalid', version: '1.0.0' },
  contentNodes: [{ path: 'content/intro.md', body: '# Intro\n' }],
  warnings: [],
};

test('writes a valid draft into a fresh output directory', async () => {
  const outDir = join(tempDir(), 'pkg');
  try {
    const { findings } = await writeDraft({ draft: VALID_DRAFT, outDir });
    assert.deepEqual(
      findings.filter((f) => f.severity === 'error'),
      []
    );
    assert.ok(existsSync(join(outDir, 'moca.json')));
    assert.ok(existsSync(join(outDir, 'content', 'intro.md')));
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('a schema-invalid draft is rejected and leaves no output on disk (fresh directory case)', async () => {
  const outDir = join(tempDir(), 'pkg');
  try {
    await assert.rejects(writeDraft({ draft: INVALID_DRAFT, outDir }), ConversionFailedError);
    assert.equal(existsSync(outDir), false);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('refuses to write into a non-empty output directory without --force', async () => {
  const outDir = tempDir();
  writeFileSync(join(outDir, 'existing.txt'), 'pre-existing content\n');
  try {
    await assert.rejects(writeDraft({ draft: VALID_DRAFT, outDir }), UsageError);
    assert.equal(readFileSync(join(outDir, 'existing.txt'), 'utf8'), 'pre-existing content\n');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('a schema-invalid draft with --force leaves the pre-existing output directory untouched', async () => {
  const outDir = tempDir();
  writeFileSync(join(outDir, 'existing.txt'), 'pre-existing content\n');
  try {
    await assert.rejects(writeDraft({ draft: INVALID_DRAFT, outDir, force: true }), ConversionFailedError);
    assert.equal(readFileSync(join(outDir, 'existing.txt'), 'utf8'), 'pre-existing content\n');
    assert.equal(existsSync(join(outDir, 'moca.json')), false);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('a valid draft with --force replaces a pre-existing non-empty output directory', async () => {
  const outDir = tempDir();
  writeFileSync(join(outDir, 'existing.txt'), 'pre-existing content\n');
  try {
    await writeDraft({ draft: VALID_DRAFT, outDir, force: true });
    assert.equal(existsSync(join(outDir, 'existing.txt')), false);
    assert.ok(existsSync(join(outDir, 'moca.json')));
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('an adapter may add files under sources/ and media/, and structure.ttl, and nothing else', async () => {
  for (const path of ['moca.json', 'content/x.md', 'attestations/a.json', 'sources/../moca.json', '/etc/passwd', 'media/./a.vtt', 'structure.json']) {
    const outDir = join(tempDir(), 'pkg');
    await assert.rejects(writeDraft({ draft: { ...VALID_DRAFT, files: [{ path, body: 'x' }] }, outDir }), UsageError, path);
    assert.equal(existsSync(outDir), false);
  }
  const outDir = join(tempDir(), 'pkg');
  try {
    const files = [{ path: 'sources/a/b.txt', body: 'b' }, { path: 'media/c.vtt', body: 'WEBVTT\n' }];
    await writeDraft({ draft: { ...VALID_DRAFT, files }, outDir });
    assert.equal(readFileSync(join(outDir, 'sources', 'a', 'b.txt'), 'utf8'), 'b');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
