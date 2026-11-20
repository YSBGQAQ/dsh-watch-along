/**
 * Report text.
 *
 * These strings are the product: the model reads them, and the person reads the model.
 * Two rules, taken from soundtry:
 *   1. every number that was actually measured says how sure it is;
 *   2. anything that was skipped, capped or inferred is printed, not hidden.
 */

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** 83.4 → "1:23.4"; 8.2 → "8.2s" */
export function sec(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const v = Math.max(0, value);
  if (v < 60) return `${v.toFixed(1)}s`;
  const m = Math.floor(v / 60);
  const s = v - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

export function ms(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${Math.round(value)}ms`;
}

export function pctOf(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${Math.round(value * 100)}%`;
}

export function hz(value) {
  if (!Number.isFinite(value)) return '—';
  return value >= 1000 ? `${(value / 1000).toFixed(2)}kHz` : `${value.toFixed(0)}Hz`;
}

export function bytes(value) {
  if (!Number.isFinite(value)) return '—';
  const mb = value / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)}GB` : `${mb.toFixed(1)}MB`;
}

export function channelsOf(info) {
  const a = info.audio?.[0];
  if (!a) return '无音轨';
  const layout = a.channelLayout || (a.channels === 1 ? 'mono' : a.channels === 2 ? 'stereo' : `${a.channels}ch`);
  return `${a.channels ?? '?'}ch ${layout}${a.sampleRate ? ` ${hz(a.sampleRate)}` : ''}`;
}

function round1(v) {
  return Math.round((Number(v) || 0) * 10) / 10;
}

function fmtRate(rate) {
  if (!rate) return '?';
  const [n, d] = String(rate).split('/').map(Number);
  if (Number.isFinite(n) && Number.isFinite(d) && d > 0) {
    const v = n / d;
    return Number.isInteger(v) ? String(v) : v.toFixed(2);
  }
  return String(rate);
}

/** "mov,mp4,m4a,3gp,3g2,mj2" is one container with six aliases, not six facts. */
export function shortContainer(name) {
  if (!name) return '?';
  const first = String(name).split(',')[0].trim();
  const map = { mov: 'mp4', matroska: 'mkv', webm: 'webm', 'mpegts': 'ts', mp3: 'mp3', flac: 'flac', ogg: 'ogg', wav: 'wav', aiff: 'aiff' };
  return map[first] || first;
}

export function oneLine(info) {
  const parts = [];
  if (info.durationSeconds) parts.push(sec(info.durationSeconds));
  parts.push(info.hasAudio ? channelsOf(info) : '无音轨');
  parts.push(shortContainer(info.container));
  return parts.join(' · ');
}

/* ------------------------------------------------------------------- probe */

export function reportProbe(info, extra = {}) {
  const lines = [];
  lines.push(`【文件】${info.file}`);
  lines.push(`  时长 ${sec(info.durationSeconds)} · ${shortContainer(info.container)} · ${bytes(info.bytes)}${info.bitRate ? ` · ${Math.round(info.bitRate / 1000)}kbps` : ''}`);
  if (info.covers) lines.push(`  内嵌封面 ${info.covers} 张（不算视频轨，不参与卡点）`);
  if (info.tags && Object.keys(info.tags).length) {
    const tags = Object.entries(info.tags).slice(0, 5).map(([k, v]) => `${k}=${String(v).slice(0, 40)}`).join(' · ');
    lines.push(`  标签 ${tags}`);
  }
  for (const stream of info.audio) {
    lines.push(`  音轨 #${stream.index}  ${stream.codec}${stream.profile ? ` (${stream.profile})` : ''} · ${channelsOf({ audio: [stream] }).replace(/^\d+ch /, `${stream.channels}ch `)} · ${stream.bitRate ? `${Math.round(stream.bitRate / 1000)}kbps` : '码率未知'}`);
  }
  for (const stream of info.video) {
    lines.push(`  视频 #${stream.index}  ${stream.codec} · ${stream.width}×${stream.height} · ${fmtRate(stream.frameRate)}fps${stream.bitRate ? ` · ${Math.round(stream.bitRate / 1000)}kbps` : ''}`);
  }
  if (!info.hasAudio) {
    lines.push('  ⚠ 这个文件没有音轨，音频分析没有输入；只有视频相关的结论成立。');
  }

  if (extra.loudness) {
    const l = extra.loudness;
    lines.push('');
    lines.push('【响度】EBU R128');
    const truePeak = l.truePeakDbtp ?? l.truePeakDb;
    lines.push(`  整体 ${l.integratedLufs?.toFixed(1) ?? '—'} LUFS · 真峰值 ${truePeak?.toFixed(1) ?? '—'} dBTP · 响度范围 ${l.loudnessRangeLu?.toFixed(1) ?? '—'} LU`);
    if (Number.isFinite(l.integratedLufs)) {
      const lufs = l.integratedLufs;
      const verdict = lufs > -9 ? '过响，流媒体会压限（建议 -14 左右）' : lufs > -12 ? '偏响，接近流媒体上限' : lufs > -20 ? '正常流媒体区间' : lufs > -28 ? '偏安静（人声/对白清晰度可能不足）' : '很安静，基本是环境声或很轻的素材';
      lines.push(`  判断 ${verdict}`);
    }
  }

  if (extra.silences) {
    const s = extra.silences;
    lines.push('');
    lines.push(`【静音图】阈值 ${s.noiseDb}dB、最短 ${s.minSilenceSeconds}s`);
    if (!s.regions.length) lines.push('  没有检测到完整静音段（≥ 阈值时长的空隙）。');
    else {
      lines.push(`  共 ${s.regions.length} 段静音，累计 ${sec(s.totalSilentSeconds)}（占 ${pctOf(s.totalSilentSeconds / Math.max(0.001, info.durationSeconds))}）`);
      for (const r of s.regions.slice(0, 12)) lines.push(`  ${sec(r.start)} → ${sec(r.end)}  ${sec(r.end - r.start)}`);
      if (s.regions.length > 12) lines.push(`  … 其余 ${s.regions.length - 12} 段省略`);
    }
  }

  if (extra.cuts) {
    lines.push('');
    lines.push(`【画面切点】ffmpeg scene 检测，阈值 ${extra.cuts.threshold}`);
    lines.push(extra.cuts.times.length ? `  ${extra.cuts.times.length} 个切点：${extra.cuts.times.slice(0, 20).map((t) => sec(t)).join('、')}${extra.cuts.times.length > 20 ? ' …' : ''}` : '  没有检测到明显切点（可能是单镜头或渐变）');
  }

  if (extra.envelope) lines.push(`\n【波形】${extra.envelope.bars}`);
  return lines.join('\n');
}

/* ------------------------------------------------------------------ rhythm */

export function reportRhythm(rhythm, { file = null, align = null, downbeatHarmonic = null } = {}) {
  const { tempo, tracked, downbeat, onsets } = rhythm;
  const lines = [];
  if (file) lines.push(`【节奏】${file}`);
  const rivalBpm = tempo.rival?.bpm ?? (typeof tempo.rival === 'number' ? tempo.rival : null);
  lines.push(`  BPM ${tempo.bpm.toFixed(1)}${tempo.score !== undefined ? ` · 自相关置信 ${tempo.score.toFixed(2)}` : ''}${tempo.ambiguity !== 'ok' ? ` · ⚠ 倍频歧义 ${tempo.ambiguity}（可能是 ${rivalBpm ? rivalBpm.toFixed(1) : '—'} BPM）` : ''}`);
  lines.push(`  拍点 ${tracked.beatCount} 个 · 间隔中位数 ${ms(tracked.medianIbiMs)} · 全程漂移 ${ms(tracked.driftMs)} · 脉冲清晰度 ${tracked.pulseClarity?.toFixed(1) ?? '—'}`);
  if (tracked.coverage < 0.98) lines.push(`  ⚠ 拍点只覆盖了 ${pctOf(tracked.coverage)} 的时长（首尾或弱拍段落未锁定）`);

  if (downbeat) {
    const contrast = downbeat.contrast;
    const trust = contrast >= 0.15 ? '' : ' · ⚠ 归属不确定';
    lines.push(`  小节 ${downbeat.beatsPerBar}/4 · 每小节第 1 拍落在四拍循环的第 ${downbeat.phase + 1} 拍 · 对比度 ${contrast.toFixed(3)}${trust}`);
    if (downbeat.ambiguous) {
      lines.push(`  ⚠ 四个相位的低频能量几乎相同（对比度 ${contrast.toFixed(3)} < 0.15），四拍循环无法从鼓点判定；小节号可能整体平移。`);
    }
    if (downbeatHarmonic) {
      lines.push(`  和声旁证：相位 ${downbeatHarmonic.phase} · 对比度 ${downbeatHarmonic.contrast.toFixed(3)}${downbeatHarmonic.phase === downbeat.phase ? '（与鼓点一致）' : '（与鼓点不一致，优先信和声变化）'}`);
    }
    const bars = tracked.beats.filter((_, i) => (i - downbeat.phase) % downbeat.beatsPerBar === 0);
    if (bars.length) lines.push(`  小节起点（${bars.length} 个）：${bars.slice(0, 10).map((t) => sec(t)).join('、')}${bars.length > 10 ? ' …' : ''}`);
  }

  lines.push(`  起音点 ${onsets.count} 个 · 平均 ${onsets.count ? (onsets.count / Math.max(0.001, tempo.durationSeconds)).toFixed(2) : '0'} 个/秒`);

  if (align && align.times?.length) {
    const beats = tracked.beats;
    const fps = Number.isFinite(align.fps) && align.fps > 0 ? align.fps : 0;
    // A scene cut is reported at the first frame of the new shot, so its timestamp is
    // only known to ±1 frame. A 40ms tolerance silently fails on 24/25fps footage; widen
    // it to 1.5 frames and say why, instead of pretending the cut time is exact.
    const tol = Math.max(0.04, fps ? 1.5 / fps : 0);
    const dists = align.times.map((t) => {
      let best = Infinity;
      let at = t;
      for (const b of beats) {
        const d = Math.abs(t - b);
        if (d < best) { best = d; at = b; }
      }
      return { t, d: best, dt: t - at };
    });
    const near = dists.filter((d) => d.d <= tol);
    const med = median(dists.map((d) => d.d));
    const signed = median(dists.map((d) => d.dt));
    lines.push('');
    lines.push(`【卡点】画面切点 ${dists.length} 个 · 落在 ±${ms(tol * 1000)} 内 ${near.length} 个（${pctOf(near.length / dists.length)}）· 偏差中位数 ${ms(med * 1000)}`);
    if (fps) lines.push(`  容差按画面帧取整：${fps.toFixed(2)}fps → 一帧 ${ms(1000 / fps)}，切点时间天然有 ±${ms(1000 / fps)} 的量化误差。`);
    if (near.length / dists.length >= 0.5) {
      const inside = fps && Math.abs(signed) <= 1 / fps;
      lines.push(`  平均偏移 ${signed >= 0 ? '+' : ''}${ms(signed * 1000)}（正=切点晚于拍点）${inside ? '，在一帧以内，可视为对齐' : ''}。`);
    }
    const off = dists.filter((d) => d.d > tol).slice(0, 8);
    if (off.length) lines.push(`  未卡上的切点：${off.map((d) => `${sec(d.t)}（差 ${ms(d.d * 1000)}）`).join('、')}`);
    if (near.length / dists.length >= 0.8) lines.push('  结论：通篇按拍剪辑。');
    else if (near.length / dists.length >= 0.4) lines.push('  结论：部分镜头卡拍，其余按内容切。');
    else lines.push('  结论：画面不按拍剪辑（或镜头长度远大于一拍）。');
  }
  return lines.join('\n');
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/* ------------------------------------------------------------------- tonal */

export function chordRuns(chords, { minSeconds = 0.6 } = {}) {
  const PC = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const nameOf = (n) => PC[((n % 12) + 12) % 12];
  const runs = [];
  for (const seg of chords.segments || []) {
    const last = runs[runs.length - 1];
    if (last && last.root === seg.root && seg.start - last.end <= 0.05) {
      last.end = seg.end;
      last.segments += 1;
      last.labels.add(seg.label);
      last.margins.push(seg.margin ?? 0);
    } else {
      runs.push({ root: seg.root, rootName: nameOf(seg.root), start: seg.start, end: seg.end, segments: 1, labels: new Set([seg.label]), margins: [seg.margin ?? 0], outOfKey: seg.outOfKey });
    }
  }
  // Absorb stubs: a 0.4 s chord between two identical ones is an analysis artefact, not a chord change.
  const cleaned = [];
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    const prev = cleaned[cleaned.length - 1];
    const next = runs[i + 1];
    if (prev && next && prev.root === next.root && run.end - run.start < minSeconds) {
      prev.end = run.end;
      continue;
    }
    if (prev && prev.root === run.root) {
      prev.end = run.end;
      for (const l of run.labels) prev.labels.add(l);
      continue;
    }
    cleaned.push({ ...run, labels: new Set(run.labels) });
  }
  return cleaned;
}

export function reportTonal(tonal, { file = null } = {}) {
  const { key, chords, melody } = tonal;
  const lines = [];
  lines.push(file ? `【调性】${file}` : '【调性】');
  if (key) {
    const conf = key.tonal ? `置信 ${key.confidence?.toFixed?.(2) ?? '—'}（与次优相差 ${key.margin?.toFixed?.(3)}）` : '⚠ 太接近噪声，不给调性结论';
    lines.push(`  调性 ${key.key}${key.tonal ? ` · ${conf}` : ''}`);
    if (key.runnerUp) lines.push(`  次优 ${key.runnerUp}（相差 ${key.margin?.toFixed(3)}）${key.margin < 0.02 ? ' · ⚠ 两者几乎并列，调性可能写成关系大调/小调' : ''}`);
    if (key.noiseLike) lines.push('  ⚠ 频谱接近噪声，和弦/调性结论仅供参考。');
  }
  if (chords) {
    const runs = chordRuns(chords);
    const hist = (Array.isArray(chords.rootsHistogram) ? chords.rootsHistogram.map((x) => [x.name, x.share]) : [])
      .sort((a, b) => b[1] - a[1]);
    lines.push('');
    const changes = Math.max(0, runs.length - 1);
    lines.push(`【和弦】${chords.chordCount} 个 0.5s 片段 → 归并为 ${runs.length} 段（${changes} 次变化）· 平均区分度 ${chords.avgMargin?.toFixed(3) ?? '—'}`);
    if (chords.keyCheck) {
      const kc = chords.keyCheck;
      lines.push(`  与调性一致性 ${pctOf(1 - kc.outOfKeyShare)}${kc.agreesWithKey < 0.5 ? ' · ⚠ 和弦走向与推定调性不一致' : ''}`);
    }
    lines.push(`  主和弦占比：${hist.slice(0, 6).map(([r, v]) => `${r} ${pctOf(v)}`).join(' · ')}`);
    lines.push('  走向：');
    const shown = runs.slice(0, 24);
    for (const run of shown) {
      const labels = [...run.labels];
      const label = labels.length === 1 ? labels[0] : `${run.rootName || run.root}(混合 ${labels.slice(0, 3).join('/')})`;
      lines.push(`  ${sec(run.start).padStart(7)} → ${sec(run.end).padStart(7)}  ${label}${run.outOfKey ? '  [调外]' : ''}`);
    }
    if (runs.length > shown.length) lines.push(`  … 其余 ${runs.length - shown.length} 段省略`);
    lines.push('  说明：只保证根音；和弦性质（大三/小三/七）在混音里不可靠，标为“混合”时表示同一段内性质有来回。');
  }
  if (melody) {
    lines.push('');
    lines.push(`【旋律线】人声/主旋律 YIN 跟踪 · 有声帧 ${pctOf(melody.voicedFraction)}`);
    if (melody.tonal) {
      lines.push(`  音域 ${melody.rangeName}（${melody.rangeLow?.toFixed(1)}–${melody.rangeHigh?.toFixed(1)} 半音，5–95 分位）· 中位 ${melody.medianNote} · 置信 ${melody.confidence?.toFixed(2) ?? '—'}`);
    } else if (melody.rangeName) {
      lines.push(`  只追踪到片段：音域 ${melody.rangeName}（${melody.medianNote} 附近），有声帧不足/八度跳变偏多，不作为旋律结论。`);
    } else {
      lines.push('  ⚠ 没有稳定的音高线（可能整段是说话/打击乐/噪声），不给旋律结论。');
    }
    if (melody.octaveJumpRate > 0.05) lines.push(`  ⚠ 八度跳变率 ${pctOf(melody.octaveJumpRate)} 偏高，音域可能偏宽（已按局部中位数折叠）。`);
    lines.push('  注意：这是“最突出的有音高线”，混音里通常是贝斯或主旋律，不保证是人声。');
  }
  return lines.join('\n');
}

/* --------------------------------------------------------------- structure */

export function reportStructure(structure, { file = null, rhythm = null } = {}) {
  const { sections, decision } = structure;
  const lines = [];
  if (file) lines.push(`【曲式】${file}`);
  lines.push(`  判定：自相似矩阵 + 棋盘核（核 ${decision.kernelBeats} 拍，σ ${decision.sigma}，最小 ${decision.minBeats} 拍）`);
  lines.push(`  阈值 ${decision.threshold.toFixed(3)}（新颖度均值 ${decision.mean.toFixed(3)}、标准差 ${decision.std.toFixed(3)}）`);
  if (!sections?.length) {
    lines.push('  没有检测到段落边界：整首可视为单段。');
    return lines.join('\n');
  }
  lines.push(`  共 ${sections.length} 段：`);
  for (const section of sections) {
    const bits = [];
    if (Number.isFinite(section.vocalBandShare)) bits.push(`人声带 ${pctOf(section.vocalBandShare)}`);
    if (Number.isFinite(section.lowBandShare)) bits.push(`低频 ${pctOf(section.lowBandShare)}`);
    if (Number.isFinite(section.energyDb)) bits.push(`能量 ${section.energyDb.toFixed(1)}dB`);
    if (Number.isFinite(section.similarityToEarlier) && section.label.includes("'")) bits.push(`与 ${section.label.replace(/'/g, '')} 相似 ${pctOf(section.similarityToEarlier)}`);
    lines.push(`  ${section.label}  ${sec(section.start).padStart(7)} → ${sec(section.end).padStart(7)}  ${sec(section.end - section.start).padStart(6)}  ${bits.join(' · ')}`);
  }
  const boundaries = structure.boundaries || [];
  if (boundaries.length) {
    // Only boundaries that actually became a section start are "used"; the rest were
    // found by the novelty curve but did not survive the minimum-length rule.
    const starts = new Set(sections.map((s) => round1(s.start)));
    const used = boundaries.filter((b) => starts.has(round1(b.time)));
    const dropped = boundaries.filter((b) => !starts.has(round1(b.time)));
    if (used.length) lines.push(`  采用的分段边界：${used.map((b) => `${sec(b.time)}=${b.strength.toFixed(2)}`).join('、')}`);
    if (dropped.length) {
      lines.push(`  另有 ${dropped.length} 个候选边界未采用（太短或与相邻段太像）：${dropped.map((b) => sec(b.time)).join('、')}`);
    }
  }
  // Where things come in/out is often more useful than the section table itself.
  if (rhythm?.tracked?.beats?.length && sections.length > 1) {
    const barLines = sections.map((s) => s.start);
    lines.push(`  段落起点对齐：${barLines.map((t) => sec(t)).join('、')}`);
  }
  return lines.join('\n');
}

/* ---------------------------------------------------------------- speech */

export function reportSpeech(speech, { file = null, showSrt = false, maxLines = 60, compact = false } = {}) {
  const lines = [];
  if (file) lines.push(`【人声】${file}`);
  const vad = speech.vad;
  if (vad) {
    const covered = Number.isFinite(vad.speechSeconds) ? vad.speechSeconds : speech.speechSeconds;
    const skipped = Math.max(0, vad.totalSeconds - covered);
    const pieces = Array.isArray(vad.blocks) ? vad.blocks.length : 0;
    const windows = Array.isArray(speech.windows) ? speech.windows.length : (Number.isFinite(speech.windows) ? speech.windows : pieces);
    const merged = pieces > windows && windows > 0;
    lines.push(`  人声切分：整段 ${sec(vad.totalSeconds)} → ${pieces} 个有人声片段${merged ? `、并为 ${windows} 个识别窗` : ''}，覆盖 ${sec(covered)}，其余 ${sec(skipped)} 跳过`);
    if (windows > speech.segments.length) {
      lines.push(`  其中 ${windows - speech.segments.length} 个窗口无文本（识别为空或被丢弃）。`);
    }
    lines.push(`  能量门限 ${vad.thresholdDb.toFixed(1)}dB（噪声底 ${(20 * Math.log10(vad.noiseFloor || 1e-9)).toFixed(1)}dB，响段 ${(20 * Math.log10(vad.loud || 1e-9)).toFixed(1)}dB）`);
    if (vad.flat) {
      lines.push(`  ⚠ 动态范围只有 ${vad.dynamicDb.toFixed(1)}dB（<6dB）→ 没有可切的静音，整段直接交给识别器；持续音/纯音乐也可能被硬转写，结果需自行判断。`);
    }
  }
  lines.push(`  识别器 ${speech.provider} · 语言 ${speech.language} · 有效块 ${speech.segments.length}`);
  for (const note of speech.notes || []) lines.push(`  ${note}`);
  if (!speech.segments.length) {
    lines.push('  没有可用的转写内容。');
    return lines.join('\n');
  }
  const per = speech.segments.map((s) => s.inferenceSeconds).filter((v) => Number.isFinite(v));
  if (per.length) {
    const total = per.reduce((a, b) => a + b, 0);
    const audio = speech.segments.reduce((a, s) => a + s.seconds, 0);
    lines.push(`  推理耗时 ${total.toFixed(2)}s（实时率 ${(total / Math.max(0.001, audio)).toFixed(2)}×，越小越快）`);
  }
  lines.push('  转写：');
  const limit = compact ? Math.min(maxLines, 3) : maxLines;
  const shown = speech.segments.slice(0, limit);
  for (const seg of shown) lines.push(`  [${sec(seg.start).padStart(7)} → ${sec(seg.end).padStart(7)}] ${seg.text}`);
  if (speech.segments.length > shown.length) {
    lines.push(compact
      ? `  …… 共 ${speech.segments.length} 段，省略 ${speech.segments.length - shown.length} 段（音乐文件，转写仅供对照）`
      : `  … 其余 ${speech.segments.length - shown.length} 块省略`);
  }
  if (showSrt) {
    lines.push('');
    lines.push('  SRT：');
    for (const line of speech.srt.split('\n')) lines.push(`  ${line}`);
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------ status */

export function reportStatus(status) {
  const lines = [];
  lines.push('【dsh-better-ears 环境】');
  lines.push(`  ffmpeg ${status.ffmpeg.version || '未知'} ${status.ffmpeg.path || status.ffmpeg.ffmpeg || ''}`);
  const ffprobePath = status.ffmpeg.ffprobe;
  if (ffprobePath) lines.push(`  ffprobe ${status.ffmpeg.ffprobeVersion || '已找到'}`);
  lines.push(`  分析采样率 ${status.sampleRate}Hz · 缓存在内存里最多 ${status.cacheEntries} 个文件`);
  lines.push(`  设置页 ${status.configWritable ? '可写（配置保存回 dsh-better-ears 这一条）' : '只读（没有找到 configEditor，改动只在本次会话生效）'}`);
  lines.push('');
  lines.push('【语音识别】');
  lines.push(`  传输方式 ${status.asr.transport.kind}${status.asr.transport.kind === 'none' ? '（不可用）' : ''}`);
  if (status.asr.speech.present) {
    for (const p of status.asr.speech.providers) {
      const progress = p.totalBytes ? ` ${pctOf((p.completedBytes || 0) / p.totalBytes)}` : '';
      lines.push(`  provider ${p.id} · ${p.name} · ${p.phase}${p.step ? `/${p.step}` : ''}${progress} · 语言 ${(p.languages || []).join('/')}`);
    }
    if (!status.asr.speech.providers.length) lines.push('  ⚠ DSH 的 speechToText 服务在，但没有注册任何识别器。');
  } else {
    lines.push('  ⚠ DSH 没有加载 speechToText 服务（设置 → 语音输入 未启用）。');
  }
  if (status.asr.local?.error) lines.push(`  ⚠ 尝试自动挂载本地识别失败：${status.asr.local.error}`);
  if (status.asr.local?.registered) lines.push(`  已自动挂载本地识别 provider：${status.asr.local.providerId}`);
  if (status.asr.needsDownload) lines.push('  首次识别需要下载模型（约 240MB）；audio_speech 传 prepare:true 或在本插件设置页点「启用本地识别」。');
  if (status.asr.endpoint?.configured) lines.push(`  远端接口 ${status.asr.endpoint.url} · 模型 ${status.asr.endpoint.model}`);
  if (status.asr.command) lines.push(`  命令模板 ${status.asr.command}`);
  if (!status.asr.canTranscribe) lines.push('  当前没有任何可用的转写通道。');
  return lines.join('\n');
}

/* -------------------------------------------------------------------- read */

export function reportRead({ info, rhythm, tonal, structure, speech, align, notes = [], kind = null }) {
  const lines = [];
  const head = [oneLine(info)];
  if (kind?.kind === 'music') head.push('音乐');
  else if (kind?.kind === 'speech') head.push('语音');
  if (rhythm?.tempo && kind?.kind !== 'speech') head.push(`${rhythm.tempo.bpm.toFixed(0)}BPM`);
  if (tonal?.key?.tonal) head.push(tonal.key.key);
  if (structure?.sections?.length) head.push(`${structure.sections.length} 段`);
  lines.push(`【总览】${head.join(' · ')}`);
  if (info.hasVideo) {
    const fps = info.video[0]?.frameRate ? fmtRate(info.video[0].frameRate) : '';
    lines.push(`  视频 ${info.video[0]?.width}×${info.video[0]?.height}${fps ? ` · ${fps}fps` : ''} · 可按画面切点检查卡拍`);
  }
  lines.push('');
  // In a one-shot overview a song's "transcript" is noise; keep a sample, not a transcript.
  if (speech) lines.push(reportSpeech(speech, { maxLines: kind?.kind === 'music' ? 6 : 24, compact: kind?.kind === 'music' }).replace(/\n\n+/g, '\n'), '');
  if (rhythm) {
    if (kind?.kind === 'speech') {
      // Speech has no beat: print the estimate as a non-conclusion, not as a tempo.
      lines.push(`【节奏】语音没有稳定节拍；自动估计 ${rhythm.tempo.bpm.toFixed(0)}BPM（置信 ${rhythm.tempo.score.toFixed(2)}，脉冲清晰度 ${(rhythm.tracked.pulseClarity ?? 0).toFixed(1)}），不要据此判断节奏。`, '');
    } else {
      lines.push(reportRhythm(rhythm, { align }).replace(/\n\n+/g, '\n'), '');
    }
  }
  if (align?.pauses?.length && align.times?.length && rhythm) {
    const tol = 0.25;
    const dist = align.times.map((t) => {
      let best = Infinity;
      for (const p of align.pauses) best = Math.min(best, Math.abs(t - p));
      return { t, d: best };
    });
    const near = dist.filter((d) => d.d <= tol);
    const med = median(dist.map((d) => d.d));
    lines.push(`【切点】说话停顿处切画面 ${near.length}/${dist.length} 个（±${ms(tol * 1000)} 内，${pctOf(near.length / dist.length)}）· 偏差中位数 ${ms(med * 1000)}`);
    if (near.length / dist.length >= 0.7) lines.push('  结论：剪辑跟着说话走，切点基本落在停顿上。');
    else if (near.length / dist.length >= 0.4) lines.push('  结论：部分切点落在停顿上，其余按画面内容切。');
    else lines.push('  结论：画面切点与说话停顿无关（或镜头很长）。');
    lines.push('');
  }
  if (tonal) lines.push(reportTonal(tonal).replace(/\n\n+/g, '\n'), '');
  if (structure) lines.push(reportStructure(structure, { rhythm }).replace(/\n\n+/g, '\n'), '');
  for (const note of notes) lines.push(`注：${note}`);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
