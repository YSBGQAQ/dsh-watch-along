// PNG 编码器的唯一出口。
//
// 单独成一个文件，是为了让门面不直接依赖 vendor 里的 native.js ——
// 那个模块一 import 就会加载 koffi（要 user32/gdi32），
// 而单测只需要编码，不需要碰任何 Win32。
//
// 进门前把像素统一成 Buffer：vendor 的 encodePng 用 rgb.copy 逐行搬像素，
// 而拼图（composeGrid）给的是 Uint8Array。曾经没做这层归一，
// 结果是每 3 秒抛一次 "rgb.copy is not a function"，拼图全废而没人察觉。
import { encodePng } from '../vendor/dsh-streamvision-main/lib/native.js'

export function encode({ width, height, rgb }) {
  // Buffer.from(arrayBuffer, byteOffset, byteLength) 是视图、不复制像素。
  const buf = Buffer.isBuffer(rgb) ? rgb : Buffer.from(rgb.buffer, rgb.byteOffset, rgb.byteLength)
  return encodePng({ width, height, rgb: buf })
}
