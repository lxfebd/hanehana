/**
 * npm run dev / start 的启动封装（harness 环境专用修复）。
 *
 * 本机 shell 环境自带 ELECTRON_RUN_AS_NODE=1（DeepSeek Harness 本身是 Electron
 * 应用，子进程继承该变量）。这个变量会把 electron.exe 降级成纯 Node：
 *   - require('electron') 返回可执行文件路径而不是 API 对象 → app 未定义；
 *   - main 走 ESM 时报「electron does not provide an export named ...」。
 * 生产验证脚本一直是显式 delete 才没踩到（见各 verify_*.mjs 的
 * `delete env.ELECTRON_RUN_AS_NODE`）。dev 链路没人做这件事，于是
 * `npm run dev` 在 harness 的终端里必崩，在用户自己的终端里反而正常。
 *
 * 用法：node scripts/dev_app.mjs [preview]
 *   无参 = dev（默认）；preview = 生产预览。
 * 在 spawn 前清掉该变量，让 dev = 生产行为。代价为零：真的要以 node
 * 身份跑 electron 的链路，没有谁会走 npm run dev / start。
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const appRoot = fileURLToPath(new URL('..', import.meta.url))
const sub = process.argv[2] === 'preview' ? 'preview' : 'dev'

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

// 走 node_modules/.bin 的 CLI 入口，不依赖 PATH/npx（Windows 上 npx 是
// .cmd，spawn 非 shell 下 ENOENT）。
const cli = join(appRoot, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js')
const child = spawn(process.execPath, [cli, sub], {
  cwd: appRoot,
  env,
  stdio: 'inherit',
})

child.on('exit', (code) => process.exit(code ?? 0))
