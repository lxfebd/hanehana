import { fileURLToPath, URL } from 'node:url'
import { readFileSync } from 'node:fs'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

// 版本号只有一个真值：package.json。构建期读出来注入，渲染层直接用，
// 不会漂移成「package.json 是 0.1.0、界面显示 1.0.0」这种硬编码。
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

export default defineConfig({
  main: {},
  preload: {
    // 必须输出 CJS。渲染进程开了 sandbox，沙箱化的 preload 根本不支持 ESM
    // import（见 Electron ESM 文档），一旦打出 .mjs 就是启动即崩。
    build: {
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
      },
    },
  },
  renderer: {
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
    },
    plugins: [vue()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
  },
})
