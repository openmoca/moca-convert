// Writes a PackageDraft (see lib/adapters/index.js) to disk and gates
// success on the reference Reader reporting zero error-severity diagnostics:
// read first, refuse to leave invalid output behind.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readPackage } from '@openmoca/moca-core';
import { UsageError } from './target.js';

export { UsageError };

/**
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
  const outDirNonEmpty = outDirExists && readdirSync(outDir).length > 0;

  if (outDirNonEmpty && !force) {
    throw new UsageError(`Output directory "${outDir}" already exists and is not empty; pass --force to overwrite.`);
  }

  const useScratch = outDirNonEmpty;
  const stageDir = useScratch ? mkdtempSync(join(tmpdir(), 'moca-convert-')) : outDir;

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

    if (useScratch) {
      rmSync(outDir, { recursive: true, force: true });
      renameSync(stageDir, outDir);
    }

    return { findings, digest: result.digest };
  } catch (err) {
    // Never leave partial/invalid output behind: on any failure, remove the
    // staged directory. In scratch mode that's a temp dir, so the
    // pre-existing outDir is untouched; in direct mode stageDir === outDir,
    // so a freshly-created output directory is fully cleaned up.
    if (existsSync(stageDir)) {
      rmSync(stageDir, { recursive: true, force: true });
    }
    throw err;
  }
}

function stageDraft(draft, stageDir) {
  mkdirSync(stageDir, { recursive: true });
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
