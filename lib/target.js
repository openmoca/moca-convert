import { existsSync, statSync } from 'node:fs';

/**
 * Resolves and validates a conversion input path exists on disk, and reports
 * whether it's a file or a directory. Glob inputs (containing *, ?, or [)
 * are not resolvable via stat and are passed through unchanged for the
 * markdown adapter to expand itself.
 *
 * @param {string} inputPath
 * @returns {{ inputPath: string, isGlob: boolean, isDirectory: boolean, isFile: boolean }}
 */
export function resolveInputTarget(inputPath) {
  if (isGlobPattern(inputPath)) {
    return { inputPath, isGlob: true, isDirectory: false, isFile: false };
  }

  if (!existsSync(inputPath)) {
    throw new UsageError(`Input does not exist: ${inputPath}`);
  }

  const stats = statSync(inputPath);
  return {
    inputPath,
    isGlob: false,
    isDirectory: stats.isDirectory(),
    isFile: stats.isFile(),
  };
}

/** @param {string} inputPath */
export function isGlobPattern(inputPath) {
  return /[*?[\]]/.test(inputPath);
}

export class UsageError extends Error {}
