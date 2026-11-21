import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { readPackage, splitFrontmatter } from '@openmoca/moca-core';
import { convert, detect } from '../lib/adapters/youtube.js';
import { resolveAdapterName } from '../lib/detect.js';
import { resolveInputTarget, UsageError } from '../lib/target.js';
import { writeDraft } from '../lib/write.js';
import { capture, chooseTrack, youtubeUrl } from '../lib/youtube/capture.js';
import { ytDlp } from '../lib/youtube/ytdlp.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'youtube');
const VIDEO = join(fixturesDir, 'video');
const PLAYLIST = join(fixturesDir, 'playlist');

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'moca-convert-test-'));
}

async function written(draft) {
  const outDir = join(tempDir(), 'pkg');
  await writeDraft({ draft, outDir });
  const result = await readPackage(outDir);
  return { outDir, result, cleanup: () => rmSync(dirname(outDir), { recursive: true, force: true }) };
}

function node(draft, path) {
  const found = draft.contentNodes.find((n) => n.path === path);
  assert.ok(found, `no node ${path}`);
  return { ...splitFrontmatter(found.body), text: found.body };
}

test('a capture folder is detected as youtube, and nothing else is', () => {
  assert.equal(detect(VIDEO), true);
  assert.equal(detect(fixturesDir), false);
  assert.equal(resolveAdapterName(resolveInputTarget(PLAYLIST)), 'youtube');
});

test('a single video becomes one node, with its captions under media/ and its description under sources/', async () => {
  const draft = convert({ inputPath: VIDEO, options: { id: 'https://example.com/test/tea', language: 'en' } });
  assert.equal(draft.manifest.title, 'Brewing Tea: A *Short* Guide');
  assert.equal(draft.manifest.description, 'How to brew tea well.');
  assert.deepEqual(draft.contentNodes.map((n) => n.path), ['content/brewing-tea-a-short-guide.md']);
  assert.deepEqual(draft.files.map((f) => f.path).sort(), [
    'media/brewing-tea-a-short-guide.en.vtt',
    'sources/brewing-tea-a-short-guide.description.txt',
  ]);

  const { data } = node(draft, 'content/brewing-tea-a-short-guide.md');
  assert.equal(data.type, 'Video');
  assert.equal(data.resource, 'https://www.youtube.com/watch?v=vid00000001');
  assert.deepEqual(data.sources.map((s) => s.id), ['video', 'description', 'captions']);
  assert.deepEqual(
    data.moca.evidence.map((e) => e.selector.value ?? e.selector.exact),
    ['How to brew tea well.', 't=0,10', 't=10,30'],
  );
  assert.equal(data.moca.concepts, undefined);
  assert.deepEqual(data.moca.media, [{ source: 'video', type: 'text/html', duration: 30, transcript: 'captions' }]);

  const { result, cleanup } = await written(draft);
  try {
    assert.equal(result.valid, true);
    assert.deepEqual(result.diagnostics.filter((d) => d.severity !== 'info'), []);
    assert.deepEqual(result.capabilities, ['core', 'located-evidence', 'self-contained-evidence']);
  } finally {
    cleanup();
  }
});

test('the transcript follows the chapters, and source text is not read as Markdown', () => {
  const draft = convert({ inputPath: VIDEO, options: { id: 'https://example.com/test/tea' } });
  const { body } = node(draft, 'content/brewing-tea-a-short-guide.md');
  assert.match(body, /^# Brewing Tea: A \\\*Short\\\* Guide$/m);
  assert.match(body, /^### 0:00 Opening$/m);
  assert.match(body, /^### 0:10 Steeping & timing$/m);
  assert.match(body, /^\[0:11\]\(<https:\/\/youtu\.be\/vid00000001\?t=11>\) Steep for three minutes & no longer\. Then pour\.$/m);
  assert.match(body, /^\\# Not a heading\\$/m);
  assert.match(body, /^1\\\. Not a list\\$/m);
  assert.match(body, /^More at <https:\/\/example\.com\/tea_guide>$/m);
});

test('a playlist keeps its order in structure.ttl and index.md, and binds each node to its concept', async () => {
  const id = 'https://example.com/test/kitchen';
  const draft = convert({ inputPath: PLAYLIST, options: { id, language: 'en' } });
  assert.deepEqual(draft.contentNodes.map((n) => n.path), [
    'content/knife-skills.md',
    'content/knife-skills-2.md',
    'content/boiling-water.md',
    'content/index.md',
  ]);

  const ttl = draft.files.find((f) => f.path === 'structure.ttl').body;
  const list = ttl.slice(ttl.indexOf('skos:memberList'));
  const order = ['pl-video-03', 'pl-video-01', 'pl-video-02'].map((v) => list.indexOf(`<${id}#video-${v}>`));
  assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])), 'members in playlist order');
  assert.match(ttl, /skos:prefLabel "Kitchen \\"Basics\\""@en/);

  const index = node(draft, 'content/index.md').text;
  assert.ok(index.indexOf('knife-skills.md') < index.indexOf('knife-skills-2.md'));
  assert.ok(index.indexOf('knife-skills-2.md') < index.indexOf('boiling-water.md'));

  assert.deepEqual(node(draft, 'content/knife-skills-2.md').data.moca.concepts, [{ iri: `${id}#video-pl-video-01`, role: 'primary' }]);

  const { result, cleanup } = await written(draft);
  try {
    assert.equal(result.valid, true);
    assert.deepEqual(result.diagnostics.filter((d) => d.severity !== 'info'), []);
    assert.ok(result.capabilities.includes('structured'));
  } finally {
    cleanup();
  }
});

test('a video whose captions run past its duration ends its range at the last caption, not after it', async () => {
  const dir = tempDir();
  try {
    const input = join(dir, 'capture');
    cpSync(VIDEO, input, { recursive: true });
    const video = join(input, 'videos', 'vid00000001');
    const info = JSON.parse(readFileSync(join(video, 'info.json'), 'utf8'));
    delete info.chapters;
    info.duration = 20;
    writeFileSync(join(video, 'info.json'), JSON.stringify(info));
    const vtt = readFileSync(join(video, 'captions.vtt'), 'utf8').replace('00:00:15.000 --> 00:00:20.000', '00:00:15.000 --> 00:00:20.400');
    writeFileSync(join(video, 'captions.vtt'), vtt);

    const draft = convert({ inputPath: input, options: { id: 'https://example.com/test/tea', language: 'en' } });
    const { data } = node(draft, 'content/brewing-tea-a-short-guide.md');
    assert.deepEqual(data.moca.evidence.filter((e) => e.source === 'captions').map((e) => e.selector.value), ['t=0,20.4']);
    assert.deepEqual(data.moca.media, [{ source: 'video', type: 'text/html', duration: 20, transcript: 'captions' }]);
    const { result, cleanup } = await written(draft);
    try {
      assert.deepEqual(result.diagnostics.filter((d) => d.severity !== 'info'), []);
    } finally {
      cleanup();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a video without captions is kept, without a transcript, and reported', () => {
  const draft = convert({ inputPath: PLAYLIST, options: { id: 'https://example.com/test/kitchen' } });
  assert.deepEqual(draft.warnings.map((w) => w.code), ['YT_NO_CAPTIONS']);
  const { data, body } = node(draft, 'content/boiling-water.md');
  assert.equal(data.moca.evidence, undefined);
  assert.doesNotMatch(body, /## Transcript/);
  assert.equal(draft.files.some((f) => f.path.startsWith('media/boiling-water')), false);
});

test('converting the same capture twice gives the same draft', () => {
  const options = { id: 'https://example.com/test/kitchen', language: 'en' };
  assert.deepEqual(convert({ inputPath: PLAYLIST, options }), convert({ inputPath: PLAYLIST, options }));
});

test('--title and --type override the capture', () => {
  const draft = convert({ inputPath: VIDEO, options: { id: 'https://example.com/test/tea', title: 'Tea', type: 'Lecture' } });
  assert.equal(draft.manifest.title, 'Tea');
  assert.equal(node(draft, 'content/brewing-tea-a-short-guide.md').data.type, 'Lecture');
});

test('a folder that is not a capture is refused', () => {
  assert.throws(() => convert({ inputPath: fixturesDir, options: { id: 'https://example.com/test/x' } }), UsageError);
});

// capture() with a stand-in for yt-dlp.

const JSON3 = { events: [{ tStartMs: 0, dDurationMs: 4000, segs: [{ utf8: 'Hello' }, { utf8: ' there' }] }] };

function fakeYtDlp({ playlist, fail = [] }) {
  const video = (id, extra = {}) => ({
    id,
    title: `Video ${id}`,
    description: `About ${id}.`,
    channel: 'Example Channel',
    duration: 4,
    view_count: 12345,
    formats: [{ url: 'https://signed.example/expiring' }],
    automatic_captions: { 'en-orig': [], en: [] },
    ...extra,
  });
  const calls = [];
  return {
    calls,
    async json(args) {
      calls.push(args);
      const url = args.at(-1);
      if (args.includes('--flat-playlist')) {
        return playlist
          ? { _type: 'playlist', id: 'PLx', title: 'A list', description: 'Some videos.', channel: 'Example Channel', entries: [{ id: 'b' }, { id: 'a' }, { id: 'c' }] }
          : video('solo');
      }
      const id = new URL(url).searchParams.get('v');
      if (fail.includes(id)) throw new Error('Video unavailable');
      return video(id, id === 'c' ? { automatic_captions: {} } : {});
    },
    async captions(info, track) {
      calls.push(['captions', info.id, track.language]);
      return JSON3;
    },
  };
}

test('capture writes the playlist in order, with stable metadata only', async () => {
  const dir = tempDir();
  try {
    const ytdlp = fakeYtDlp({ playlist: true });
    const result = await capture({ url: 'https://www.youtube.com/playlist?list=PLx', captureDir: dir, ytdlp });
    assert.deepEqual(result, { kind: 'playlist', videos: 3, warnings: ['c has no en captions.'] });

    const top = JSON.parse(readFileSync(join(dir, 'youtube-capture.json'), 'utf8'));
    assert.deepEqual(top.videos, ['b', 'a', 'c']);
    assert.equal(top.url, 'https://www.youtube.com/playlist?list=PLx');

    const info = JSON.parse(readFileSync(join(dir, 'videos', 'b', 'info.json'), 'utf8'));
    assert.equal(info.view_count, undefined);
    assert.equal(info.formats, undefined);
    assert.deepEqual(info.captions, { language: 'en', automatic: true });
    assert.match(readFileSync(join(dir, 'videos', 'b', 'captions.vtt'), 'utf8'), /00:00:00\.000 --> 00:00:04\.000\nHello there\n/);
    assert.equal(existsSync(join(dir, 'videos', 'c', 'captions.vtt')), false);
    assert.ok(ytdlp.calls.some((c) => c[0] === 'captions' && c[2] === 'en-orig'));

    const draft = convert({ inputPath: dir, options: { id: 'https://example.com/test/captured' } });
    assert.equal(draft.contentNodes.length, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('capture of a single video reuses the first lookup', async () => {
  const dir = tempDir();
  try {
    const ytdlp = fakeYtDlp({ playlist: false });
    const result = await capture({ url: 'https://www.youtube.com/watch?v=solo', captureDir: dir, ytdlp });
    assert.equal(result.kind, 'video');
    assert.equal(ytdlp.calls.filter((c) => c[0] !== 'captions').length, 1);
    assert.ok(existsSync(join(dir, 'videos', 'solo', 'captions.vtt')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('capture skips a video it cannot read, and says so', async () => {
  const dir = tempDir();
  try {
    const result = await capture({ url: 'https://www.youtube.com/playlist?list=PLx', captureDir: dir, ytdlp: fakeYtDlp({ playlist: true, fail: ['a'] }) });
    assert.equal(result.videos, 2);
    assert.match(result.warnings[0], /^Skipped a: Video unavailable/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('capture refuses a non-empty directory without --force', async () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, 'keep.txt'), 'x');
    await assert.rejects(capture({ url: 'u', captureDir: dir, ytdlp: fakeYtDlp({ playlist: false }) }), UsageError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('chooseTrack prefers the creator\'s captions, then automatic captions in the spoken language', () => {
  assert.deepEqual(chooseTrack({ subtitles: { 'en-GB': [], live_chat: [] }, automatic_captions: { 'en-orig': [] } }, 'en'), { language: 'en-GB', manual: true });
  assert.deepEqual(chooseTrack({ subtitles: { live_chat: [] }, automatic_captions: { en: [], 'en-orig': [] } }, 'en'), { language: 'en-orig', manual: false });
  assert.deepEqual(chooseTrack({ automatic_captions: { en: [] } }, 'en'), { language: 'en', manual: false });
  assert.equal(chooseTrack({ automatic_captions: { fr: [] } }, 'en'), null);
});

test('a capture file is checked on read: ids, URLs, dates and the caption language', async () => {
  const dir = tempDir();
  try {
    cpSync(VIDEO, dir, { recursive: true });
    const infoPath = join(dir, 'videos', 'vid00000001', 'info.json');
    const info = JSON.parse(readFileSync(infoPath, 'utf8'));
    Object.assign(info, {
      webpage_url: 'javascript:alert(1)',
      channel_url: 'https://example.com/a>b)c<script>',
      upload_date: '2026<b>x</b>',
      captions: { language: '../../escape', automatic: false },
    });
    writeFileSync(infoPath, JSON.stringify(info));
    const draft = convert({ inputPath: dir, options: { id: 'https://example.com/test/tea' } });
    const { data, body } = node(draft, draft.contentNodes[0].path);
    // The watch page falls back to the one the id gives; the channel URL is rebuilt; the bad date is left out.
    assert.equal(data.resource, 'https://www.youtube.com/watch?v=vid00000001');
    assert.match(body, /\[Example Channel\]\(<https:\/\/example\.com\/a%3Eb\)c%3Cscript%3E>\)/);
    assert.doesNotMatch(body, /javascript:|<b>|published/);
    assert.ok(draft.files.every((f) => !f.path.includes('..')));
    assert.ok(draft.files.some((f) => f.path.endsWith('.und.vtt')));
    const { result, cleanup } = await written(draft);
    try {
      assert.deepEqual(result.diagnostics.filter((d) => d.severity === 'error'), []);
    } finally {
      cleanup();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a capture that lists a video id that is not a plain id, or info for another video, is refused', () => {
  for (const bad of ['../x', 'a/b', '', 'a b', 7]) {
    const dir = tempDir();
    try {
      cpSync(VIDEO, dir, { recursive: true });
      const path = join(dir, 'youtube-capture.json');
      writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), videos: [bad] }));
      assert.throws(() => convert({ inputPath: dir, options: { id: 'https://example.com/test/x' } }), /is not a video id/, String(bad));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const dir = tempDir();
  try {
    cpSync(VIDEO, dir, { recursive: true });
    const infoPath = join(dir, 'videos', 'vid00000001', 'info.json');
    writeFileSync(infoPath, JSON.stringify({ ...JSON.parse(readFileSync(infoPath, 'utf8')), id: 'other' }));
    assert.throws(() => convert({ inputPath: dir, options: { id: 'https://example.com/test/x' } }), /not the info for video vid00000001/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('capture reads only YouTube URLs, and passes the URL after --', async () => {
  for (const url of ['https://example.com/watch?v=x', 'file:///etc/passwd', 'http://localhost:8080/', 'https://user@www.youtube.com/watch?v=x', '--exec=x', 'https://youtube.com.example/x']) {
    assert.throws(() => youtubeUrl(url), UsageError, url);
  }
  const dir = tempDir();
  try {
    const ytdlp = fakeYtDlp({ playlist: true });
    await capture({ url: 'https://www.youtube.com/playlist?list=PLx', captureDir: dir, ytdlp });
    for (const call of ytdlp.calls.filter((c) => c[0] !== 'captions')) assert.equal(call.at(-2), '--', call.join(' '));
    await assert.rejects(capture({ url: 'https://example.com/x', captureDir: tempDir(), ytdlp }), UsageError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('capture skips an entry whose id is not a plain id, and one that comes back as another video', async () => {
  const dir = tempDir();
  try {
    const ytdlp = fakeYtDlp({ playlist: true });
    const json = ytdlp.json.bind(ytdlp);
    ytdlp.json = async (args) => {
      const out = await json(args);
      if (args.includes('--flat-playlist')) out.entries = [{ id: '../../x' }, ...out.entries];
      if (out.id === 'a') out.id = 'not-a';
      return out;
    };
    const result = await capture({ url: 'https://www.youtube.com/playlist?list=PLx', captureDir: dir, ytdlp });
    assert.equal(result.videos, 2);
    assert.ok(result.warnings.some((w) => /not a plain id/.test(w)));
    assert.ok(result.warnings.some((w) => /Skipped a: yt-dlp returned another video/.test(w)));
    assert.equal(existsSync(join(dir, '..', 'x')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('yt-dlp runs with --ignore-config, and is stopped after its time limit', { skip: process.platform === 'win32' ? 'a shell script stands in for yt-dlp' : false }, async () => {
  const dir = tempDir();
  try {
    const argsFile = join(dir, 'args.txt');
    const echo = join(dir, 'echo-yt-dlp');
    writeFileSync(echo, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\necho '{}'\n`);
    chmodSync(echo, 0o755);
    await ytDlp({ bin: echo }).json(['--flat-playlist', '--', 'https://www.youtube.com/watch?v=x']);
    const args = readFileSync(argsFile, 'utf8').trim().split('\n');
    assert.equal(args[0], '--ignore-config');
    assert.deepEqual(args.slice(-2), ['--', 'https://www.youtube.com/watch?v=x']);

    const slow = join(dir, 'slow-yt-dlp');
    writeFileSync(slow, '#!/bin/sh\nsleep 5\n');
    chmodSync(slow, 0o755);
    await assert.rejects(ytDlp({ bin: slow, timeoutMs: 200 }).json(['--', 'https://www.youtube.com/watch?v=x']), /took longer than/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
