import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveInputTarget, UsageError } from '../lib/target.js';
import { resolveAdapterName } from '../lib/detect.js';

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'moca-convert-test-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('explicit --from is returned as-is without touching disk', () => {
  const target = { inputPath: 'does-not-matter', isGlob: false, isDirectory: false, isFile: false };
  assert.equal(resolveAdapterName(target, 'directory'), 'directory');
});

test('explicit --from with an unknown adapter name is a usage error', () => {
  const target = { inputPath: 'does-not-matter', isGlob: false, isDirectory: false, isFile: false };
  assert.throws(() => resolveAdapterName(target, 'not-a-real-adapter'), UsageError);
});

test('a glob input always requires an explicit --from', () => {
  const target = resolveInputTarget('content/*.md');
  assert.throws(() => resolveAdapterName(target), UsageError);
});

test('a directory containing only Markdown files detects as "directory"', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, 'a.md'), '# A\n');
    const target = resolveInputTarget(dir);
    assert.equal(resolveAdapterName(target), 'directory');
  });
});

test('a directory with an .obsidian/ folder detects as "obsidian"', () => {
  withTempDir((dir) => {
    mkdirSync(join(dir, '.obsidian'));
    writeFileSync(join(dir, 'note.md'), '# Note\n');
    const target = resolveInputTarget(dir);
    assert.equal(resolveAdapterName(target), 'obsidian');
  });
});

test('a directory with no Markdown and no OpenAPI document is ambiguous', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, 'notes.txt'), 'plain text\n');
    const target = resolveInputTarget(dir);
    assert.throws(() => resolveAdapterName(target), UsageError);
  });
});

test('a directory with both Markdown files and a top-level OpenAPI document is ambiguous', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, 'a.md'), '# A\n');
    writeFileSync(join(dir, 'api.json'), JSON.stringify({ openapi: '3.0.0', info: {}, paths: {} }));
    const target = resolveInputTarget(dir);
    assert.throws(() => resolveAdapterName(target), UsageError);
  });
});

test('a single .md file detects as "markdown"', () => {
  withTempDir((dir) => {
    const file = join(dir, 'doc.md');
    writeFileSync(file, '# Doc\n');
    const target = resolveInputTarget(file);
    assert.equal(resolveAdapterName(target), 'markdown');
  });
});

test('a single JSON file with an openapi 3.x key detects as "openapi"', () => {
  withTempDir((dir) => {
    const file = join(dir, 'api.json');
    writeFileSync(file, JSON.stringify({ openapi: '3.0.0', info: {}, paths: {} }));
    const target = resolveInputTarget(file);
    assert.equal(resolveAdapterName(target), 'openapi');
  });
});

test('a single YAML file with a swagger 2.0 key is explicitly rejected, not silently accepted', () => {
  withTempDir((dir) => {
    const file = join(dir, 'api.yaml');
    writeFileSync(file, 'swagger: "2.0"\ninfo:\n  title: Old API\n');
    const target = resolveInputTarget(file);
    assert.throws(() => resolveAdapterName(target), UsageError);
  });
});

test('a single JSON/YAML file that is neither Markdown nor OpenAPI-shaped is ambiguous', () => {
  withTempDir((dir) => {
    const file = join(dir, 'data.json');
    writeFileSync(file, JSON.stringify({ some: 'data' }));
    const target = resolveInputTarget(file);
    assert.throws(() => resolveAdapterName(target), UsageError);
  });
});

test('a nonexistent input path is a usage error', () => {
  assert.throws(() => resolveInputTarget('/does/not/exist/at/all'), UsageError);
});
