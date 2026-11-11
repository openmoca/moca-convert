// `youtube` adapter: a capture folder written by `moca-youtube` (see
// lib/youtube/capture.js) becomes one content node per video. The captions
// travel under media/ and the description under sources/, so every citation
// can be checked without a network; a playlist also gets a structure.ttl that
// keeps the videos in playlist order.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { joinFrontmatter } from '@openmoca/moca-core';
import { buildManifest } from '../manifest.js';
import { slugify } from '../slug.js';
import { UsageError } from '../target.js';
import { escapeInline, escapeText, firstLine, summary, turtleString, uniqueSlug } from '../text.js';
import { CAPTURE_FILE } from '../youtube/capture.js';
import { parseVtt } from '../youtube/json3-to-vtt.js';

export const name = 'youtube';
export const DEFAULT_TYPE = 'Video';

const MEDIA_FRAGS = 'http://www.w3.org/TR/media-frags/';
const PARAGRAPH_MS = 60_000;

/** @param {string} inputPath */
export function detect(inputPath) {
  return existsSync(inputPath) && statSync(inputPath).isDirectory() && existsSync(join(inputPath, CAPTURE_FILE));
}

/**
 * @param {{ inputPath: string, options: object }} ctx
 * @returns {import('./index.js').PackageDraft}
 */
export function convert({ inputPath, options }) {
  if (!detect(inputPath)) throw new UsageError(`${inputPath} is not a YouTube capture folder (no ${CAPTURE_FILE}); create one with moca-youtube.`);
  const capture = readJson(join(inputPath, CAPTURE_FILE));
  if (capture.videos.length === 0) throw new UsageError(`${inputPath} holds no videos.`);
  const playlist = capture.kind === 'playlist';
  const manifest = buildManifest({
    ...options,
    title: options.title ?? capture.title,
    description: options.description ?? summary(capture.description),
  });
  const type = options.type ?? DEFAULT_TYPE;
  const lang = options.language;
  const iri = (fragment) => `${manifest.id}#${fragment}`;

  const warnings = [];
  const contentNodes = [];
  const files = [];
  const taken = new Set(playlist ? ['index'] : []);
  const videos = capture.videos.map((id) => {
    const dir = join(inputPath, 'videos', id);
    const info = readJson(join(dir, 'info.json'));
    const vttPath = join(dir, 'captions.vtt');
    const vtt = existsSync(vttPath) ? readFileSync(vttPath, 'utf8').replace(/\r\n?/g, '\n') : undefined;
    return { info, vtt, slug: uniqueSlug(slugify(info.title), taken) };
  });

  for (const { info, vtt, slug } of videos) {
    const captionLang = info.captions?.language ?? lang ?? 'und';
    const captionsPath = `media/${slug}.${captionLang}.vtt`;
    const descriptionPath = `sources/${slug}.description.txt`;
    const description = info.description.replace(/\r\n?/g, '\n').trim();

    const sources = [{ id: 'video', resource: info.webpage_url, title: `${info.title} (YouTube${info.channel ? `, ${info.channel}` : ''})` }];
    const evidence = [];
    if (description) {
      files.push({ path: descriptionPath, body: `${description}\n` });
      sources.push({ id: 'description', resource: `../${descriptionPath}`, title: 'Video description' });
      evidence.push({ source: 'description', selector: { type: 'TextQuoteSelector', exact: firstLine(description) } });
    }
    const cues = vtt ? parseVtt(vtt) : [];
    if (vtt) {
      files.push({ path: captionsPath, body: vtt });
      sources.push({ id: 'captions', resource: `../${captionsPath}`, title: `${info.captions?.automatic ? 'Automatic captions' : 'Captions'} (${captionLang})` });
      for (const chapter of sections(info, cues)) {
        evidence.push({
          source: 'captions',
          selector: { type: 'FragmentSelector', conformsTo: MEDIA_FRAGS, value: `t=${chapter.start},${chapter.end}` },
          ...(chapter.title ? { note: chapter.title } : {}),
        });
      }
    } else {
      warnings.push({ code: 'YT_NO_CAPTIONS', message: `${info.title} has no captions; its node has no transcript.`, file: `videos/${info.id}` });
    }

    const data = {
      type,
      title: info.title,
      ...(description ? { description: summary(description) } : {}),
      resource: info.webpage_url,
      sources,
      moca: {
        ...(playlist ? { concepts: [{ iri: iri(`video-${info.id}`), role: 'primary' }] } : {}),
        ...(evidence.length > 0 ? { evidence } : {}),
      },
    };
    if (Object.keys(data.moca).length === 0) delete data.moca;
    contentNodes.push({ path: `content/${slug}.md`, body: joinFrontmatter(data, videoBody(info, description, cues)) });
  }

  if (playlist) {
    contentNodes.push({ path: 'content/index.md', body: playlistIndex(capture, videos) });
    files.push({ path: 'structure.ttl', body: playlistStructure(capture, videos, { iri, lang, title: manifest.title }) });
  }
  return { manifest, contentNodes, files, warnings };
}

function videoBody(info, description, cues) {
  const facts = [`[Watch on YouTube](${info.webpage_url})`];
  if (info.channel) facts.push(info.channel_url ? `[${escapeInline(info.channel)}](${info.channel_url})` : escapeInline(info.channel));
  if (info.upload_date) facts.push(`published ${info.upload_date.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3')}`);
  if (info.duration) facts.push(clock(info.duration));
  const out = [`# ${escapeInline(info.title)}`, facts.join(' · ')];
  if (description) out.push('## Description', escapeText(description));
  if (cues.length > 0) {
    out.push('## Transcript');
    for (const section of sections(info, cues)) {
      if (section.title) out.push(`### ${clock(section.start)} ${escapeInline(section.title)}`);
      for (const para of paragraphs(section.cues)) {
        out.push(`[${clock(para.start / 1000)}](https://youtu.be/${info.id}?t=${Math.floor(para.start / 1000)}) ${escapeInline(para.text)}`);
      }
    }
  }
  return `\n${out.join('\n\n')}\n`;
}

/**
 * The video's chapters with the cues each holds (by cue start), or the whole
 * video as one untitled section. Times are whole seconds.
 */
function sections(info, cues) {
  const lastEnd = Math.ceil((cues.at(-1)?.end ?? 0) / 1000);
  const end = Math.max(info.duration ?? 0, lastEnd);
  const chapters = info.chapters?.length > 0
    ? info.chapters.map((c, i) => ({ start: Math.floor(c.start), end: Math.ceil(c.end ?? end), title: chapterTitle(c.title, i) }))
    : [{ start: 0, end, title: null }];
  return chapters
    .map((c, i) => ({
      ...c,
      cues: cues.filter((cue) => cue.start >= c.start * 1000 && (i === chapters.length - 1 || cue.start < chapters[i + 1].start * 1000)),
    }))
    .filter((c) => c.cues.length > 0 && c.end > c.start);
}

// YouTube names a chapter it had to invent, before the first timestamp in
// the description, "<Untitled Chapter 1>".
function chapterTitle(title, index) {
  if (title && !/^<Untitled Chapter \d+>$/.test(title)) return title;
  return index === 0 ? 'Opening' : `Chapter ${index + 1}`;
}

function paragraphs(cues) {
  const out = [];
  for (const cue of cues) {
    const last = out.at(-1);
    if (last && cue.start - last.start < PARAGRAPH_MS) last.text += ` ${cue.text}`;
    else out.push({ start: cue.start, text: cue.text });
  }
  return out;
}

function playlistIndex(capture, videos) {
  const lines = [`# ${escapeInline(capture.title)}`, ''];
  const description = (capture.description ?? '').trim();
  if (description) lines.push(escapeText(description), '');
  lines.push(`Videos in [playlist](${capture.url}) order:`, '');
  videos.forEach(({ info, slug }, i) => lines.push(`${i + 1}. [${escapeInline(info.title)}](${slug}.md)`));
  return `${lines.join('\n')}\n`;
}

function playlistStructure(capture, videos, { iri, lang, title }) {
  const label = (text) => `${turtleString(text)}${lang ? `@${lang}` : ''}`;
  const ref = (fragment) => `<${iri(fragment)}>`;
  const members = videos.map(({ info }) => ref(`video-${info.id}`));
  const blocks = [
    '@prefix skos: <http://www.w3.org/2004/02/skos/core#> .\n@prefix dct: <http://purl.org/dc/terms/> .',
    `${ref('playlist')} a skos:Concept ;\n  skos:prefLabel ${label(capture.title ?? title)} ;\n  dct:hasPart ${members.join(',\n    ')} .`,
    `${ref('playlist-order')} a skos:OrderedCollection ;\n  skos:prefLabel ${label(`${capture.title ?? title} (playlist order)`)} ;\n  skos:memberList (\n    ${members.join('\n    ')}\n  ) .`,
    ...videos.map(({ info }) => `${ref(`video-${info.id}`)} a skos:Concept ;\n  skos:prefLabel ${label(info.title)} .`),
  ];
  return `${blocks.join('\n\n')}\n`;
}

/** Seconds as m:ss or h:mm:ss, as YouTube shows them. */
function clock(seconds) {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}
