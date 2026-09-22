/**
 * preload 桥。把主进程的 IPC 用 contextBridge 暴露成 window.hh 全局对象。
 *
 * 渲染进程沙箱开启（sandbox: true），preload 只能 require electron 的
 * contextBridge / ipcRenderer，不能碰 Node 内置模块。
 */
import { contextBridge, ipcRenderer } from 'electron'
import { Ipc } from '../shared/ipc'

const bridge = {
  hello: (): Promise<{ name: string; version: string }> =>
    ipcRenderer.invoke(Ipc.Hello),
}

contextBridge.exposeInMainWorld('hh', bridge)

export type HaneHanaBridge = typeof bridge