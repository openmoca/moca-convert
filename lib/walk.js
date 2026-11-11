import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Recursively lists files under `dir`, returning paths relative to `rootDir`
 * (using forward slashes regardless of platform), sorted lexicographically
 * for deterministic iteration order.
 *
 * @param {string} dir
 * @param {string} rootDir
 * @returns {string[]}
 */
export function walkFiles(dir, rootDir = dir) {
  if (!existsSyncSafe(dir)) return [];
  const entries = readdirSync(dir, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(full, rootDir));
    } else if (entry.isFile()) {
      results.push(relative(rootDir, full).split('\\').join('/'));
    }
  }
  return results.sort();
}

function existsSyncSafe(dir) {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}
