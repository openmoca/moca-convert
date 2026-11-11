#!/usr/bin/env node
// Captures a YouTube video or playlist (metadata, description, captions) with
// yt-dlp, then runs moca-convert on the capture to build the package.
import { Command } from 'commander';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UsageError } from '../lib/target.js';
import { capture } from '../lib/youtube/capture.js';
import { ytDlp } from '../lib/youtube/ytdlp.js';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const program = new Command();
program
  .name('moca-youtube')
  .description('Capture a YouTube video or playlist (metadata, description and captions) and convert it into a MOCA package.')
  .version(version, '-V, --cli-version', "output moca-youtube's own version")
  .argument('<url>', 'a YouTube video or playlist URL')
  .option('-o, --output <dir>', 'output package directory (required unless --no-convert)')
  .option('--id <uri>', 'package id: an absolute URI (required unless --no-convert)')
  .option('--capture-dir <dir>', 'keep the capture here (default: a temporary directory, removed afterwards)')
  .option('--title <string>', 'manifest title (default: the video or playlist title)')
  .option('--version <semver>', 'manifest version for the package', '1.0.0')
  .option('--type <type>', 'OKF type for each video node (default Video)')
  .option('--language <bcp47>', 'content language, and the caption language to fetch', 'en')
  .option('--license <spdx>', 'SPDX license expression for the package')
  .option('--yt-dlp <path>', 'the yt-dlp executable (default: $YT_DLP, else yt-dlp on PATH)')
  .option('--no-convert', 'only capture; do not run moca-convert')
  .option('--force', 'overwrite a non-empty capture or output directory', false)
  .option('-q, --quiet', 'suppress progress output', false)
  .action(run);

program.exitOverride();
program.parseAsync(process.argv).catch((err) => {
  if (err.code && err.code.startsWith('commander.')) {
    process.exit(err.code === 'commander.helpDisplayed' || err.code === 'commander.version' ? 0 : 2);
  }
  throw err;
});

async function run(url, options) {
  const log = options.quiet ? () => {} : (line) => console.error(`moca-youtube: ${line}`);
  let captureDir = options.captureDir;
  const temporary = !captureDir;
  try {
    if (options.convert && (!options.output || !options.id)) {
      throw new UsageError('--output and --id are required to convert; pass --no-convert to only capture.');
    }
    if (!options.convert && temporary) throw new UsageError('--no-convert needs --capture-dir, or the capture is thrown away.');
    if (temporary) captureDir = mkdtempSync(join(tmpdir(), 'moca-youtube-capture-'));

    const result = await capture({
      url,
      captureDir,
      language: options.language,
      force: options.force,
      ytdlp: ytDlp({ bin: options.ytDlp }),
      log,
    });
    for (const warning of result.warnings) console.error(`moca-youtube: WARNING ${warning}`);
    log(`captured ${result.videos} video(s) from a ${result.kind}${temporary ? '' : ` into ${captureDir}`}`);
    if (!options.convert) return;

    const args = [
      fileURLToPath(new URL('./moca-convert.js', import.meta.url)),
      captureDir, '--from', 'youtube',
      '-o', options.output,
      '--id', options.id,
      '--version', options.version,
      '--language', options.language,
      ...(options.title ? ['--title', options.title] : []),
      ...(options.type ? ['--type', options.type] : []),
      ...(options.license ? ['--license', options.license] : []),
      ...(options.force ? ['--force'] : []),
      ...(options.quiet ? ['--quiet'] : []),
    ];
    const converted = spawnSync(process.execPath, args, { stdio: 'inherit' });
    process.exitCode = converted.status ?? 1;
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`moca-youtube: ${err.message}`);
      process.exitCode = 2;
      return;
    }
    console.error(`moca-youtube: ${err.message}`);
    process.exitCode = 1;
  } finally {
    if (temporary && captureDir) rmSync(captureDir, { recursive: true, force: true });
  }
}
