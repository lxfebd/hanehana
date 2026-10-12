/**
 * 主进程日志（log.ts）：console 的旁路落盘。
 *
 * 为什么做：主进程的 console.* 只进 stdout，打包后用户报障时
 * 没有任何日志可取。这里把主进程关键事件同步写进
 *   <userData>/logs/main-YYYYMMDD.log
 * 保留最近 7 天，单文件超 100MB 自动截断（从头扔一半，防无限膨胀）。
 *
 * 设计边界：
 * - 只服务主进程（依赖 electron app.getPath('userData')），渲染层不碰；
 * - 同步写 + 尽力而为：日志绝不影响主流程，写失败静默降级到 console；
 * - 不改任何调用方：log.ts 内部把 console 打补丁，业务代码的
 *   console.log/error 自动进文件，零迁移成本。
 */
import { app } from 'electron'
import { readdirSync, readFileSync, statSync, unlinkSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/** 保 7 天：早于这个时间的日志文件直接删。 */
const KEEP_DAYS = 7
/** 单文件上限：超过就把前半截扔掉（append 不可能从中间删，只能重写）。 */
const MAX_BYTES = 100 * 1024 * 1024

let logDir = ''
let logPath = ''
let logReady = false

function ensureLogFile(): string {
  if (logReady) return logPath
  try {
    logDir = join(app.getPath('userData'), 'logs')
    mkdirSync(logDir, { recursive: true })
    const d = new Date()
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
    logPath = join(logDir, `main-${stamp}.log`)
    pruneOldLogs()
    logReady = true
    return logPath
  } catch {
    return ''
  }
}

/** 删掉 KEEP_DAYS 天前的日志文件。 */
function pruneOldLogs(): void {
  try {
    const cutoff = Date.now() - KEEP_DAYS * 86400000
    for (const f of readdirSync(logDir)) {
      if (!/^main-\d{8}\.log$/.test(f)) continue
      try {
        if (statSync(join(logDir, f)).mtimeMs < cutoff) {
          unlinkSync(join(logDir, f))
        }
      } catch {
        /* stat 失败就当不存在 */
      }
    }
  } catch {
    /* 目录读不到就跳过 */
  }
}

/** 单文件超限时从头截断：读后半段写回。失败就放弃（日志不能影响主流程）。 */
function truncateIfOversize(): void {
  try {
    if (!logPath || !existsSync(logPath)) return
    if (statSync(logPath).size < MAX_BYTES) return
    const all = readFileSync(logPath, 'utf8')
    writeFileSync(logPath, all.slice(Math.max(0, all.length - MAX_BYTES / 2)), 'utf8')
  } catch {
    /* 截断失败不影响功能 */
  }
}

/** 写一行。同步 + 尽力而为：任何失败都静默。 */
function append(line: string): void {
  const p = ensureLogFile()
  if (!p) return
  try {
    truncateIfOversize()
    writeFileSync(p, line + '\n', { encoding: 'utf8', flag: 'a' })
  } catch {
    /* 写失败（磁盘满/权限）静默降级 */
  }
}

let patched = false

/**
 * 敏感值脱敏：console 全量旁路落盘后，任何未来新增的日志里夹带凭据都会
 * 明文进文件（并保留 7 天）。这里做轻量正则屏蔽，覆盖最常见的几类
 * （WebDAV 密码、通用 password、Authorization 头、proxy 串里的 user:pass@）。
 */
function redact(text: string): string {
  return (
    text
      // webdav_pass: "xxx" / webdav_pass=xxx
      .replace(/webdav_pass["']?\s*[:=]\s*["'][^"']*["']/gi, 'webdav_pass: "***"')
      // password: "xxx" / password=xxx / "password":"xxx"
      .replace(/("password"\s*:\s*")[^"]*(")/gi, '$1***$2')
      .replace(/password["']?\s*[:=]\s*["'][^"']*["']/gi, 'password: "***"')
      // Authorization: Basic xxx
      .replace(/authorization["']?\s*[:=]\s*["'][^"']*["']/gi, 'Authorization: "***"')
      // 代理串内嵌凭据 user:pass@host → user:***@host
      .replace(/(\/\/[^/\s:@]+:)[^@\s/]+@/g, '$1***@')
      .replace(/(https?:\/\/[^/\s:@]+:)[^@\s/]+@/g, '$1***@')
  )
}

/** 任意值 → 字符串：Error/对象尽量展开信息，避免「Error 记成 [object Object]」。 */
function safe(x: unknown): string {
  if (x instanceof Error) {
    return `${x.name}: ${x.message}${x.stack ? '\n' + x.stack : ''}`
  }
  if (x && typeof x === 'object') {
    try {
      return JSON.stringify(x)
    } catch {
      return String(x)
    }
  }
  return String(x)
}

const fmt = (a: unknown[]): string => a.map((x) => (typeof x === 'string' ? x : safe(x))).join(' ')

/** 安装 console 补丁。幂等，多调无害。 */
export function installMainLogger(): void {
  if (patched) return
  patched = true
  // 读取原 console.* 引用（no-console 把「读取」也算 console 使用；这里是
  // 保存原实现以便补丁后透传，属日志补丁本身的必要操作）。
  // eslint-disable-next-line no-console
  const origLog = console.log
  // error/warn 是规则放行的方法，无需 disable
  const origErr = console.error
  const origWarn = console.warn
  // eslint-disable-next-line no-console
  const origInfo = console.info
  // eslint-disable-next-line no-console
  const origDebug = console.debug
  const stamp = () => new Date().toISOString()
  // 重写 console.* 使日志统一落盘 + 脱敏；no-console 规则禁的是业务代码随手
  // console.log，这里是安装日志补丁本身，属于例外。
  // eslint-disable-next-line no-console
  console.log = (...a: unknown[]) => {
    origLog(...a)
    append(`[${stamp()}] INFO ${redact(fmt(a))}`)
  }
  // eslint-disable-next-line no-console
  console.info = (...a: unknown[]) => {
    origInfo?.(...a)
    append(`[${stamp()}] INFO ${redact(fmt(a))}`)
  }
  // eslint-disable-next-line no-console
  console.debug = (...a: unknown[]) => {
    origDebug?.(...a)
    append(`[${stamp()}] DEBUG ${redact(fmt(a))}`)
  }
  console.error = (...a: unknown[]) => {
    origErr(...a)
    append(`[${stamp()}] ERROR ${redact(fmt(a))}`)
  }
  console.warn = (...a: unknown[]) => {
    origWarn(...a)
    append(`[${stamp()}] WARN ${redact(fmt(a))}`)
  }
}
