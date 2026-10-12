import { writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const dir = join(homedir(), '.hanehana')
const gp = join(dir, 'games.json')
const now = Date.now()
const id = () => crypto.randomUUID()

const games = [
  {
    dir: 'J:\\ggame\\Living With SIster Monochrome Fantasy',
    exePath: 'J:\\ggame\\Living With SIster Monochrome Fantasy\\Game.exe',
    rawTitle: 'Living With SIster Monochrome Fantasy',
    title: 'Living With SIster Monochrome Fantasy',
    id: id(),
    addedAt: now,
    playMs: 0,
    tags: [],
    categories: [],
    sources: [],
    favorite: false,
    useLE: false,
    useMagpie: false,
  },
  {
    dir: 'J:\\ggame\\妹相随1.4.5+DLC+fffmod1.6.0 步兵整合包小黑盒叮卜汉化（全部使用daseson上色）',
    exePath: 'J:\\ggame\\妹相随1.4.5+DLC+fffmod1.6.0 步兵整合包小黑盒叮卜汉化（全部使用daseson上色）\\GamePro.exe',
    rawTitle: '妹相随1.4.5+DLC+fffmod1.6.0 步兵整合包小黑盒叮卜汉化（全部使用daseson上色）',
    title: '妹相随（彩色）',
    id: id(),
    addedAt: now,
    playMs: 0,
    tags: [],
    categories: [],
    sources: [],
    favorite: false,
    useLE: false,
    useMagpie: false,
  },
  {
    dir: 'J:\\ggame\\妹相随1.4.5+DLC+fffmod1.6.0 步兵整合包小黑盒叮卜汉化（黑白版本！！！）',
    exePath: 'J:\\ggame\\妹相随1.4.5+DLC+fffmod1.6.0 步兵整合包小黑盒叮卜汉化（黑白版本！！！）\\GamePro.exe',
    rawTitle: '妹相随1.4.5+DLC+fffmod1.6.0 步兵整合包小黑盒叮卜汉化（黑白版本！！！）',
    title: '妹相随（黑白）',
    id: id(),
    addedAt: now,
    playMs: 0,
    tags: [],
    categories: [],
    sources: [],
    favorite: false,
    useLE: false,
    useMagpie: false,
  },
  {
    dir: "J:\\ggame\\Yog-Sothoth's Yard",
    exePath: "J:\\ggame\\Yog-Sothoth's Yard\\Yog-Sothoth's Yard\\Yog-Sothoth's Yard.exe",
    rawTitle: "Yog-Sothoth's Yard",
    title: "Yog-Sothoth's Yard",
    id: id(),
    addedAt: now,
    playMs: 0,
    tags: [],
    categories: [],
    sources: [],
    favorite: false,
    useLE: false,
    useMagpie: false,
  },
]

writeFileSync(gp, JSON.stringify(games, null, 2), 'utf8')
console.log('wrote', games.length, 'games to', gp)
