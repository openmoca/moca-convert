// Adapter registry. Every adapter module exports `name`, `detect(inputPath)`,
// and `convert({ inputPath, options })`, which returns a PackageDraft or a
// promise of one. `detect`/`convert` never touch disk
// outside reading the source tree; all output writing goes through
// lib/write.js so determinism and the fail-closed lint gate live in one
// place instead of being duplicated per adapter.
//
// @typedef {object} ContentNode
// @property {string} path   - package-relative path under content/, forward slashes
// @property {string} body   - full file contents, including any frontmatter block
//
// @typedef {object} ConversionWarning
// @property {string} code
// @property {string} message
// @property {string} [file] - source-relative path, for user-facing messages
//
// @typedef {object} PackageDraft
// @property {object} manifest
// @property {ContentNode[]} contentNodes
// @property {{ path: string, body: string|Buffer }[]} [files] - other package files:
//   under sources/ or media/, or structure.ttl
// @property {ConversionWarning[]} warnings
import { UsageError } from '../target.js';
import * as directory from './directory.js';
import * as markdown from './markdown.js';
import * as obsidian from './obsidian.js';
import * as openapi from './openapi.js';
import * as pdf from './pdf.js';
import * as youtube from './youtube.js';

export const ADAPTER_NAMES = ['directory', 'markdown', 'obsidian', 'openapi', 'pdf', 'youtube'];

const IMPLEMENTED = {
  directory,
  markdown,
  obsidian,
  openapi,
  pdf,
  youtube,
};

/**
 * @param {string} name
 * @returns {{ name: string, detect: (inputPath: string) => boolean, convert: Function }}
 */
export function getAdapter(name) {
  const adapter = IMPLEMENTED[name];
  if (!adapter) {
    if (ADAPTER_NAMES.includes(name)) {
      throw new UsageError(`The "${name}" adapter is not implemented yet.`);
    }
    throw new UsageError(`Unknown adapter "${name}"; expected one of: ${ADAPTER_NAMES.join(', ')}.`);
  }
  return adapter;
}

/** Adapters usable by lib/detect.js auto-detection, in priority order. */
export function implementedAdapters() {
  return Object.values(IMPLEMENTED);
}
