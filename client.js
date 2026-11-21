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
        h(Section, { title: '现在能做什么' },
          h('div', { style: styles.card },
            h(Row, { label: '画面' }, h('span', null, 'watch_start / watch_frame / watch_events')),
            h(Row, { label: '取回那几帧' }, h('span', null, '事件里带 sheetId，用 watch_frame({sheetId}) 取')),
            h(Row, { label: '手机看' }, h('span', null, 'GET /api/events?token=…（只读）')))),
        h('div', { style: styles.note },
          '第一版只读：这里显示的是默认值与能力概览，修改设置在下一步（需要接主进程 RPC）。'))
    }

    function apply(ctx) {
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

    // 注入清单照抄本机跑得通的 dsh-purge-community（它用同一套 ui-slots）。
    return {
      apply,
      inject: [
        '@deepseek-ai/dsh-client-connection',
        '@deepseek-ai/dsh-client-runtime',
        '@deepseek-ai/dsh-client-locale',
        '@deepseek-ai/dsh-client-ui-slots',
        '@deepseek-ai/dsh-client-ui-settings',
      ],
    }
  },
})
