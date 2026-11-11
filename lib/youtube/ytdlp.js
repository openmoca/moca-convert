// Runs yt-dlp (https://github.com/yt-dlp/yt-dlp), which does the talking to
// YouTube. It is spawned directly, never through a shell, so the same code
// runs on macOS, Linux and Windows.
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageError } from '../target.js';

const MAX_BUFFER = 512 * 1024 * 1024;

/**
 * @param {{ bin?: string }} [options]
 * @returns {{ json: (args: string[]) => Promise<object>, captions: (info: object, track: { language: string, manual: boolean }) => Promise<object> }}
 */
export function ytDlp({ bin = process.env.YT_DLP || 'yt-dlp' } = {}) {
  const run = (args) =>
    new Promise((resolve, reject) => {
      execFile(bin, args, { maxBuffer: MAX_BUFFER, windowsHide: true }, (err, stdout, stderr) => {
        if (err?.code === 'ENOENT') {
          reject(new UsageError(`Cannot run "${bin}". Install yt-dlp (https://github.com/yt-dlp/yt-dlp#installation) or pass --yt-dlp <path>.`));
        } else if (err) {
          reject(new Error(`yt-dlp ${args.join(' ')} failed: ${(stderr || err.message).trim()}`));
        } else {
          resolve(stdout);
        }
      });
    });

  return {
    async json(args) {
      return JSON.parse(await run(['--dump-single-json', '--no-warnings', ...args]));
    },

    // Reuses the metadata already fetched, so YouTube is only asked for the
    // caption track itself.
    async captions(info, { language, manual }) {
      const dir = mkdtempSync(join(tmpdir(), 'moca-youtube-'));
      try {
        const infoPath = join(dir, 'info.json');
        writeFileSync(infoPath, JSON.stringify(info));
        await run([
          '--load-info-json', infoPath,
          '--skip-download', '--no-warnings',
          manual ? '--write-subs' : '--write-auto-subs',
          '--sub-langs', language,
          '--sub-format', 'json3',
          '-o', join(dir, 'captions.%(ext)s'),
        ]);
        const file = readdirSync(dir).find((f) => f.endsWith('.json3'));
        if (!file) throw new Error(`yt-dlp wrote no ${language} caption track for ${info.id}.`);
        return JSON.parse(readFileSync(join(dir, file), 'utf8'));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
