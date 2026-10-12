import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
const p = join(process.env.APPDATA || '', '.hanehana', 'games.json')
console.log(existsSync(p) ? p : 'not found: ' + p)
if (!existsSync(p)) process.exit(0)
const g = JSON.parse(readFileSync(p, 'utf8'))
console.log('count', g.length)
for (const x of g) console.log(x.title, '|', x.coverPath ? 'COVER' : 'NO_COVER', '|', x.exePath)
