/**
 * 存档备份 IPC：快照创建/列出/恢复/删除 + WebDAV 同步。通道名来自 Ipc，一字不改。
 */
import { ipcMain } from 'electron'
import { existsSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { Ipc } from '../../shared/ipc'
import { getGame, getGames } from '../gameStore'
import {
  createSnapshot,
  deleteSnapshot,
  gameBackupDir,
  listAllBackups,
  restoreSnapshot,
  rotateSnapshots,
  syncToCloud,
} from '../saves'
import { isId, err, type IpcCtx } from './shared'

/** 快照路径必须在该游戏的备份目录内（IPC 输入不可信：防任意路径恢复/删除） */
function validSnapshotDir(id: string, snapshotDir: unknown): snapshotDir is string {
  if (typeof snapshotDir !== 'string' || !snapshotDir) return false
  const root = gameBackupDir(id)
  const full = resolve(snapshotDir)
  const base = resolve(root)
  return full.startsWith(base + sep) && existsSync(full)
}

export function registerBackupHandlers(ctx: IpcCtx): void {
  const s = () => ctx.store()

  ipcMain.handle(Ipc.BackupsList, () => listAllBackups(getGames()))

  ipcMain.handle(Ipc.BackupCreate, (_e, id: unknown) => {
    if (!isId(id)) return err('游戏不存在')
    const g = getGame(id)
    if (!g) return err('游戏不在库中')
    const snap = createSnapshot(g)
    if (!snap) return err('游戏目录不存在，无法备份')
    rotateSnapshots(g.id, s().loadSettings().backup_keep)
    return snap
  })

  ipcMain.handle(Ipc.BackupRestore, (_e, id: unknown, snapshotDir: unknown) => {
    if (!isId(id)) return err('游戏不存在')
    const g = getGame(id)
    if (!g) return err('游戏不在库中')
    if (!validSnapshotDir(id, snapshotDir)) return err('快照路径无效')
    return restoreSnapshot(g, snapshotDir)
  })

  ipcMain.handle(Ipc.BackupDelete, (_e, id: unknown, snapshotDir: unknown) => {
    if (!isId(id)) return err('游戏不存在')
    if (!validSnapshotDir(id, snapshotDir)) return err('快照路径无效')
    return deleteSnapshot(id, snapshotDir) ? { ok: true as const } : err('删除快照失败')
  })

  ipcMain.handle(Ipc.BackupSync, async (_e, id: unknown, snapshotDir: unknown) => {
    if (!isId(id)) return err('游戏不存在')
    const g = getGame(id)
    if (!g) return err('游戏不在库中')
    if (!validSnapshotDir(id, snapshotDir)) return err('快照路径无效')
    const st = s().loadSettings()
    if (!st.webdav_url) return err('未配置 WebDAV 同步地址')
    return await syncToCloud(g, { url: st.webdav_url, user: st.webdav_user, pass: st.webdav_pass }, snapshotDir)
  })
}
