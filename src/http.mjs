// 手机端接口：三条只读（status / events / frame）+ 两条写（start / stop）
// + 两条诊断（GET /api/windows、POST /api/ocr-test）。
// frame 有两条路：?sheetId= 取已产出的拼图，?live=1 现抓一帧（后者是 2026-11-24 加的，
// 因为拼图只在画面明显变化时才产，看视频时常常一张都没有）。
//
// ==================== 能力边界：谁能在哪用到什么 ====================
// 同一份插件跑两个 HTTP 面：
//   · 本机面板  —— supervisor.serve()，127.0.0.1:<panel 端口>，不鉴权（只对本机回环开）
//   · 手机/局域网 —— 本文件，绑定 host（默认 0.0.0.0）+ token 鉴权
// 两个面的能力**必须显式对齐**，否则会分叉：面板上点得通的东西，躺床上点不通，
// 于是有人为了"能用"去把面板端口也放到 0.0.0.0 —— 那才是真的把电脑敞开。
//
// 【只给本机面板，不开给局域网】
//   · 服务管家（启动/停止 OCR、ASR 子进程、改端口、看它们的日志、/restart）
//     —— 这些会拉起任意可执行文件、动到进程表，属于"运维"而不是"看画面"。
//   · 改设置（settings 落盘：窗口、分带、唤醒间隔、token、绑定地址 …）
//     —— 一次误触就能让下一场陪看静默失效，且很难从手机上看出是哪个值错了。
//   · 文件/目录类操作（取帧落盘路径、清理、导出）
//     —— 手机不该有写本机文件系统的能力。
//   · 工具注册、会话投递（watch_* 工具、wake 的 send）
//     —— 这属于 agent 侧，走不到 HTTP。
//
// 【也开给局域网手机，因为它们在床上一模一样地需要】
//   · GET  /api/status   —— 现在在采什么、有没有中断。
//   · GET  /api/events   —— 字幕/语音/动作事件流（带 sinceId 增量 + 长轮询）。
//   · GET  /api/frame    —— ?sheetId= 取历史拼图；?live=1 现抓一帧。
//   · POST /api/start    —— {window?"标题片段"}；不带就用面板锁定的那个窗口，
//     没锁定会直接报错并说明去哪儿锁（不猜）。
//   · POST /api/stop     —— 停采集。
//   · GET  /api/windows  —— 列当前窗口标题，给手机"点一条选中"用；只读、不动状态。
//     启停之所以破例放出去（2026-11-23）：躺床上够不到电脑，而启停**只改采集开关**，
//     不碰设置、不碰文件、不执行命令，失败也只是回到"没在采"。
//   · POST /api/ocr-test —— 诊断"现在这一帧底部字幕能不能认出来"。
//     它是只读诊断（只抓一帧、只读像素、调一次 OCR），不上传、不落盘、不改任何状态，
//     而且它是唯一能远程回答"为什么手机看不到字幕"的接口。逻辑不在这里复制一份：
//     真正的实现在 index.js 的 ocrTestRoute，通过 opts.ocrTest 注入，两个面共用同一个函数
//     —— 改一处两边一起变，避免"面板通过、手机不通过"这种最难查的分叉。
//   · 其余一律 404。新增路由时先回答：手机在什么场景下真的需要它？
//     答不出来就留在面板里。
// ==================================================================
//
// 为什么现在允许写：躺床上看的时候没法起身去够电脑，"开始/停止采集"是唯一值得
// 放出去的写动作 —— 它不碰设置、不碰文件、不执行命令，只改采集的启停。别的遥控
// 一律不做，改设置仍然只能在电脑面板里。
//
// 鉴权沿用原来那一套，没有放松：token 必须出现在 ?token= 或 Authorization: Bearer，
// 不对一律 401。token 默认每次启动随机（WATCH_ALONG_TOKEN 可固定），不传 token
// 构造函数直接抛 —— 这个服务绑 0.0.0.0，没 token 等于把电脑敞开。
//
// 写接口的失败**不用 HTTP 状态码表达**：一律 200 + {ok:false,error:"中文原因"}。
// 因为手机面板要把这句话原样显示给人看；若走 4xx/5xx，前端只看到一个数字，
// 「窗口找不到」和「服务没起来」就分不出来了。
import http from 'node:http'

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' }

// 写接口的请求体只该有 {window}，给 8KB 够了。超了就当空体处理，别让一个
// 坏客户端把内存吃满（这个口对局域网开着）。
const MAX_BODY = 8 * 1024

function readBody(req, maxBody = MAX_BODY, encoding = 'utf8') {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    let done = false
    const finish = (v) => {
      if (done) return
      done = true
      resolve(v)
    }
    req.on('data', (c) => {
      // 已经判超限了：剩下的数据继续吃掉但不再累积。
      // **不能 req.destroy()** —— 掐断 socket 会让调用方只看到 fetch failed，
      // 收不到我们准备好的那句原因（2026-11-24 实测踩到）。
      if (done) return
      size += c.length
      if (size > maxBody) {
        finish(null) // null = 超限，调用方自己决定怎么回
        return
      }
      chunks.push(c)
    })
    req.on('end', () => finish(Buffer.concat(chunks).toString(encoding)))
    req.on('error', () => finish(''))
  })
}

/**
 * @param service  watch-along 的门面（status/events/frame/start/stop）
 * @param token    必填。没有 token 的请求一律 401 —— 这个服务会绑到 0.0.0.0
 * @param port     0 = 随机可用端口（测试用）
 * @param control  两条写接口的实现 { start(window), stop() }。缺省时写接口回「未启用」
 *                 而不是崩：http 层不认识 supervisor，接线在 index.js 里做。
 * @param ocrTest  POST /api/ocr-test 的实现 ({body}) => {ok,...}。缺省时回「未启用」。
 *                 这里**不另写一份**：与面板的 'POST /ocr-test' 是同一个函数
 *                 （index.js 的 ocrTestRoute），只是同时挂到两个面上。
 *                 少一份实现，就少一处能分叉的地方。
 * @param windows  GET /api/windows 的实现 () => {ok,count,windows}，同样是面板那个
 *                 listWindowsRoute。只读、不动状态，所以也放给手机。
 * @param listTitles  () => string[]，塞进 GET /api/status 的 titles 字段（最多 20 条）。
 *                 与面板那份取法一致（listWindowTitles）。取不到就回空数组，状态本身不受影响。
 * @param maxBody  请求体上限，默认 8KB。ocr-test 的请求体只有 {"expect":"一句台词"}，
 *                 8KB 绰绰有余；超了按空体处理，别让坏客户端把这个对局域网开着的口吃满。
 */
export function createMobileServer({
  service,
  token,
  control = null,
  ocrTest = null,
  windows = null,
  listTitles = null,
  host = '0.0.0.0',
  port = 0,
  maxBody = MAX_BODY,
  now = Date.now,
} = {}) {
  if (!token) throw new Error('createMobileServer 需要 token（不设 token 等于把电脑敞开）')

  // 现抓的"同一秒只抓一次"缓存。放在 handler 外面：它要跨请求存活。
  let liveCache = null // { sec, png }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const authed =
      url.searchParams.get('token') === token ||
      (req.headers.authorization ?? '') === `Bearer ${token}`

    if (!authed) {
      res.writeHead(401, JSON_HEADERS)
      res.end(JSON.stringify({ ok: false, error: '需要 token' }))
      return
    }

    const send = (code, body, headers = JSON_HEADERS) => {
      res.writeHead(code, headers)
      res.end(body)
    }

    try {
      if (url.pathname === '/api/status') {
        // titles：手机端每 2.5 秒轮询这个接口，顺手把可见窗口清单带上，
        // 省得为一份列表再开一条路由。取不到就是空数组 —— **不能让状态接口因此挂掉**。
        let titles = []
        if (typeof listTitles === 'function') {
          try {
            titles = (await listTitles()) ?? []
          } catch {
            titles = []
          }
        }
        const clean = Array.isArray(titles)
          ? titles.filter((t) => typeof t === 'string' && t).slice(0, 20)
          : []
        send(200, JSON.stringify({ ok: true, ...service.status(), titles: clean }))
        return
      }

      if (url.pathname === '/api/events') {
        const sinceId = url.searchParams.has('sinceId') ? Number(url.searchParams.get('sinceId')) : null
        const wait = Math.min(60, Math.max(0, Number(url.searchParams.get('wait') ?? 0)))
        const got = await service.events({ sinceId, waitMs: Math.round(wait * 1000) })
        send(200, JSON.stringify({ ok: true, ...got }))
        return
      }

      if (url.pathname === '/api/frame') {
        const sheetId = url.searchParams.get('sheetId')
        const wantLive = url.searchParams.get('live') === '1'
        if (!sheetId && !wantLive) {
          send(
            400,
            JSON.stringify({ ok: false, error: '缺参数：取已产出的拼图用 ?sheetId=xxx，要现抓一帧用 ?live=1' }),
          )
          return
        }
        // 老分支：一行没动，行为与以前一致。
        if (sheetId) {
          const shot = await service.frame({ sheetId })
          send(200, shot.png, { 'Content-Type': 'image/png', 'Content-Length': String(shot.png.length) })
          return
        }

        // 现抓一帧。为什么需要它：拼图只在画面明显变化时才产，实测两场（20 分钟 133 事件、
        // 63 秒 9 事件）一个 motion 都没有 —— 手机端于是一张图都取不到。看画面这件事
        // 不该依赖"画面对模型来说够不够新鲜"。
        //
        // 同一秒内重复点只给上一张：单次抓取 15–25ms 不算贵，但手机连点会白占 CPU，
        // 而且同一秒的两张图内容几乎一样，多抓一次没有信息量。
        const sec = Math.floor(now() / 1000)
        if (liveCache && liveCache.sec === sec) {
          send(200, liveCache.png, {
            'Content-Type': 'image/png',
            'Content-Length': String(liveCache.png.length),
          })
          return
        }

        // 没在采就直说，别去等帧 —— 等只会等成"超时"，而超时在 service 里会被记成
        // 一次采集故障（state=failed），手机点一下就把整场标红，太重了。
        const st = service.status()
        if (st?.state !== 'running') {
          send(200, JSON.stringify({ ok: false, error: '现在没在采，抓不到画面' }))
          return
        }

        try {
          // live:true = 等"调用之后才到达"的那一帧，最多等 0.8 秒。
          // 12fps 下新帧 83ms 就到；等不到说明采集真的卡住了，这时必须立刻失败而不是挂着。
          const shot = await service.frame({ live: true, timeoutMs: 800 })
          liveCache = { sec, png: shot.png }
          send(200, shot.png, { 'Content-Type': 'image/png', 'Content-Length': String(shot.png.length) })
        } catch (e) {
          const msg = String(e?.message ?? e)
          // 「采不到帧」是 service 的等待超时，不是解码/内存问题，两者要分开告诉手机端。
          // 注意：窗口关掉或最小化**不会**让抓取报错（抓的是屏幕那一块，会拍到背后的内容），
          // 所以这条实际是"采集卡住/停摆"的信号，文案把两种可能都写上，别让人误判。
          send(
            200,
            JSON.stringify({
              ok: false,
              error: /采不到帧/.test(msg)
                ? '窗口没了：0.8 秒内没等到新画面（可能已关闭或最小化，也可能是采集卡住了）'
                : `抓图失败：${msg}`,
            }),
          )
        }
        return
      }

      // ---- 下面两条是写：只改采集的启停，别的一概不做 ----
      // 失败一律 200 + {ok:false,error}：手机面板要显示那句话本身，见文件头。
      if (url.pathname === '/api/start' || url.pathname === '/api/stop') {
        const isStart = url.pathname === '/api/start'
        if (req.method !== 'POST') {
          send(200, JSON.stringify({ ok: false, error: `${url.pathname} 只接受 POST` }))
          return
        }
        if (!control || typeof control[isStart ? 'start' : 'stop'] !== 'function') {
          send(200, JSON.stringify({ ok: false, error: '未启用：这个版本没有接启停能力（需要重启 DSH 加载新代码）' }))
          return
        }

        let want = ''
        if (isStart) {
          const raw = (await readBody(req)) ?? ''
          let body = {}
          if (raw.trim()) {
            try {
              body = JSON.parse(raw)
            } catch {
              send(
                200,
                JSON.stringify({
                  ok: false,
                  error: '请求体不是合法 JSON（要 {"window":"标题片段"}，也可以整个不发）',
                }),
              )
              return
            }
          }
          if (body?.window != null && typeof body.window !== 'string') {
            send(200, JSON.stringify({ ok: false, error: 'window 要写字符串：{"window":"哔哩哔哩"}' }))
            return
          }
          want = (body?.window ?? '').trim()
        }

        try {
          const st = await control[isStart ? 'start' : 'stop'](want)
          send(200, JSON.stringify({ ok: true, ...(st && typeof st === 'object' ? st : {}) }))
        } catch (e) {
          send(200, JSON.stringify({ ok: false, error: String(e?.message ?? e) }))
        }
        return
      }

      // ---- GET /api/windows：列当前可见窗口，给手机端"点一条选中"用 ----
      // 只读、不动任何状态；枚举是原生的（微秒级），和按标题匹配同一套判据。
      if (url.pathname === '/api/windows') {
        if (req.method !== 'GET') {
          send(200, JSON.stringify({ ok: false, error: '/api/windows 只接受 GET' }))
          return
        }
        if (typeof windows !== 'function') {
          send(200, JSON.stringify({ ok: false, error: '未启用：这个版本没有接窗口列表（需要重启 DSH 加载新代码）' }))
          return
        }
        try {
          send(200, JSON.stringify(await windows()))
        } catch (e) {
          send(200, JSON.stringify({ ok: false, error: String(e?.message ?? e) }))
        }
        return
      }

      // ---- POST /api/ocr-test：只读诊断，逻辑在 index.js 的 ocrTestRoute ----
      // 与面板的 'POST /ocr-test' 是**同一个函数**，这里只负责鉴权、收体、转发、包 HTTP。
      // 失败形状与上面两条写一致：200 + {ok:false,error}，让手机面板原样显示中文原因。
      if (url.pathname === '/api/ocr-test') {
        if (req.method !== 'POST') {
          send(200, JSON.stringify({ ok: false, error: '/api/ocr-test 只接受 POST' }))
          return
        }
        if (typeof ocrTest !== 'function') {
          send(200, JSON.stringify({ ok: false, error: '未启用：这个版本没有接识别测试（需要重启 DSH 加载新代码）' }))
          return
        }
        // 超限时 readBody 给 null：不把半截 JSON 传下去，直接说清楚，避免下游报"不是合法 JSON"误导人。
        const body = await readBody(req, maxBody)
        if (body === null) {
          send(200, JSON.stringify({ ok: false, error: `请求体太大（上限 ${maxBody} 字节）` }))
          return
        }
        try {
          const r = await ocrTest({ body })
          send(200, JSON.stringify(r ?? { ok: false, error: '识别测试没有返回结果' }))
        } catch (e) {
          send(200, JSON.stringify({ ok: false, error: String(e?.message ?? e) }))
        }
        return
      }

      send(404, JSON.stringify({ ok: false, error: '没有这个接口' }))
    } catch (e) {
      send(500, JSON.stringify({ ok: false, error: String(e?.message ?? e) }))
    }
  })

  return {
    server,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => {
          const addr = server.address()
          resolve({ host, port: addr.port, url: `http://${host === '0.0.0.0' ? 'localhost' : host}:${addr.port}`, token })
        })
      })
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()))
    },
  }
}
