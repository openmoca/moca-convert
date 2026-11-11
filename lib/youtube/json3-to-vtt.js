// Turns YouTube's json3 caption track into clean WebVTT.
//
// YouTube's own VTT for automatic captions repeats each line as it scrolls
// and carries per-word timing tags. json3 has one event per phrase instead,
// with durations that overlap the next phrase and newline-only "append"
// events in between. Each phrase with text becomes one cue, ending where the
// next one starts, so the cues never overlap and the text appears once.

/**
 * @param {{ events?: object[] }} json3
 * @returns {{ start: number, end: number, text: string }[]} times in milliseconds
 */
export function json3Cues(json3) {
  const phrases = [];
  for (const event of json3.events ?? []) {
    if (!Array.isArray(event.segs)) continue;
    const text = event.segs.map((s) => s.utf8 ?? '').join('').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const start = event.tStartMs ?? 0;
    phrases.push({ start, end: start + (event.dDurationMs ?? 0), text });
  }
  phrases.sort((a, b) => a.start - b.start);
  const cues = [];
  for (let i = 0; i < phrases.length; i++) {
    const next = phrases[i + 1];
    const end = next ? Math.min(phrases[i].end, next.start) : phrases[i].end;
    // A phrase that starts at the same instant as the next has no time of
    // its own; fold its text into the next rather than emit an empty cue.
    if (next && end <= phrases[i].start) {
      next.text = `${phrases[i].text} ${next.text}`;
      continue;
    }
    cues.push({ start: phrases[i].start, end: Math.max(end, phrases[i].start + 1), text: phrases[i].text });
  }
  return cues;
}

/**
 * @param {{ start: number, end: number, text: string }[]} cues
 * @param {string} [note]  a NOTE block written after the header
 * @returns {string}
 */
export function cuesToVtt(cues, note) {
  const blocks = ['WEBVTT'];
  if (note) blocks.push(`NOTE ${note.replace(/-->/g, '->').replace(/\n+/g, ' ')}`);
  cues.forEach((cue, i) => {
    blocks.push(`${i + 1}\n${vttTime(cue.start)} --> ${vttTime(cue.end)}\n${escapeCueText(cue.text)}`);
  });
  return `${blocks.join('\n\n')}\n`;
}

/** @param {object} json3 @param {string} [note] */
export function json3ToVtt(json3, note) {
  return cuesToVtt(json3Cues(json3), note);
}

/** Milliseconds as WebVTT hh:mm:ss.ttt. */
export function vttTime(ms) {
  const total = Math.max(0, Math.round(ms));
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor((total % 3_600_000) / 60_000);
  const s = Math.floor((total % 60_000) / 1000);
  const t = total % 1000;
  return `${pad(h)}:${pad(m)}:${pad(s)}.${String(t).padStart(3, '0')}`;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

// Cue payload may not contain "-->", and "&" and "<" start character
// references and tags, so they are written as references.
function escapeCueText(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Parses the cues back out of a WebVTT file written by cuesToVtt (or any
 * simple WebVTT): used by the adapter to build the transcript.
 * @param {string} text
 * @returns {{ start: number, end: number, text: string }[]}
 */
export function parseVtt(text) {
  const cues = [];
  for (const block of text.replace(/\r\n?/g, '\n').split(/\n{2,}/)) {
    const lines = block.split('\n');
    const at = lines.findIndex((l) => l.includes('-->'));
    if (at === -1) continue;
    const [from, to] = lines[at].split('-->').map((p) => parseTime(p.trim().split(/\s+/)[0]));
    if (from === undefined || to === undefined) continue;
    const payload = lines
      .slice(at + 1)
      .join(' ')
      .replace(/<[^>]*>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .trim();
    cues.push({ start: from, end: to, text: payload });
  }
  return cues;
}

function parseTime(value) {
  const m = /^(?:(\d+):)?(\d{2}):(\d{2})\.(\d{3})$/.exec(value ?? '');
  if (!m) return undefined;
  return ((Number(m[1] ?? 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4]);
}
