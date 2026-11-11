import { test } from 'node:test';
import assert from 'node:assert/strict';
import { json3Cues, json3ToVtt, parseVtt, vttTime } from '../lib/youtube/json3-to-vtt.js';

const seg = (utf8) => ({ utf8 });

test('overlapping phrases become cues that end where the next begins', () => {
  const cues = json3Cues({
    events: [
      { tStartMs: 0, dDurationMs: 999999 },
      { tStartMs: 640, dDurationMs: 4480, segs: [seg('I'), seg(' hope')] },
      { tStartMs: 3030, dDurationMs: 2090, aAppend: 1, segs: [seg('\n')] },
      { tStartMs: 3040, dDurationMs: 4400, segs: [seg('it  works.')] },
    ],
  });
  assert.deepEqual(cues, [
    { start: 640, end: 3040, text: 'I hope' },
    { start: 3040, end: 7440, text: 'it works.' },
  ]);
});

test('a phrase with no time of its own joins the next', () => {
  const cues = json3Cues({ events: [{ tStartMs: 100, dDurationMs: 50, segs: [seg('a')] }, { tStartMs: 100, dDurationMs: 50, segs: [seg('b')] }] });
  assert.deepEqual(cues, [{ start: 100, end: 150, text: 'a b' }]);
});

test('WebVTT output escapes cue text and round-trips through parseVtt', () => {
  const vtt = json3ToVtt({ events: [{ tStartMs: 3_723_004, dDurationMs: 1000, segs: [seg('Fish & <chips> --> now')] }] }, 'A note');
  assert.equal(vtt, 'WEBVTT\n\nNOTE A note\n\n1\n01:02:03.004 --> 01:02:04.004\nFish &amp; &lt;chips&gt; --&gt; now\n');
  assert.deepEqual(parseVtt(vtt), [{ start: 3_723_004, end: 3_724_004, text: 'Fish & <chips> --> now' }]);
});

test('vttTime pads every field', () => {
  assert.equal(vttTime(0), '00:00:00.000');
  assert.equal(vttTime(61_005), '00:01:01.005');
});
