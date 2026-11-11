// Collects what the youtube adapter converts: a capture folder holding each
// video's metadata and captions, in the order YouTube lists them.
//
//   youtube-capture.json          what was captured, and the video order
//   videos/<id>/info.json         the video's metadata, stable fields only
//   videos/<id>/captions.vtt      its captions as clean WebVTT, when it has any
//
// Everything that changes from one fetch to the next (view counts, signed
// media URLs, thumbnails) is left out, so a capture is worth reviewing and
// converting it twice gives the same package.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { UsageError } from '../target.js';
import { json3ToVtt } from './json3-to-vtt.js';

export const CAPTURE_FILE = 'youtube-capture.json';

/**
 * @param {object} params
 * @param {string} params.url
 * @param {string} params.captureDir
 * @param {string} [params.language]  caption language, BCP 47 (default en)
 * @param {boolean} [params.force]
 * @param {ReturnType<import('./ytdlp.js').ytDlp>} params.ytdlp
 * @param {(line: string) => void} [params.log]
 * @returns {Promise<{ kind: string, videos: number, warnings: string[] }>}
 */
export async function capture({ url, captureDir, language = 'en', force = false, ytdlp, log = () => {} }) {
  if (existsSync(captureDir) && readdirSync(captureDir).length > 0 && !force) {
    throw new UsageError(`Capture directory "${captureDir}" is not empty; pass --force to overwrite.`);
  }
  const warnings = [];
  log(`reading ${url}`);
  const top = await ytdlp.json(['--flat-playlist', url]);
  const isPlaylist = top._type === 'playlist';
  const entries = isPlaylist ? (top.entries ?? []).filter((e) => e?.id) : [top];

  const videos = [];
  for (const [i, entry] of entries.entries()) {
    const label = `${i + 1}/${entries.length} ${entry.title ?? entry.id}`;
    let info;
    try {
      info = isPlaylist ? await ytdlp.json(['--skip-download', watchUrl(entry.id)]) : entry;
    } catch (err) {
      warnings.push(`Skipped ${entry.id}: ${err.message}`);
      log(`skip   ${label}`);
      continue;
    }
    const track = chooseTrack(info, language);
    let vtt;
    if (track) {
      log(`fetch  ${label} (${track.manual ? 'captions' : 'automatic captions'}, ${track.language})`);
      const json3 = await ytdlp.captions(info, track);
      vtt = json3ToVtt(json3, `${track.manual ? 'Captions' : 'Automatic captions'} for ${watchUrl(info.id)}, from YouTube.`);
    } else {
      warnings.push(`${info.id} has no ${language} captions.`);
      log(`fetch  ${label} (no ${language} captions)`);
    }
    const dir = join(captureDir, 'videos', info.id);
    mkdirSync(dir, { recursive: true });
    writeJson(join(dir, 'info.json'), trimInfo(info, track));
    if (vtt) writeFileSync(join(dir, 'captions.vtt'), vtt);
    videos.push(info.id);
  }

  const first = entries[0] ?? {};
  writeJson(join(captureDir, CAPTURE_FILE), {
    kind: isPlaylist ? 'playlist' : 'video',
    id: top.id,
    url: isPlaylist ? `https://www.youtube.com/playlist?list=${top.id}` : watchUrl(top.id),
    title: top.title,
    description: top.description ?? '',
    channel: top.channel ?? top.uploader ?? first.channel ?? null,
    channel_url: top.channel_url ?? top.uploader_url ?? null,
    videos,
  });
  return { kind: isPlaylist ? 'playlist' : 'video', videos: videos.length, warnings };
}

/**
 * Picks the caption track: captions the creator supplied in `language`, or
 * failing that YouTube's automatic captions in the spoken language
 * (`<language>-orig`), then its automatic ones in `language`.
 * @returns {{ language: string, manual: boolean } | null}
 */
export function chooseTrack(info, language) {
  const manual = Object.keys(info.subtitles ?? {}).filter((k) => k !== 'live_chat');
  const auto = Object.keys(info.automatic_captions ?? {});
  const own = manual.find((k) => k === language) ?? manual.find((k) => k.startsWith(`${language}-`));
  if (own) return { language: own, manual: true };
  const asr = [`${language}-orig`, language].find((k) => auto.includes(k));
  return asr ? { language: asr, manual: false } : null;
}

export function watchUrl(id) {
  return `https://www.youtube.com/watch?v=${id}`;
}

function trimInfo(info, track) {
  return {
    id: info.id,
    title: info.title,
    description: info.description ?? '',
    channel: info.channel ?? info.uploader ?? null,
    channel_url: info.channel_url ?? info.uploader_url ?? null,
    upload_date: info.upload_date ?? null,
    duration: info.duration ?? null,
    webpage_url: watchUrl(info.id),
    license: info.license ?? null,
    chapters: (info.chapters ?? []).map((c) => ({ start: c.start_time, end: c.end_time, title: c.title })),
    captions: track ? { language: track.language.replace(/-orig$/, ''), automatic: !track.manual } : null,
  };
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
