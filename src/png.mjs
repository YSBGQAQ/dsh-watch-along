// PNG 编码器的唯一出口。
//
// 单独成一个文件，是为了让门面不直接依赖 vendor 里的 native.js ——
// 那个模块一 import 就会加载 koffi（要 user32/gdi32），
// 而单测只需要编码，不需要碰任何 Win32。
export { encodePng as encode } from '../vendor/dsh-streamvision-main/lib/native.js'
