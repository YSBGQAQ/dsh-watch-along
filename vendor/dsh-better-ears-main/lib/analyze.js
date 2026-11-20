/**
 * analyze.js — 编排层：一个文件进来，几条互不干扰的流水线出去。
 *
 * 这里的每个常数都有一个"为什么"，写在常数旁边。它们是可调的，但调之前先看那句理由：
 *  - 音高类折叠从 150 Hz 开始：在测试混音上，踢鼓 48→168 Hz 的扫频占了最响的十几个 bin，
 *    不砍掉它，色度图就变成一张踢鼓地图（C 大三和弦被读成 C/B/C#）。
 *  - 色度用功率而不是幅度：pad 的峰是噪声底的 70 倍，但 150 Hz 以上有 1400 个噪声 bin，
 *    线性求和时它们加起来仍然压过 pad，色度会平到 0.08/音级。
 *  - 谐波/打击分离用时间轴中值滤波（Fitzgerald 2010）：持续音活下来，军鼓/踩镲的瞬态死掉。
 *  - 调性 STFT 用 8192/2048：22050 Hz 下 2.7 Hz/bin，A3 附近一个半音有 5.8 个 bin，
 *    2048 点时只有 1.4 个，纯音会漏到相邻半音（实测 A3 → A 0.46 / A# 0.22 / G# 0.22）。
 */

import {
  AudioError, decode, probe, resolveFfmpeg,
} from './audio.js';
import { harmonicMags as harmonicFrameMags, highpass, stft } from './dsp/core.js';
import {
  estimateDownbeat, estimateDownbeatChroma, estimateTempo, onsetEnvelope, onsetTimes, rhythmSummary, trackBeats,
} from './dsp/rhy.js';
import {
  chromagram, detectChords, estimateKey, melodyTrack,
} from './dsp/tonal.js';
import {
  beatSyncChroma, detectSections, labelSections, loudnessEnvelope, meanVector, noveltyCurve, sectionChain, selfSimilarity,
} from './dsp/structure.js';

export const ANALYSIS_SR = 22050;
/** Tonal constants, exported so the report can print them instead of hiding them. */
export const TONAL = {
  highpassHz: 150,
  nfft: 8192,
  hop: 2048,
  fmin: 150,
  fmax: 4000,
  harmonicKernelFrames: 21,
};
export const RHYTHM = { nfft: 1024, hop: 256, melBands: 40 };

/* ---- decode cache --------------------------------------------------------------- */

const CACHE_LIMIT = 3;
const cache = new Map();

/**
 * Decode once per (file, mtime, window). Tools ask for rhythm, tonality and structure
 * separately, and decoding a 5-minute file three times would dominate the latency.
 */
export async function prepare(file, { config = {}, sr = ANALYSIS_SR, maxSeconds = null, startSeconds = 0 } = {}) {
  const abs = file;
  const st = await probe(abs, config);
  const duration = st.durationSeconds ?? null;
  if (!st.hasAudio) {
    throw new AudioError('这个文件没有音轨', st.hasVideo ? '它是视频但没有音频流；换一个有声音的文件' : '检查文件是否损坏');
  }
  let window = maxSeconds;
  if (!window && duration && duration > 0) window = Math.min(duration, 600);
  const key = `${abs}|${st.bytes}|${sr}|${window}|${startSeconds}`;
  const hit = cache.get(key);
  if (hit) {
    // LRU: refresh position.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const { samples } = await decode(abs, { sr, maxSeconds: window, startSeconds, config });
  const seconds = samples.length / sr;
  const entry = {
    file: abs,
    info: st,
    samples,
    sr,
    seconds,
    startSeconds,
    truncated: Boolean(duration && seconds + startSeconds + 0.25 < duration),
    analyzedSeconds: Math.min(seconds, Math.max(0, (duration ?? seconds) - startSeconds)),
  };
  cache.set(key, entry);
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  return entry;
}

export function clearCache() {
  cache.clear();
}

/* ---- rhythm --------------------------------------------------------------------- */

export function rhythmFrom(prepared) {
  const { samples, sr } = prepared;
  const env = onsetEnvelope(samples, sr, { ...RHYTHM, lowBand: [30, 150] });
  const onsets = onsetTimes(env);
  const tempo = estimateTempo(env, onsets);
  const tracked = trackBeats(env, tempo);
  const downbeat = estimateDownbeat(tracked.beats, env.lowBand);
  const summary = rhythmSummary(tempo, tracked, downbeat);
  return {
    stft: { nfft: RHYTHM.nfft, hop: RHYTHM.hop, sr },
    tempo,
    tracked,
    downbeat,
    onsets: { count: onsets.times.length, times: onsets.times },
    summary,
  };
}

/* ---- tonality ------------------------------------------------------------------- */

export function tonalFrom(prepared, { beats = null } = {}) {
  const { samples, sr } = prepared;
  const filtered = highpass(samples, sr, { fc: TONAL.highpassHz });
  const S = stft(filtered, sr, { nfft: TONAL.nfft, hop: TONAL.hop });
  // Harmonic/percussive split before folding: otherwise the kick decides the key.
  const harmonic = harmonicFrameMags(S.mags);
  const chroma = chromagram(harmonic, S.nfft, sr, {
    frameHop: S.hop,
    fmin: TONAL.fmin,
    fmax: TONAL.fmax,
    power: 2,
  });
  const key = estimateKey(chroma);
  const chords = detectChords(chroma, { beats, key });
  const melody = melodyTrack(samples, sr, { fmin: 80, fmax: 1200, frame: 2048, hop: 512 });
  // A pitch line is worth reporting only when enough frames agree. `tonal` here answers
  // "can I state a range/contour", not "is this music": sparse coverage widens the range
  // and octave errors inflate the jump rate, so both gates matter.
  melody.tonal = Boolean(melody.rangeName) && melody.voicedFraction >= 0.3 && melody.octaveJumpRate <= 0.2;
  melody.confidence = melody.tonal
    ? Math.min(1, Math.max(0, 0.5 * melody.voicedFraction + 0.5 * (1 - Math.min(1, melody.octaveJumpRate * 4))))
    : 0;
  return {
    stft: { nfft: S.nfft, hop: S.hop, sr, mags: S.mags },
    chroma,
    key,
    chords,
    melody,
  };
}

/* ---- structure ------------------------------------------------------------------ */

export function structureFrom(tonal, rhythm) {
  const beats = rhythm?.tracked?.beats ?? [];
  const beatChroma = beatSyncChroma(tonal.chroma, beats);
  const vectors = beatChroma.map((b) => b.vector);
  const ssm = selfSimilarity(vectors);
  const { novelty } = noveltyCurve(ssm, 8);
  const beatTimes = beatChroma.length ? beatChroma.map((b) => b.start) : [0];
  const detected = detectSections(novelty, beatTimes, { sigma: 1.2, minBeats: 16 });
  const times = [...detected.boundaries.map((b) => b.time), beatChroma.length ? beatChroma[beatChroma.length - 1].end : tonalDuration(tonal)];
  const sections = [];
  for (let i = 0; i < times.length - 1; i++) {
    const start = i === 0 ? 0 : times[i];
    const end = times[i + 1];
    if (end - start < 1) continue;
    const fromIdx = Math.max(0, Math.round(start / (beatTimes[1] - beatTimes[0] || 1)));
    const toIdx = Math.max(fromIdx + 1, Math.round(end / (beatTimes[1] - beatTimes[0] || 1)));
    sections.push({ time: start, strength: i === 0 ? 1 : detected.boundaries[i - 1]?.strength ?? 0, vector: meanVector(beatChroma, fromIdx, toIdx) });
  }
  const labeled = labelSections(sections);
  const chain = sectionChain(
    labeled,
    beatChroma.length ? beatChroma : [{ start: 0, end: tonalDuration(tonal) }],
    tonal.stft.mags,
    tonal.stft.nfft,
    tonal.stft.sr,
    tonal.stft.hop,
  );
  // Harmony-based downbeat guess, to be compared with the kick-based one.
  const harmonicDownbeat = estimateDownbeatChroma(beatChroma.map((b) => b.vector));
  return {
    sections: chain,
    boundaries: detected.boundaries,
    downbeatHarmonic: harmonicDownbeat,
    decision: { threshold: detected.threshold, mean: detected.mean, std: detected.std, sigma: 1.2, minBeats: 16, kernelBeats: 8 },
    ssmSize: ssm.length,
  };
}

function tonalDuration(tonal) {
  const { mags } = tonal.stft ?? {};
  const spf = (tonal.chroma?.secondsPerFrame) ?? 0.1;
  return mags ? mags.length * spf : 0;
}

/**
 * Music or speech? Decided from evidence already computed, and reported as a judgement with
 * reasons — a wrong guess must be visible, not silently folded into the numbers.
 */
export function contentKind({ rhythm, structure, tonal } = {}) {
  const reasons = [];
  let score = 0;
  const sections = structure?.sections ?? [];
  const low = sections.length ? sections.reduce((sum, s) => sum + (s.lowBandShare ?? 0), 0) / sections.length : null;
  const vocal = sections.length ? sections.reduce((sum, s) => sum + (s.vocalBandShare ?? 0), 0) / sections.length : null;
  if (low !== null) {
    if (low >= 0.35) { score += 2; reasons.push(`低频占比 ${(low * 100).toFixed(0)}%`); }
    else if (low >= 0.18) { score += 1; reasons.push(`低频占比 ${(low * 100).toFixed(0)}%`); }
  }
  // Tonality and a sustained pitch line are the two things speech cannot fake:
  // a piano piece lives in the vocal band too, but it has a stable key and held notes.
  const keyConfidence = tonal?.key?.confidence ?? 0;
  const voiced = tonal?.melody?.voicedFraction ?? 0;
  if (keyConfidence >= 0.55) {
    score += 2;
    reasons.push(`调性明确（${tonal.key.key}，置信 ${(keyConfidence * 100).toFixed(0)}%）`);
  } else if (keyConfidence >= 0.35) {
    score += 1;
  }
  if (voiced >= 0.45 && keyConfidence >= 0.35) {
    score += 2;
    reasons.push(`持续音高线占 ${(voiced * 100).toFixed(0)}%`);
  } else if (voiced >= 0.25 && keyConfidence >= 0.35) {
    score += 1;
  }
  if (vocal !== null && vocal >= 0.5 && (low ?? 0) < 0.15 && keyConfidence < 0.35) {
    score -= 2;
    reasons.push(`人声频段占 ${(vocal * 100).toFixed(0)}% 且无稳定调性`);
  }
  const clarity = rhythm?.tracked?.pulseClarity ?? 0;
  if (clarity >= 15) score += 2;
  else if (clarity >= 8) score += 1;
  else { score -= 1; reasons.push(`脉冲不清晰（${clarity.toFixed(1)}）`); }
  const tempoScore = rhythm?.tempo?.score ?? 0;
  if (tempoScore >= 0.8) score += 2;
  else if (tempoScore >= 0.5) score += 1;
  else { score -= 1; reasons.push(`速度不自证（${tempoScore.toFixed(2)}）`); }
  // A confident key is something speech never produces (measured 0.28–0.30 on real
  // speech, 0.88–0.96 on real songs), so it outranks the weaker cues outright.
  const musical = keyConfidence >= 0.7 ? true : null;
  if (musical) reasons.push('调性置信度本身就是音乐的强证据');
  const kind = musical ? 'music' : score >= 4 ? 'music' : score <= -1 ? 'speech' : 'unclear';
  return { kind, score, lowShare: low, vocalShare: vocal, pulseClarity: clarity, tempoScore, keyConfidence, voicedFraction: voiced, reasons };
}

/** Overall energy picture, cheap enough to always include in audio_read. */
export function energyFrom(prepared) {
  const env = loudnessEnvelope(prepared.samples, prepared.sr, 1);
  return {
    medianDb: env.medianDb,
    p95Db: env.p95Db,
    rangeDb: env.rangeDb,
    curve: env.points,
  };
}
