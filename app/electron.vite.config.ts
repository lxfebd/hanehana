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
    build: {
      rollupOptions: {
        output: {
          // 分包：单块 2.28MB 的 index 让首帧必须等整包解析完。按「变不变」切分——
          // vue/antd/图标/虚拟滚动都是版本锁死的第三方，业务代码改一行不应该让
          // 这几块全部失效重解析（Electron 从磁盘读，解析耗时才是启动大头）。
          manualChunks(id: string) {
            if (!id.includes('node_modules')) return undefined;
            if (id.includes('ant-design-vue') || id.includes('@ant-design')) return 'vendor-antd'
            if (id.includes('lucide-vue-next')) return 'vendor-icons'
            if (id.includes('vue-virtual-scroller') || id.includes('vue-observe-visibility') || id.includes('vue-resize')) return 'vendor-scroller'
            if (id.includes('/vue/') || id.includes('@vue/')) return 'vendor-vue'
            return 'vendor'
          },
        },
      },
    },
  },
})
