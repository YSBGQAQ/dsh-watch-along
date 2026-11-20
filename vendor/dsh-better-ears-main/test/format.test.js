import { test } from 'node:test';
import assert from 'node:assert/strict';

import { reportProbe, reportRhythm, reportTonal, reportSpeech, reportStatus, sec, pctOf } from '../lib/format.js';

test('format helpers never print NaN or undefined', () => {
  assert.equal(sec(83.4), '1:23.4');
  assert.equal(sec(8.2), '8.2s');
  assert.equal(sec(null), '—');
  assert.equal(pctOf(0.6), '60%');
  assert.equal(pctOf(undefined), '—');
});

test('probe reads truePeakDbtp from ffmpeg loudness', () => {
  const text = reportProbe({
    file: '/tmp/a.wav',
    durationSeconds: 10,
    container: 'wav',
    bytes: 1024 * 1024,
    bitRate: 1411200,
    tags: {},
    audio: [{ index: 0, codec: 'pcm_s16le', channels: 2, sampleRate: 44100, channelLayout: 'stereo' }],
    video: [],
    hasAudio: true,
    hasVideo: false,
  }, {
    loudness: { integratedLufs: -14.2, truePeakDbtp: -1.0, loudnessRangeLu: 5.1 },
    silences: { noiseDb: -35, minSilenceSeconds: 0.5, regions: [], totalSilentSeconds: 0 },
  });
  assert.match(text, /-1\.0 dBTP/);
  assert.match(text, /-14\.2 LUFS/);
  assert.doesNotMatch(text, /undefined|NaN/);
});

test('tonal prints chord root names from an array histogram', () => {
  const text = reportTonal({
    key: { key: 'C major', tonal: true, confidence: 0.9, margin: 0.1, runnerUp: 'A minor', noiseLike: false },
    chords: {
      segments: [{ root: 0, start: 0, end: 4, label: 'C', margin: 0.2, outOfKey: false }],
      rootsHistogram: [{ root: 0, name: 'C', share: 1 }],
      chordCount: 1,
      avgMargin: 0.2,
      keyCheck: { outOfKeyShare: 0, agreesWithKey: 1 },
    },
    melody: { voicedFraction: 0.5, tonal: false },
  });
  assert.match(text, /次优 A minor/);
  assert.match(text, /C 100%/);
  assert.doesNotMatch(text, /undefined|NaN/);
});

test('speech report says it did not call ASR when VAD found nothing', () => {
  const text = reportSpeech({
    provider: null,
    language: 'auto',
    vad: { totalSeconds: 8, speechSeconds: 0, thresholdDb: -20, noiseFloor: 1e-6, loud: 0.1 },
    segments: [],
    speechSeconds: 0,
    notes: ['没有检测到人声（能量低于动态阈值），未调用识别器。'],
  });
  assert.match(text, /未调用/);
  assert.match(text, /没有检测到人声/);
});

test('speech report keeps timestamps and the VAD honesty line', () => {
  const text = reportSpeech({
    vad: { totalSeconds: 5, speechSeconds: 4, thresholdDb: -30, noiseFloor: 1e-6, loud: 0.1 },
    segments: [{ start: 0, end: 2, text: '你好', seconds: 2, inferenceSeconds: 0.1 }],
    speechSeconds: 2,
    provider: 'test',
    language: 'zh',
    notes: [],
    srt: '1\n00:00:00,000 --> 00:00:02,000\n你好\n',
  }, { showSrt: true });
  assert.match(text, /人声切分/);
  assert.match(text, /你好/);
  assert.match(text, /SRT/);
});

test('status survives a host without ffmpeg or speechToText', () => {
  const text = reportStatus({
    ffmpeg: { ffmpeg: null, ffprobe: null, version: null, ffprobeVersion: null },
    sampleRate: 22050,
    cacheEntries: 3,
    asr: {
      transport: { kind: 'none' },
      speech: { present: false, providers: [] },
      local: null,
      needsDownload: false,
      endpoint: { configured: false },
      command: null,
      canTranscribe: false,
    },
  });
  assert.match(text, /dsh-better-ears 环境/);
  assert.match(text, /没有加载 speechToText/);
  assert.doesNotMatch(text, /undefined|NaN/);
});

test('rhythm report renders a rival BPM whether it arrives as number or object', () => {
  const base = {
    tempo: { bpm: 180, score: 0.46, ambiguity: 'marginal', rival: { bpm: 90 } },
    tracked: { beats: [0.5, 1, 1.5], medianIbiMs: 500, driftMs: 7, pulseClarity: 11.7, coverage: 1 },
    downbeat: { phase: 2, contrast: 0.13, ambiguous: true, beatsPerBar: 4 },
    onsets: { times: [0.5, 1] },
  };
  const obj = reportRhythm(base, {});
  assert.match(obj, /90\.0 BPM/);
  const num = reportRhythm({ ...base, tempo: { ...base.tempo, rival: 90 } }, {});
  assert.match(num, /90\.0 BPM/);
  const none = reportRhythm({ ...base, tempo: { ...base.tempo, ambiguity: 'ok', rival: null } }, {});
  assert.doesNotMatch(none, /倍频歧义/);
});
