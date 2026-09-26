/**
 * 扫描入库 IPC：目录扫描（GameScan）。
 */
import { ipcMain } from 'electron'
import { Ipc } from '../../shared/ipc'
import { handleScan } from '../games'
import { err, type IpcCtx } from './shared'

export function registerScanHandlers(_ctx: IpcCtx): void {
  ipcMain.handle(Ipc.GameScan, async (_e, root: unknown) => {
    if (typeof root !== 'string' || !root.trim() || root.length > 4000) {
      return err('请先选择要扫描的目录')
    }
    try {
      return await handleScan(root.trim())
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e))
    }
  })
}
