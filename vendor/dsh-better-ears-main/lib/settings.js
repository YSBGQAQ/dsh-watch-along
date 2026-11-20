/**
 * The plugin's own settings API.
 *
 * Security boundary, copied from the pattern the installed storyboard plugin uses:
 * only registered when a local webServer exists; the page URL carries a 32-byte random
 * token; the API also checks the token header; bodies are JSON and capped; the API key
 * is never returned. No "install this for me" endpoints — the browser cannot run code.
 */

import { randomBytes } from 'node:crypto';

const PAGE_PATH = '/dsh-better-ears';
const API_PREFIX = PAGE_PATH + '/api';
const MAX_BODY = 64 * 1024;
const INDEX_GLOBAL = '__DSH_BETTER_EARS_SETTINGS__';

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sameToken(actual, expected) {
  if (typeof actual !== 'string' || actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体太大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

function publicConfig(config) {
  const copy = JSON.parse(JSON.stringify(config ?? {}));
  if (copy.asr?.endpoint) {
    copy.asr.endpoint.apiKeySet = Boolean(copy.asr.endpoint.apiKey);
    delete copy.asr.endpoint.apiKey;
  }
  return copy;
}

function page() {
  return `<!doctype html><meta charset="utf-8"><title>dsh-better-ears 设置</title>
<style>body{font:14px/1.6 -apple-system,system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 20px;color:#1f2329}
code{background:#f2f3f5;padding:2px 6px;border-radius:4px}pre{background:#f2f3f5;padding:12px;border-radius:8px;overflow:auto;font-size:12px}</style>
<h1>dsh-better-ears</h1>
<p>设置请到 DeepSeek Harness 的 <b>设置 → 插件 → dsh-better-ears</b> 页面修改（那里有完整表单）。
这个地址只是同一个 API 的只读状态页。</p>
<pre id="s">加载中…</pre>
<script>
fetch(location.pathname + '/api/state', { headers: { 'x-settings-token': new URL(location.href).searchParams.get('token') || '' } })
  .then(r => r.json()).then(d => { document.getElementById('s').textContent = JSON.stringify(d, null, 2); })
  .catch(e => { document.getElementById('s').textContent = String(e); });
</script>`;
}

/**
 * @param {object} options
 * @param {object} options.ctx
 * @param {() => object} options.getConfig
 * @param {(patch: object) => Promise<object>} options.saveConfig
 * @param {() => Promise<object>} options.status   environment/status payload
 * @param {(options: object) => Promise<object>} options.prepareLocal
 * @param {(message: string) => void} [options.log]
 * @returns {null | { url: string, dispose: () => void }}
 */
export function createSettingsServer({ ctx, getConfig, saveConfig, status, prepareLocal, log = () => {} }) {
  const webServer = ctx?.get?.('webServer');
  if (!webServer || typeof webServer.register !== 'function') return null;
  const token = randomBytes(32).toString('hex');

  const handle = async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (url.pathname === PAGE_PATH) {
        if (!sameToken(url.searchParams.get('token'), token)) return json(res, 403, { error: 'token 无效' });
        const html = page();
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
        });
        res.end(html);
        return;
      }
      if (!url.pathname.startsWith(API_PREFIX + '/')) return json(res, 404, { error: 'not found' });
      if (!sameToken(req.headers['x-settings-token'], token)) return json(res, 401, { error: 'token 无效' });

      const action = url.pathname.slice(API_PREFIX.length);
      if (req.method === 'GET' && action === '/state') {
        return json(res, 200, { config: publicConfig(getConfig()), env: await status() });
      }
      if (req.method === 'POST' && action === '/config') {
        const body = await readBody(req);
        if (!body || typeof body !== 'object') throw new Error('请求体必须是对象');
        const saved = await saveConfig(body);
        return json(res, 200, { config: publicConfig(saved), env: await status() });
      }
      if (req.method === 'POST' && action === '/prepare') {
        const body = await readBody(req);
        const result = await prepareLocal(body || {});
        return json(res, 200, { result, env: await status() });
      }
      return json(res, 404, { error: 'not found' });
    } catch (error) {
      const message = String(error?.message ?? error).slice(0, 300);
      if (!res.headersSent) json(res, 400, { error: message });
      else res.end();
    }
  };

  let routeDispose = null;
  try {
    routeDispose = webServer.register({ kind: 'prefix', path: PAGE_PATH, handler: handle });
  } catch (error) {
    log(`[dsh-better-ears] settings page unavailable: ${String(error?.message ?? error)}`);
    return null;
  }

  const origin = webServer.getOrigin?.() || 'http://127.0.0.1:' + webServer.port;
  const url = origin + PAGE_PATH + '?token=' + token;

  let offIndex = null;
  if (typeof ctx.on === 'function') {
    try {
      offIndex = ctx.on('webserver/index-inject', (table) => {
        table.push({ kind: 'global', name: INDEX_GLOBAL, value: { url } });
      });
    } catch { /* older host without the injection table: the React tab falls back to no API */ }
  }

  return {
    url,
    dispose() {
      try { offIndex?.(); } catch { /* ignore */ }
      try { routeDispose?.(); } catch { /* ignore */ }
    },
  };
}

export { PAGE_PATH, INDEX_GLOBAL };
