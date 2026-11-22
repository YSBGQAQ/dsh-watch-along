// 采集器（koffi 直抓）的契约测试。
//
// 为什么这几条必须存在：
//   1. koffi 是 native 调用，参数类型写错是**段错误**，不是异常 —— 一旦没有入口校验，
//      整个宿主进程直接没了，连堆栈都没有（票 20 的「风险」一节）。
//   2. `params` 的形状是硬契约：service 会读 `capture.params.fps` / `.region` /
//      `.width` / `.height`，少一个就死在 status() 上（实测报 reading 'fps'）。
import test from 'node:test'
import assert from 'node:assert/strict'

import { windowRect, capture, startCapture } from '../src/capture-koffi.mjs'

test('windowRect 传非字符串 / 空串立即抛 TypeError（不能段错误）', () => {
  for (const bad of [123, null, undefined, {}, [], true]) {
    assert.throws(() => windowRect(bad), TypeError, `入参 ${String(bad)} 没有抛 TypeError`)
  }
  assert.throws(() => windowRect(''), TypeError)
})

test('capture 缺尺寸或非数字立即抛 TypeError', () => {
  assert.throws(() => capture({ x: 0, y: 0 }), TypeError)
  assert.throws(() => capture({ x: 'a', y: 0, width: 8, height: 8 }), TypeError)
  assert.throws(() => capture(), TypeError)
})

test('startCapture 交出的 params 含 fps / region / width / height', () => {
  const cap = startCapture({
    region: { x: 0, y: 0, width: 8, height: 8, dpiScale: 1 },
    width: 8,
    height: 8,
    fps: 4,
  })
  try {
    assert.equal(cap.params.fps, 4, 'fps 丢了 —— service.status() 会崩')
    assert.equal(cap.params.width, 8)
    assert.equal(cap.params.height, 8)
    assert.ok(cap.params.region && typeof cap.params.region === 'object')
    assert.equal(typeof cap.stop, 'function')
  } finally {
    cap.stop()
  }
})

test('region 是逻辑像素时按 dpiScale 换算成物理像素', () => {
  // 不换算就会抓左上角一块（实测 motion / ocr 全 0）
  const cap = startCapture({
    region: { x: 10, y: 10, width: 8, height: 8, dpiScale: 1.5 },
    width: 8,
    height: 8,
    fps: 2,
  })
  try {
    assert.equal(cap.params.region.x, 15)
    assert.equal(cap.params.region.y, 15)
  } finally {
    cap.stop()
  }
})

test('只传 region、不传 width/height 时输出尺寸跟 region 一致', () => {
  const cap = startCapture({ region: { x: 0, y: 0, width: 8, height: 6, dpiScale: 1 }, fps: 2 })
  try {
    assert.equal(cap.params.width, 8)
    assert.equal(cap.params.height, 6)
  } finally {
    cap.stop()
  }
})

test('fps 是垃圾值时退回 8，不能把 setInterval 打成 1ms 空转', () => {
  for (const bad of [NaN, 0, -1, Infinity]) {
    const cap = startCapture({
      region: { x: 0, y: 0, width: 8, height: 8, dpiScale: 1 },
      width: 8,
      height: 8,
      fps: bad,
    })
    try {
      assert.equal(cap.params.fps, 8, `fps=${bad} 没有退回 8`)
    } finally {
      cap.stop()
    }
  }
})

test('stop() 之后不再回调 onFrame', async (t) => {
  let n = 0
  const cap = startCapture({
    region: { x: 0, y: 0, width: 8, height: 8, dpiScale: 1 },
    width: 8,
    height: 8,
    fps: 20, // 50ms 一拍
    onFrame: () => {
      n += 1
    },
  })
  try {
    // 先让它真的出过帧，否则「stop 后不再出帧」是恒真的空断言。
    await new Promise((r) => setTimeout(r, 300))
    if (n === 0) {
      // 没有桌面会话 / 抓不到帧时，这条用例没有信息量，明确 skip 而不是假装通过
      t.skip('这台机器 300ms 内没抓到任何帧，stop 语义无法验证')
      return
    }
    const before = n
    cap.stop()
    await new Promise((r) => setTimeout(r, 200))
    assert.equal(n, before, 'stop() 之后还在出帧')
  } finally {
    cap.stop()
  }
})
