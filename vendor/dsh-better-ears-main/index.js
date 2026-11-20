/**
 * dsh-better-ears — audio that the agent can actually hear.
 *
 * Two halves, both local:
 *   1. DSP (lib/dsp/*): tempo, beat grid, key, chords, pitched line, song form, loudness.
 *   2. Speech: reuse the recognizer DSH already ships. If the host has no `speechToText`
 *      service, this plugin loads the built-in SenseVoice package itself (model on first
 *      use, ~240 MB, hf-mirror first because huggingface.co is often unreachable).
 *
 * Nothing here is required for the DSP tools: if speech setup fails, the audio tools still
 * work and audio_status explains the failure.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import * as analyze from './lib/analyze.js';
import { describeSpeech, ensureProvider, plannedTransport, speechService } from './lib/asr.js';
import { resolveFfmpeg, run } from './lib/audio.js';
import { createSettingsServer } from './lib/settings.js';
import { createTools } from './lib/tools.js';

export const name = 'dsh-better-ears';

/**
 * `tools` is genuine: every tool here needs it. webServer/attachments/configEditor are
 * looked up with ctx.get() instead, so a host without them still loads (inject is a hard
 * prefix in cordis: a missing service would stop apply from running at all).
 */
export const inject = ['tools'];

const DEFAULTS = {
  ffmpegPath: '',
  ffprobePath: '',
  maxAnalyzeSeconds: 600,
  cacheEntries: 3,
  cutThreshold: 0.3,
  enableLocalAsr: true,
  localAsrProviderId: 'ears-sensevoice',
  localAsrDataRoot: '',
  localAsrPrecision: 'int8',
  localAsrThreads: 2,
  asr: {
    mode: 'auto',
    language: 'auto',
    providerId: '',
    maxSeconds: 1800,
    windowSeconds: 24,
    minSpeechSeconds: 0.2,
    minGapSeconds: 0.35,
    thresholdRatio: 0.25,
    prepareTimeoutMs: 600_000,
    endpoint: { url: '', model: '', apiKey: '', language: '' },
    command: '',
  },
};

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function mergeDeep(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...(isPlainObject(base) ? base : {}) };
  if (!isPlainObject(patch)) return out;
  for (const [key, value] of Object.entries(patch)) {
    if (isPlainObject(value) && isPlainObject(out[key])) out[key] = mergeDeep(out[key], value);
    else if (value !== undefined) out[key] = value;
  }
  return out;
}

function normalize(raw) {
  const merged = mergeDeep(DEFAULTS, isPlainObject(raw) ? raw : {});
  const number = (value, fallback, min, max) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
  };
  merged.maxAnalyzeSeconds = number(merged.maxAnalyzeSeconds, 600, 10, 7200);
  merged.cacheEntries = Math.round(number(merged.cacheEntries, 3, 1, 10));
  merged.cutThreshold = number(merged.cutThreshold, 0.3, 0.02, 1);
  merged.localAsrThreads = Math.round(number(merged.localAsrThreads, 2, 1, 16));
  merged.localAsrPrecision = merged.localAsrPrecision === 'fp32' ? 'fp32' : 'int8';
  merged.asr.maxSeconds = number(merged.asr.maxSeconds, 1800, 10, 21600);
  merged.asr.windowSeconds = number(merged.asr.windowSeconds, 24, 5, 30);
  merged.asr.minSpeechSeconds = number(merged.asr.minSpeechSeconds, 0.2, 0.02, 5);
  merged.asr.minGapSeconds = number(merged.asr.minGapSeconds, 0.35, 0.05, 5);
  merged.asr.thresholdRatio = number(merged.asr.thresholdRatio, 0.25, 0.02, 0.95);
  merged.asr.prepareTimeoutMs = number(merged.asr.prepareTimeoutMs, 600_000, 10_000, 7_200_000);
  const mode = String(merged.asr.mode || 'auto');
  merged.asr.mode = ['auto', 'host', 'endpoint', 'command', 'off'].includes(mode) ? mode : 'auto';
  const language = String(merged.asr.language || 'auto');
  merged.asr.language = ['auto', 'zh', 'en', 'yue', 'ja', 'ko'].includes(language) ? language : 'auto';
  return merged;
}

/* ------------------------------------------------- locator for the DSH install */

function dshInstallCandidates() {
  const candidates = [];
  if (process.env.DSH_INSTALL_DIR) candidates.push(process.env.DSH_INSTALL_DIR);
  const resources = process.resourcesPath;
  if (resources) {
    candidates.push(join(resources, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh'));
    candidates.push(join(resources, 'app', 'dsh', 'node_modules', '@deepseek-ai', 'dsh'));
  }
  try {
    candidates.push(join(dirname(process.execPath), '..', 'Resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh'));
  } catch { /* execPath always exists, but be safe */ }
  candidates.push('/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh');
  return candidates;
}

function findScopeDir() {
  for (const candidate of dshInstallCandidates()) {
    try {
      if (existsSync(join(candidate, 'package.json'))) return dirname(candidate);
    } catch { /* asar path may not exist */ }
  }
  return null;
}

function speechDataRoot(config) {
  if (config.localAsrDataRoot) return config.localAsrDataRoot;
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(home, 'ears', 'speech');
}

/* ------------------------------------------------------------- local ASR setup */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function apply(ctx, rawConfig) {
  const disposers = [];
  let live = normalize(rawConfig);
  const getConfig = () => live;
  const log = (message, error = null) => {
    const text = error ? `${message} ${String(error?.message || error)}` : message;
    try {
      const logger = ctx?.logger;
      if (typeof logger?.warn === 'function') logger.warn(`[dsh-better-ears] ${text}`);
      else if (typeof logger?.info === 'function') logger.info(`[dsh-better-ears] ${text}`);
    } catch { /* logging must never break loading */ }
  };

  const localState = { state: 'idle', registered: false, providerId: null, reason: null, error: null };
  let localPromise = null;

  const ensureLocalAsr = () => {
    if (localPromise) return localPromise;
    localPromise = (async () => {
      if (live.enableLocalAsr === false) {
        Object.assign(localState, { state: 'disabled', reason: 'disabled-in-settings' });
        return { ...localState };
      }
      const existing = speechService(ctx);
      if (existing) {
        Object.assign(localState, { state: 'ready', registered: false, reason: 'host-service-present' });
        return { ...localState };
      }
      const scope = findScopeDir();
      if (!scope) {
        Object.assign(localState, { state: 'failed', reason: 'install-not-found', error: '未找到 DSH 安装目录' });
        return { ...localState };
      }
      const serviceFile = join(scope, 'dsh-experimental-speech-to-text', 'lib', 'index.js');
      const providerFile = join(scope, 'dsh-experimental-speech-to-text-sensevoice', 'lib', 'index.js');
      if (!existsSync(serviceFile) || !existsSync(providerFile)) {
        Object.assign(localState, {
          state: 'unavailable',
          reason: 'speech-packages-missing',
          error: `未找到 DSH 内置语音包（${scope}）`,
        });
        return { ...localState };
      }
      const sherpa = join(dirname(scope), 'sherpa-onnx-node', 'package.json');
      if (!existsSync(sherpa)) {
        Object.assign(localState, {
          state: 'unavailable',
          reason: 'sherpa-missing',
          error: 'DSH 内置语音包缺少 sherpa-onnx-node 运行时',
        });
        return { ...localState };
      }
      try {
        const [serviceModule, providerModule] = await Promise.all([
          import(pathToFileURL(serviceFile).href),
          import(pathToFileURL(providerFile).href),
        ]);
        const ServiceClass = serviceModule.default;
        if (typeof ServiceClass !== 'function') throw new Error('语音服务模块没有默认导出的服务类');
        const providerId = live.localAsrProviderId || 'ears-sensevoice';
        const dataRoot = speechDataRoot(live);
        mkdirSync(dataRoot, { recursive: true });
        ctx.plugin(ServiceClass, { defaultProvider: providerId, language: live.asr.language || 'auto' });
        await sleep(0);
        ctx.plugin(providerModule, {
          providerId,
          dataRoot,
          modelOrigins: ['https://hf-mirror.com', 'https://huggingface.co'],
          precision: live.localAsrPrecision,
          threads: live.localAsrThreads,
        });
        Object.assign(localState, { state: 'registered', registered: true, providerId, reason: null, error: null });
        log(`local speech recognizer registered (provider ${providerId}, data ${dataRoot})`);
      } catch (error) {
        Object.assign(localState, { state: 'failed', reason: 'register-failed', error: String(error?.message || error) });
        log('local speech recognizer registration failed:', error);
      }
      return { ...localState };
    })();
    return localPromise;
  };

  /* ------------------------------------------------------------- settings side */

  const status = async () => {
    const config = getConfig();
    const paths = resolveFfmpeg(config);
    let ffmpeg = { ...paths, version: null, ok: false, error: null };
    try {
      const { stdout } = await run(paths.ffmpeg, ['-hide_banner', '-version'], { timeoutMs: 8_000 });
      ffmpeg = {
        ...paths,
        ok: true,
        version: String(stdout).split('\n')[0]?.replace(/^ffmpeg version\s*/i, '').split(' ')[0] || null,
      };
    } catch (error) {
      ffmpeg.error = String(error?.message || error);
    }
    return {
      platform: process.platform,
      runtime: process.versions.electron ? `electron ${process.versions.electron}` : process.version,
      ffmpeg,
      speech: describeSpeech(ctx),
      transport: plannedTransport(ctx, config),
      local: { ...localState },
      analysis: {
        sampleRate: analyze.ANALYSIS_SR,
        maxAnalyzeSeconds: config.maxAnalyzeSeconds,
        cacheEntries: config.cacheEntries,
        cutThreshold: config.cutThreshold,
      },
    };
  };

  const prepareLocal = async (body = {}) => {
    const config = getConfig();
    const state = await ensureLocalAsr();
    const service = speechService(ctx);
    if (!service) {
      return { ok: false, message: '没有可用的 speechToText 服务', local: state };
    }
    const providerId = body.providerId || config.asr.providerId || undefined;
    try {
      const ready = await ensureProvider(service, {
        providerId,
        timeoutMs: Math.min(Number(body.timeoutMs) || config.asr.prepareTimeoutMs, 7_200_000),
      });
      return { ok: true, providerId: ready, local: state };
    } catch (error) {
      return {
        ok: false,
        message: String(error?.message || error),
        hint: error?.hint || null,
        local: state,
      };
    }
  };

  const saveConfig = async (patch) => {
    const next = normalize(mergeDeep(live, isPlainObject(patch) ? patch : {}));
    live = next;
    try {
      const editor = ctx.get('configEditor');
      const entry = ctx.fiber?.entry;
      if (editor && entry && typeof editor.edit === 'function') {
        await editor.edit(entry, () => next);
      }
    } catch (error) {
      log('could not persist settings:', error);
    }
    return next;
  };

  /* ------------------------------------------------------------------ wiring */

  try {
    const tools = createTools({ ctx, getConfig, localAsr: ensureLocalAsr });
    for (const tool of tools) {
      disposers.push(ctx.tools.register(tool));
    }
    log(`registered ${tools.length} tools`);
  } catch (error) {
    log('tool registration failed:', error);
  }

  try {
    const server = createSettingsServer({ ctx, getConfig, saveConfig, status, prepareLocal, log });
    if (server) {
      disposers.push(server.dispose);
      const shown = new URL(server.url);
      shown.searchParams.delete('token');
      log(`settings page at ${shown}`);
    }
  } catch (error) {
    log('settings page unavailable:', error);
  }

  if (live.enableLocalAsr !== false) {
    // Fire and forget: tools await the same promise when they actually need speech.
    ensureLocalAsr().catch(() => {});
  }

  return () => {
    for (const dispose of disposers.reverse()) {
      try { dispose(); } catch { /* best effort */ }
    }
    analyze.clearCache?.();
  };
}
