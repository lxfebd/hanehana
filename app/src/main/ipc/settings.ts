/**
 * 设置 / 引擎自检 / 自动更新 / 新作追踪 IPC。通道名来自 Ipc，一字不改。
 */
import { app, ipcMain } from 'electron'
import { Ipc } from '../../shared/ipc'
import type { Settings, TrackCheckResult } from '../../shared/types'
import { engineStatus } from '../engine'
import { normalizeSettings, dataDir, isPortable } from '../store'
import { applyChromiumProxy } from '../netConfig'
import { proxyFormatError } from '../../shared/proxy'
import { checkUpdate, installUpdate, updateEnabled } from '../updater'
import { addTrack, checkTracks, loadTracking, removeTrack } from '../tracking'
import { webdavUrlError } from '../saveRules'
import { err, type IpcCtx } from './shared'

export function registerSettingsHandlers(ctx: IpcCtx): void {
  const m = () => ctx.manager()
  const s = () => ctx.store()

  // 引擎自检结果搭 hello 一起下去：设置页靠它说明「下载为什么不可用、怎么修」。
  ipcMain.handle(Ipc.Hello, () => {
    const st = engineStatus()
    return {
      name: 'hanehana',
      version: app.getVersion(),
      engine_ok: st.ok,
      engine_path: st.path,
      engine_hint: st.hint,
      data_dir: dataDir(),
      portable: isPortable(),
    }
  })

  // 新作追踪（G16）
  ipcMain.handle(Ipc.TrackList, () => loadTracking())
  ipcMain.handle(Ipc.TrackAdd, (_e, keyword: unknown) => {
    if (typeof keyword !== 'string' || !keyword.trim() || keyword.trim().length > 200) {
      return { ok: false as const, error: '订阅词不能为空且不超过 200 字' }
    }
    return { ok: true as const, entry: addTrack(keyword) }
  })
  ipcMain.handle(Ipc.TrackRemove, (_e, id: unknown) => {
    if (typeof id !== 'string' || !id) return { ok: false as const, error: '订阅不存在' }
    return { ok: removeTrack(id) }
  })
  ipcMain.handle(Ipc.TrackCheck, async (): Promise<TrackCheckResult> => {
    const r = await checkTracks()
    ctx.notifyTrackFresh(r)
    return r
  })

  // 设置读取脱敏：webdav_pass 只在设置页回显时清空，免得任何能拿 IPC 的对象
  // 都能读到明文密码。渲染层密码框留空 = 不修改（SettingsSave 里空串保留原值），
  // 用户填了新密码才覆盖。proxy 原样回显：代理串是用户自己填的，编辑时需要看到
  // 完整值（含 user:pass@host 这类内嵌凭据），脱敏会让「清空代理」和「未修改」
  // 无法区分，反而更容易误清。
  ipcMain.handle(Ipc.SettingsGet, () => {
    const full = s().loadSettings()
    return { ...full, webdav_pass: '' }
  })
  ipcMain.handle(Ipc.SettingsSave, async (_e, next) => {
    const prev = s().loadSettings()
    const raw = (next && typeof next === 'object' ? next : {}) as Partial<Settings>
    // webdav_pass 是脱敏返回的（SettingsGet 永远给空串），渲染层密码框留空
    // 有两种可能：用户没改（保留原密码）/ 用户清空了（少见，密码不是必填）。
    // 按「空 = 不修改」处理：想清空密码可以直接清 webdav_user，密码留空
    // 只是不更新。真需要清时把 webdav_user 也清掉即可。
    if (typeof raw.webdav_pass === 'string' && raw.webdav_pass === '') {
      ;(raw as Record<string, unknown>).webdav_pass = prev.webdav_pass
    }
    // 必须喂 raw 而不是 next：上面的回填只在 raw 上生效，normalizeSettings
    // 拿 next 的话 webdav_pass 还是空串，密码照样被清掉。
    const saved = normalizeSettings(raw)
    if (saved.theme_mode !== 'system') {
      const modeChanged = typeof raw.theme_mode === 'string' && raw.theme_mode !== prev.theme_mode
      const darkChanged = typeof raw.dark === 'boolean' && raw.dark !== prev.dark
      if (modeChanged && !darkChanged) saved.dark = saved.theme_mode === 'dark'
      else if (darkChanged && !modeChanged) saved.theme_mode = saved.dark ? 'dark' : 'light'
      else saved.dark = saved.theme_mode === 'dark'
    }
    const bad = proxyFormatError(saved.proxy)
    if (bad) return err(bad)
    // WebDAV 地址协议闸：Basic 凭据明文，http:// 不允许（本机回环测试豁免）。
    // 在保存时就拒绝，避免用户配好后才在每次同步时报错。
    if (saved.webdav_url) {
      const wdErr = webdavUrlError(saved.webdav_url)
      if (wdErr) return err(wdErr)
    }
    try {
      await applyChromiumProxy(saved.proxy)
    } catch (e) {
      return err(`代理没能下发到内置浏览器与站点解析：${e instanceof Error ? e.message : String(e)}`)
    }
    s().saveSettings(saved)
    // 设置是用户显式保存动作，必须同步落盘：jsonStore 默认 400ms 合并写，而
    // TasksAdd 的 isDestAllowed 读的是磁盘里的 download_dir——保存后立刻下载
    // （点完保存马上开下载对话框）会读到旧值，被「保存路径不在允许的目录内」
    // 拒掉，观感就是「改了目录没用、下载用不了」。flush 让磁盘与内存同刻一致。
    s().flushSettings()
    m().applySettings(saved)
    const effDark = ctx.applyThemeMode(saved.theme_mode)
    ctx.applyThemeToWindow(effDark)
    if (saved.theme_mode === 'system' && saved.dark !== effDark) {
      s().saveSettings({ ...saved, dark: effDark })
      saved.dark = effDark
    }
    ctx.syncKeepAwake()
    const discarded: string[] = []
    for (const key of ['backup_dir', 'le_path', 'magpie_path'] as const) {
      const input = (raw as Record<string, unknown>)[key]
      const kept = saved[key]
      if (typeof input === 'string' && input.trim() && !kept) discarded.push(key)
    }
    return { ok: true as const, settings: saved, ...(discarded.length ? { discarded } : {}) }
  })

  // 自动更新：检查与安装都由用户界面发起
  ipcMain.handle(Ipc.UpdateCheck, async () => {
    const st = updateEnabled()
    if (!st) return { ok: false as const, error: '自动更新仅打包版可用（开发模式无发布源）' }
    void checkUpdate()
    return { ok: true as const }
  })

  ipcMain.handle(Ipc.UpdateInstall, () => {
    const st = updateEnabled()
    if (!st) return { ok: false as const, error: '自动更新仅打包版可用（开发模式无发布源）' }
    if (!installUpdate()) return { ok: false as const, error: '没有已下载的更新可安装' }
    return { ok: true as const }
  })
}
