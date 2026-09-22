// T5 验收：隔离 DATA_DIR 伪造 coverPath → 启动 → 确认缩略图生成 + hh:// 协议可用。
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const APP_ROOT = join(here, '..')
const DATA_DIR = join(APP_ROOT, '.t5-data')
rmSync(DATA_DIR, { recursive: true, force: true })
mkdirSync(join(DATA_DIR, 'covers'), { recursive: true })

// 先生成一张真实图片当封面（用 Electron 没法在 node 里直接造，借 nativeImage 需要主进程）。
// 这里用最小的合法 JPEG bytes 占位；真正生成的缩略图由主进程 createThumbnailFromPath 产出。
// 用 base64 的最小 1x1 jpeg。
const b64 = '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q=='
writeFileSync(join(DATA_DIR, 'covers', 't5.jpg'), Buffer.from(b64, 'base64'))

const games = [
  {
    id: 't5-game-1',
    dir: 'D:\\Fake\\Game1',
    exePath: 'D:\\Fake\\Game1\\game.exe',
    rawTitle: 'Game1',
    title: 'Game1',
    coverPath: join(DATA_DIR, 'covers', 't5.jpg'),
    tags: [], categories: [], sources: [], playMs: 0, useLE: false, useMagpie: false, addedAt: Date.now(),
  },
]
writeFileSync(join(DATA_DIR, 'games.json'), JSON.stringify(games, null, 2), 'utf8')
console.log('seeded', DATA_DIR)