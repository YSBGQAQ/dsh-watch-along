// 面板内容的一致性检查。
//
// 起因：删掉设置里的 maxWakes 之后，面板里那一行**没删掉** —— 因为那次替换没匹配上，
// 而且没有任何测试盯着 client.js。界面于是还在渲染一个后端已经没有的字段，
// 输入框空白、保存时也传不上去。
//
// 这类"改了后端忘了改前端"的问题，静态扫一遍就能抓住。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const CLIENT = path.join(import.meta.dirname, '..', 'client.js')
const src = fs.readFileSync(CLIENT, 'utf8')

/** 去掉注释行，只留真正会被渲染的字符串。 */
function codeLines(text) {
  return text
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
}

test('面板不再渲染已删除的 maxWakes 字段', () => {
  assert.equal(src.includes('maxWakes'), false, 'client.js 还在引用 maxWakes')
})

test('面板里不要写 Markdown 星号（JS 字符串不会渲染 Markdown）', () => {
  const bad = codeLines(src).filter((l) => l.includes('**'))
  assert.deepEqual(bad, [], `这些行会把星号原样显示：\n${bad.join('\n')}`)
})

test('面板的字段都能在设置模型里找到（防"前端多一个")', async () => {
  const { DEFAULTS } = await import('../src/settings.mjs')
  const keys = [...src.matchAll(/row\('([a-zA-Z]+)'/g)].map((m) => m[1])
  assert.ok(keys.length >= 6, `只找到 ${keys.length} 行设置`)
  const unknown = keys.filter((k) => !(k in DEFAULTS))
  assert.deepEqual(unknown, [], `面板有、设置模型里没有：${unknown.join(',')}`)
})
