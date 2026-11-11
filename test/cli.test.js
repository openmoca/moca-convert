// Smoke tests that invoke the actual bin/moca-convert.js entrypoint via a
// subprocess, rather than calling library functions directly. The other
// test files exercise adapters/write.js/detect.js as libraries and would
// not catch a bug confined to CLI wiring itself (e.g. a module-level
// temporal-dead-zone reference, or an option not being threaded through) --
// this file exists specifically to catch that class of bug.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const binPath = join(packageDir, 'bin', 'moca-convert.js');
const fixturesDir = join(packageDir, 'test', 'fixtures');

function runCli(args) {
  return spawnSync(process.execPath, [binPath, ...args], { encoding: 'utf8' });
}

function tempOutDir() {
  const parent = mkdtempSync(join(tmpdir(), 'moca-convert-cli-test-'));
  return join(parent, 'pkg');
}

function cleanup(outDir) {
  rmSync(dirname(outDir), { recursive: true, force: true });
}

test('CLI: directory adapter succeeds end-to-end and exits 0', () => {
  const outDir = tempOutDir();
  try {
    const result = runCli([
      join(fixturesDir, 'directory', 'basic-nested'),
      '-o', outDir,
      '--id', 'https://example.com/test/cli-directory',
      '--title', 'CLI Directory',
    ]);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    cleanup(outDir);
  }
});

test('CLI: obsidian adapter succeeds end-to-end and exits 0', () => {
  const outDir = tempOutDir();
  try {
    const result = runCli([
      join(fixturesDir, 'obsidian', 'vault-basic'),
      '-o', outDir,
      '--id', 'https://example.com/test/cli-obsidian',
    ]);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    cleanup(outDir);
  }
});

test('CLI: markdown adapter succeeds end-to-end and exits 0', () => {
  const outDir = tempOutDir();
  try {
    const result = runCli([
      join(fixturesDir, 'markdown', 'loose-files', 'from-heading.md'),
      '-o', outDir,
      '--id', 'https://example.com/test/cli-markdown',
      '--title', 'CLI Markdown',
    ]);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    cleanup(outDir);
  }
});

test('CLI: openapi adapter succeeds end-to-end and exits 0', () => {
  const outDir = tempOutDir();
  try {
    const result = runCli([
      join(fixturesDir, 'openapi', 'suitable.yaml'),
      '-o', outDir,
      '--id', 'https://example.com/test/cli-openapi',
    ]);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    cleanup(outDir);
  }
});

test('CLI: an unsuitable openapi document exits 2', () => {
  const outDir = tempOutDir();
  try {
    const result = runCli([
      join(fixturesDir, 'openapi', 'unsuitable-sparse-descriptions.yaml'),
      '-o', outDir,
      '--id', 'https://example.com/test/cli-openapi-unsuitable',
    ]);
    assert.equal(result.status, 2);
  } finally {
    cleanup(outDir);
  }
});

test('CLI: missing --id exits 2', () => {
  const outDir = tempOutDir();
  try {
    const result = runCli([
      join(fixturesDir, 'directory', 'basic-nested'),
      '-o', outDir,
      '--title', 'No Id',
    ]);
    assert.equal(result.status, 2);
  } finally {
    cleanup(outDir);
  }
});

test('CLI: --exclude on a non-obsidian adapter is a usage error (exit 2)', () => {
  const outDir = tempOutDir();
  try {
    const result = runCli([
      join(fixturesDir, 'directory', 'basic-nested'),
      '-o', outDir,
      '--id', 'https://example.com/test/cli-bad-flag',
      '--title', 'X',
      '--exclude', 'notes/foo.md',
    ]);
    assert.equal(result.status, 2);
  } finally {
    cleanup(outDir);
  }
});

test('CLI: nonexistent input exits 2', () => {
  const outDir = tempOutDir();
  try {
    const result = runCli(['/no/such/path', '-o', outDir, '--id', 'https://example.com/x', '--title', 'X']);
    assert.equal(result.status, 2);
  } finally {
    cleanup(outDir);
  }
});
