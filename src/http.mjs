// 手机端接口：只读。给"躺床上看"用，不给遥控用。
//
// 为什么只读：每多一个写接口，就多一个"别人能控制你电脑"的入口。
// 要看，三个 GET 就够了；要控，等真有需求再加，并且必须解决鉴权。
import http from 'node:http'

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' }

/** 手机端页面：单文件 HTML，无构建链。轮询 /api/events，断线自己重连。 */
const PAGE = (token) => `<!doctype html>
<html lang="zh"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>陪看</title>
<style>
  :root{color-scheme:light dark;--bg:#fff;--fg:#1a1a1a;--dim:#6b7280;--line:#e5e7eb;--card:#f7f7f8;--accent:#2563eb}
  @media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#e8e8e8;--dim:#9ca3af;--line:#2a2a2a;--card:#1c1c1e;--accent:#60a5fa}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 -apple-system,"Segoe UI",system-ui,sans-serif}
  header{position:sticky;top:0;background:var(--bg);border-bottom:1px solid var(--line);padding:10px 14px;display:flex;gap:8px;align-items:center}
  header b{font-size:15px}
  #st{margin-left:auto;font-size:12px;color:var(--dim)}
  main{padding:8px 10px 40px}
  .e{background:var(--card);border-radius:10px;padding:10px 12px;margin:8px 0}
  .h{display:flex;gap:8px;align-items:baseline;font-size:12px;color:var(--dim)}
  .k{font-weight:600;color:var(--accent)}
  .t{margin-top:4px;white-space:pre-wrap;word-break:break-word}
  img{width:100%;border-radius:8px;margin-top:8px;display:block}
  .empty{color:var(--dim);text-align:center;padding:40px 0}
</style></head>
<body>
<header><b>陪看</b><span id="st">连接中…</span></header>
<main id="list"><div class="empty">还没有事件</div></main>
<script>
const TOKEN=${JSON.stringify(token)};
let since=0, seen=new Set();
const list=document.getElementById('list'), st=document.getElementById('st');

function add(e){
  if(seen.has(e.id)) return; seen.add(e.id);
  const d=document.createElement('div'); d.className='e';
  const k=document.createElement('div'); k.className='h';
  k.innerHTML='<span class="k">'+e.kind+'</span><span>'+fmt(e.at)+'</span>';
  d.appendChild(k);
  if(e.text){const t=document.createElement('div');t.className='t';t.textContent=e.text;d.appendChild(t);}
  if(e.where){const t=document.createElement('div');t.className='t';t.textContent='位置 '+e.where+(e.strength?' · '+e.strength:'');d.appendChild(t);}
  if(e.sheetId){
    const img=document.createElement('img');
    img.loading='lazy';
    img.src='/api/frame?token='+encodeURIComponent(TOKEN)+'&sheetId='+encodeURIComponent(e.sheetId);
    d.appendChild(img);
  }
  const box=list.querySelector('.empty'); if(box) box.remove();
  list.insertBefore(d, list.firstChild);
}
function fmt(ms){ if(!ms) return ''; const d=new Date(ms); return d.toTimeString().slice(0,8); }

async function loop(){
  try{
    const r=await fetch('/api/events?wait=10&sinceId='+since+'&token='+encodeURIComponent(TOKEN),{cache:'no-store'});
    if(r.status===401){ st.textContent='token 不对'; return; }
    const j=await r.json();
    (j.events||[]).forEach(add);
    if(typeof j.nextId==='number') since=j.nextId;
    st.textContent='在线 · 已收到 '+seen.size+' 条';
  }catch(err){
    st.textContent='断线，正在重连…';
    await new Promise(r=>setTimeout(r,2000));
  }
  setTimeout(loop,300);
}
loop();
</script></body></html>`;


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
      if (url.pathname === '/' || url.pathname === '/index.html') {
        send(200, PAGE(token), { 'Content-Type': 'text/html; charset=utf-8' })
        return
      }

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
