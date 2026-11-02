/**
 * native messaging 宿主在 Windows 上的「注册」。
 *
 * Chrome 在 Windows 上不按固定路径找宿主清单，而是查注册表：
 *   HKCU\Software\Google\Chrome\NativeMessagingHosts\<宿主名>  的默认值 = 清单文件路径
 * Edge / Brave 各自有自己的一棵树。清单文件本身可以放任意位置，我们放在数据目录里
 * （和 tasks.json / settings.json 同级），这样卸载应用不会留下孤儿注册表项指向空文件。
 *
 * 为什么不写 HKLM：那是机器级，要管理员权限。HKCU 是用户级，零权限——
 * 用户装扩展、装应用都是自己给自己用，没必要为它要一次提权。
 *
 * 官方约束（Chrome 文档「Native messaging host location」）：
 *   - 清单字段只有 name / description / path / type / allowed_origins，没有 args
 *   - allowed_origins 不许通配符，只能写死扩展 origin
 *   - Chrome 先查 32 位注册表视图，再查 64 位视图
 *     → 两个视图都写一遍，32 位浏览器（少见但存在）也能用
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { NM_EXTENSION_ID, NM_HOST_NAME, type NmBrowserId } from '../shared/nmProtocol'
import { dataDir } from './store'

/** 支持注册的浏览器。键是内部标识，值是注册表路径。 */
export type { NmBrowserId }

const REG_ROOTS: Record<NmBrowserId, string> = {
  chrome: 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts',
  edge: 'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts',
  brave: 'HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts',
  chromium: 'HKCU\\Software\\Chromium\\NativeMessagingHosts',
}

export const NM_BROWSERS: NmBrowserId[] = ['chrome', 'edge', 'brave', 'chromium']

/** 浏览器在界面上的名字。 */
export const NM_BROWSER_LABELS: Record<NmBrowserId, string> = {
  chrome: 'Chrome',
  edge: 'Edge',
  brave: 'Brave',
  chromium: 'Chromium',
}

/** 宿主清单文件路径（放在数据目录，卸载应用时一并带走）。 */
export function nmHostManifestPath(): string {
  return join(dataDir(), 'native-messaging', `${NM_HOST_NAME}.json`)
}

/** 我们自己记的注册状态（哪些浏览器是我们写进去的）。 */
function nmStatePath(): string {
  return join(dataDir(), 'native-messaging', 'registered.json')
}

/**
 * 扩展目录：浏览器「加载已解压的扩展程序」时要选它。
 *
 * 打包后扩展在 resources/extension（electron-builder 的 extraResources），
 * 开发时在仓库的 app/extension。找不到就返回空串，界面据此提示。
 */
export function nmExtensionDir(): string {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'extension')]
    : [join(app.getAppPath(), 'extension'), join(app.getAppPath(), '..', 'extension')]
  for (const p of candidates) {
    if (existsSync(join(p, 'manifest.json'))) return p
  }
  return ''
}

/**
 * Chrome 要拉起的那个可执行文件。
 *
 * 必须是「装完就能双击的那个 exe」——宿主清单没有 args 字段，Chrome 只会在命令行
 * 后面追加 origin，没法把「先跑哪个应用目录」也传进去。所以开发态不能拿 electron.exe
 * 顶（它会去找应用目录而找不到），只能指向打出来的未安装版 exe。
 */
export function nmHostExecutable(): string {
  if (app.isPackaged) return process.execPath
  const outRoot = join(app.getAppPath(), 'release')
  const names = process.platform === 'win32' ? ['win-unpacked'] : ['linux-unpacked', 'mac']
  for (const dir of names) {
    for (const exe of ['hanehana.exe', 'hanehana', 'HaneHana.exe', 'HaneHana']) {
      const p = join(outRoot, dir, exe)
      if (existsSync(p)) return p
    }
  }
  return ''
}

/** 宿主清单内容。path 指向我们自己，allowed_origins 钉死扩展 ID。 */
export function nmHostManifest(): Record<string, unknown> {
  return {
    name: NM_HOST_NAME,
    description: 'HaneHana（羽花）下载链接投递',
    path: nmHostExecutable(),
    type: 'stdio',
    allowed_origins: [`chrome-extension://${NM_EXTENSION_ID}/`],
  }
}

function regExe(view: '64' | '32'): string {
  if (view === '64') return 'reg.exe'
  // 32 位视图要专门用 SysWOW64 里的 reg.exe 写，否则写进去的还是 64 位视图。
  const sysRoot = process.env.SystemRoot ?? 'C:\\Windows'
  return join(sysRoot, 'SysWOW64', 'reg.exe')
}

function runReg(exe: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    execFile(exe, args, { windowsHide: true, timeout: 8000 }, (err, _stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : err ? 1 : 0
      resolve({ code, stderr: String(stderr ?? '') })
    })
  })
}

function regKey(browser: NmBrowserId): string {
  return `${REG_ROOTS[browser]}\\${NM_HOST_NAME}`
}

function readState(): Record<string, boolean> {
  try {
    const raw = JSON.parse(readFileSync(nmStatePath(), 'utf8')) as unknown
    if (raw && typeof raw === 'object') return raw as Record<string, boolean>
  } catch {
    /* 没有或坏了：当作没注册过 */
  }
  return {}
}

function writeState(state: Record<string, boolean>): void {
  const dir = join(dataDir(), 'native-messaging')
  mkdirSync(dir, { recursive: true })
  writeFileSync(nmStatePath(), JSON.stringify(state, null, 2), 'utf8')
}

/** 写宿主清单文件。path 为空（找不到 exe）时直接失败，不写半截清单。 */
export function writeNmManifest(): { ok: boolean; path: string; error?: string } {
  const exe = nmHostExecutable()
  if (!exe) {
    return {
      ok: false,
      path: nmHostManifestPath(),
      error: '找不到可用的宿主程序：请先运行 npm run dist:dir 生成打包版（开发态无法直接用 electron.exe 当宿主）',
    }
  }
  const dir = join(dataDir(), 'native-messaging')
  mkdirSync(dir, { recursive: true })
  const path = nmHostManifestPath()
  writeFileSync(path, JSON.stringify(nmHostManifest(), null, 2), 'utf8')
  return { ok: true, path }
}

/**
 * 注册到指定浏览器。
 *
 * 两个视图都写：Chrome 先查 32 位再查 64 位，只写一个视图的话，
 * 换个位数的浏览器安装就「注册了却用不了」。
 */
export async function registerNmHost(
  browsers: NmBrowserId[],
): Promise<{ ok: boolean; installed: NmBrowserId[]; errors: string[] }> {
  const installed: NmBrowserId[] = []
  const errors: string[] = []
  const manifest = writeNmManifest()
  if (!manifest.ok) return { ok: false, installed, errors: [manifest.error ?? '写清单失败'] }

  for (const b of browsers) {
    const key = regKey(b)
    let done = false
    for (const view of ['64', '32'] as const) {
      const exe = regExe(view)
      if (view === '32' && !existsSync(exe)) continue
      const r = await runReg(exe, ['add', key, '/ve', '/t', 'REG_SZ', '/d', manifest.path, '/f'])
      if (r.code === 0) done = true
      else if (view === '64') errors.push(`${NM_BROWSER_LABELS[b]}：${r.stderr.trim() || '注册表写入失败'}`)
    }
    if (done) {
      installed.push(b)
      const state = readState()
      state[b] = true
      writeState(state)
    }
  }
  return { ok: installed.length > 0, installed, errors }
}

/** 注销（删注册表项）。清单文件保留：用户可能还要再注册回来。 */
export async function unregisterNmHost(
  browsers: NmBrowserId[],
): Promise<{ ok: boolean; removed: NmBrowserId[]; errors: string[] }> {
  const removed: NmBrowserId[] = []
  const errors: string[] = []
  for (const b of browsers) {
    const key = regKey(b)
    let done = false
    for (const view of ['64', '32'] as const) {
      const exe = regExe(view)
      if (view === '32' && !existsSync(exe)) continue
      const r = await runReg(exe, ['delete', key, '/f'])
      // 退出码 1 = 该键不存在，本来就是期望状态，算成功
      if (r.code === 0 || r.code === 1) done = true
    }
    if (done) {
      removed.push(b)
      const state = readState()
      state[b] = false
      writeState(state)
    } else {
      errors.push(`${NM_BROWSER_LABELS[b]}：注销失败`)
    }
  }
  return { ok: removed.length > 0, removed, errors }
}

/**
 * 当前注册情况。
 *
 * 判定用两个独立信号：注册表键**确实存在**（reg query 的退出码），
 * 以及我们自己的状态文件记着「是我们写的」。
 * 只看状态文件会把「用户手工删了注册表项」误报成已注册——那时用户点投递，
 * 浏览器直接报「找不到宿主」，而界面却说装好了，最伤信任。
 */
export async function nmHostRegistration(): Promise<Record<NmBrowserId, boolean>> {
  const state = readState()
  const out = {} as Record<NmBrowserId, boolean>
  for (const b of NM_BROWSERS) {
    let exists = false
    for (const view of ['64', '32'] as const) {
      const exe = regExe(view)
      if (view === '32' && !existsSync(exe)) continue
      const r = await runReg(exe, ['query', regKey(b)])
      if (r.code === 0) exists = true
    }
    out[b] = exists && state[b] === true
  }
  return out
}
