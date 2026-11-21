// Writes a PackageDraft (see lib/adapters/index.js) to disk and gates
// success on the reference Reader reporting zero error-severity diagnostics:
// read first, refuse to leave invalid output behind.
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { readPackage } from '@openmoca/moca-core';
import { UsageError } from './target.js';

export { UsageError };

/** A hidden name beside `outDir`, on the same file system, so a rename never crosses devices. */
const besideName = (outDir, tag) => join(dirname(resolve(outDir)), `.${basename(resolve(outDir))}.${randomBytes(6).toString('hex')}.${tag}`);

/**
 * Writes the draft to a folder beside `outDir`, checks it with the reference
 * Reader, and only then moves it into place. Anything already at `outDir` is
 * moved aside first and deleted once the new package is in; if the move fails,
 * it is put back. On any failure the staged folder is removed and `outDir` is
 * as it was.
 *
 * `force` replaces a non-empty `outDir` only when it is a previous package (it
 * has a moca.json); anything else is refused.
 *
 * @param {object} params
 * @param {import('./adapters/index.js').PackageDraft} params.draft
 * @param {string} params.outDir
 * @param {boolean} [params.force]
 * @param {boolean} [params.strict]
 * @param {(entry: string) => void} [params.onLog]
 * @returns {Promise<{ findings: object[], digest: string }>}
 */
export async function writeDraft({ draft, outDir, force = false, strict = false, onLog = () => {} }) {
  checkFiles(draft);
  const outDirExists = existsSync(outDir);
  if (outDirExists && !statSync(outDir).isDirectory()) {
    throw new UsageError(`Output "${outDir}" exists and is not a directory.`);
  }
  const outDirNonEmpty = outDirExists && readdirSync(outDir).length > 0;
  if (outDirNonEmpty && !force) {
    throw new UsageError(`Output directory "${outDir}" already exists and is not empty; pass --force to replace it.`);
  }
  if (outDirNonEmpty && !existsSync(join(outDir, 'moca.json'))) {
    throw new UsageError(`Output directory "${outDir}" is not a previous package (it has no moca.json), so --force will not replace it.`);
  }

  mkdirSync(dirname(resolve(outDir)), { recursive: true });
  const stageDir = besideName(outDir, 'partial');
  try {
    stageDraft(draft, stageDir);

    onLog(`reading ${stageDir}`);
    const result = await readPackage(stageDir, { strict });
    const findings = result.diagnostics;
    const errors = findings.filter((f) => f.severity === 'error');

    if (errors.length > 0) {
      throw new ConversionFailedError(
        'The converted package failed its own validation; no output was written.',
        findings
      );
    }

    replaceWith(stageDir, outDir, onLog);
    return { findings, digest: result.digest };
  } finally {
    // Never leave partial or invalid output behind. After a successful move
    // the staged folder no longer exists.
    rmSync(stageDir, { recursive: true, force: true });
  }
}

/** Moves the staged folder to `outDir`: the old one aside first, removed last. */
function replaceWith(stageDir, outDir, onLog) {
  if (!existsSync(outDir)) {
    renameSync(stageDir, outDir);
    return;
  }
  const aside = besideName(outDir, 'old');
  onLog(`moving the previous ${outDir} aside`);
  renameSync(outDir, aside);
  try {
    renameSync(stageDir, outDir);
  } catch (err) {
    renameSync(aside, outDir);
    throw err;
  }
  rmSync(aside, { recursive: true, force: true });
}

function stageDraft(draft, stageDir) {
  mkdirSync(stageDir);
  writeFileSync(join(stageDir, 'moca.json'), `${JSON.stringify(draft.manifest, null, 2)}\n`);

  for (const node of [...draft.contentNodes, ...(draft.files ?? [])]) {
    const absPath = join(stageDir, node.path);
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, node.body);
  }
}

// Adapters may add the evidence layer and the structure layer beside
// content/, and nothing else.
const OTHER_FILE = /^(?:(?:sources|media)\/(?:[^/]+\/)*[^/]+|structure\.ttl)$/;

function checkFiles(draft) {
  for (const file of draft.files ?? []) {
    if (!OTHER_FILE.test(file.path) || file.path.split('/').some((seg) => seg === '..' || seg === '.')) {
      throw new UsageError(`An adapter may only add files under sources/ or media/, or structure.ttl; refusing "${file.path}".`);
    }
  }
}

export class ConversionFailedError extends Error {
  /**
   * @param {string} message
   * @param {object[]} findings
   */
  constructor(message, findings) {
    super(message);
    this.findings = findings;
  }
}
