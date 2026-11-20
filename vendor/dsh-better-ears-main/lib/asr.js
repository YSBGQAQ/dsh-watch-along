/**
 * Speech-to-text for dsh-better-ears.
 *
 * Three transports, tried in the order that costs the user least:
 *   1. host  — DSH's own `speechToText` service (local SenseVoice, offline)
 *   2. http  — any OpenAI-compatible /audio/transcriptions endpoint
 *   3. cmd   — a user-supplied command template
 *
 * Whatever the transport, the audio is cut the same way: energy VAD first, so the
 * recognizer only ever sees speech. That is what keeps a whisper-class model from
 * inventing sentences over music, silence or applause, and it is why the report can
 * claim "we skipped 41.2 s of non-speech" instead of silently transcribing it.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { canonicalizeWav, probe, wav16k } from './audio.js';

/** Sentences whisper-family models emit over silence; dropping them needs a short window to be safe. */
export const HALLUCINATIONS = [
  '谢谢观看', '谢谢收看', '谢谢大家', '请不吝点赞', '订阅', '转发', '打赏', '字幕由', '字幕提供',
  '明镜与点点', 'amara.org', 'thanks for watching', 'thank you for watching', 'subscribe',
  'please subscribe', 'like and subscribe', 'subtitles by', 'transcribed by', 'www.',
];

export class AsrError extends Error {
  constructor(code, message, hint) {
    super(message);
    this.name = 'AsrError';
    this.code = code;
    this.hint = hint;
  }
}

/* ------------------------------------------------------------------ service */

/** The host recognizer, or null. `ctx.speechToText` throws for undeclared services, so never touch it directly. */
export function speechService(ctx) {
  try {
    const service = ctx?.get?.('speechToText');
    if (!service || typeof service.resolve !== 'function' || typeof service.transcribe !== 'function') return null;
    return service;
  } catch {
    return null;
  }
}

/** Snapshot in a shape the report can print without knowing DSH's types. */
export function describeSpeech(ctx) {
  const service = speechService(ctx);
  if (!service) return { present: false, providers: [], selection: null };
  let snap;
  try {
    snap = service.snapshot();
  } catch (error) {
    return { present: true, providers: [], selection: null, error: String(error?.message || error) };
  }
  const providers = (snap?.providers || []).map((p) => ({
    id: p.id,
    name: p.name,
    location: p.location,
    languages: p.languages || [],
    phase: p.preparation?.phase || 'unknown',
    step: p.preparation?.step ?? null,
    completedBytes: p.preparation?.completedBytes ?? null,
    totalBytes: p.preparation?.totalBytes ?? null,
    message: p.preparation?.message ?? null,
    setupEstimate: p.setupEstimate ?? null,
  }));
  return { present: true, providers, selection: snap?.selection ?? null };
}

function providerOf(service, id) {
  try {
    const snap = service.snapshot();
    const wanted = id || snap?.selection?.providerId;
    return (snap?.providers || []).find((p) => p.id === wanted) || null;
  } catch {
    return null;
  }
}

const READY_PHASES = new Set(['ready', 'standby']);
const DEAD_PHASES = new Set(['failed', 'cancelling']);

/**
 * Make one provider usable.
 *
 * `prepare()` is deliberately not awaited: DSH resolves it when the model finishes
 * downloading, which can be minutes; polling the snapshot lets us print real progress.
 */
export async function ensureProvider(service, { providerId = null, timeoutMs = 60_000, onProgress = null } = {}) {
  const first = providerOf(service, providerId);
  if (!first) {
    const snap = service.snapshot?.() || {};
    const ids = (snap.providers || []).map((p) => p.id);
    throw new AsrError(
      'no-provider',
      ids.length
        ? `speech provider "${providerId || snap?.selection?.providerId}" is not registered (have: ${ids.join(', ')})`
        : 'DSH has no speech-to-text provider loaded',
      '在 DSH 设置 → 语音输入 里启用本地识别，或在 dsh-better-ears 设置页点击「启用本地识别」。',
    );
  }
  const id = first.id;
  if (!first.preparation) return id;
  if (READY_PHASES.has(first.preparation.phase)) return id;
  if (DEAD_PHASES.has(first.preparation.phase)) {
    throw new AsrError('provider-failed', `speech provider "${id}" is ${first.preparation.phase}: ${first.preparation.message || 'no detail'}`,
      '打开 dsh-better-ears 设置页查看下载/加载错误，或改用远端接口。');
  }

  const deadline = Date.now() + timeoutMs;
  const started = Promise.resolve()
    .then(() => service.prepare(id))
    .catch(() => null); // failures surface through the snapshot's `failed` phase
  void started;

  let lastStep = '';
  for (;;) {
    const view = providerOf(service, id);
    const prep = view?.preparation;
    if (!prep) return id;
    if (READY_PHASES.has(prep.phase)) return id;
    if (prep.phase === 'failed') {
      throw new AsrError('provider-failed', `speech provider "${id}" failed: ${prep.message || 'no detail'}`,
        '打开 dsh-better-ears 设置页查看错误详情。');
    }
    const pct = prep.totalBytes ? Math.floor((100 * (prep.completedBytes || 0)) / prep.totalBytes) : null;
    const label = `${prep.phase}${prep.step ? `/${prep.step}` : ''}${pct === null ? '' : ` ${pct}%`}`;
    if (label !== lastStep) {
      lastStep = label;
      onProgress?.({ providerId: id, phase: prep.phase, step: prep.step ?? null, percent: pct, completedBytes: prep.completedBytes ?? null, totalBytes: prep.totalBytes ?? null });
    }
    if (Date.now() > deadline) {
      throw new AsrError('provider-timeout', `speech provider "${id}" was still ${prep.phase} after ${Math.round(timeoutMs / 1000)}s`,
        '首次使用需要下载模型；在 dsh-better-ears 设置页点「启用本地识别」并等待下载完成，或先用远端接口。');
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/* ---------------------------------------------------------------- vtt math */

/** 16-bit mono PCM out of a canonical WAV. */
export function pcmFromWav(buffer) {
  const buf = canonicalizeWav(buffer);
  return { pcm: buf.subarray(44), sampleRate: buf.readUInt32LE(24), durationSeconds: (buf.length - 44) / 2 / buf.readUInt32LE(24) };
}

/** A canonical 44-byte-header WAV around raw PCM16 (what the host recognizer insists on). */
export function wavFromPcm(pcm, sampleRate = 16_000) {
  const data = pcm.length % 2 ? pcm.subarray(0, pcm.length - 1) : pcm;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/* ------------------------------------------------------------------- to text */

function pct(values, q) {
  if (!values.length) return 0;
  const sorted = Float64Array.from(values).sort();
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[i];
}

/**
 * Energy voice activity.
 *
 * Threshold is relative to the recording, never absolute: `max(3×noise floor, 25% of p90)`
 * — the same shape soundtry uses. Absolute thresholds break on phone recordings (−45 dBFS
 * speech) and on loud masters alike.
 */
export function voiceBlocks(samples, sampleRate, {
  frameSeconds = 0.03,
  minSpeechSeconds = 0.2,
  minGapSeconds = 0.35,
  padSeconds = 0.2,
  thresholdRatio = 0.25,
  noiseMultiple = 3,
} = {}) {
  const frame = Math.max(1, Math.round(frameSeconds * sampleRate));
  const count = Math.floor(samples.length / frame);
  if (count === 0) return { blocks: [], threshold: 0, noiseFloor: 0, speechSeconds: 0, totalSeconds: samples.length / sampleRate };
  const rms = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    let sum = 0;
    const off = i * frame;
    for (let j = 0; j < frame; j++) {
      const v = samples[off + j];
      sum += v * v;
    }
    rms[i] = Math.sqrt(sum / frame);
  }
  const noiseFloor = pct(rms, 0.1);
  const loud = pct(rms, 0.9);
  const dynamicDb = 20 * Math.log10((loud || 1e-9) / (noiseFloor || 1e-9));
  // A recording with almost no dynamic range — a steady tone, mains hum, a wall of
  // continuous speech with no pauses — makes noiseFloor ≈ loud, and 3×noiseFloor then
  // lands ABOVE the loudest frame and silently drops every word. When that happens there
  // is nothing to cut away: keep everything and let the recognizer decide.
  const flat = dynamicDb < 6;
  const threshold = flat ? loud * 0.5 : Math.max(noiseFloor * noiseMultiple, loud * thresholdRatio);

  const raw = [];
  let start = -1;
  for (let i = 0; i < count; i++) {
    const on = rms[i] > threshold;
    if (on && start < 0) start = i;
    if (!on && start >= 0) { raw.push([start, i]); start = -1; }
  }
  if (start >= 0) raw.push([start, count]);

  // Close short holes (breaths, stop consonants) so one sentence is not cut in three.
  const merged = [];
  for (const [s, e] of raw) {
    const last = merged[merged.length - 1];
    if (last && (s - last[1]) * frameSeconds <= minGapSeconds) last[1] = e;
    else merged.push([s, e]);
  }

  const blocks = [];
  let speechSeconds = 0;
  for (const [s, e] of merged) {
    if ((e - s) * frameSeconds < minSpeechSeconds) continue;
    const from = Math.max(0, s * frameSeconds - padSeconds);
    const to = Math.min(samples.length / sampleRate, e * frameSeconds + padSeconds);
    blocks.push({ start: round3(from), end: round3(to), seconds: round3(to - from) });
    speechSeconds += to - from;
  }
  return {
    blocks,
    threshold,
    thresholdDb: 20 * Math.log10(threshold || 1e-9),
    noiseFloor,
    loud,
    dynamicDb,
    flat,
    speechSeconds: round3(speechSeconds),
    totalSeconds: round3(samples.length / sampleRate),
  };
}

/**
 * Group speech blocks into recognizer windows.
 *
 * The host provider rejects anything above its `maxAudioBytes`, and long windows lose
 * timestamps; 20–25 s is the sweet spot for both accuracy and timestamp resolution.
 */
export function planWindows(blocks, { maxSeconds = 24, minGapSeconds = 0.45 } = {}) {
  const windows = [];
  let current = null;
  for (const block of blocks) {
    if (!current) {
      current = { start: block.start, end: block.end, blocks: 1 };
      continue;
    }
    const gap = block.start - current.end;
    const wouldBe = block.end - current.start;
    if (gap <= minGapSeconds && wouldBe <= maxSeconds) {
      current.end = block.end;
      current.blocks += 1;
    } else {
      windows.push(current);
      current = { start: block.start, end: block.end, blocks: 1 };
    }
  }
  if (current) windows.push(current);

  // A single unbroken block (music under speech, a lecture without pauses) is split evenly.
  const split = [];
  for (const win of windows) {
    const span = win.end - win.start;
    if (span <= maxSeconds * 1.25) { split.push({ ...win, start: round3(win.start), end: round3(win.end) }); continue; }
    const parts = Math.ceil(span / maxSeconds);
    for (let i = 0; i < parts; i++) {
      split.push({
        start: round3(win.start + (span * i) / parts),
        end: round3(win.start + (span * (i + 1)) / parts),
        blocks: 1,
        splitFromLongBlock: true,
      });
    }
  }
  return split;
}

function round3(v) { return Math.round(v * 1000) / 1000; }

/* --------------------------------------------------------------- transports */

function stripTags(text) {
  return String(text || '')
    .replace(/<\|[^|]*\|>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeText(text) {
  return stripTags(text).toLowerCase().replace(/[\s,，。.!！?？、"'“”‘’()（）-]/g, '');
}

/** True for the stock phrases whisper/SenseVoice produce over silence or music. */
export function looksHallucinated(text, seconds) {
  const norm = normalizeText(text);
  if (!norm) return 'empty';
  if (norm.length <= 2 && seconds < 3) return 'too-short';
  const hit = HALLUCINATIONS.find((h) => normalizeText(h) === norm || (norm.length <= 12 && norm.includes(normalizeText(h))));
  if (hit && seconds < 3.5) return `artifact:${hit}`;
  if (seconds < 1.2) return 'too-short';
  return null;
}

async function hostTranscribe({ service, wavs, language, providerId, timeoutMs, onProgress }) {
  const out = [];
  for (let i = 0; i < wavs.length; i++) {
    const item = wavs[i];
    const spec = service.resolve({
      audio: new Uint8Array(item.wav),
      ...(providerId ? { providerId } : {}),
      ...(language && language !== 'auto' ? { language } : {}),
    });
    const result = await service.transcribe(spec, AbortSignal.timeout(timeoutMs));
    out.push({ text: result?.text ?? '', audioSeconds: result?.audioSeconds ?? null, inferenceSeconds: result?.inferenceSeconds ?? null });
    onProgress?.({ done: i + 1, total: wavs.length, window: item });
  }
  return out;
}

async function httpTranscribe({ wavs, endpoint, language, onProgress, fetchImpl = fetch }) {
  const url = endpoint.url.replace(/\/+$/, '').endsWith('/audio/transcriptions')
    ? endpoint.url.replace(/\/+$/, '')
    : `${endpoint.url.replace(/\/+$/, '')}/audio/transcriptions`;
  const out = [];
  for (let i = 0; i < wavs.length; i++) {
    const item = wavs[i];
    const form = new FormData();
    form.append('file', new Blob([item.wav], { type: 'audio/wav' }), 'audio.wav');
    form.append('model', endpoint.model);
    form.append('response_format', 'json');
    if (endpoint.language && endpoint.language !== 'auto') form.append('language', endpoint.language);
    else if (language && language !== 'auto') form.append('language', language);
    const headers = {};
    if (endpoint.apiKey) headers.authorization = `Bearer ${endpoint.apiKey}`;
    for (const [k, v] of Object.entries(endpoint.headers || {})) headers[k] = String(v);
    const response = await fetchImpl(url, { method: 'POST', headers, body: form, signal: AbortSignal.timeout(endpoint.timeoutMs ?? 120_000) });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new AsrError('endpoint-http', `speech endpoint returned HTTP ${response.status}`, body.slice(0, 300));
    }
    const payload = await response.json().catch(() => ({}));
    out.push({ text: payload.text || '', audioSeconds: item.seconds ?? null, inferenceSeconds: null });
    onProgress?.({ done: i + 1, total: wavs.length, window: item });
  }
  return out;
}

async function commandTranscribe({ wavs, command, language, onProgress }) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-better-ears-asr-'));
  try {
    const out = [];
    for (let i = 0; i < wavs.length; i++) {
      const item = wavs[i];
      const file = join(dir, `window-${String(i).padStart(4, '0')}.wav`);
      await writeFile(file, item.wav);
      const cmd = command.replaceAll('{input}', file).replaceAll('{lang}', language || 'auto');
      const text = await new Promise((resolve, reject) => {
        const child = spawn('/bin/sh', ['-c', cmd], { env: { ...process.env, EARS_AUDIO: file, EARS_LANG: language || 'auto' } });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new AsrError('command-timeout', `speech command timed out: ${cmd}`)); }, 180_000);
        child.stdout.on('data', (d) => { stdout += d.toString(); });
        child.stderr.on('data', (d) => { stderr += d.toString(); });
        child.on('error', (error) => { clearTimeout(timer); reject(new AsrError('command-failed', `speech command failed: ${error.message}`)); });
        child.on('close', (code) => {
          clearTimeout(timer);
          if (code === 0) resolve(stdout.trim());
          else reject(new AsrError('command-failed', `speech command exited ${code}`, stderr.trim().slice(0, 300)));
        });
      });
      out.push({ text, audioSeconds: item.seconds ?? null, inferenceSeconds: null });
      onProgress?.({ done: i + 1, total: wavs.length, window: item });
    }
    return out;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/* -------------------------------------------------------------------- main */

/** `config.asr.mode`: host | endpoint | command | off | auto (default). */
export function plannedTransport(ctx, config) {
  const mode = config?.asr?.mode || 'auto';
  const endpoint = config?.asr?.endpoint;
  const command = config?.asr?.command;
  if (mode === 'off') return { kind: 'off' };
  if (mode === 'host' || mode === 'auto') {
    if (speechService(ctx)) return { kind: 'host' };
  }
  if ((mode === 'endpoint' || mode === 'auto') && endpoint?.url && endpoint?.model) return { kind: 'endpoint' };
  if ((mode === 'command' || mode === 'auto') && command) return { kind: 'command' };
  if (mode === 'host') return { kind: 'host' };
  if (mode === 'endpoint') return { kind: 'endpoint', missing: true };
  if (mode === 'command') return { kind: 'command', missing: true };
  return { kind: 'none' };
}

/**
 * Transcribe one media file.
 *
 * Returns windows, joined text, SRT, and — just as important — how much of the
 * recording was *not* sent to the recognizer.
 */
export async function transcribeFile(file, {
  ctx,
  config = {},
  language = null,
  maxSeconds = null,
  timeoutMs = null,
  prepareTimeoutMs = 60_000,
  prepare = false,
  onProgress = null,
} = {}) {
  const transport = plannedTransport(ctx, config);
  if (transport.kind === 'off') throw new AsrError('disabled', 'speech recognition is disabled in settings (asr.mode = off)');
  if (transport.kind === 'none') {
    throw new AsrError('unavailable', 'no speech-to-text transport is available',
      '三种可选：① DSH 设置 → 语音输入 启用本地识别；② 在 dsh-better-ears 设置页填一个 OpenAI 兼容的转写接口；③ 配置本地命令模板。');
  }
  if (transport.missing) {
    throw new AsrError('misconfigured', `asr.mode is "${config?.asr?.mode}" but its settings are empty`,
      '补全 asr.endpoint.url + asr.endpoint.model，或 asr.command，或在设置页改回 auto。');
  }

  const info = await probe(file, config);
  const cap = maxSeconds ?? config?.asr?.maxSeconds ?? 1800;
  const limit = Math.min(info.durationSeconds || cap, cap, info.durationSeconds || Infinity);
  const wavBuffer = await wav16k(file, { durationSeconds: limit, config });
  const { pcm, sampleRate } = pcmFromWav(wavBuffer);
  const samples = new Float32Array(pcm.length >> 1);
  for (let i = 0; i < samples.length; i++) samples[i] = pcm.readInt16LE(i * 2) / 32768;

  const vad = voiceBlocks(samples, sampleRate, {
    minSpeechSeconds: config?.asr?.minSpeechSeconds ?? 0.2,
    minGapSeconds: config?.asr?.minGapSeconds ?? 0.35,
    thresholdRatio: config?.asr?.thresholdRatio ?? 0.25,
  });
  const windows = planWindows(vad.blocks, { maxSeconds: config?.asr?.windowSeconds ?? 24 });
  if (!windows.length) {
    return {
      provider: null,
      language: language || config?.asr?.language || 'auto',
      text: '',
      segments: [],
      srt: '',
      vad,
      windows: [],
      speechSeconds: 0,
      truncated: info.durationSeconds > limit,
      notes: ['没有检测到人声（能量低于动态阈值），未调用识别器。'],
    };
  }

  const wavs = windows.map((win) => {
    const from = Math.max(0, Math.floor(win.start * sampleRate));
    const to = Math.min(samples.length, Math.ceil(win.end * sampleRate));
    return { ...win, wav: wavFromPcm(pcm.subarray(from * 2, to * 2), sampleRate), seconds: (to - from) / sampleRate };
  });

  let providerLabel = transport.kind;
  let raw;
  if (transport.kind === 'host') {
    const service = speechService(ctx);
    const providerId = config?.asr?.providerId || null;
    const view = providerOf(service, providerId);
    const needs = view?.preparation && !READY_PHASES.has(view.preparation.phase);
    if (needs && !prepare) {
      const phase = view.preparation.phase;
      throw new AsrError('not-prepared', `本地识别器尚未就绪（${phase}）`,
        '首次使用需要下载并加载模型（约 240 MB）。把 prepare 设为 true 再调用一次，或在 dsh-better-ears 设置页点「启用本地识别」。');
    }
    const readyId = await ensureProvider(service, { providerId, timeoutMs: prepareTimeoutMs, onProgress });
    providerLabel = `host:${readyId}`;
    raw = await hostTranscribe({ service, wavs, language, providerId: readyId, timeoutMs: timeoutMs ?? 120_000, onProgress });
  } else if (transport.kind === 'endpoint') {
    providerLabel = `http:${config.asr.endpoint.model}`;
    raw = await httpTranscribe({ wavs, endpoint: { ...config.asr.endpoint, language }, language, onProgress });
  } else {
    providerLabel = 'cmd';
    raw = await commandTranscribe({ wavs, command: config.asr.command, language, onProgress });
  }

  const segments = [];
  const dropped = [];
  for (let i = 0; i < wavs.length; i++) {
    const text = stripTags(raw[i]?.text);
    const seconds = wavs[i].seconds;
    const artifact = looksHallucinated(text, seconds);
    if (artifact) {
      dropped.push({ start: wavs[i].start, end: wavs[i].end, text, reason: artifact });
      continue;
    }
    segments.push({
      index: segments.length + 1,
      start: wavs[i].start,
      end: wavs[i].end,
      seconds: round3(seconds),
      text,
      audioSeconds: raw[i]?.audioSeconds ?? null,
      inferenceSeconds: raw[i]?.inferenceSeconds ?? null,
    });
  }

  const notes = [];
  if (dropped.length) notes.push(`丢弃${dropped.length}个疑似幻听片段（短窗内只出现字幕/致谢套话）。`);
  if (!segments.length && dropped.length) {
    notes.push('所有文本都被判为空或幻听：这段多半不是人声（纯音乐、持续音或噪声）。');
  }
  if (!segments.length && dropped.length) {
    notes.push('所有文本都被判为空或幻听：这段多半不是人声（纯音乐、持续音或噪声）。');
  } else if (!segments.length && windows.length) {
    notes.push('识别器在每个窗口都返回了空文本。');
  }
  if (info.durationSeconds > limit) notes.push(`只分析了前${round3(limit)}s（共${round3(info.durationSeconds)}s），可用 maxSeconds 放宽。`);
  if (vad.blocks.length && vad.speechSeconds / Math.max(0.001, vad.totalSeconds) < 0.02) {
    notes.push('人声占比极低，转写结果可能不可靠。');
  }

  return {
    provider: providerLabel,
    language: language || config?.asr?.language || 'auto',
    text: segments.map((s) => s.text).join(' ').trim(),
    segments,
    dropped,
    srt: toSrt(segments),
    vad,
    windows: windows.length,
    speechSeconds: round3(segments.reduce((sum, s) => sum + s.seconds, 0)),
    truncated: info.durationSeconds > limit,
    notes,
  };
}

/** SRT with comma decimals, which is what players actually parse. */
export function toSrt(segments) {
  const stamp = (seconds) => {
    const ms = Math.max(0, Math.round(seconds * 1000));
    const h = String(Math.floor(ms / 3_600_000)).padStart(2, '0');
    const m = String(Math.floor((ms % 3_600_000) / 60_000)).padStart(2, '0');
    const s = String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0');
    return `${h}:${m}:${s},${String(ms % 1000).padStart(3, '0')}`;
  };
  return segments.map((s, i) => `${i + 1}\n${stamp(s.start)} --> ${stamp(s.end)}\n${s.text}\n`).join('\n');
}

/** Guard used by the tools when the caller does not want speech at all. */
export function asrCapability(ctx, config) {
  const transport = plannedTransport(ctx, config);
  const speech = describeSpeech(ctx);
  const ready = speech.providers.find((p) => READY_PHASES.has(p.phase));
  const configured = speech.providers.find((p) => p.id === (config?.asr?.providerId || speech.selection?.providerId));
  return {
    transport,
    speech,
    readyProviderId: ready?.id ?? null,
    configuredProviderId: configured?.id ?? null,
    canTranscribe: transport.kind === 'host' || transport.kind === 'endpoint' || transport.kind === 'command',
    needsDownload: transport.kind === 'host' && !ready && Boolean(configured),
  };
}

/** Read a test fixture from disk (used by audio_status self-check). */
export async function readWavFile(file) {
  const buf = await readFile(file);
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') throw new AsrError('not-wav', `${file} is not a RIFF/WAVE file`);
  return buf;
}
