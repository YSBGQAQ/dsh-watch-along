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
      wrap: { padding: '16px 18px', fontFamily: 'inherit', lineHeight: 1.7 },
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
          h('div', { style: styles.card },
            FIELDS.map((f) => h(Row, { key: f.k, label: f.label },
              h('span', null, f.hint))))),
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

    function apply(ctx) {
      if (!ctx?.slots?.inject) {
        // 没有 slots 服务：面板不出现，但插件其余部分照常（工具在 index.js 里注册）
        return
      }
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'watch-along',
            order: 210,
            label: () => '陪看',
            inject: () => ({ ctx }),
          },
          Panel,
        ))
    }

    // 导出空 inject：宿主的判定是 `fiber.inject` 里每个服务都要 ctx.get() 拿得到，
    // 拿不到就 pending（dsh-app-boot/src/index.ts:1093）。实测声明 5 个 → 5 个全 pending，
    // 而跑得通的 dsh-jiuling 包声明就是 `inject: []`。服务大概率本来就在作用域里，
    // 是我们把它标成硬依赖才卡住的。apply 里改成可选访问，拿不到就只少一个面板。
    return { apply, inject: [] }
  },
})
