// 手机端接口：只读。给"躺床上看"用，不给遥控用。
//
// 为什么只读：每多一个写接口，就多一个"别人能控制你电脑"的入口。
// 要看，三个 GET 就够了；要控，等真有需求再加，并且必须解决鉴权。
import http from 'node:http'

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' }

/**
 * @param service  watch-along 的门面（status/events/frame）
 * @param token    必填。没有 token 的请求一律 401 —— 这个服务会绑到 0.0.0.0
 * @param port     0 = 随机可用端口（测试用）
 */
export function createMobileServer({ service, token, host = '0.0.0.0', port = 0, now = Date.now } = {}) {
  if (!token) throw new Error('createMobileServer 需要 token（不设 token 等于把电脑敞开）')

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
        send(200, JSON.stringify({ ok: true, ...service.status() }))
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
        if (!sheetId) {
          send(400, JSON.stringify({ ok: false, error: '缺 sheetId（手机端不提供实时抓屏，只取已产出的拼图）' }))
          return
        }
        const shot = await service.frame({ sheetId })
        send(200, shot.png, { 'Content-Type': 'image/png', 'Content-Length': String(shot.png.length) })
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
