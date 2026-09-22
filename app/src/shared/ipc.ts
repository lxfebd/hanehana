/**
 * IPC 通道名唯一真值。
 *
 * 主进程 ipcMain.handle(Ipc.Xxx) 与 preload contextBridge.exposeInMainWorld
 * 都用这里的字符串。两处各写一遍字符串是历史教训：改一边忘另一边，
 * 通道静默失效（handle 挂了而 preload 还在调旧名），界面表现为「点了没反应」。
 */
export const Ipc = {
  Hello: 'hanehana:hello',
} as const

export type IpcChannel = (typeof Ipc)[keyof typeof Ipc]