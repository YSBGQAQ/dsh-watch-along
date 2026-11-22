// DSH 客户端面板：陪看的设置概览（只读第一版）。
//
// 这个文件必须是"已打包"的形态 —— 宿主用自己的模块加载器读它，
// 没有 JSX 编译，所以元素一律用 React.createElement 手写。
// 契约见 docs/client-ui-contract.md。
window.__ModuleLoader__.load({
  id: 'dsh-watch-along',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    // 与 src/settings.mjs 保持一致的只读快照。
    // 为什么内联而不是 import：client 跑在浏览器侧，拿不到主进程的模块。
    const PRESETS = [
      { id: 'game', name: '游戏', detail: '12fps · 高画质 · 4 条/分钟' },
      { id: 'lecture', name: '讲课', detail: '8fps · 中画质 · 6 条/分钟' },
      { id: 'cinema', name: '影视', detail: '8fps · 高画质 · 3 条/分钟' },
    ]
    const FIELDS = [
      { k: 'window', label: '窗口标题片段', hint: '留空 = 还没选窗口' },
      { k: 'preset', label: '场景预设', hint: '选预设会一并写入帧率与画质' },
      { k: 'quality', label: '画质档', hint: 'low / medium / high' },
      { k: 'subtitle', label: '画面字幕（OCR）', hint: '关掉就不读屏幕上的字' },
      { k: 'speech', label: '声音转写（Whisper）', hint: '关掉就不听人说话' },
      { k: 'speechPerMin', label: '说话频率上限', hint: '每分钟最多几条，防刷屏' },
    ]

    const styles = {
      // 面板内容比可视区高，宿主不给滚动 → 自己滚。height+overflowY 缺一不可。
      // 面板内容比可视区高，宿主不给滚动 → 自己滚。
      // height:100% 在父容器无固定高度时解析成 auto（不滚），所以再兜一个 maxHeight:100vh。
      wrap: { padding: '16px 18px', fontFamily: 'inherit', lineHeight: 1.7, height: '100%', maxHeight: '100vh', overflowY: 'auto', boxSizing: 'border-box' },
      title: { fontSize: 15, fontWeight: 600, margin: '0 0 4px' },
      intro: { fontSize: 12, opacity: 0.62, margin: '0 0 14px' },
      group: { marginBottom: 16 },
      groupTitle: { fontSize: 12, fontWeight: 600, opacity: 0.75, margin: '0 0 6px' },
      row: { display: 'flex', gap: 10, padding: '4px 0', fontSize: 13 },
      key: { width: 140, opacity: 0.55, flex: '0 0 auto' },
      val: { flex: 1 },
      card: { border: '1px solid rgba(127,127,127,.25)', borderRadius: 8, padding: '10px 12px', fontSize: 13 },
      note: { fontSize: 11.5, opacity: 0.55, marginTop: 12 },
    }

    function Row(props) {
      return h('div', { style: styles.row },
        h('div', { style: styles.key }, props.label),
        h('div', { style: styles.val }, props.children))
    }

    function Section(props) {
      return h('div', { style: styles.group },
        h('div', { style: styles.groupTitle }, props.title),
        props.children)
    }

    // 常用设置（票 07）：六个可改项 + 场景预设。
    // 后端只有 /settings 两个动作，校验全在 src/settings.mjs 的 validate 里 ——
    // 非法值是 200 + rejected，界面负责把原因显示到对应输入框下面（票面明确要求）。
    const QUALITY_OPTS = ['low', 'medium', 'high']
    const PRESET_NAMES = { game: '游戏', lecture: '讲课', cinema: '影视' }

    const fieldStyle = { padding: '4px 6px', fontSize: 13, border: '1px solid rgba(127,127,127,.35)', borderRadius: 5, background: 'transparent', color: 'inherit', width: 200 }
    const errStyle = { color: '#c0392b', fontSize: 11.5, marginTop: 2 }

    function Settings() {
      const [val, setVal] = React.useState(null)
      const [rejected, setRejected] = React.useState({})
      const [dirty, setDirty] = React.useState({})
      const [msg, setMsg] = React.useState('')
      const [busy, setBusy] = React.useState(false)

      const load = () => {
        fetch(PANEL_API + '/settings')
          .then((r) => r.json())
          .then((d) => { if (d && d.ok) setVal(d.value) })
          .catch(() => setMsg('读设置失败：连不上面板接口'))
      }
      React.useEffect(() => { load() }, [])

      const edit = (k, v) => {
        setVal(Object.assign({}, val, { [k]: v }))
        setDirty(Object.assign({}, dirty, { [k]: v }))
        setMsg('')
      }

      const save = () => {
        const patch = Object.assign({}, dirty)
        if (!Object.keys(patch).length) { setMsg('没有改动'); return }
        setBusy(true)
        fetch(PANEL_API + '/settings', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        })
          .then((r) => r.json())
          .then((d) => {
            if (d.ok) {
              setRejected({})
              setDirty({})
              setVal(d.value)
              setMsg('已保存。采集参数与通道开关都要重启 DSH 才生效。')
            } else {
              const m = {}
              ;(d.rejected || []).forEach((x) => { m[x.field] = x.reason })
              setRejected(m)
              setMsg('有 ' + (d.rejected || []).length + ' 项没通过校验，已逐条标在下面。')
            }
          })
          .catch((e) => setMsg('保存失败：' + String(e && e.message ? e.message : e)))
          .finally(() => setBusy(false))
      }

      if (!val) return h('div', { style: styles.card }, '读取设置…')

      const row = (k, label, node, hint) =>
        h('div', { key: k, style: { display: 'flex', gap: 10, padding: '5px 0', alignItems: 'flex-start' } },
          h('div', { style: { width: 140, flex: '0 0 auto', opacity: 0.6, fontSize: 13 } }, label),
          h('div', { style: { flex: 1 } },
            node,
            hint ? h('div', { style: { fontSize: 11.5, opacity: 0.5, marginTop: 2 } }, hint) : null,
            rejected[k] ? h('div', { style: errStyle }, rejected[k]) : null))

      return h('div', { style: styles.card },
        row('window', '窗口标题片段',
          h('input', { style: fieldStyle, value: val.window || '', placeholder: '留空 = 还没选窗口', onChange: (e) => edit('window', e.target.value) })),
        row('preset', '场景预设',
          h('select', { style: fieldStyle, value: val.preset, onChange: (e) => edit('preset', e.target.value) },
            Object.keys(PRESET_NAMES).map((k) => h('option', { key: k, value: k }, PRESET_NAMES[k]))),
          '选预设会一并写入帧率与画质'),
        row('quality', '画质档',
          h('select', { style: fieldStyle, value: val.quality, onChange: (e) => edit('quality', e.target.value) },
            QUALITY_OPTS.map((q) => h('option', { key: q, value: q }, q))),
          '改小更省 CPU，但字幕像素也变少、OCR 准头会降'),
        row('subtitle', '画面字幕（OCR）',
          h('input', { type: 'checkbox', checked: !!val.subtitle, onChange: (e) => edit('subtitle', e.target.checked) }),
          '关掉就不读屏幕上的字'),
        row('speech', '声音转写（Whisper）',
          h('input', { type: 'checkbox', checked: !!val.speech, onChange: (e) => edit('speech', e.target.checked) }),
          '关掉就不听人说话'),
        row('wakeGapSec', '主动说话间隔',
          h('input', { type: 'number', min: 0, max: 300, step: 5, style: Object.assign({}, fieldStyle, { width: 90 }), value: val.wakeGapSec, onChange: (e) => edit('wakeGapSec', Number(e.target.value)) }),
          '秒；0–300。**填 0 = 不说话**，只采集不主动开口；间隔越短越费 token'),
        row('maxWakes', '一次最多说几句',
          h('input', { type: 'number', min: 1, max: 200, style: Object.assign({}, fieldStyle, { width: 90 }), value: val.maxWakes, onChange: (e) => edit('maxWakes', Number(e.target.value)) }),
          '1–200；**连续**这么多次没人接就收工，有人接就清零'),
        row('idleStopMin', '多久没人理就收工',
          h('input', { type: 'number', min: 0, max: 1440, style: Object.assign({}, fieldStyle, { width: 90 }), value: val.idleStopMin, onChange: (e) => edit('idleStopMin', Number(e.target.value)) }),
          '分钟；0 = 不因空闲收工'),
        row('speechPerMin', '说话频率上限',
          h('input', { type: 'number', min: 1, max: 30, style: Object.assign({}, fieldStyle, { width: 90 }), value: val.speechPerMin, onChange: (e) => edit('speechPerMin', Number(e.target.value)) }),
          '每分钟最多几条进事件队列（转写照常跑，只是超出的不发）'),
        h('div', { style: { marginTop: 10 } },
          h('button', {
            type: 'button',
            onClick: save,
            disabled: busy,
            style: { padding: '5px 12px', borderRadius: 6, cursor: busy ? 'default' : 'pointer', fontSize: 13, border: '1px solid rgba(127,127,127,.35)', background: 'transparent', color: 'inherit', opacity: busy ? 0.5 : 1 },
          }, busy ? '保存中…' : '保存')),
        msg ? h('div', { style: { marginTop: 6, fontSize: 12, opacity: 0.75 } }, msg) : null)
    }

    // 两个 python 服务的状态与启动。
    //
    // 为什么走本机回环而不是宿主 RPC：这个面板跑在渲染进程里，拿不到主进程模块；
    // 主进程那边起了一个只绑 127.0.0.1:8790 的小接口（src/service-supervisor.mjs）。
    // 服务没起时插件**不会报错**，只是少两类事件 —— 所以这里必须显式提示"服务未启用"。
    const PANEL_API = 'http://127.0.0.1:8790'

    function Services() {
      const [st, setSt] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [msg, setMsg] = React.useState('')

      const load = () => {
        fetch(PANEL_API + '/status')
          .then((r) => r.json())
          .then(setSt)
          .catch(() => setSt({ error: '连不上面板接口（8790）。插件可能没启动。' }))
      }
      React.useEffect(() => {
        load()
        const t = setInterval(load, 5000)
        return () => clearInterval(t)
      }, [])

      const startServices = () => {
        setBusy(true)
        setMsg('正在启动，模型加载约 10–30 秒…')
        fetch(PANEL_API + '/start', { method: 'POST' })
          .then((r) => r.json())
          .then((r) => {
            setMsg(r.ok ? (r.note || '已启动') : ('启动失败：' + (r.error || '未知原因')))
            setTimeout(load, 1500)
          })
          .catch((e) => setMsg('启动失败：' + String(e && e.message ? e.message : e)))
          .finally(() => setBusy(false))
      }

      if (!st) return h('div', { style: styles.card }, '读取服务状态…')
      if (st.error) return h('div', { style: styles.card }, st.error)

      const down = (st.services || []).filter((x) => !x.up)
      return h('div', { style: styles.card },
        (st.services || []).map((x) =>
          h('div', { key: x.id, style: { display: 'flex', gap: 8, padding: '2px 0' } },
            h('span', { style: { width: 18 } }, x.up ? '🟢' : '🔴'),
            h('span', { style: { flex: '0 0 auto', width: 150 } }, x.name),
            h('span', { style: { opacity: 0.6, flex: 1 } },
              x.up ? ('端口 ' + x.port + (x.detail ? ' · ' + x.detail : '')) : ('未启动 · 端口 ' + x.port + (x.error ? ' · ' + x.error : ''))))),
        down.length
          ? h('div', { style: { marginTop: 8, color: '#c0392b', fontWeight: 600 } }, '服务未启用：' + down.map((x) => x.name).join('、'))
          : h('div', { style: { marginTop: 8, opacity: 0.6 } }, '两个服务都在运行。'),
        st.configured === false
          ? h('div', { style: { marginTop: 6, fontSize: 12, opacity: 0.8 } },
              '缺配置：' + (st.missing || []).join('；') + '（设好环境变量后重启 DSH）')
          : null,
        h('div', { style: { marginTop: 10 } },
          h('button', {
            type: 'button',
            disabled: busy || st.configured === false || down.length === 0,
            onClick: startServices,
            style: {
              padding: '5px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 13,
              border: '1px solid rgba(127,127,127,.35)', background: 'transparent', color: 'inherit',
              opacity: busy || st.configured === false || down.length === 0 ? 0.45 : 1,
            },
          }, busy ? '启动中…' : (down.length ? '启动服务' : '都已在运行'))),
        msg ? h('div', { style: { marginTop: 6, fontSize: 12, opacity: 0.75 } }, msg) : null)
    }

    function Panel() {
      return h('div', { style: styles.wrap },
        h('div', { style: styles.title }, '陪看'),
        h('div', { style: styles.intro }, '让 AI 看你的屏幕：画面变化、屏幕文字、系统声音，三条通道汇成一条事件流。'),
        h(Section, { title: '场景预设' },
          h('div', { style: styles.card },
            PRESETS.map((p) => h('div', { key: p.id, style: { padding: '2px 0' } },
              h('strong', null, p.name), ' — ', h('span', { style: { opacity: 0.65 } }, p.detail))))),
        h(Section, { title: '常用设置' },
          h(Settings, null)),
        h(Section, { title: '服务' },
          h(Services, null)),
        h(Section, { title: '现在能做什么' },
          h('div', { style: styles.card },
            h(Row, { label: '画面' }, h('span', null, 'watch_start / watch_frame / watch_events')),
            h(Row, { label: '取回那几帧' }, h('span', null, '事件里带 sheetId，用 watch_frame({sheetId}) 取')),
            h(Row, { label: '手机看' }, h('span', null, 'GET /api/events?token=…（只读）')))),
        h('div', { style: styles.note },
          '第一版只读：这里显示的是默认值与能力概览，修改设置在下一步（需要接主进程 RPC）。'))
    }

    /** 左栏图标：宿主把这里当图标组件渲染，给个简单的眼睛即可。 */
    function Icon() {
      return h('span', { style: { fontSize: 15, lineHeight: 1 } }, '\u{1F441}')
    }

    function apply(ctx) {
      // 插槽名必须对：2026-11-22 实测 —— 左栏那排（插件 / 自动化任务 / Purge）是
      // `sidebar.panellist`（条目）+ `main`（内容区），**不是** `settings.section`。
      // 之前注册到 settings.section，所以左栏永远看不到「陪看」。
      // 参照：dsh-purge-community/client.js 就是这么注册的。
      try {
        console.info('[watch-along] client apply；slots=', !!(ctx && ctx.slots && ctx.slots.inject))
      } catch {
        /* 控制台不可用就算了 */
      }
      if (!ctx?.slots?.inject) {
        try {
          console.warn('[watch-along] 拿不到 ctx.slots.inject，侧栏入口不会出现')
        } catch {
          /* 忽略 */
        }
        return
      }
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: 'watch-along',
            order: 30,
            label: '陪看', // 跟 purge 一样用字符串；宿主直接拿它当文字渲染
            inject: () => ({}),
          },
          Icon,
        ))
      ctx.slots.inject('main', () =>
        ctx.slots.register(
          {
            name: 'main',
            key: 'watch-along',
            inject: () => ({}),
          },
          Panel,
        ))
    }

    // **必须声明 slots**。cordis 不允许在未 inject 的情况下读 `ctx.slots`：
    // 声明成 `inject: []` 会直接抛
    //   `cannot get property "slots" without inject`
    // 整个 entry 因此不激活（DevTools 里的 "1 entry did not activate"）。
    // 参照 dsh-purge-community/client.js：`var inject = ["slots", "locale"]`（它还用 locale）。
    return { apply, inject: ['slots'] }
  },
})
