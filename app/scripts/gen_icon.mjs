// 程序化生成 app/build/icon.ico（16/32/48 BMP + 256 PNG 四尺寸）。
// 零依赖：纯 Node 手写位图 → BMP/PNG 编码 → ICO 容器。
// 图案是「三叶羽」几何标（品牌 accent 主色），无任何 AI 生成成分。
//
// 用法：node scripts/gen_icon.mjs
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const OUT = join(here, '..', 'build', 'icon.ico')

// ---- 256 主位图（RGBA）----
const SIZE = 256
const BG = [0x20, 0x20, 0x20] // tokens.color.windowFallback
const ACCENT = [0x4d, 0xa3, 0xff] // tokens.color.accent
const RADIUS = 52 // 圆角

// 三叶羽：底部交汇、向斜上张开。每叶是绕中心旋转的圆头矩形。
const LEAVES = [
  { cx: 128, cy: 152, w: 22, h: 118, ang: (-25 * Math.PI) / 180 },
  { cx: 128, cy: 152, w: 22, h: 118, ang: (25 * Math.PI) / 180 },
  { cx: 128, cy: 166, w: 20, h: 92, ang: 0 },
]

function leafCoverage(x, y) {
  let best = 0
  for (const l of LEAVES) {
    const dx = x - l.cx
    const dy = y - l.cy
    const cos = Math.cos(-l.ang)
    const sin = Math.sin(-l.ang)
    const lx = Math.abs(dx * cos - dy * sin) - l.w / 2
    const ly = Math.abs(dx * sin + dy * cos) - l.h / 2
    const d = Math.hypot(Math.max(lx, 0), Math.max(ly, 0)) + Math.min(Math.max(lx, ly), 0)
    best = Math.max(best, Math.min(1, 0.5 - d))
  }
  return best
}

const px = new Uint8Array(SIZE * SIZE * 4)
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const i = (y * SIZE + x) * 4
    // 圆角方形背景（角透明）
    const cx = Math.max(RADIUS - x, x - (SIZE - 1 - RADIUS), 0)
    const cy = Math.max(RADIUS - y, y - (SIZE - 1 - RADIUS), 0)
    const bgA = Math.min(1, 0.5 - (Math.hypot(cx, cy) - RADIUS))
    const leaf = leafCoverage(x, y)
    const a = Math.min(1, bgA + leaf)
    // 叶上叠一点高光：顶部更亮，模拟玻璃柔光
    const lift = (1 - y / SIZE) * 26
    const r = Math.round(BG[0] + (ACCENT[0] - BG[0]) * leaf + lift)
    const g = Math.round(BG[1] + (ACCENT[1] - BG[1]) * leaf + lift)
    const b = Math.round(BG[2] + (ACCENT[2] - BG[2]) * leaf + lift * 1.4)
    px[i] = Math.max(0, Math.min(255, r))
    px[i + 1] = Math.max(0, Math.min(255, g))
    px[i + 2] = Math.max(0, Math.min(255, b))
    px[i + 3] = Math.round(a * 255)
  }
}

// ---- 小尺寸：box 缩小（带 1px 软边抗锯齿量）----
function downscale(src, srcSize, dstSize) {
  const out = new Uint8Array(dstSize * dstSize * 4)
  const scale = srcSize / dstSize
  for (let y = 0; y < dstSize; y++) {
    for (let x = 0; x < dstSize; x++) {
      const x0 = Math.floor(x * scale)
      const y0 = Math.floor(y * scale)
      const x1 = Math.min(srcSize, x0 + Math.ceil(scale))
      const y1 = Math.min(srcSize, y0 + Math.ceil(scale))
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let n = 0
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * srcSize + sx) * 4
          const w = src[i + 3]
          r += src[i] * w
          g += src[i + 1] * w
          b += src[i + 2] * w
          a += w
          n += 255
        }
      }
      const oi = (y * dstSize + x) * 4
      const an = a || 1
      out[oi] = Math.round(r / an)
      out[oi + 1] = Math.round(g / an)
      out[oi + 2] = Math.round(b / an)
      out[oi + 3] = Math.round((a / n) * 255)
    }
  }
  return out
}

// ---- 编码器 ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0 // filter none
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
function encodeBmp(size, rgba) {
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0) // biSize
  header.writeInt32LE(size, 4) // biWidth
  header.writeInt32LE(size * 2, 8) // biHeight（ICO 惯例：高度×2）
  header.writeUInt16LE(1, 12) // biPlanes
  header.writeUInt16LE(32, 14) // biBitCount
  const pixels = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      const o = (y * size + x) * 4
      pixels[o] = rgba[i + 2] // B
      pixels[o + 1] = rgba[i + 1] // G
      pixels[o + 2] = rgba[i] // R
      pixels[o + 3] = rgba[i + 3] // A
    }
  }
  return Buffer.concat([header, pixels])
}

// ---- ICO 容器 ----
const sizes = [16, 32, 48, 256]
const images = sizes.map((s) =>
  s === 256 ? { data: encodePng(s, px) } : { data: encodeBmp(s, downscale(px, SIZE, s)) },
)
const head = Buffer.alloc(6)
head.writeUInt16LE(0, 0) // reserved
head.writeUInt16LE(1, 2) // type: icon
head.writeUInt16LE(images.length, 4)
let offset = 6 + images.length * 16
const entries = []
for (const img of images) {
  const isPng = img.data[0] === 0x89 && img.data[1] === 0x50 // PNG 魔数
  const size = isPng ? 256 : Math.round(Math.sqrt((img.data.length - 40) / 4))
  const entry = Buffer.alloc(16)
  entry[0] = size === 256 ? 0 : size
  entry[1] = size === 256 ? 0 : size
  entry[4] = 1 // planes
  entry[6] = 32 // bitcount
  entry.writeUInt32LE(img.data.length, 8)
  entry.writeUInt32LE(offset, 12)
  entries.push(entry)
  offset += img.data.length
}
const ico = Buffer.concat([head, ...entries, ...images.map((i) => i.data)])
mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, ico)
console.log(`icon.ico 已生成：${ico.length} B（${sizes.join('/')} 四尺寸）`)
