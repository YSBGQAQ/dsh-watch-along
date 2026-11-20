/**
 * The seven tools.
 *
 * Every tool returns `{ text }` and one shared renderer: the text IS the result. That is
 * deliberate — an agent that "hears" needs prose it can reason about (BPM with its
 * ambiguity, sections with their thresholds), not a blob of JSON it must re-summarize.
 * The structured value exists only so the card and logs keep a copy.
 */

import { existsSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, resolve } from 'node:path';

import * as audio from './audio.js';
import * as analyze from './analyze.js';
import { AsrError, ensureProvider, plannedTransport, speechService, transcribeFile } from './asr.js';
import * as fmt from './format.js';

const OUTPUT = {
  schema: {
    type: 'object',
    properties: { text: { type: 'string', description: 'Human/agent-readable analysis report.' } },
    required: ['text'],
    additionalProperties: false,
  },
  render(_args, value) {
    return [{ type: 'text', text: String(value?.text ?? '') }];
  },
};

const str = (description) => ({ type: 'string', description });
const num = (description) => ({ type: 'number', description });
const bool = (description) => ({ type: 'boolean', description });

/** ~/x, ./x and file:// all mean the same thing to a person typing a path. */
export function resolveMediaPath(input) {
  let file = String(input || '').trim();
  if (!file) throw new Error('需要一个音频或视频文件路径');
  if (file.startsWith('file://')) file = decodeURIComponent(file.slice(7));
  if (file === '~') file = homedir();
  else if (file.startsWith('~/')) file = resolve(homedir(), file.slice(2));
  if (!isAbsolute(file)) file = resolve(process.cwd(), file);
  if (!existsSync(file)) throw new Error(`文件不存在：${file}`);
  const stat = statSync(file);
  if (!stat.isFile()) throw new Error(`不是文件：${file}`);
  if (stat.size === 0) throw new Error(`文件是空的：${file}`);
  return file;
}

/** ffprobe reports frame rates as "30000/1001"; scene-cut tolerance needs a number. */
function parseRate(rate) {
  if (!rate) return 0;
  const [num, den] = String(rate).split('/').map(Number);
  if (Number.isFinite(num) && Number.isFinite(den) && den > 0) return num / den;
  const value = Number(rate);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function hintFor(error) {
  if (error?.hint) return error.hint;
  if (error instanceof AsrError) return error.hint || '';
  const text = String(error?.message || error);
  if (/ffmpeg|ffprobe/i.test(text)) return '确认 ffmpeg 可用：audio_status 会给出它找到的路径；也可以在插件设置里指定 ffmpegPath。';
  if (/ENOENT/.test(text)) return '路径写错了，或者文件已被移动。';
  if (/no audio/i.test(text) || /没有音轨/.test(text)) return '这个文件没有音轨；换成带声音的文件，或用 audio_probe 确认流信息。';
  return '';
}

function failure(label, error) {
  const message = String(error?.message || error);
  const hint = hintFor(error);
  return { text: `失败：${label}\n原因：${message}${hint ? `\n建议：${hint}` : ''}` };
}

/** A 60-second answer to a 4-minute song must say so, in the first line. */
function windowNote(prepared) {
  if (!prepared?.truncated) return '';
  const from = prepared.startSeconds ?? 0;
  const to = from + (prepared.seconds ?? 0);
  return `（分析窗口 ${fmt.sec(from)}–${fmt.sec(to)}，全长 ${fmt.sec(prepared.info?.durationSeconds)}；要整首请调大 maxSeconds）\n`;
}

/** Run one tool body, turning every failure into readable text instead of a thrown tool error. */
async function guarded(label, body) {
  try {
    return await body();
  } catch (error) {
    return failure(label, error);
  }
}

/* ------------------------------------------------------------------ status */

async function ffmpegInfo(config) {
  const paths = audio.resolveFfmpeg(config);
  try {
    const { stdout } = await audio.run(paths.ffmpeg, ['-hide_banner', '-version'], { timeoutMs: 15_000 });
    const version = String(stdout).split('\n')[0]?.replace(/^ffmpeg version\s*/i, '').split(' ')[0] || null;
    let ffprobeVersion = null;
    try {
      const probeOut = await audio.run(paths.ffprobe, ['-hide_banner', '-version'], { timeoutMs: 15_000 });
      ffprobeVersion = String(probeOut.stdout).split('\n')[0]?.replace(/^ffprobe version\s*/i, '').split(' ')[0] || null;
    } catch { /* ffprobe is optional for everything except probe() */ }
    return { ...paths, version, ffprobeVersion };
  } catch (error) {
    return { ...paths, version: null, error: String(error?.message || error) };
  }
}

function asrStatus(ctx, config, localAsr) {
  const service = speechService(ctx);
  let speech = { present: Boolean(service), providers: [], selection: null };
  if (service) {
    try {
      const snap = service.snapshot();
      speech = {
        present: true,
        selection: snap?.selection ?? null,
        providers: (snap?.providers || []).map((p) => ({
          id: p.id,
          name: p.name,
          languages: p.languages || [],
          phase: p.preparation?.phase || 'unknown',
          step: p.preparation?.step ?? null,
          completedBytes: p.preparation?.completedBytes ?? null,
          totalBytes: p.preparation?.totalBytes ?? null,
        })),
      };
    } catch (error) {
      speech = { present: true, providers: [], selection: null, error: String(error?.message || error) };
    }
  }
  const transport = plannedTransport(ctx, config);
  const configuredId = config?.asr?.providerId || speech.selection?.providerId || null;
  const selected = speech.providers.find((p) => p.id === configuredId) || null;
  const ready = speech.providers.find((p) => p.phase === 'ready' || p.phase === 'standby');
  return {
    transport,
    speech,
    local: localAsr,
    needsDownload: Boolean(selected && !ready && selected.phase !== 'failed'),
    endpoint: {
      configured: Boolean(config?.asr?.endpoint?.url && config?.asr?.endpoint?.model),
      url: config?.asr?.endpoint?.url || null,
      model: config?.asr?.endpoint?.model || null,
    },
    command: config?.asr?.command || null,
    canTranscribe: transport.kind === 'host' || transport.kind === 'endpoint' || transport.kind === 'command',
  };
}

/* ------------------------------------------------------------------- tools */

/**
 * @param {object} deps
 * @param {import('@deepseek-ai/cordis').Context} deps.ctx
 * @param {() => object} deps.getConfig live config (settings page writes it)
 * @param {() => Promise<{registered:boolean, providerId?:string, error?:string}>} deps.localAsr
 */
export function createTools({ ctx, getConfig, localAsr }) {
  const config = () => getConfig();

  const probeTool = {
    name: 'audio_probe',
    description: [
      'Read a media file\'s audio container WITHOUT decoding it: streams, duration, EBU R128 loudness,',
      'silence map, and (for video) scene cuts. Cheap — use it first when you know nothing about a file,',
      'or when you only need "is there sound, how loud, where are the gaps".',
      '',
      'For content (what is said, key, tempo, sections) use audio_read / audio_speech instead.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        file: str('Path to an audio or video file (~ and relative paths are resolved).'),
        silenceDb: num('Silence threshold in dBFS (default -35). Lower = stricter, fewer silences.'),
        minSilenceSeconds: num('Shortest silence worth reporting, seconds (default 0.55).'),
        cuts: bool('Also detect video scene cuts (default false; only meaningful for video).'),
        cutThreshold: num('ffmpeg scene score threshold 0..1 (default 0.3). Higher = fewer cuts.'),
      },
      required: ['file'],
      additionalProperties: false,
    },
    output: OUTPUT,
    timeoutMs: 120_000,
    isConcurrencySafe: () => true,
    async execute(args) {
      return guarded('audio_probe', async () => {
        const file = resolveMediaPath(args.file);
        const cfg = config();
        const info = await audio.probe(file, cfg);
        const extra = {};
        if (info.hasAudio) {
          extra.loudness = await audio.loudness(file, { config: cfg });
          const silence = await audio.silenceMap(file, {
            config: cfg,
            noiseDb: args.silenceDb ?? -35,
            minSilenceSeconds: args.minSilenceSeconds ?? 0.55,
          });
          extra.silences = {
            regions: silence.silences,
            noiseDb: silence.params.noiseDb,
            minSilenceSeconds: silence.params.minSilenceSeconds,
            totalSilentSeconds: silence.silences.reduce((sum, s) => sum + (s.end - s.start), 0),
          };
        }
        if (args.cuts && info.hasVideo) {
          const times = await audio.sceneCuts(file, { config: cfg, threshold: args.cutThreshold ?? 0.3 });
          extra.cuts = { times, threshold: args.cutThreshold ?? 0.3 };
        }
        return { text: fmt.reportProbe(info, extra) };
      });
    },
  };

  const speechTool = {
    name: 'audio_speech',
    description: [
      'Transcribe speech in an audio or video file, with timestamps and an SRT track.',
      '',
      'Non-speech is cut away by energy VAD before recognition, so music, applause and silence are not',
      'sent to the model (and cannot become hallucinated sentences). The report says exactly how much',
      'audio was skipped. Works offline when DSH has a local recognizer; otherwise uses the configured',
      'OpenAI-compatible endpoint or command.',
      '',
      'First use of the local recognizer needs a ~240 MB model download: if the report says "尚未就绪",',
      'call again with prepare:true (or set it up in the dsh-better-ears settings page).',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        file: str('Path to an audio or video file.'),
        language: str('Spoken language hint (zh/en/yue/ja/ko/auto). Defaults to the plugin setting.'),
        maxSeconds: num('Analyze at most this many seconds from the start (default 1800).'),
        prepare: bool('Allow the local recognizer to download/load its model now (default false).'),
        srt: bool('Include the full SRT text in the report (default false).'),
        writeSrt: bool('Write an .srt file next to the media (default false).'),
      },
      required: ['file'],
      additionalProperties: false,
    },
    output: OUTPUT,
    timeoutMs: 900_000,
    isConcurrencySafe: () => false,
    async execute(args) {
      return guarded('audio_speech', async () => {
        const file = resolveMediaPath(args.file);
        const cfg = config();
        await localAsr();
        const speech = await transcribeFile(file, {
          ctx,
          config: cfg,
          language: args.language || cfg?.asr?.language || 'auto',
          maxSeconds: args.maxSeconds ?? cfg?.asr?.maxSeconds ?? 1800,
          prepare: Boolean(args.prepare),
          prepareTimeoutMs: cfg?.asr?.prepareTimeoutMs ?? 120_000,
        });
        const text = fmt.reportSpeech(speech, { file, showSrt: Boolean(args.srt) });
        const lines = [text];
        if (args.writeSrt && speech.srt) {
          const out = `${file.replace(/\.[^.]+$/, '')}.srt`;
          writeFileSync(out, speech.srt, 'utf8');
          lines.push(`\n已写出字幕：${out}`);
        }
        return { text: lines.join('\n') };
      });
    },
  };

  const rhythmTool = {
    name: 'audio_rhythm',
    description: [
      'Tempo and beat grid: BPM, every beat time, the downbeat phase, and — for video — whether the cuts',
      'land on the beat. Use it to cut a video on the beat, to transcribe a drum pattern, or to explain',
      '"why does this edit feel off".',
      '',
      'BPM ambiguity is reported, never hidden: half/double-time rivals are printed with their scores.',
      'Downbeat is reported with its contrast; when the four phases are indistinguishable the report says',
      'so instead of inventing a bar number.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        file: str('Path to an audio or video file.'),
        startSeconds: num('Start of the analyzed window in seconds (default 0).'),
        durationSeconds: num('Length of the analyzed window in seconds (default: whole file, capped by setting).'),
        alignCuts: bool('Detect video scene cuts and compare them to the beat grid (default false).'),
      },
      required: ['file'],
      additionalProperties: false,
    },
    output: OUTPUT,
    timeoutMs: 600_000,
    isConcurrencySafe: () => false,
    async execute(args) {
      return guarded('audio_rhythm', async () => {
        const file = resolveMediaPath(args.file);
        const cfg = config();
        const prepared = await analyze.prepare(file, {
          config: cfg,
          startSeconds: args.startSeconds ?? 0,
          maxSeconds: args.durationSeconds ?? cfg?.maxAnalyzeSeconds ?? 600,
        });
        const rhythm = analyze.rhythmFrom(prepared);
        const kind = analyze.contentKind({ rhythm });
        let align = null;
        const info = await audio.probe(file, cfg);
        if (args.alignCuts && info.hasVideo) {
          const times = await audio.sceneCuts(file, { config: cfg, threshold: cfg?.cutThreshold ?? 0.3 });
          align = { times, fps: parseRate(info.video?.[0]?.frameRate) };
        }
        const caveat = kind.kind === 'speech'
          ? `注：内容更像语音（${kind.reasons.join('、')}），上面的节拍数字仅供参考。\n`
          : '';
        return { text: caveat + windowNote(prepared) + fmt.reportRhythm(rhythm, { file, align }) };
      });
    },
  };

  const tonalTool = {
    name: 'audio_tonal',
    description: [
      'Harmony: key, chord progression by root, and the dominant pitched line.',
      '',
      'Only roots are guaranteed — chord quality (major/minor/seventh) is unstable in a full mix and is',
      'reported as "mixed" when the estimate flip-flops. Pitches are folded onto pitch classes after',
      'harmonic/percussive separation, so drums do not decide the key.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        file: str('Path to an audio or video file.'),
        startSeconds: num('Start of the analyzed window (default 0).'),
        durationSeconds: num('Window length (default: whole file, capped by setting).'),
        chords: bool('Include the chord progression (default true).'),
        melody: bool('Include the pitched-line track (default true).'),
      },
      required: ['file'],
      additionalProperties: false,
    },
    output: OUTPUT,
    timeoutMs: 600_000,
    isConcurrencySafe: () => false,
    async execute(args) {
      return guarded('audio_tonal', async () => {
        const file = resolveMediaPath(args.file);
        const cfg = config();
        const prepared = await analyze.prepare(file, {
          config: cfg,
          startSeconds: args.startSeconds ?? 0,
          maxSeconds: args.durationSeconds ?? cfg?.maxAnalyzeSeconds ?? 600,
        });
        const rhythm = analyze.rhythmFrom(prepared);
        const tonal = analyze.tonalFrom(prepared, { beats: rhythm.tracked.beats });
        const kind = analyze.contentKind({ rhythm });
        const value = {
          ...tonal,
          chords: args.chords === false ? null : tonal.chords,
          melody: args.melody === false ? null : tonal.melody,
        };
        const caveat = kind.kind === 'speech'
          ? `注：内容更像语音（${kind.reasons.join('、')}），调性/和弦对语音没有意义。\n`
          : '';
        return { text: caveat + windowNote(prepared) + fmt.reportTonal(value, { file }) };
      });
    },
  };

  const structureTool = {
    name: 'audio_structure',
    description: [
      'Song form: how many sections, where they start, which ones repeat, and what changes between them',
      '(vocal-band share, low-end share, energy). Built from a beat-synchronous self-similarity matrix,',
      'not from loudness — so a quiet verse and a loud verse are still recognized as the same section.',
      '',
      'The decision threshold and its statistics are printed; a single-section answer is a real answer.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        file: str('Path to an audio or video file.'),
        startSeconds: num('Start of the analyzed window (default 0).'),
        durationSeconds: num('Window length (default: whole file, capped by setting).'),
      },
      required: ['file'],
      additionalProperties: false,
    },
    output: OUTPUT,
    timeoutMs: 600_000,
    isConcurrencySafe: () => false,
    async execute(args) {
      return guarded('audio_structure', async () => {
        const file = resolveMediaPath(args.file);
        const cfg = config();
        const prepared = await analyze.prepare(file, {
          config: cfg,
          startSeconds: args.startSeconds ?? 0,
          maxSeconds: args.durationSeconds ?? cfg?.maxAnalyzeSeconds ?? 600,
        });
        const rhythm = analyze.rhythmFrom(prepared);
        const tonal = analyze.tonalFrom(prepared, { beats: rhythm.tracked.beats });
        const structure = analyze.structureFrom(tonal, rhythm);
        return {
          text: windowNote(prepared) + fmt.reportStructure(
            { ...structure, downbeatHarmonic: structure.downbeatHarmonic },
            { file, rhythm },
          ),
        };
      });
    },
  };

  const readTool = {
    name: 'audio_read',
    description: [
      'Hear the whole thing at once: speech (if any), tempo and beat grid, key/chords/pitched line, and',
      'song form — one file, one call, one report. This is the default entry point; drill down with',
      'audio_speech / audio_rhythm / audio_tonal / audio_structure when you need more of one axis.',
      '',
      'Speech is skipped automatically when no recognizer is available or the file is longer than the',
      'speech budget; the report says which part was skipped and why.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        file: str('Path to an audio or video file.'),
        speech: bool('Include transcription (default true when a recognizer is available).'),
        language: str('Spoken language hint (zh/en/yue/ja/ko/auto).'),
        prepare: bool('Allow the local recognizer to download/load its model now (default false).'),
        alignCuts: bool('For video: compare scene cuts to the beat grid (default true).'),
        maxSeconds: num('Analyze at most this many seconds (default 600).'),
      },
      required: ['file'],
      additionalProperties: false,
    },
    output: OUTPUT,
    timeoutMs: 1_200_000,
    isConcurrencySafe: () => false,
    async execute(args) {
      return guarded('audio_read', async () => {
        const file = resolveMediaPath(args.file);
        const cfg = config();
        const info = await audio.probe(file, cfg);
        if (!info.hasAudio) {
          return { text: `${fmt.reportProbe(info, {})}\n\n没有音轨，音频分析到此为止。` };
        }
        const prepared = await analyze.prepare(file, {
          config: cfg,
          maxSeconds: args.maxSeconds ?? cfg?.maxAnalyzeSeconds ?? 600,
        });
        const rhythm = analyze.rhythmFrom(prepared);
        const tonal = analyze.tonalFrom(prepared, { beats: rhythm.tracked.beats });
        const structure = analyze.structureFrom(tonal, rhythm);
        const energy = analyze.energyFrom(prepared);
        const kind = analyze.contentKind({ rhythm, structure, tonal });
        const isSpeech = kind.kind === 'speech';

        const notes = [];
        if (isSpeech) notes.push(`内容更像语音（${kind.reasons.join('、')}），跳过调性/和弦/旋律；节拍数字仅供参考。`);
        let speech = null;
        const wantSpeech = args.speech !== false;
        if (wantSpeech) {
          await localAsr();
          const transport = plannedTransport(ctx, cfg);
          if (transport.kind === 'none') {
            notes.push('没有可用的语音识别通道，跳过转写；在 dsh-better-ears 设置页启用本地识别或配置接口后重试。');
          } else if ((info.durationSeconds ?? 0) > (cfg?.asr?.maxSeconds ?? 1800)) {
            notes.push(`文件长于 ${cfg?.asr?.maxSeconds ?? 1800}s，只转写前 ${cfg?.asr?.maxSeconds ?? 1800}s。`);
          }
          if (transport.kind !== 'none') {
            try {
              speech = await transcribeFile(file, {
                ctx,
                config: cfg,
                language: args.language || cfg?.asr?.language || 'auto',
                maxSeconds: cfg?.asr?.maxSeconds ?? 1800,
                prepare: Boolean(args.prepare),
                prepareTimeoutMs: cfg?.asr?.prepareTimeoutMs ?? 120_000,
              });
            } catch (error) {
              notes.push(`转写未完成：${String(error?.message || error)}${error?.hint ? `（${error.hint}）` : ''}`);
            }
          }
        } else {
          notes.push('按要求未做语音识别。');
        }
        if (!isSpeech && speech?.segments?.length) {
          notes.push('内容更像音乐：识别器是为说话训练的，上面的“转写”连唱词都算不上，只能当噪声参考。');
        }

        let align = null;
        if (args.alignCuts !== false && info.hasVideo) {
          const times = await audio.sceneCuts(file, { config: cfg, threshold: cfg?.cutThreshold ?? 0.3 });
          if (times.length) {
            align = { times, fps: parseRate(info.video?.[0]?.frameRate) };
            // A talking video has no beat to cut to, but it does have pauses: editors cut
            // between sentences. Compare cuts to the gaps the VAD already found.
            const blocks = speech?.vad?.blocks ?? [];
            if (blocks.length) {
              const pauses = [0];
              for (let i = 1; i < blocks.length; i++) pauses.push((blocks[i - 1].end + blocks[i].start) / 2);
              pauses.push(info.durationSeconds ?? blocks[blocks.length - 1].end);
              align.pauses = pauses;
            }
          }
        }

        const headNote = windowNote(prepared);
        const text = headNote + fmt.reportRead({
          info,
          rhythm,
          tonal: isSpeech ? null : tonal,
          structure: isSpeech ? null : structure,
          speech,
          align,
          energy,
          notes,
          kind,
        });
        return { text };
      });
    },
  };

  const statusTool = {
    name: 'audio_status',
    description: [
      'Environment self-check for audio work: where ffmpeg is, which speech recognizers DSH has loaded and',
      'whether they are ready, which transport a transcription would use, and the active settings.',
      '',
      'Call it when a previous audio tool failed or said "尚未就绪". With prepare:true it will also start',
      'the local recognizer download (blocking until ready or timeout).',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        prepare: bool('Start/await local recognizer preparation (downloads ~240 MB on first use).'),
      },
      additionalProperties: false,
    },
    output: OUTPUT,
    timeoutMs: 900_000,
    isConcurrencySafe: () => true,
    async execute(args) {
      return guarded('audio_status', async () => {
        const cfg = config();
        const state = await localAsr();
        const ffmpeg = await ffmpegInfo(cfg);
        const asr = asrStatus(ctx, cfg, state);
        let configEditor = null;
        try { configEditor = ctx?.get?.('configEditor') ?? null; } catch { configEditor = null; }
        const lines = [fmt.reportStatus({
          ffmpeg,
          sampleRate: analyze.ANALYSIS_SR,
          cacheEntries: cfg?.cacheEntries ?? 3,
          configWritable: Boolean(configEditor && ctx?.fiber?.entry),
          asr,
        })];
        if (args.prepare) {
          const service = speechService(ctx);
          if (!service) {
            lines.push('\n无法准备：DSH 没有 speechToText 服务。');
          } else {
            lines.push('\n开始准备本地识别器（首次需下载模型）…');
            try {
              const id = await ensureProvider(service, {
                providerId: cfg?.asr?.providerId || null,
                timeoutMs: cfg?.asr?.prepareTimeoutMs ?? 600_000,
                onProgress: (p) => lines.push(`  ${p.phase}${p.step ? `/${p.step}` : ''}${p.percent === null ? '' : ` ${p.percent}%`}`),
              });
              lines.push(`就绪：${id}`);
            } catch (error) {
              lines.push(`准备失败：${String(error?.message || error)}${error?.hint ? `\n${error.hint}` : ''}`);
            }
          }
        }
        lines.push('');
        lines.push(`设置：mode=${cfg?.asr?.mode ?? 'auto'} · language=${cfg?.asr?.language ?? 'auto'} · maxSeconds=${cfg?.asr?.maxSeconds ?? 1800}`);
        return { text: lines.join('\n') };
      });
    },
  };

  return [readTool, speechTool, rhythmTool, tonalTool, structureTool, probeTool, statusTool];
}

/** Kept out of the tool list: purely cosmetic extra hint lines. */
export function summarizeFile(file) {
  const ext = extname(file).toLowerCase();
  const kind = ['.mp4', '.mov', '.mkv', '.webm', '.avi'].includes(ext) ? 'video'
    : ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus'].includes(ext) ? 'audio' : 'media';
  return { name: basename(file), dir: dirname(file), kind };
}
