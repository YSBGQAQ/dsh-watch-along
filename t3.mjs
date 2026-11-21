import fs from 'node:fs'
import { windowRect, capture } from './src/capture-koffi.mjs'
import { encode } from './src/png.mjs'
const r = windowRect('反向之地')
const f = capture(r)
const W = f.width, H = f.height
fs.writeFileSync('.scratch/run/full.png', encode({ width: W, height: H, rgb: f.buf }))
const y0 = Math.floor(H * 0.66)
const bh = H - y0
const band = Buffer.alloc(W * bh * 3)
f.buf.copy(band, 0, y0 * W * 3, H * W * 3)
fs.writeFileSync('.scratch/run/band.png', encode({ width: W, height: bh, rgb: band }))
console.log('full', W + 'x' + H, 'band', W + 'x' + bh)
