/**
 * audio.js — 一切"听得见"的前提：找到 ffmpeg，把文件解成数字，再把数字交回给调用方。
 *
 * 这里刻意只做 IO，不做判断：解码、探测、响度、静音、镜头切换点。
 * 任何分析都从 `decode()` 拿到的 mono Float32 开始，所以"能不能听"这个问题
 * 只有一个答案——audio_status 里那行 ffmpeg 路径。
 */

import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const isWin = process.platform === 'win32';

export class AudioError extends Error {
  constructor(message, hint) {
    super(message);
    this.name = 'AudioError';
    this.hint = hint;
  }
}

/* ---- locating ffmpeg ------------------------------------------------------------- */

const envFfmpeg = () => process.env.DSH_BETTER_EARS_FFMPEG || process.env.DSH_EARS_FFMPEG || null;
const envFfprobe = () => process.env.DSH_BETTER_EARS_FFPROBE || process.env.DSH_EARS_FFPROBE || null;

const candidates = () => {
  const list = [];
  const ffEnv = envFfmpeg();
  const fpEnv = envFfprobe();
  if (ffEnv) list.push(ffEnv);
  if (fpEnv) list.push(fpEnv);
  const dshHome = process.env.DSH_HOME || path.join(homedir(), '.dsh');
  list.push(path.join(dshHome, 'tools', 'ffmpeg', 'bin', isWin ? 'ffmpeg.exe' : 'ffmpeg'));
  list.push(path.join(dshHome, 'tools', 'ffmpeg', 'bin', isWin ? 'ffprobe.exe' : 'ffprobe'));
  return list;
};

let cached = null;

/**
 * Resolve the ffmpeg/ffprobe pair. A config override wins; then the copy DSH manages
 * under ~/.dsh/tools/ffmpeg (which is where the desktop app puts it); then PATH.
 * Nothing is installed here — we report what we found and let the caller decide.
 */
export function resolveFfmpeg(config = {}) {
  const ffCfg = config.ffmpeg || config.ffmpegPath;
  const fpCfg = config.ffprobe || config.ffprobePath;
  if (cached && !ffCfg && !fpCfg) return cached;
  const ff = ffCfg || envFfmpeg();
  const fp = fpCfg || envFfprobe();
  let ffmpeg = ff && existsSync(ff) ? ff : null;
  let ffprobe = fp && existsSync(fp) ? fp : null;
  if (!ffmpeg || !ffprobe) {
    const dshHome = process.env.DSH_HOME || path.join(homedir(), '.dsh');
    const bin = path.join(dshHome, 'tools', 'ffmpeg', 'bin');
    const a = path.join(bin, isWin ? 'ffmpeg.exe' : 'ffmpeg');
    const b = path.join(bin, isWin ? 'ffprobe.exe' : 'ffprobe');
    if (!ffmpeg && existsSync(a)) ffmpeg = a;
    if (!ffprobe && existsSync(b)) ffprobe = b;
  }
  if (!ffmpeg) ffmpeg = which('ffmpeg');
  if (!ffprobe) ffprobe = which('ffprobe');
  const out = { ffmpeg, ffprobe };
  if (!ffCfg && !fpCfg) cached = out;
  return out;
}

function which(name) {
  const dirs = (process.env.PATH || '').split(isWin ? ';' : ':').filter(Boolean);
  const exts = isWin ? ['.exe', '.cmd', ''] : [''];
  for (const d of dirs) {
    for (const e of exts) {
      const p = path.join(d, name + e);
      try {
        if (statSync(p).isFile()) return p;
      } catch {}
    }
  }
  return null;
}

/* ---- running processes ------------------------------------------------------------ */

export function run(bin, args, { timeoutMs = 120_000, maxBufferMb = 512, onStderr } = {}) {
  return new Promise((resolve, reject) => {
    if (!bin) {
      reject(new AudioError('ffmpeg 未找到', '装好 ffmpeg/ffprobe 后在插件设置里填路径，或 export DSH_BETTER_EARS_FFMPEG=/path/to/ffmpeg（旧名 DSH_EARS_FFMPEG 仍兼容）'));
      return;
    }
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    let err = '';
    let outLen = 0;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch {}
      reject(new AudioError(`ffmpeg 超时（${Math.round(timeoutMs / 1000)}s）`, '文件可能过大；试试 max_seconds 参数只分析前一段'));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      outLen += chunk.length;
      if (outLen > maxBufferMb * 1024 * 1024) {
        try { child.kill('SIGKILL'); } catch {}
        return;
      }
      out.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      err += chunk.toString('utf8');
      if (err.length > 4_000_000) err = err.slice(-2_000_000);
      if (onStderr) { try { onStderr(err); } catch {} }
    });
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new AudioError(`无法执行 ${path.basename(bin)}：${e.message}`, '检查路径与可执行权限'));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdout = Buffer.concat(out);
      if (code !== 0) {
        reject(new AudioError(`ffmpeg 退出码 ${code}`, tail(err, 600) || '见 stderr'));
        return;
      }
      resolve({ stdout, stderr: err, code });
    });
  });
}

const tail = (s, n) => (typeof s === 'string' && s.length > n ? s.slice(-n) : s || '');

/* ---- probing --------------------------------------------------------------------- */

/** ffprobe → a flat, LLM-friendly description of the file. */
export async function probe(file, config = {}) {
  const { ffprobe } = resolveFfmpeg(config);
  assertFile(file);
  const args = [
    '-v', 'error',
    '-show_format', '-show_streams',
    '-of', 'json',
    file,
  ];
  const { stdout } = await run(ffprobe, args, { timeoutMs: 30_000 });
  let info;
  try {
    info = JSON.parse(stdout.toString('utf8'));
  } catch (e) {
    throw new AudioError('ffprobe 输出无法解析', tail(stdout.toString('utf8'), 400));
  }
  const streams = (info.streams || []).map((s) => ({
    index: s.index,
    type: s.codec_type,
    codec: s.codec_name,
    profile: s.profile ?? undefined,
    sampleRate: s.sample_rate ? Number(s.sample_rate) : undefined,
    channels: s.channels ?? undefined,
    channelLayout: s.channel_layout ?? undefined,
    bitRate: s.bit_rate ? Number(s.bit_rate) : undefined,
    durationSeconds: s.duration ? Number(s.duration) : undefined,
    width: s.width ?? undefined,
    height: s.height ?? undefined,
    frameRate: pickRate(s),
    attachedPicture: s.disposition?.attached_pic === 1 || (COVER_CODECS.has(s.codec_name) && Number(s.nb_frames ?? 0) <= 1),
    startSeconds: s.start_time ? Number(s.start_time) : undefined,
    tags: cleanTags(s.tags),
  }));
  const audio = streams.filter((s) => s.type === 'audio');
  // An embedded cover is a video stream to ffprobe but not a picture track:
  // counting it would print "视频 640×640 · 90000fps" for a plain MP3.
  const covers = streams.filter((s) => s.type === 'video' && s.attachedPicture);
  const video = streams.filter((s) => s.type === 'video' && !s.attachedPicture);
  const fmt = info.format || {};
  return {
    file,
    bytes: fmt.size ? Number(fmt.size) : safeSize(file),
    container: fmt.format_name,
    durationSeconds: fmt.duration ? Number(fmt.duration) : (audio[0]?.durationSeconds ?? video[0]?.durationSeconds ?? null),
    bitRate: fmt.bit_rate ? Number(fmt.bit_rate) : undefined,
    tags: cleanTags(fmt.tags),
    audio,
    video,
    covers: covers.length,
    subtitleStreams: streams.filter((s) => s.type === 'subtitle').length,
    hasAudio: audio.length > 0,
    hasVideo: video.length > 0,
  };
}

const COVER_CODECS = new Set(['png', 'mjpeg', 'bmp', 'gif', 'webp']);

/** r_frame_rate is a timebase when a stream has one frame (covers report 90000/1). */
function pickRate(s) {
  const avg = s.avg_frame_rate && s.avg_frame_rate !== '0/0' ? s.avg_frame_rate : null;
  const real = s.r_frame_rate && s.r_frame_rate !== '0/0' ? s.r_frame_rate : null;
  return avg || real || undefined;
}

function cleanTags(tags) {
  if (!tags) return undefined;
  const out = {};
  for (const [k, v] of Object.entries(tags)) {
    if (typeof v === 'string' && v.length <= 200 && !/^(encoder|handler_name|vendor_id|major_brand|minor_version|compatible_brands|creation_time)$/i.test(k)) out[k.toLowerCase()] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

function safeSize(file) {
  try { return statSync(file).size; } catch { return undefined; }
}

export function assertFile(file) {
  if (typeof file !== 'string' || !file.trim()) {
    throw new AudioError('需要一个音频或视频文件路径', '例如 /Users/me/voice.m4a');
  }
  const p = path.resolve(file.trim());
  if (!existsSync(p)) {
    throw new AudioError(`文件不存在：${p}`, '给绝对路径最稳；相对路径按当前工作目录解析');
  }
  const st = statSync(p);
  if (!st.isFile()) throw new AudioError(`不是文件：${p}`);
  if (st.size === 0) throw new AudioError(`空文件：${p}`, '可能是下载没完成');
  return p;
}

/* ---- decoding -------------------------------------------------------------------- */

/**
 * Decode the first audio stream to mono Float32 PCM.
 * `maxSeconds` truncates from the start (`startSeconds` offsets it) so a 3-hour
 * podcast can still be sampled quickly.
 */
export async function decode(file, { sr = 22050, maxSeconds = null, startSeconds = 0, config = {} } = {}) {
  const { ffmpeg } = resolveFfmpeg(config);
  const args = [
    '-nostdin', '-hide_banner', '-loglevel', 'error',
    ...(startSeconds > 0 ? ['-ss', String(startSeconds)] : []),
    '-i', file,
    '-map', '0:a:0', '-vn', '-ac', '1', '-ar', String(sr),
    ...(maxSeconds ? ['-t', String(maxSeconds)] : []),
    '-f', 'f32le', '-acodec', 'pcm_f32le', 'pipe:1',
  ];
  const { stdout } = await run(ffmpeg, args, { timeoutMs: 300_000 });
  if (stdout.length < 4) {
    throw new AudioError('解码出 0 个采样点', '这个文件可能没有音轨，或音轨是空的；用 audio_probe 看流信息');
  }
  const samples = new Float32Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.length / 4));
  // Copy out of the pooled Buffer so the ArrayBuffer can be GC'd independently.
  return { samples: Float32Array.from(samples), sr };
}

/**
 * A canonical 16 kHz mono PCM16 WAV, exactly the shape the host speech service demands:
 * 44-byte header, `fmt ` at 12, `data` at 36. ffmpeg happily emits extra chunks
 * (LIST/INFO) when writing to a pipe, so the header is rebuilt instead of trusted.
 */
export async function wav16k(file, { startSeconds = 0, durationSeconds = null, config = {} } = {}) {
  const { ffmpeg } = resolveFfmpeg(config);
  const args = [
    '-nostdin', '-hide_banner', '-loglevel', 'error',
    ...(startSeconds > 0 ? ['-ss', String(startSeconds.toFixed(3))] : []),
    '-i', file,
    '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000',
    ...(durationSeconds ? ['-t', String(durationSeconds.toFixed(3))] : []),
    '-acodec', 'pcm_s16le', '-f', 'wav', 'pipe:1',
  ];
  const { stdout } = await run(ffmpeg, args, { timeoutMs: 300_000 });
  return canonicalizeWav(stdout);
}

export function canonicalizeWav(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.length < 44 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') {
    throw new AudioError('不是 WAV 数据', 'ffmpeg 参数应带 -f wav');
  }
  let off = 12;
  let fmt = null;
  let dataStart = -1;
  let dataLen = 0;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') fmt = b.subarray(body, Math.min(body + size, b.length));
    else if (id === 'data') { dataStart = body; dataLen = Math.min(size, b.length - body); }
    off = body + size + (size % 2);
  }
  if (!fmt || dataStart < 0 || dataLen <= 0) throw new AudioError('WAV 缺少 fmt/data 块');
  const format = fmt.readUInt16LE(0);
  const channels = fmt.readUInt16LE(2);
  const rate = fmt.readUInt32LE(4);
  const bits = fmt.length >= 16 ? fmt.readUInt16LE(14) : 16;
  if (channels !== 1 || rate !== 16000 || bits !== 16 || (format !== 1 && format !== 0xfffe)) {
    throw new AudioError(`WAV 不是 16k/mono/16bit（ch=${channels} sr=${rate} bits=${bits} fmt=${format}）`);
  }
  const even = dataLen - (dataLen % 2);
  const out = Buffer.allocUnsafe(44 + even);
  out.write('RIFF', 0, 'ascii');
  out.writeUInt32LE(36 + even, 4);
  out.write('WAVE', 8, 'ascii');
  out.write('fmt ', 12, 'ascii');
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(16000, 24);
  out.writeUInt32LE(32000, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36, 'ascii');
  out.writeUInt32LE(even, 40);
  b.copy(out, 44, dataStart, dataStart + even);
  return out;
}

/* ---- measurements --------------------------------------------------------------- */

/** EBU R128 integrated loudness + true peak, from ffmpeg's own meter. */
export async function loudness(file, { config = {}, startSeconds = 0, durationSeconds = null } = {}) {
  const { ffmpeg } = resolveFfmpeg(config);
  const args = [
    '-nostdin', '-hide_banner', '-nostats',
    ...(startSeconds > 0 ? ['-ss', String(startSeconds)] : []),
    '-i', file,
    '-map', '0:a:0', '-vn',
    ...(durationSeconds ? ['-t', String(durationSeconds)] : []),
    '-af', 'ebur128=peak=true', '-f', 'null', '-',
  ];
  const { stderr } = await run(ffmpeg, args, { timeoutMs: 300_000 });
  const summary = stderr.slice(stderr.lastIndexOf('Summary:'));
  const num = (re) => { const m = summary.match(re); return m ? Number(m[1]) : null; };
  return {
    integratedLufs: num(/I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/),
    loudnessRangeLu: num(/LRA:\s*(-?\d+(?:\.\d+)?)\s*LU/),
    truePeakDbtp: num(/Peak:\s*(-?\d+(?:\.\d+)?)\s*dBFS/),
  };
}

/** Silence map via silencedetect. Returns the silent intervals (and therefore the speech-ish ones). */
export async function silenceMap(file, { config = {}, noiseDb = -35, minSilenceSeconds = 0.55, durationSeconds = null } = {}) {
  const { ffmpeg } = resolveFfmpeg(config);
  const args = [
    '-nostdin', '-hide_banner', '-nostats',
    '-i', file, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000',
    ...(durationSeconds ? ['-t', String(durationSeconds)] : []),
    '-af', `silencedetect=noise=${noiseDb}dB:d=${minSilenceSeconds}`,
    '-f', 'null', '-',
  ];
  const { stderr } = await run(ffmpeg, args, { timeoutMs: 300_000 });
  const silences = [];
  let cur = null;
  for (const line of stderr.split('\n')) {
    const s = line.match(/silence_start:\s*(-?\d+(?:\.\d+)?)/);
    const e = line.match(/silence_end:\s*(-?\d+(?:\.\d+)?)\s*\|\s*silence_duration:\s*(\d+(?:\.\d+)?)/);
    if (s) cur = { start: Math.max(0, Number(s[1])) };
    if (e && cur) {
      silences.push({ start: Number(cur.start.toFixed(3)), end: Number(e[1]).toFixed(3) * 1, duration: Number(e[2]) });
      cur = null;
    }
  }
  // silencedetect omits a trailing silence that runs to EOF; set it from the media duration.
  for (const s of silences) s.end = Number(s.end);
  const sorted = silences.sort((a, b) => a.start - b.start);
  return { silences: sorted, params: { noiseDb, minSilenceSeconds } };
}

/** Hard cut timestamps from ffmpeg's scene score. Cheap, and good enough to align beats to edits. */
export async function sceneCuts(file, { config = {}, threshold = 0.3, durationSeconds = null } = {}) {
  const { ffmpeg } = resolveFfmpeg(config);
  const args = [
    '-nostdin', '-hide_banner', '-nostats',
    '-i', file,
    ...(durationSeconds ? ['-t', String(durationSeconds)] : []),
    '-an', '-vf', `select='gt(scene,${threshold})',showinfo`, '-f', 'null', '-',
  ];
  const { stderr } = await run(ffmpeg, args, { timeoutMs: 600_000 });
  const cuts = [];
  for (const line of stderr.split('\n')) {
    const m = line.match(/pts_time:(\d+(?:\.\d+)?)/);
    if (m) cuts.push(Number(Number(m[1]).toFixed(3)));
  }
  return cuts.filter((t, i) => i === 0 || t - cuts[i - 1] > 0.05);
}

/** Downsampled peak envelope for text-side "where is the loud part" summaries. */
export function envelope(samples, buckets = 120) {
  const n = samples.length;
  if (!n || buckets <= 0) return [];
  const size = Math.max(1, Math.floor(n / buckets));
  const out = [];
  let max = 0;
  for (let i = 0; i < buckets; i++) {
    const from = i * size;
    const to = Math.min(n, from + size);
    let peak = 0;
    let sum = 0;
    for (let k = from; k < to; k++) {
      const v = Math.abs(samples[k]);
      if (v > peak) peak = v;
      sum += samples[k] * samples[k];
    }
    const rms = Math.sqrt(sum / Math.max(1, to - from));
    out.push({ peak, rms });
    if (rms > max) max = rms;
  }
  return out.map((b) => ({ rms: max > 0 ? b.rms / max : 0, peak: max > 0 ? b.peak / max : 0 }));
}
