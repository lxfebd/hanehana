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
 * Chrome 要拉起的那个可执行文件 = **宿主中继 exe**（fastdrop-nm-host）。
 *
 * 为什么不让 Chrome 直接拉起本应用（hanehana.exe）：
 *   1. Electron 在 Windows 启动时会往 stdout 写一个 "\r\n"（原生代码，拦不掉）。
 *      Chrome 把 stdout 首 4 字节当长度头，多这 2 个字节整条链路就错位——
 *      扩展那边表现为「通信错误 / 一直转圈」，而且极难定位。
 *   2. Chrome 只会把 origin 作为命令行第一个参数追加过来，而 Electron 会把
 *      第一个位置参数当成「要加载的应用路径」，直接拉起会报找不到应用。
 * 中继 exe 是纯 Rust 小程序：它把 origin 转成环境变量再拉起本应用，
 * 并把本应用的应答按 Chrome 协议重新封帧转发，自己的 stdout 天然干净。
 *
 * 位置：
 *   打包版 → resources/fastdrop-nm-host.exe（与 fastdrop-engine.exe 同级）
 *   开发态 → engine-rs/target/release/fastdrop-nm-host.exe
 *            （需要先 cargo build --release --locked）
 */
export function nmHostExecutable(): string {
  if (app.isPackaged) {
    const p = join(process.resourcesPath, 'fastdrop-nm-host.exe')
    return existsSync(p) ? p : ''
  }
  const repoRoot = join(app.getAppPath(), '..')
  const p = join(repoRoot, 'engine-rs', 'target', 'release', 'fastdrop-nm-host.exe')
  return existsSync(p) ? p : ''
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
      error: '找不到宿主中继程序（fastdrop-nm-host）：打包版需 npm run dist:dir，开发态需先在 engine-rs 跑 cargo build --release --locked',
    }
  }
  const dir = join(dataDir(), 'native-messaging')
  mkdirSync(dir, { recursive: true })
  const path = nmHostManifestPath()
  writeFileSync(path, JSON.stringify(nmHostManifest(), null, 2), 'utf8')
  return { ok: true, path }
}

/**
 * 幂等自愈：清单内容与「当下应该的样子」不一致就重写。
 *
 * 注册表里记的是注册那一刻的宿主中继 exe 路径。允许改安装目录、便携模式切换、
 * 升级后 resources/ 路径变化，都会让注册表指向一个不存在的 exe——用户侧症状
 * 正是 README 里最难自查的那行「找不到 HaneHana 宿主」。用户不可能知道要去
 * 重写清单，所以每次查状态（设置页打开/轮询）时顺手比一次：一个字符串读 +
 * 解析，内容真不同才写，没有额外磁盘压力。
 */
export function ensureNmManifest(): void {
  const path = nmHostManifestPath()
  if (!existsSync(path)) return
  try {
    const cur = readFileSync(path, 'utf8')
    if (cur === JSON.stringify(nmHostManifest(), null, 2)) return
    writeNmManifest()
  } catch {
    /* 读不了（占用中/权限）就重写一次兜底 */
    writeNmManifest()
  }
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
      // 两个视图的失败都要报：64 位写成功、32 位被安全软件锁了时，界面显示
      // 「注册成功」而 32 位浏览器实际不可用——那正是最难自查的一档。
      else {
        const why = r.stderr.trim() || '注册表写入失败'
        errors.push(
          view === '32'
            ? `${NM_BROWSER_LABELS[b]}：32 位视图写入失败（${why}），32 位浏览器可能不可用`
            : `${NM_BROWSER_LABELS[b]}：${why}`,
        )
      }
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
