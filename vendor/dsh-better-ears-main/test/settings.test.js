import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';

import { createSettingsServer } from '../lib/settings.js';

test('settings page and API enforce the token', async () => {
  let handler = null;
  const server = createServer((req, res) => handler(req, res));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;

  const ctx = {
    get(name) {
      if (name !== 'webServer') return null;
      return {
        register(spec) {
          handler = spec.handler;
          return () => { handler = null; };
        },
        getOrigin: () => origin,
        port,
      };
    },
    on() {
      return () => {};
    },
  };

  const settings = createSettingsServer({
    ctx,
    getConfig: () => ({ asr: { mode: 'auto', endpoint: { apiKey: 'secret' } } }),
    saveConfig: async (patch) => ({ ...patch }),
    status: async () => ({ ok: true }),
    prepareLocal: async () => ({ prepared: true }),
  });
  assert.ok(settings?.url);

  try {
    const url = new URL(settings.url);
    assert.equal(url.pathname, '/dsh-better-ears');
    const token = url.searchParams.get('token');
    assert.ok(token && token.length === 64);

    const noToken = await fetch(origin + '/dsh-better-ears');
    assert.equal(noToken.status, 403);

    const page = await fetch(settings.url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /dsh-better-ears/);

    const state = await fetch(origin + '/dsh-better-ears/api/state', {
      headers: { 'x-settings-token': token },
    });
    assert.equal(state.status, 200);
    const body = await state.json();
    assert.equal(body.config.asr.endpoint.apiKey, undefined);
    assert.equal(body.config.asr.endpoint.apiKeySet, true);

    const post = await fetch(origin + '/dsh-better-ears/api/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-settings-token': token },
      body: JSON.stringify({ maxAnalyzeSeconds: 30 }),
    });
    assert.equal(post.status, 200);
  } finally {
    settings.dispose();
    server.close();
  }
});
