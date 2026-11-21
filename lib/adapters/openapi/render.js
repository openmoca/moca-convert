// Renders parsed OpenAPI operations into content nodes: either one node per
// operation, or one node per tag with each operation as a subsection.
import { joinFrontmatter } from '@openmoca/moca-core';
import { slugify } from '../../slug.js';
import { uniqueSlug } from '../../text.js';
import { resolveSchema } from './parse.js';

const OPERATION_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;

/**
 * @param {string} path
 * @param {string} method
 * @param {object} operation
 * @param {object} doc
 * @param {{ parameters?: object[], taken?: Set<string> }} [more]  `parameters`: the
 *   operation's and its path's (collectOperations); `taken`: file names already used,
 *   so two operations whose paths slug alike get distinct files
 * @returns {import('../index.js').ContentNode}
 */
export function renderOperationNode(path, method, operation, doc, { parameters = operation.parameters ?? [], taken = new Set() } = {}) {
  const title = firstNonEmpty(operation.summary, `${method.toUpperCase()} ${path}`);
  const operationId = safeOperationId(operation.operationId);
  const frontmatter = {
    type: 'API Operation',
    title,
    resource: `${method.toUpperCase()} ${path}`,
    ...(operationId ? { tags: [operationId] } : {}),
  };
  const body = `# ${title}\n\n${renderSections(operation, doc, 2, parameters)}`;
  return {
    path: `content/${uniqueSlug(`${method}-${slugifyOperationPath(path)}`, taken)}.md`,
    body: joinFrontmatter(frontmatter, body),
  };
}

/**
 * @param {string} tag
 * @param {Array<{ path: string, method: string, operation: object }>} operations
 * @param {object} doc
 * @returns {import('../index.js').ContentNode}
 */
export function renderTagNode(tag, operations, doc, taken = new Set()) {
  const sections = operations
    .map(({ path, method, operation, parameters }) => {
      const opTitle = firstNonEmpty(operation.summary, `${method.toUpperCase()} ${path}`);
      return `## ${method.toUpperCase()} ${path} — ${opTitle}\n\n${renderSections(operation, doc, 3, parameters ?? operation.parameters ?? [])}`;
    })
    .join('\n');
  const body = `# ${tag}\n\n${sections}`;
  return {
    path: `content/${uniqueSlug(slugify(tag), taken)}.md`,
    body: joinFrontmatter({ type: 'API Tag', title: tag }, body),
  };
}

/**
 * Renders the Description/Request/Responses subsections for one operation,
 * starting at the given heading level (2 for a standalone operation node's
 * "##" sections, 3 when nested one level deeper under a tag node's "## METHOD
 * path" heading).
 */
function renderSections(operation, doc, level, parameters) {
  const h = '#'.repeat(level);
  const hSub = '#'.repeat(level + 1);
  const lines = [];

  lines.push(`${h} Description`, '', describe(operation), '');

  const requestBody = operation.requestBody;
  if (parameters.length > 0 || requestBody) {
    lines.push(`${h} Request`, '');
    if (parameters.length > 0) {
      lines.push(...parameterTable(parameters), '');
    }
    const requestSchema = requestBody && firstJsonSchema(requestBody.content);
    if (requestSchema) {
      lines.push('```json', JSON.stringify(resolveSchema(requestSchema, doc), null, 2), '```', '');
    }
  }

  const responses = operation.responses ?? {};
  const statusCodes = Object.keys(responses).sort();
  if (statusCodes.length > 0) {
    lines.push(`${h} Responses`, '');
    for (const status of statusCodes) {
      const response = responses[status] ?? {};
      lines.push(`${hSub} ${status}`, '');
      if (typeof response.description === 'string' && response.description.trim()) {
        lines.push(response.description.trim(), '');
      }
      const responseSchema = firstJsonSchema(response.content);
      if (responseSchema) {
        lines.push('```json', JSON.stringify(resolveSchema(responseSchema, doc), null, 2), '```', '');
      }
    }
  }

  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd() + '\n';
}

function describe(operation) {
  return firstNonEmpty(operation.description, operation.summary, '_No description provided._').trim();
}

function parameterTable(parameters) {
  const rows = ['| Parameter | In | Required | Type |', '|---|---|---|---|'];
  for (const param of parameters) {
    rows.push(`| ${cell(param.name)} | ${cell(param.in)} | ${param.required ? 'yes' : 'no'} | ${cell(schemaType(param.schema))} |`);
  }
  return rows;
}

/** A table cell from the document: one line, with `|` escaped so it cannot add a column. */
function cell(value) {
  return typeof value === 'string' ? value.replace(/[\r\n]+/g, ' ').replace(/\\/g, '\\\\').replace(/\|/g, '\\|') : '';
}

function schemaType(schema) {
  if (!schema || typeof schema !== 'object') return '';
  if (typeof schema.type === 'string') return schema.type;
  if (typeof schema.$ref === 'string') return schema.$ref.split('/').pop();
  return '';
}

function firstJsonSchema(content) {
  if (!content || typeof content !== 'object') return null;
  const mediaType = content['application/json'] ?? Object.values(content)[0];
  return mediaType?.schema ?? null;
}

function safeOperationId(operationId) {
  return typeof operationId === 'string' && OPERATION_ID_PATTERN.test(operationId) ? operationId : undefined;
}

function slugifyOperationPath(path) {
  const segments = path
    .replace(/[{}]/g, '')
    .split('/')
    .filter(Boolean)
    .map((segment) => slugify(segment));
  return segments.length > 0 ? segments.join('-') : 'root';
}

function firstNonEmpty(...values) {
  return values.find((v) => typeof v === 'string' && v.trim().length > 0) ?? values[values.length - 1];
}
