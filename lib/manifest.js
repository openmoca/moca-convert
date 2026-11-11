// Builds the manifest every adapter writes.
import { UsageError } from './target.js';

const URI = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/;

/**
 * @param {{ id?: string, title?: string, version?: string, description?: string, language?: string, license?: string }} o
 */
export function buildManifest(o) {
  if (!o.id) throw new UsageError('--id is required.');
  if (!URI.test(o.id)) throw new UsageError(`--id must be an absolute URI (for example https://example.com/kb/support or tag:example.com,2026:kb), got "${o.id}".`);
  if (!o.title) throw new UsageError('--title is required.');
  return {
    $schema: 'https://w3id.org/moca/schemas/v1/manifest.schema.json',
    mocaVersion: '0.6',
    id: o.id,
    version: o.version ?? '1.0.0',
    title: o.title,
    ...(o.description ? { description: o.description } : {}),
    ...(o.language ? { language: o.language } : {}),
    ...(o.license ? { license: o.license } : {}),
  };
}
