// 种子数据：真实形状的游戏库 + 下载任务，供布局探针用。
// 用法：node scripts/seed_layout.mjs <DATA_DIR>
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { join } from 'node:path'

const DATA_DIR = process.argv[2] || join(process.cwd(), '.layout-seed')
mkdirSync(join(DATA_DIR, 'covers'), { recursive: true })
// 旧白图缩略图缓存必须清掉，否则主进程不会用新封面重生成
rmSync(join(DATA_DIR, 'thumbs'), { recursive: true, force: true })

/* ---- 最小 PNG 编码器：竖向渐变纯色图，让探针截图有真实封面的观感 ---- */
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
function gradientPng(w, h, top, bottom) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: RGB
  const raw = Buffer.alloc(h * (1 + w * 3))
  for (let y = 0; y < h; y++) {
    const t = y / (h - 1)
    const row = y * (1 + w * 3)
    raw[row] = 0 // filter: none
    for (let x = 0; x < w; x++) {
      const off = row + 1 + x * 3
      raw[off] = Math.round(top[0] + (bottom[0] - top[0]) * t)
      raw[off + 1] = Math.round(top[1] + (bottom[1] - top[1]) * t)
      raw[off + 2] = Math.round(top[2] + (bottom[2] - top[2]) * t)
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}
/** 每款一个低饱和渐变，明暗两档拉开层次（截图里能一眼分辨封面是否渲染成功） */
const COVER_COLORS = [
  [[124, 111, 168], [58, 48, 92]],
  [[74, 111, 165], [30, 48, 78]],
  [[168, 93, 93], [82, 38, 44]],
  [[93, 138, 102], [36, 66, 45]],
  [[138, 110, 79], [70, 50, 32]],
  [[86, 107, 138], [38, 50, 72]],
  [[138, 86, 117], [66, 38, 56]],
  [[79, 138, 133], [34, 68, 66]],
  [[154, 122, 63], [78, 58, 28]],
  [[107, 79, 138], [52, 36, 74]],
  [[63, 107, 93], [28, 56, 46]],
  [[138, 79, 86], [70, 36, 42]],
]
for (let i = 0; i < COVER_COLORS.length; i++) {
  const [top, bottom] = COVER_COLORS[i]
  writeFileSync(join(DATA_DIR, 'covers', `g${i + 1}.png`), gradientPng(240, 320, top, bottom))
}

const now = Date.now()
const games = [
  ['g1', 'D:\\Galgame\\Summertime', '美少女万华镜 -理与迷宫的少女们-', '美少女万華鏡 -理と迷宮の少女たち-', '恋爱冒险视觉小说，瀬戸口廉也执笔，全年龄向。', '2021-05-28', 8.9, ['汉化版', '全年龄', '恋爱', '催泪'], 26 * 3600000],
  ['g2', 'D:\\Galgame\\SteinsGate', '命运石之门 STEINS;GATE', 'シュタインズ・ゲート', '时间旅行题材，命运石之门选择门。', '2009-10-15', 9.2, ['科学ADV', '时间旅行', '悬疑'], 42 * 3600000],
  ['g3', 'D:\\Galgame\\WhiteAlbum2', 'White Album 2 白色相簿2', 'ホワイトアルバム2', '经典三角恋催泪作品，内含 IC+CC 全部章节。', '2012-12-20', 9.0, ['恋爱', '催泪', '冬'], 58 * 3600000],
  ['g4', 'D:\\Galgame\\SummerPockets', 'Summer Pockets REFLECTION BLUE', 'サマーポケッツ リフレクションブルー', 'Key 社夏日青春物语，鸟白岛の夏。', '2020-06-26', 8.7, ['Key', '夏日', '治愈'], 31 * 3600000],
  ['g5', 'D:\\Galgame\\ATRI', 'ATRI -My Dear Moments-', 'アトリ -My Dear Moments-', 'ANIPLEX.EXE 短篇，未来海洋世界机器人少女。', '2020-06-19', 8.5, ['短篇', '机器人', '催泪'], 8 * 3600000],
  ['g6', 'D:\\Galgame\\Tsukihime', '月姫 -A piece of blue glass moon-', '月姫 -A piece of blue glass moon-', 'TYPE-MOON 重制，爱尔奎特线。', '2021-08-26', 8.8, ['TYPE-MOON', '吸血鬼', '奇幻'], 35 * 3600000],
  ['g7', 'D:\\Galgame\\MuvLuv', 'Muv-Luv Alternative 全蚀篇', 'マブラヴ オルタネイティヴ', '机甲科幻长篇史诗。', '2006-02-24', 9.1, ['机甲', '科幻', '战争'], 60 * 3600000],
  ['g8', 'D:\\Galgame\\KatawaShoujo', 'Katawa Shoujo 片轮少女', 'かたわ少女', '残疾少女恋爱物语，免费同人作。', '2012-01-04', 8.2, ['同人', '恋爱', '治愈'], 20 * 3600000],
  ['g9', 'D:\\Galgame\\Ever17', 'Ever17 -the out of infinity-', 'エバー17 -the out of infinity-', 'KID 悬疑推理名作，多视角叙事。', '2002-08-29', 8.9, ['悬疑', '科幻', '名作'], 25 * 3600000],
  ['g10', 'D:\\Galgame\\Clannad', 'CLANNAD 经典版（含 After Story）', 'クラナド', 'Key 社催泪三部曲之首，家族物语。', '2004-04-28', 9.3, ['Key', '家族', '催泪'], 70 * 3600000],
  ['g11', 'D:\\Galgame\\Yuzusoft', '千恋＊万花 千恋＊万花', '千恋＊万花', '柚子社招牌废萌作品。', '2016-07-29', 8.4, ['柚子社', '废萌', '恋爱'], 30 * 3600000],
  ['g12', 'D:\\Galgame\\Higurashi', 'ひぐらしのなく頃に ひぐらしのなく頃に', 'ひぐらしのなく頃に', '龙骑士07 悬疑轮回恐怖名作。', '2002-08-10', 8.6, ['悬疑', '恐怖', '轮回'], 40 * 3600000],
].map(([id, dir, title, titleNative, description, releaseDate, rating, tags, playMs], i) => ({
  id, dir, exePath: `${dir}\\game.exe`, rawTitle: title, title, titleNative, description,
  coverPath: join(DATA_DIR, 'covers', `${id}.png`),
  releaseDate, rating, tags, categories: i % 2 ? ['全年龄'] : [], sources: [{ provider: 'vndb', id: 'v' + i }],
  playMs: playMs + i * 60000, lastPlayed: now - i * 86400000, useLE: i % 3 === 0, useMagpie: false, addedAt: now - i * 3600000,
}))

writeFileSync(join(DATA_DIR, 'games.json'), JSON.stringify(games, null, 2), 'utf8')

// 下载任务：覆盖各状态与长文件名。
// 「下载中」任务指向不可路由地址（10.255.255.1，RFC1918 黑洞）：真引擎启动后
// 会一直停在连接中，截图前不会因 404/DNS 抢先翻成失败——验收图才能拍到
// 粉色下载中状态与进度条（可路由的 example.com 会在开拍前就全变失败）。
const tasks = [
  { id: 't1', url: 'https://10.255.255.1/visual-novel-collection-part-1-of-12.7z', name: '美少女万华镜合集包 01.7z', state: 'downloading', total: 8.5e9, downloaded: 3.2e9, note: '测试长备注：包含全部汉化补丁与特典内容', threads: 16, error: '' },
  { id: 't2', url: 'https://10.255.255.1/steins-gate-0-cn-patch.7z', name: '命运石之门0 汉化补丁.7z', state: 'queued', total: 2.1e9, downloaded: 0, note: '', threads: 8, error: '' },
  { id: 't3', url: 'https://10.255.255.1/wa2-complete-pack.zip', name: 'White Album 2 完全版合集（含特典OST）.zip', state: 'paused', total: 12e9, downloaded: 6.8e9, note: '分卷下载中', threads: 32, error: '' },
  { id: 't4', url: 'https://10.255.255.1/hanapatch.exe', name: '夏日补丁 v2.0.exe', state: 'done', total: 4e8, downloaded: 4e8, note: '', threads: 4, error: '' },
  { id: 't5', url: 'https://example.com/broken-link.7z', name: '失效链接测试文件.7z', state: 'error', total: 0, downloaded: 0, note: '下载中断', threads: 8, error: '服务器连接被重置' },
  { id: 't6', url: 'https://10.255.255.1/atribgm.rar', name: 'ATRI 原声带 OST.rar', state: 'downloading', total: 9.8e8, downloaded: 7.7e8, note: '下完自动解压', threads: 12, error: '' },
]
const defs = tasks.map((t) => ({
  id: t.id, url: t.url, dest: `D:\\Downloads\\${t.name}`, threads: t.threads, proxy: '',
  added_at: now / 1000 - 3600, note: t.note, state: t.state, total: t.total, downloaded: t.downloaded,
  error: t.error, finished_at: t.state === 'done' ? now : 0, checksum: '',
}))
writeFileSync(join(DATA_DIR, 'tasks.json'), JSON.stringify(defs, null, 2), 'utf8')

console.log('seeded', DATA_DIR, games.length, 'games,', tasks.length, 'tasks')