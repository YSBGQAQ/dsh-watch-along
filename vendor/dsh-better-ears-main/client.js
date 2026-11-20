window.__ModuleLoader__.load({
  id: "dsh-better-ears",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require("react");
    const h = React.createElement;
    const { useCallback, useEffect, useState } = React;

    const CSS = [
      '[data-dsh-better-ears]{color:var(--dsw-alias-label-primary,#1f2329);font-size:13px;line-height:20px}',
      '[data-dsh-better-ears] *{box-sizing:border-box}',
      '[data-dsh-better-ears] .de-section{padding:20px 0;border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1))}',
      '[data-dsh-better-ears] .de-section:first-of-type{padding-top:2px;border-top:0}',
      '[data-dsh-better-ears] .de-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 12px}',
      '[data-dsh-better-ears] .de-title{margin:0;font-size:14px;line-height:22px;font-weight:600}',
      '[data-dsh-better-ears] .de-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px 18px}',
      '[data-dsh-better-ears] .de-field{display:flex;flex-direction:column;gap:6px;min-width:0}',
      '[data-dsh-better-ears] .de-span{grid-column:1/-1}',
      '[data-dsh-better-ears] .de-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#646a73)}',
      '[data-dsh-better-ears] .de-input,[data-dsh-better-ears] .de-select{width:100%;height:32px;padding:0 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.15));background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font:inherit;outline:none}',
      '[data-dsh-better-ears] .de-input:focus,[data-dsh-better-ears] .de-select:focus{border-color:var(--dsw-alias-brand-primary,#4d6bfe)}',
      '[data-dsh-better-ears] .de-input[type=number]{max-width:160px}',
      '[data-dsh-better-ears] .de-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8f959e)}',
      '[data-dsh-better-ears] .de-btn{height:30px;padding:0 12px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.15));background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font:inherit;cursor:pointer}',
      '[data-dsh-better-ears] .de-btn:hover{background:var(--dsw-alias-bg-skeleton,rgba(0,0,0,.04))}',
      '[data-dsh-better-ears] .de-btn.primary{border-color:transparent;background:var(--dsw-alias-brand-primary,#4d6bfe);color:#fff}',
      '[data-dsh-better-ears] .de-btn:disabled{opacity:.5;cursor:default}',
      '[data-dsh-better-ears] .de-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '[data-dsh-better-ears] .de-toggle{display:inline-flex;align-items:center;gap:8px;cursor:pointer;user-select:none}',
      '[data-dsh-better-ears] .de-box{position:relative;width:34px;height:20px;border-radius:999px;background:var(--dsw-alias-border-l2,rgba(0,0,0,.2));transition:background .15s}',
      '[data-dsh-better-ears] .de-box.on{background:var(--dsw-alias-brand-primary,#4d6bfe)}',
      '[data-dsh-better-ears] .de-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:left .15s}',
      '[data-dsh-better-ears] .de-box.on .de-knob{left:16px}',
      '[data-dsh-better-ears] .de-status{min-height:20px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#646a73)}',
      '[data-dsh-better-ears] .de-status.error{color:#d92d20}',
      '[data-dsh-better-ears] .de-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;word-break:break-all}',
      '[data-dsh-better-ears] .de-pill{display:inline-flex;align-items:center;gap:6px;padding:1px 8px;border-radius:999px;background:var(--dsw-alias-bg-skeleton,rgba(0,0,0,.05));font-size:12px}',
      '[data-dsh-better-ears] .de-pill.ok{color:#067647;background:rgba(18,183,106,.12)}',
      '[data-dsh-better-ears] .de-pill.warn{color:#b54708;background:rgba(247,144,9,.14)}',
      '[data-dsh-better-ears] .de-pill.bad{color:#b42318;background:rgba(240,68,56,.12)}',
      '[data-dsh-better-ears] .de-list{display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none}',
      '[data-dsh-better-ears] .de-footer{display:flex;align-items:center;justify-content:space-between;gap:12px;padding-top:16px;border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1))}',
    ].join('');

    function useStyle() {
      useEffect(() => {
        if (typeof document === 'undefined' || document.getElementById('dsh-better-ears-style')) return;
        const style = document.createElement('style');
        style.id = 'dsh-better-ears-style';
        style.textContent = CSS;
        document.head.appendChild(style);
      }, []);
    }

    function apiConfig() {
      const injected = globalThis.__DSH_BETTER_EARS_SETTINGS__;
      if (!injected || typeof injected.url !== 'string') return null;
      const url = new URL(injected.url);
      const token = url.searchParams.get('token') || '';
      const sameOrigin = typeof location !== 'undefined' && url.origin === location.origin;
      const base = (sameOrigin ? '' : url.origin) + url.pathname.replace(/\/+$/, '') + '/api';
      return { token, base };
    }

    async function apiCall(api, action, body) {
      const res = await fetch(api.base + action, {
        method: body === undefined ? 'GET' : 'POST',
        cache: 'no-store',
        headers: body === undefined
          ? { 'x-settings-token': api.token }
          : { 'x-settings-token': api.token, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
      return data;
    }

    function setIn(source, path, value) {
      const copy = Array.isArray(source) ? source.slice() : { ...source };
      let cursor = copy;
      for (let i = 0; i < path.length - 1; i++) {
        const key = path[i];
        cursor[key] = Array.isArray(cursor[key]) ? cursor[key].slice() : { ...(cursor[key] || {}) };
        cursor = cursor[key];
      }
      cursor[path[path.length - 1]] = value;
      return copy;
    }

    function getIn(source, path) {
      let cursor = source;
      for (const key of path) {
        if (cursor === null || cursor === undefined) return undefined;
        cursor = cursor[key];
      }
      return cursor;
    }

    function Field(props) {
      return h('div', { className: 'de-field' + (props.span ? ' de-span' : '') },
        h('label', { className: 'de-label' }, props.label),
        props.children,
        props.hint ? h('p', { className: 'de-hint' }, props.hint) : null);
    }

    function Toggle({ label, on, onChange, hint }) {
      return h('div', { className: 'de-field' + (hint ? ' de-span' : '') },
        h('label', { className: 'de-toggle', onClick: () => onChange(!on) },
          h('span', { className: 'de-box' + (on ? ' on' : '') }, h('span', { className: 'de-knob' })),
          h('span', null, label)),
        hint ? h('p', { className: 'de-hint' }, hint) : null);
    }

    function phasePill(phase) {
      const cls = phase === 'ready' || phase === 'standby' ? 'ok'
        : phase === 'failed' ? 'bad'
          : phase === 'unprepared' ? '' : 'warn';
      return h('span', { className: 'de-pill ' + cls }, phase);
    }

    function SettingsTab() {
      useStyle();
      const api = apiConfig();
      const [state, setState] = useState(null);
      const [draft, setDraft] = useState(null);
      const [busy, setBusy] = useState('');
      const [notice, setNotice] = useState('');
      const [error, setError] = useState('');

      const load = useCallback(async () => {
        if (!api) { setError('没有拿到设置 API（插件可能未加载完成，刷新页面再试）'); return; }
        try {
          const data = await apiCall(api, '/state');
          setState(data.env);
          setDraft(data.config);
        } catch (e) {
          setError(String(e.message || e));
        }
      }, [api]);

      useEffect(() => { load(); }, [load]);

      if (!draft) {
        return h('div', { 'data-dsh-better-ears': true, className: 'de-section' },
          h('div', { className: 'de-status' + (error ? ' error' : '') }, error || '加载中…'));
      }

      const bind = (path, kind) => ({
        value: getIn(draft, path) ?? '',
        onChange: (event) => {
          const raw = event.target.value;
          const value = kind === 'number' ? (raw === '' ? '' : Number(raw)) : raw;
          setDraft((current) => setIn(current, path, value));
        },
      });
      const bindBool = (path) => ({
        on: Boolean(getIn(draft, path)),
        onChange: (value) => setDraft((current) => setIn(current, path, value)),
      });

      const save = async (extra) => {
        setBusy('save'); setNotice(''); setError('');
        try {
          const data = await apiCall(api, '/config', extra ? { ...draft, ...extra } : draft);
          setState(data.env);
          setDraft(data.config);
          setNotice('已保存');
        } catch (e) {
          setError(String(e.message || e));
        } finally { setBusy(''); }
      };

      const check = async () => {
        setBusy('check'); setNotice(''); setError('');
        try {
          const data = await apiCall(api, '/state');
          setState(data.env);
          setNotice('已刷新环境状态');
        } catch (e) { setError(String(e.message || e)); } finally { setBusy(''); }
      };

      const prepare = async () => {
        setBusy('prepare'); setNotice('本地识别器准备中（首次需下载约 240 MB 模型）…'); setError('');
        try {
          const data = await apiCall(api, '/prepare', { providerId: draft.asr?.providerId || undefined });
          setState(data.env);
          const result = data.result || {};
          setNotice(result.ok ? `就绪：${result.providerId}` : `未就绪：${result.message || '未知原因'}${result.hint ? ' — ' + result.hint : ''}`);
        } catch (e) { setError(String(e.message || e)); } finally { setBusy(''); }
      };

      const env = state || {};
      const speech = env.speech || { present: false, providers: [] };
      const transport = env.transport || { kind: 'none' };
      const local = env.local || {};
      const ffmpeg = env.ffmpeg || {};

      return h('div', { 'data-dsh-better-ears': true },
        h('div', { className: 'de-section' },
          h('div', { className: 'de-head' },
            h('h3', { className: 'de-title' }, '运行状态'),
            h('div', { className: 'de-row' },
              h('button', { className: 'de-btn', disabled: busy !== '', onClick: check }, busy === 'check' ? '检查中…' : '刷新'),
              h('button', { className: 'de-btn primary', disabled: busy !== '', onClick: prepare }, busy === 'prepare' ? '准备中…' : '准备本地识别器'))),
          h('ul', { className: 'de-list' },
            h('li', null,
              h('span', { className: 'de-label' }, 'ffmpeg：'),
              h('span', { className: 'de-mono' }, ffmpeg.ffmpeg || '未找到'),
              ffmpeg.ok ? h('span', { className: 'de-pill ok' }, 'v' + (ffmpeg.version || '?')) : h('span', { className: 'de-pill bad' }, '不可用')),
            h('li', null,
              h('span', { className: 'de-label' }, '语音通道：'),
              h('span', { className: 'de-pill' + (transport.kind === 'none' ? ' bad' : ' ok') }, transport.kind)),
            h('li', null,
              h('span', { className: 'de-label' }, '识别器：'),
              speech.present
                ? (speech.providers.length
                  ? h('span', { className: 'de-row' }, speech.providers.map((provider) =>
                    h('span', { key: provider.id, className: 'de-pill' },
                      provider.name + ' ' + (provider.phase || '?'), ' ', phasePill(provider.phase || 'unknown'))))
                  : h('span', { className: 'de-pill warn' }, '服务在，但没有注册的识别器'))
                : h('span', { className: 'de-pill bad' }, '无 speechToText 服务')),
            h('li', null,
              h('span', { className: 'de-label' }, '本地接入：'),
              h('span', { className: 'de-mono' }, local.state + (local.reason ? ' · ' + local.reason : '') + (local.error ? ' · ' + local.error : '')))),
          h('p', { className: 'de-hint' },
            '音频分析本身不依赖语音识别：节奏、调性、结构、响度全部在本地用 ffmpeg + JS 计算，不需要下载任何模型。')),

        h('div', { className: 'de-section' },
          h('div', { className: 'de-head' }, h('h3', { className: 'de-title' }, '语音识别')),
          h('div', { className: 'de-grid' },
            h(Field, { label: '通道', hint: 'auto：优先用 DSH 本地识别器，其次接口，最后命令。' },
              h('select', { className: 'de-select', ...bind(['asr', 'mode']) },
                h('option', { value: 'auto' }, 'auto'),
                h('option', { value: 'host' }, 'host（只用本地服务）'),
                h('option', { value: 'endpoint' }, 'endpoint（只用接口）'),
                h('option', { value: 'command' }, 'command（只用外部命令）'),
                h('option', { value: 'off' }, 'off（关闭转写）'))),
            h(Field, { label: '语言' },
              h('select', { className: 'de-select', ...bind(['asr', 'language']) },
                ['auto', 'zh', 'en', 'yue', 'ja', 'ko'].map((code) => h('option', { key: code, value: code }, code)))),
            h(Field, { label: '单次最长转写（秒）', hint: '超过这个长度的文件只转写前 N 秒。' },
              h('input', { className: 'de-input', type: 'number', ...bind(['asr', 'maxSeconds'], 'number') })),
            h(Field, { label: '识别器 ID（留空用默认）' },
              h('input', { className: 'de-input', ...bind(['asr', 'providerId']) })),
            h(Field, { label: '接口地址', span: true, hint: 'OpenAI 兼容的 /v1 地址，例如 https://api.example.com/v1（会请求 /audio/transcriptions）。' },
              h('input', { className: 'de-input', ...bind(['asr', 'endpoint', 'url']) })),
            h(Field, { label: '接口模型' },
              h('input', { className: 'de-input', ...bind(['asr', 'endpoint', 'model']) })),
            h(Field, { label: '接口 Key', hint: '只保存在本机插件配置里，不会回传给页面。' },
              h('input', { className: 'de-input', type: 'password', ...bind(['asr', 'endpoint', 'apiKey']) ,
                placeholder: draft.asr?.endpoint?.apiKeySet ? '已设置（留空保持不变）' : '未设置' })),
            h(Field, { label: '外部命令（可选）', span: true, hint: '模板里可用 {input} 与 {lang}；也可读环境变量 EARS_AUDIO / EARS_LANG。' },
              h('input', { className: 'de-input', ...bind(['asr', 'command']) }))),
          h('div', { className: 'de-row', style: { marginTop: 12 } },
            h(Toggle, { label: '启用内置本地识别器（DSH 自带 SenseVoice）', ...bindBool(['enableLocalAsr']) }))),

        h('div', { className: 'de-section' },
          h('div', { className: 'de-head' }, h('h3', { className: 'de-title' }, '分析参数')),
          h('div', { className: 'de-grid' },
            h(Field, { label: '最长分析时长（秒）' },
              h('input', { className: 'de-input', type: 'number', ...bind(['maxAnalyzeSeconds'], 'number') })),
            h(Field, { label: '缓存条目数', hint: '同一个文件重复分析时复用解码结果。' },
              h('input', { className: 'de-input', type: 'number', ...bind(['cacheEntries'], 'number') })),
            h(Field, { label: '镜头切换阈值', hint: '0.02–1，越大切换点越少；用于“卡点”分析。' },
              h('input', { className: 'de-input', type: 'number', step: '0.05', ...bind(['cutThreshold'], 'number') })),
            h(Field, { label: 'ffmpeg 路径（留空自动查找）' },
              h('input', { className: 'de-input', ...bind(['ffmpegPath']) })),
            h(Field, { label: 'ffprobe 路径（留空自动查找）' },
              h('input', { className: 'de-input', ...bind(['ffprobePath']) }))) ),

        h('div', { className: 'de-footer' },
          h('span', { className: 'de-status' + (error ? ' error' : '') }, error || notice),
          h('button', { className: 'de-btn primary', disabled: busy !== '', onClick: () => save() },
            busy === 'save' ? '保存中…' : '保存设置')));
    }

    function BundleConfig(props) {
      return props && props.view === 'page' ? h(SettingsTab) : null;
    }

    function apply(ctx) {
      ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
        name: 'settings.plugins.tab',
        id: 'ears',
        order: 21,
        label: () => '音频分析',
      }, SettingsTab));
      ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
        name: 'plugins.bundle.config',
        key: 'dsh-better-ears',
      }, BundleConfig));
    }

    exports.apply = apply;
    exports.inject = ['slots'];
    return module.exports;
  },
});
