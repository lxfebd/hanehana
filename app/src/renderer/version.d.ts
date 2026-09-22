/// <reference types="vite/client" />

declare global {
  /** 来自 app/package.json 的 version，由 electron.vite.config.ts 的 define 构建期注入 */
  const __APP_VERSION__: string
}

export {}
