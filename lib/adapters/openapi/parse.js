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
 * @returns {Array<{ path: string, method: string, operation: object }>}
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
        operations.push({ path, method, operation: pathItem[method] });
      }
    }
  }

  operations.sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return HTTP_METHODS.indexOf(a.method) - HTTP_METHODS.indexOf(b.method);
  });

  return operations;
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

/**
 * Recursively expands local $ref pointers within a schema/value so rendered
 * code blocks show the actual shape rather than a bare pointer. An external
 * ref (doesn't start with "#/"), an unresolvable ref, or a ref cycle is left
 * as a literal `{ "$ref": "..." }` marker instead of failing.
 * @param {*} value
 * @param {object} doc
 * @param {Set<string>} [seen]
 */
export function resolveSchema(value, doc, seen = new Set()) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => resolveSchema(item, doc, seen));

  if (typeof value.$ref === 'string') {
    if (!value.$ref.startsWith('#/') || seen.has(value.$ref)) return { $ref: value.$ref };
    const target = resolveLocalRef(doc, value.$ref);
    if (target === undefined) return { $ref: value.$ref };
    return resolveSchema(target, doc, new Set(seen).add(value.$ref));
  }

  const result = {};
  for (const [key, nested] of Object.entries(value)) {
    result[key] = resolveSchema(nested, doc, seen);
  }
  return result;
}
