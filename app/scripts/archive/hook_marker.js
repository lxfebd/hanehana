// T18 验收用的挂接命令标记脚本：
// 把收到的 argv 原样写进 log 文件，让验收断言「挂接命令确实被跑、占位符替换正确、参数传对」。
// 用法：node hook.js <logPath> <arg1> <arg2> ...
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

const logPath = process.argv[2]
const args = process.argv.slice(3)
mkdirSync(dirname(logPath), { recursive: true })
writeFileSync(join(logPath), JSON.stringify({ args, cwd: process.cwd() }, null, 2), 'utf8')