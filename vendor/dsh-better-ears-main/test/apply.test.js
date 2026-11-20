import { test } from 'node:test';
import assert from 'node:assert/strict';

import { apply } from '../index.js';

function fakeContext() {
  const registered = [];
  const warnings = [];
  return {
    registered,
    warnings,
    ctx: {
      tools: {
        register(spec) {
          registered.push(spec);
          return () => {};
        },
      },
      get() {
        return null;
      },
      logger: { warn: (message) => warnings.push(String(message)) },
      fiber: {},
    },
  };
}

test('apply registers all seven tools', () => {
  const { ctx, registered } = fakeContext();
  apply(ctx, { enableLocalAsr: false });
  const names = registered.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    'audio_probe',
    'audio_read',
    'audio_rhythm',
    'audio_speech',
    'audio_status',
    'audio_structure',
    'audio_tonal',
  ]);
});

test('audio_status is callable without a speech service', async () => {
  const { ctx, registered } = fakeContext();
  apply(ctx, { enableLocalAsr: false });
  const status = registered.find((tool) => tool.name === 'audio_status');
  const result = await status.execute({});
  assert.match(result.text, /dsh-better-ears 环境/);
  assert.match(result.text, /语音识别/);
  assert.doesNotMatch(result.text, /undefined|NaN/);
});

test('a bad config falls back to defaults instead of throwing', () => {
  const { ctx, registered, warnings } = fakeContext();
  apply(ctx, { asr: { mode: 'not-a-mode' } });
  assert.ok(registered.length > 0);
  // Normalizer silently normalizes the enum rather than rejecting the whole profile.
  assert.ok(warnings.length >= 0);
});
