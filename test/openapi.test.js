import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { convert } from '../lib/adapters/openapi.js';
import { UsageError } from '../lib/target.js';
import { writeDraft } from '../lib/write.js';
import { readPackage } from '@openmoca/moca-core';

const lintPackage = async ({ rootDir }) => ({ findings: (await readPackage(rootDir)).diagnostics });

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'openapi');

test('a suitable YAML document converts to one content node per operation', () => {
  const draft = convert({
    inputPath: join(fixturesDir, 'suitable.yaml'),
    options: { id: 'https://example.com/test/widget-api' },
  });
  assert.equal(draft.contentNodes.length, 3);
  assert.equal(draft.manifest.title, 'Widget API');
  assert.equal(draft.manifest.description, 'A small API for managing widgets.');
});

test('a suitable JSON document converts successfully', () => {
  const draft = convert({
    inputPath: join(fixturesDir, 'suitable.json'),
    options: { id: 'https://example.com/test/simple-api' },
  });
  assert.equal(draft.contentNodes.length, 1);
  assert.equal(draft.manifest.title, 'Simple API');
});

test('--title overrides info.title when given', () => {
  const draft = convert({
    inputPath: join(fixturesDir, 'suitable.json'),
    options: { id: 'https://example.com/test/simple-api', title: 'Overridden Title' },
  });
  assert.equal(draft.manifest.title, 'Overridden Title');
});

test('an operation becomes an OKF "API Operation" node tagged with its operationId', () => {
  const draft = convert({
    inputPath: join(fixturesDir, 'suitable.yaml'),
    options: { id: 'https://example.com/test/widget-api' },
  });
  const listWidgets = draft.contentNodes.find((n) => n.path === 'content/get-widgets.md');
  assert.ok(listWidgets, 'expected content/get-widgets.md to exist');
  assert.match(listWidgets.body, /^---\ntype: API Operation\n/);
  assert.match(listWidgets.body, /- listWidgets/);
});

test('a path-parameter operation slugifies braces out of the path', () => {
  const draft = convert({
    inputPath: join(fixturesDir, 'suitable.yaml'),
    options: { id: 'https://example.com/test/widget-api' },
  });
  assert.ok(draft.contentNodes.some((n) => n.path === 'content/get-widgets-id.md'));
});

test('a $ref in a request/response schema is resolved to its actual shape', () => {
  const draft = convert({
    inputPath: join(fixturesDir, 'suitable.yaml'),
    options: { id: 'https://example.com/test/widget-api' },
  });
  const createWidget = draft.contentNodes.find((n) => n.path === 'content/post-widgets.md');
  assert.match(createWidget.body, /"properties"/);
  assert.match(createWidget.body, /"name"/);
  assert.doesNotMatch(createWidget.body, /\$ref/);
});

test('title falls back to "METHOD path" when an operation has no summary', () => {
  const draft = convert({
    inputPath: join(fixturesDir, 'no-summary.yaml'),
    options: { id: 'https://example.com/test/no-summary' },
  });
  assert.match(draft.contentNodes[0].body, /^# GET \/items/m);
});

test('an unsuitable document (too few described operations) is refused (usage error), and nothing is written', () => {
  assert.throws(
    () =>
      convert({
        inputPath: join(fixturesDir, 'unsuitable-sparse-descriptions.yaml'),
        options: { id: 'https://example.com/test/sparse' },
      }),
    UsageError
  );
});

test('--min-description-ratio lowers the suitability bar', () => {
  const draft = convert({
    inputPath: join(fixturesDir, 'unsuitable-sparse-descriptions.yaml'),
    options: { id: 'https://example.com/test/sparse', minDescriptionRatio: 0.2 },
  });
  assert.equal(draft.contentNodes.length, 4);
});

test('an OpenAPI 2.0 (Swagger) document is explicitly rejected', () => {
  assert.throws(() => {
    convert({ inputPath: join(fixturesDir, 'swagger.json'), options: { id: 'https://example.com/x' } });
  }, /Swagger/);
});

test('--chunker tag groups operations by first tag, with an Untagged bucket', () => {
  const draft = convert({
    inputPath: join(fixturesDir, 'tag-grouped.yaml'),
    options: { id: 'https://example.com/test/tag-grouped', chunker: 'tag' },
  });
  const paths = draft.contentNodes.map((n) => n.path).sort();
  assert.deepEqual(paths, ['content/untagged.md', 'content/users.md', 'content/widgets.md']);

  const widgets = draft.contentNodes.find((n) => n.path === 'content/widgets.md');
  assert.match(widgets.body, /## GET \/widgets/);
  assert.match(widgets.body, /## POST \/widgets/);
});

test('an unknown --chunker value is a usage error', () => {
  assert.throws(
    () =>
      convert({
        inputPath: join(fixturesDir, 'suitable.json'),
        options: { id: 'https://example.com/x', chunker: 'not-a-real-mode' },
      }),
    UsageError
  );
});

test('--id is required', () => {
  assert.throws(
    () => convert({ inputPath: join(fixturesDir, 'suitable.json'), options: {} }),
    UsageError
  );
});

test('a document with no operations under paths is a usage error', () => {
  assert.throws(
    () => convert({ inputPath: join(fixturesDir, 'swagger.json'), options: { id: 'https://example.com/x' } }),
    UsageError
  );
});

test('end-to-end: converted output passes moca-lint with zero error-severity findings', async () => {
  const draft = convert({
    inputPath: join(fixturesDir, 'suitable.yaml'),
    options: { id: 'https://example.com/test/widget-api-e2e' },
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

/** Writes an OpenAPI document to a temporary JSON file and converts it. */
function convertDoc(doc, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'moca-openapi-'));
  const file = join(dir, 'api.json');
  writeFileSync(file, JSON.stringify({ openapi: '3.0.3', info: { title: 'T' }, ...doc }));
  try {
    return convert({ inputPath: file, options: { id: 'https://example.com/test/api', ...options } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const op = (summary, extra = {}) => ({ summary, description: `${summary}.`, responses: { 200: { description: 'OK' } }, ...extra });

test('two operations whose paths slug alike get distinct files', () => {
  const draft = convertDoc({ paths: { '/a-b': { get: op('Dash') }, '/a/b': { get: op('Slash') }, '/{a}/b': { get: op('Param') } } });
  const paths = draft.contentNodes.map((n) => n.path);
  assert.equal(new Set(paths).size, 3, paths.join(', '));
  assert.deepEqual(paths.sort(), ['content/get-a-b-2.md', 'content/get-a-b-3.md', 'content/get-a-b.md']);
});

test('schema references that fan out at each level are expanded only up to a budget', () => {
  const schemas = {};
  for (let i = 0; i < 40; i++) schemas[`S${i}`] = { type: 'object', properties: { l: { $ref: `#/components/schemas/S${i + 1}` }, r: { $ref: `#/components/schemas/S${i + 1}` } } };
  schemas.S40 = { type: 'string' };
  const started = Date.now();
  const draft = convertDoc({
    components: { schemas },
    paths: { '/x': { get: op('X', { responses: { 200: { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/S0' } } } } } }) } },
  });
  assert.ok(Date.now() - started < 5_000);
  const body = draft.contentNodes[0].body;
  assert.ok(body.length < 1_000_000, `${body.length} characters`);
  assert.match(body, /"\$ref": "#\/components\/schemas\/S\d+"|"…"/);
});

test('path-level and referenced parameters are listed, and an operation\'s own replaces the path\'s', () => {
  const draft = convertDoc({
    components: { parameters: { Limit: { name: 'limit', in: 'query', schema: { type: 'integer' } } } },
    paths: {
      '/items/{id}': {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, { name: 'v', in: 'header', schema: { type: 'string' } }],
        get: op('Get', { parameters: [{ $ref: '#/components/parameters/Limit' }, { name: 'v', in: 'header', required: true, schema: { type: 'integer' } }, { name: 'a|b', in: 'query' }] }),
      },
    },
  });
  const body = draft.contentNodes[0].body;
  assert.match(body, /\| id \| path \| yes \| string \|/);
  assert.match(body, /\| limit \| query \| no \| integer \|/);
  assert.match(body, /\| v \| header \| yes \| integer \|/);
  assert.doesNotMatch(body, /\| v \| header \| no \| string \|/);
  assert.match(body, /\| a\\\|b \| query \| no \|  \|/);
});
