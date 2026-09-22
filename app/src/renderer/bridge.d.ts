import type { HaneHanaBridge } from '../preload'

declare global {
  interface Window {
    hh: HaneHanaBridge
  }
}

export {}
