// Parses an OpenAPI 3.x document (JSON or YAML) and walks its operations.
// Deliberately does not use a full OpenAPI parser/validator: content nodes
// only need to *display* request/response shapes as fenced code blocks, not
// machine-validate them, so only a small local (#/...) $ref resolver is
// implemented -- an external or unresolvable $ref is left as literal
// {"$ref": "..."} text in the rendered output rather than failing.
import { readFileSync } from 'node:fs';
import * as yaml from 'js-yaml';
import { UsageError } from '../../target.js';

export const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

/**
 * @param {string} inputPath
 * @returns {object} the parsed OpenAPI 3.x document
 */
export function parseOpenApiDocument(inputPath) {
  const raw = readFileSync(inputPath, 'utf8');
  const isYaml = /\.ya?ml$/i.test(inputPath);

  let doc;
  try {
    doc = isYaml ? yaml.load(raw) : JSON.parse(raw);
  } catch (err) {
    throw new UsageError(`Failed to parse "${inputPath}" as ${isYaml ? 'YAML' : 'JSON'}: ${err.message}`);
  }

  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new UsageError(`"${inputPath}" does not contain an OpenAPI document object.`);
  }
  if (typeof doc.swagger === 'string') {
    throw new UsageError(`"${inputPath}" is an OpenAPI 2.0 (Swagger) document; only OpenAPI 3.x is supported.`);
  }
  if (typeof doc.openapi !== 'string' || !/^3\.\d+\.\d+/.test(doc.openapi)) {
    throw new UsageError(`"${inputPath}" does not declare a supported "openapi: 3.x.x" version.`);
  }

  return doc;
}

/**
 * @param {object} doc
 * @returns {Array<{ path: string, method: string, operation: object, parameters: object[] }>}
 *   `parameters` are the operation's own and its path's, with local $refs
 *   resolved; the operation's own replaces a path parameter with the same
 *   name and location.
 *   sorted by path (lexicographic), then by a fixed HTTP method order --
 *   not object-insertion order, which isn't guaranteed stable across
 *   different JSON/YAML parsers.
 */
export function collectOperations(doc) {
  const paths = doc.paths ?? {};
  const operations = [];

  for (const path of Object.keys(paths)) {
    const pathItem = paths[path] ?? {};
    for (const method of HTTP_METHODS) {
      if (pathItem[method]) {
        const operation = pathItem[method];
        operations.push({ path, method, operation, parameters: mergeParameters(doc, pathItem.parameters, operation.parameters) });
      }
    }
  }

  operations.sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return HTTP_METHODS.indexOf(a.method) - HTTP_METHODS.indexOf(b.method);
  });

  return operations;
}

/** OpenAPI: a path's parameters apply to each of its operations, unless the operation lists one with the same name and `in`. */
function mergeParameters(doc, pathLevel, operationLevel) {
  const resolve = (list) => (Array.isArray(list) ? list : [])
    .map((p) => (typeof p?.$ref === 'string' ? resolveLocalRef(doc, p.$ref) ?? { name: p.$ref.split('/').pop(), in: '' } : p))
    .filter((p) => p && typeof p === 'object');
  const own = resolve(operationLevel);
  const key = (p) => `${p.name}\u0000${p.in}`;
  const ownKeys = new Set(own.map(key));
  return [...resolve(pathLevel).filter((p) => !ownKeys.has(key(p))), ...own];
}

/**
 * Resolves a local (same-document) JSON Pointer $ref, e.g.
 * "#/components/schemas/Widget". Returns undefined if the ref doesn't
 * resolve within `doc`.
 * @param {object} doc
 * @param {string} ref
 */
export function resolveLocalRef(doc, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return undefined;
  return ref
    .slice(2)
    .split('/')
    .map(decodeRefSegment)
    .reduce((node, key) => (node == null ? undefined : node[key]), doc);
}

function decodeRefSegment(segment) {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

/** The most objects and arrays one rendered schema may hold, however its references fan out. */
export const MAX_SCHEMA_NODES = 1_000;

/**
 * Recursively expands local $ref pointers within a schema/value so rendered
 * code blocks show the actual shape rather than a bare pointer. An external
 * ref (doesn't start with "#/"), an unresolvable ref, or a ref cycle is left
 * as a literal `{ "$ref": "..." }` marker instead of failing.
 *
 * The expansion is bounded: once it has made `maxNodes` objects and arrays,
 * every further reference is left as its `{ "$ref": "..." }` marker and every
 * further object as "…", so references that fan out at each level cannot
 * take exponential time or memory.
 * @param {*} value
 * @param {object} doc
 * @param {{ maxNodes?: number }} [limits]
 * @returns {*} the expanded value; `truncated` is not part of it
 */
export function resolveSchema(value, doc, { maxNodes = MAX_SCHEMA_NODES } = {}) {
  const ctx = { doc, nodes: 0, maxNodes };
  return expand(value, ctx, new Set());
}

function expand(value, ctx, seen) {
  if (value === null || typeof value !== 'object') return value;
  if (typeof value.$ref === 'string') {
    if (!value.$ref.startsWith('#/') || seen.has(value.$ref) || ctx.nodes >= ctx.maxNodes) return { $ref: value.$ref };
    const target = resolveLocalRef(ctx.doc, value.$ref);
    if (target === undefined) return { $ref: value.$ref };
    return expand(target, ctx, new Set(seen).add(value.$ref));
  }
  if (++ctx.nodes > ctx.maxNodes) return '…';
  if (Array.isArray(value)) return value.map((item) => expand(item, ctx, seen));

  const result = {};
  for (const [key, nested] of Object.entries(value)) {
    result[key] = expand(nested, ctx, seen);
  }
  return result;
}
