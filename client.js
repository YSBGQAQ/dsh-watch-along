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

    // 常用设置（票 07）：逐项可改。**没有场景预设**（2026-11-21 用户决定删掉，
    // settings.mjs 里也不再有 PRESETS）——别再往这里加"一键预设"。
    // 后端只有 /settings 两个动作，校验全在 src/settings.mjs 的 validate 里 ——
    // 非法值是 200 + rejected，界面负责把原因显示到对应输入框下面（票面明确要求）。
    const QUALITY_OPTS = ['low', 'medium', 'high']
    // 传图三档：值 → 界面文案
    const IMAGE_OPTS = [
      ['none', '不传（纯文字）'],
      ['low', '低清 640 宽（默认）'],
      ['high', '高清 798 原尺寸'],
    ]

    const fieldStyle = { padding: '4px 6px', fontSize: 13, border: '1px solid rgba(127,127,127,.35)', borderRadius: 5, background: 'transparent', color: 'inherit', width: 200 }
    const errStyle = { color: '#c0392b', fontSize: 11.5, marginTop: 2 }

    function Settings() {
      const [val, setVal] = React.useState(null)
      // 服务端的默认值：输入框里的值缺失时拿它兜底，保证"默认提示词看得见"，
      // 而不是一个空框（旧进程不带新键时尤其明显）。
      const [def, setDef] = React.useState({})
      const [rejected, setRejected] = React.useState({})
      const [dirty, setDirty] = React.useState({})
      const [msg, setMsg] = React.useState('')
      const [busy, setBusy] = React.useState(false)

      const load = () => {
        fetch(PANEL_API + '/settings')
          .then((r) => r.json())
          .then((d) => {
            if (d && d.ok) {
              setVal(d.value)
              setDef(d.defaults || {})
            }
          })
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
        row('fps', '采集帧率',
          h('input', { type: 'number', min: 0, max: 30, style: Object.assign({}, fieldStyle, { width: 90 }), value: val.fps, onChange: (e) => edit('fps', Number(e.target.value)) }),
          '0–30 帧/秒。填 0 = 关闭画面通道（只剩声音）；越高越跟得上动作，也越费 CPU'),
        row('quality', '画质档',
          h('select', { style: fieldStyle, value: val.quality, onChange: (e) => edit('quality', e.target.value) },
            QUALITY_OPTS.map((q) => h('option', { key: q, value: q }, q))),
          '改小更省 CPU，但字幕像素也变少、OCR 准头会降'),
        row('imageQuality', '传图档位',
          h('select', { style: fieldStyle, value: val.imageQuality || 'low', onChange: (e) => edit('imageQuality', e.target.value) },
            IMAGE_OPTS.map((o) => h('option', { key: o[0], value: o[0] }, o[1]))),
          '每一轮发给模型的画面：低清 640 宽最省时间（默认）；高清 798 能看清小字，每轮多花约 1 秒；不传则只读文字'),
        row('subtitle', '画面字幕（OCR）',
          h('input', { type: 'checkbox', checked: !!val.subtitle, onChange: (e) => edit('subtitle', e.target.checked) }),
          '关掉就不读屏幕上的字'),
        row('speech', '声音转写（Whisper）',
          h('input', { type: 'checkbox', checked: !!val.speech, onChange: (e) => edit('speech', e.target.checked) }),
          '关掉就不听人说话'),
        row('commentPrompt', '陪聊提示词',
          h('textarea', {
            rows: 4,
            style: Object.assign({}, fieldStyle, { width: '100%', maxWidth: 520, resize: 'vertical', lineHeight: 1.6 }),
            value: val.commentPrompt || def.commentPrompt || '',
            onChange: (e) => edit('commentPrompt', e.target.value),
          }),
          '每次主动开口时发给模型的指令。模板里可以写 {n}，会被替换成「主动说话间隔」的秒数（默认这句没写）'),
        row('observePrompt', '静默提示词',
          h('textarea', {
            rows: 4,
            style: Object.assign({}, fieldStyle, { width: '100%', maxWidth: 520, resize: 'vertical', lineHeight: 1.6 }),
            value: val.observePrompt || def.observePrompt || '',
            onChange: (e) => edit('observePrompt', e.target.value),
          }),
          '每隔「静默观察间隔」秒随图发出去的那句话：只让它看、不让它说话。默认那句要求回答包在代码块里 —— 改成"说点什么"会让它每几秒冒一个气泡'),
        row('observeSec', '静默观察间隔',
          h('input', { type: 'number', min: 0, max: 120, step: 1, style: Object.assign({}, fieldStyle, { width: 90 }), value: val.observeSec, onChange: (e) => edit('observeSec', Number(e.target.value)) }),
          '每隔几秒叫醒它一次：把刚过去这一段的字幕/声音/画面变化交给它，回一句"现在是什么情况"。它不跟你说话，只保持对剧情的理解。0 = 关掉。默认 6 秒，低于 6 会按 6 保存——模型一轮 3–4 秒，发得比它快只会排队'),
        row('wakeGapSec', '主动说话间隔',
          h('input', { type: 'number', min: 0, max: 300, step: 5, style: Object.assign({}, fieldStyle, { width: 90 }), value: val.wakeGapSec, onChange: (e) => edit('wakeGapSec', Number(e.target.value)) }),
          '秒；0–300。填 0 = 不说话，只采集不主动开口；间隔越短越费 token。第一次开口也要等满这个间隔，不会一开场就说话'),
        row('idleStopMin', '多久没人理就收工（已停用）',
          h('input', { type: 'number', min: 0, max: 1440, style: Object.assign({}, fieldStyle, { width: 90 }), value: val.idleStopMin, onChange: (e) => edit('idleStopMin', Number(e.target.value)) }),
          '分钟；暂时不用：现在填几都不会收工（2026-11-23 决定，代码里留了开关）'),
        row('speechPerMin', '每分钟语音转写条数',
          h('input', { type: 'number', min: 0, max: 30, style: Object.assign({}, fieldStyle, { width: 90 }), value: val.speechPerMin, onChange: (e) => edit('speechPerMin', Number(e.target.value)) }),
          '0–30 条。填 0 = 不限制；超出这一分钟的条数不进事件队列（转写照常跑，只是模型看不到那么多）'),
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

    // 窗口识别测试（2026-11-24 定稿）：
    //   打开面板先自动列一次当前窗口 → 点一条自动填进框 → 「测试并锁定匹配窗口」
    //   抓到一帧、只读底部那条带、认到任意文字就算通过，并把这条窗口锁下来。
    // 窗口片段**每次启动为空**（不读设置里的旧值）：上次锁的窗口多半早关了，
    // 拿旧片段去找只会让人困惑。
    function WindowTest() {
      const [win, setWin] = React.useState('')
      const [wins, setWins] = React.useState(null) // null = 还没查过
      const [listBusy, setListBusy] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [out, setOut] = React.useState(null)
      const [msg, setMsg] = React.useState('')

      const loadWindows = () => {
        setListBusy(true)
        fetch(PANEL_API + '/windows')
          .then((r) => r.json())
          .then((d) => {
            if (d && d.ok) setWins(d.windows || [])
            else setMsg('列窗口失败：' + ((d && d.error) || '未知原因'))
          })
          .catch(() => setMsg('连不上面板接口（8790）'))
          .finally(() => setListBusy(false))
      }

      // 打开面板自动列一次：第一次用的人不用猜该填什么。
      React.useEffect(() => {
        loadWindows()
      }, [])

      const run = () => {
        const fragment = win.trim()
        if (!fragment) {
          setMsg('先选一个窗口（或手填窗口标题里的一段字），再点测试')
          return
        }
        setBusy(true)
        setMsg('')
        setOut(null)
        fetch(PANEL_API + '/ocr-test', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ window: fragment }),
        })
          .then((r) => r.json())
          .then(setOut)
          .catch((e) => setMsg('测试没跑起来：' + String(e && e.message ? e.message : e)))
          .finally(() => setBusy(false))
      }

      const inputStyle = Object.assign({}, fieldStyle, { width: '100%', maxWidth: 420 })
      const smallBtn = {
        padding: '3px 10px', borderRadius: 6, fontSize: 12, cursor: 'pointer',
        border: '1px solid rgba(127,127,127,.35)', background: 'transparent', color: 'inherit',
      }

      let result = null
      if (out && out.ok === false) {
        result = h('div', { style: { marginTop: 8, color: '#c0392b', fontSize: 12.5, lineHeight: 1.7, wordBreak: 'break-all' } }, out.error)
      } else if (out) {
        result = h('div', { style: { marginTop: 8, fontSize: 12.5, lineHeight: 1.7 } },
          h('div', { style: { fontWeight: 600, color: out.matched ? '#1a7f37' : '#b58105' } },
            out.matched
              ? '认到 ' + (out.lines || []).length + ' 行文字' + (out.locked ? '，已锁定「' + out.window + '」' : '')
              : (out.lines || []).length
                ? '认到的都不像文字（多半是界面噪声）：换一个窗口，或把播放器放大些再试'
                : '一行都没认到：这个窗口底部可能没有字，或者被挡住了'),
          out.matched
            ? h('div', { style: { opacity: 0.72, marginTop: 2 } },
                '本次运行内有效：说「开始陪看」不用再报窗口名，手机点「开始」也不用带。重启 DSH 后要重新锁定')
            : null,
          h('div', { style: { opacity: 0.6, marginTop: 2 } }, out.size + ' · ' + out.ms + 'ms'),
          out.lines && out.lines.length
            ? h('div', { style: { marginTop: 6, opacity: 0.85, maxHeight: 170, overflowY: 'auto' } },
                out.lines.slice(0, 12).map((line, i) => h('div', { key: i, style: { padding: '1px 0' } }, '· ' + line)))
            : null)
      }

      return h('div', { style: styles.card },
        h('div', { style: { display: 'flex', gap: 10, alignItems: 'flex-start', padding: '2px 0 4px' } },
          h('div', { style: { width: 140, flex: '0 0 auto', opacity: 0.6, fontSize: 13 } }, '窗口标题片段'),
          h('div', { style: { flex: 1 } },
            h('input', {
              style: inputStyle,
              value: win,
              placeholder: '选下面一条，或手填窗口标题里的一段字',
              onChange: (e) => { setWin(e.target.value); setMsg('') },
            }),
            h('div', { style: { fontSize: 11.5, opacity: 0.5, marginTop: 2 } },
              '填的是窗口标题里的一段字，不是画面上的字幕。大小写敏感；同名窗口取最上面那个'))),

        // 当前窗口列表：点一条就填进上面的框。原生枚举，刷新是微秒级的。
        h('div', { style: { marginTop: 4, marginLeft: 150 } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h('button', { type: 'button', onClick: loadWindows, disabled: listBusy, style: smallBtn },
              listBusy ? '读取中…' : (wins ? '刷新窗口列表' : '看看有哪些窗口')),
            h('span', { style: { fontSize: 11.5, opacity: 0.5 } },
              wins ? '共 ' + wins.length + ' 个，点一条就填进上面的框' : '')),

          wins && wins.length
            ? h('div', { style: { marginTop: 6, maxHeight: 168, overflowY: 'auto', border: '1px solid rgba(127,127,127,.2)', borderRadius: 6 } },
                wins.map((t, i) => h('div', {
                  key: i,
                  onClick: () => { setWin(t); setMsg('') },
                  title: t,
                  style: {
                    padding: '4px 8px', fontSize: 12, cursor: 'pointer', lineHeight: 1.5,
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    background: t === win ? 'rgba(127,127,127,.12)' : 'transparent',
                  },
                }, t)))
            : wins
              ? h('div', { style: { marginTop: 6, fontSize: 12, opacity: 0.6 } }, '没读到可见窗口（窗口都最小化了？）')
              : null),

        h('div', {
          style: {
            marginTop: 10, padding: '8px 10px', border: '1px solid rgba(127,127,127,.25)',
            borderRadius: 6, fontSize: 12, lineHeight: 1.75, opacity: 0.9,
          },
        },
          h('div', { style: { fontWeight: 600, marginBottom: 2 } }, '测试前把这个窗口放到最前面'),
          h('span', { style: { color: '#b58105' } },
            '别让别的窗口挡住、别把播放器缩得太小 —— 被挡住时它读到的是遮挡物上的字，缩太小则字糊成一团，两种都会「认不到」。')),

        h('div', { style: { marginTop: 8, display: 'flex', alignItems: 'center', gap: 10 } },
          h('button', {
            type: 'button',
            onClick: run,
            disabled: busy,
            style: {
              padding: '5px 12px', borderRadius: 6, fontSize: 13,
              cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.5 : 1,
              border: '1px solid rgba(127,127,127,.35)', background: 'transparent', color: 'inherit',
            },
          }, busy ? '测试中…' : '测试并锁定匹配窗口'),
          h('span', { style: { fontSize: 11.5, opacity: 0.55 } }, '约 1–4 秒')),

        msg ? h('div', { style: { marginTop: 8, color: '#c0392b', fontSize: 12 } }, msg) : null,
        result)
    }

    function Services() {
      const [st, setSt] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [msg, setMsg] = React.useState('')
      // 刚点过启动/重启：这段时间内不要报红 —— 模型加载要 10–30 秒，
      // 期间 /health 连不上是正常的（这正是"服务起来了界面还报错"的来源）。
      const [startingAt, setStartingAt] = React.useState(0)
      const [slow, setSlow] = React.useState(false)

      const load = () => {
        fetch(PANEL_API + '/status')
          .then((r) => r.json())
          .then(setSt)
          .catch(() => setSt({ error: '连不上面板接口（8790）。插件可能没启动。' }))
      }
      // 打开面板立刻检测一次，然后每 2 秒一次（原 5 秒太钝，起完服务要等半天才变绿）
      React.useEffect(() => {
        load()
        const t = setInterval(load, 2000)
        return () => clearInterval(t)
      }, [])

      const act = (path, label) => {
        setBusy(true)
        setStartingAt(Date.now())
        setMsg(label + '，模型加载约 10–30 秒…')
        fetch(PANEL_API + path, { method: 'POST' })
          .then((r) => r.json())
          .then((r) => {
            setMsg(r.ok ? (r.note || '已发起') : ('失败：' + (r.error || '未知原因')))
            setTimeout(load, 1500)
          })
          .catch((e) => setMsg('失败：' + String(e && e.message ? e.message : e)))
          .finally(() => setBusy(false))
      }
      const startServices = () => act('/start', '正在启动')
      const restartServices = () => act('/restart', '正在重启')

      if (!st) return h('div', { style: styles.card }, '读取服务状态…')
      if (st.error) return h('div', { style: styles.card }, st.error)

      const down = (st.services || []).filter((x) => !x.up)
      // 30 秒宽限：刚发过启动/重启就不再喊"未启用"
      const warming = startingAt && Date.now() - startingAt < 30_000
      return h('div', { style: styles.card },
        (st.services || []).map((x) =>
          h('div', { key: x.id, style: { display: 'flex', gap: 8, padding: '2px 0' } },
            h('span', { style: { width: 18 } }, x.up ? '🟢' : '🔴'),
            h('span', { style: { flex: '0 0 auto', width: 150 } }, x.name),
            h('span', { style: { opacity: 0.6, flex: 1 } },
              x.up ? ('端口 ' + x.port + (x.detail ? ' · ' + x.detail : '')) : ('未启动 · 端口 ' + x.port + (x.error ? ' · ' + x.error : ''))))),
        down.length === 0
          ? h('div', { style: { marginTop: 8, opacity: 0.6 } }, '两个服务都在运行。')
          : warming
            ? h('div', { style: { marginTop: 8, color: '#b8860b', fontWeight: 600 } },
                '正在启动：' + down.map((x) => x.name).join('、') + '（模型加载中，稍等）')
            : h('div', { style: { marginTop: 8, color: '#c0392b', fontWeight: 600 } },
                '服务未启用：' + down.map((x) => x.name).join('、')),

        // 采集中断：不自动恢复，只把原因摆在面板上，让人去点「重启服务」。
        // 2026-11-23 用户决定：故障恢复不做，页面报告 + 提示重启即可。
        st.watch && st.watch.state === 'failed'
          ? h('div', { style: { marginTop: 8, color: '#c0392b', fontWeight: 600, lineHeight: 1.6 } },
              '采集中断：' + (st.watch.reason || '未知原因'),
              h('br', null),
              h('span', { style: { fontWeight: 400, opacity: 0.85 } },
                '重新 watch_start 即可；如果上面的服务变红了，先点「重启服务」'))
          : null,
        st.watch && st.watch.state === 'running'
          ? h('div', { style: { marginTop: 8, opacity: 0.7, fontSize: 12 } },
              '正在采集：' + (st.watch.window || '?') + '（' + (st.watch.frames || 0) + ' 帧）')
          : null,

        // 启动日志地址：出环境问题时让人知道去哪看。路径由后端给，面板不猜。
        st.startupLog
          ? h('div', { style: { marginTop: 8, fontSize: 11.5, opacity: 0.55, lineHeight: 1.6 } },
              '环境日志（每个会话首次使用时记一条，最多 50 条）：',
              h('br', null),
              h('code', { style: { fontSize: 11.5 } }, st.startupLog))
          : null,
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
              padding: '5px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 13, marginRight: 8,
              border: '1px solid rgba(127,127,127,.35)', background: 'transparent', color: 'inherit',
              opacity: busy || st.configured === false || down.length === 0 ? 0.45 : 1,
            },
          }, busy ? '启动中…' : (down.length ? '启动服务' : '都已在运行')),
          h('button', {
            type: 'button',
            disabled: busy || st.configured === false,
            onClick: restartServices,
            style: {
              padding: '5px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 13,
              border: '1px solid rgba(127,127,127,.35)', background: 'transparent', color: 'inherit',
              opacity: busy || st.configured === false ? 0.45 : 1,
            },
          }, '重启服务')),
        msg ? h('div', { style: { marginTop: 6, fontSize: 12, opacity: 0.75 } }, msg) : null)
    }

    /**
     * 环境检查：八项只读，绿/黄/红。
     * 为什么放最前：环境不对时，用户看到的第一个现象是"AI 不理我"，
     * 而不是"缺 ffmpeg" —— 把它顶到第一屏，问题自己会说话。
     */
    function Doctor() {
      const [d, setD] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const load = () => {
        setBusy(true)
        fetch(PANEL_API + '/doctor')
          .then((r) => r.json())
          .then(setD)
          .catch(() => setD({ ready: false, checks: [{ id: 'x', label: '面板接口', state: 'fail', reason: '连不上面板接口' }] }))
          .finally(() => setBusy(false))
      }
      React.useEffect(() => { load() }, [])
      if (!d) return h('div', { style: styles.card }, '正在检查环境…')
      const color = (s) => (s === 'ok' ? '#1a7f37' : s === 'warn' ? '#b58105' : '#c0392b')
      const mark = (s) => (s === 'ok' ? '●' : s === 'warn' ? '◐' : '✕')
      return h('div', { style: styles.card },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 } },
          h('span', { style: { fontWeight: 600 } }, d.ready ? '环境齐全，可以开始' : '有项没过，先修再跑'),
          h('button', {
            style: { marginLeft: 'auto', fontSize: 12, padding: '2px 10px', cursor: 'pointer', borderRadius: 6,
              border: '1px solid rgba(127,127,127,.35)', background: 'transparent', color: 'inherit' },
            onClick: load,
            disabled: busy,
          }, busy ? '检查中…' : '重新检测')),
        (d.checks || []).map((c) => h('div', { key: c.id, style: { display: 'flex', gap: 8, padding: '3px 0', fontSize: 13 } },
          h('span', { style: { color: color(c.state), width: 14, flex: '0 0 auto' } }, mark(c.state)),
          h('span', { style: { width: 128, flex: '0 0 auto' } }, c.label),
          h('span', { style: { opacity: 0.7, flex: 1, wordBreak: 'break-all' } }, c.reason || ''))))
    }

    function Panel() {
      return h('div', { style: styles.wrap },
        h('div', { style: styles.title }, '陪看'),
        h('div', { style: styles.intro }, '让 AI 看你的屏幕：画面变化、屏幕文字、系统声音，三条通道汇成一条事件流。'),
        // spec：首项永远是「环境检查」。八项只读检查，绿黄红三态，
        // 失败只给原因，**不提供任何一键下载**（环境须用户自备）。
        h(Section, { title: '环境检查' },
          h(Doctor, null)),
        // 窗口识别测试（2026-11-24）：按标题锁一个窗口，顺手验"底部这条带能不能认出字"。
        h(Section, { title: '窗口识别测试' },
          h(WindowTest, null)),
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
