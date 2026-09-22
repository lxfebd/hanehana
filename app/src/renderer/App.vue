<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { App as AntApp, ConfigProvider } from 'ant-design-vue'
import zhCN from 'ant-design-vue/es/locale/zh_CN'
import { appTheme } from './theme'

const dark = ref(true)
const bootInfo = ref('连接主进程…')
// 本地绑定版本号：直接在模板写 __APP_VERSION__ 会被编译成 _ctx.__APP_VERSION__，拿不到值。
const version = __APP_VERSION__

onMounted(async () => {
  try {
    if (!window.hh?.hello) {
      bootInfo.value = '主进程桥未就绪（浏览器预览模式）'
      return
    }
    const info = await window.hh.hello()
    bootInfo.value = `已连接 · ${info.name} v${info.version}`
  } catch (e) {
    bootInfo.value = `连接主进程失败：${e instanceof Error ? e.message : String(e)}`
  }
})
</script>

<template>
  <ConfigProvider :locale="zhCN" :theme="appTheme(dark)">
    <AntApp>
      <div class="app-shell">
        <!-- 自定义标题栏：整条可拖拽，按钮/图标区 no-drag -->
        <header class="titlebar">
          <span class="logo">羽花 HaneHana</span>
          <span class="no-drag tag">v{{ version }}</span>
        </header>

        <!-- 三栏布局：左侧导航 + 中栏索引 + 右侧内容区（业界最佳实践骨架） -->
        <div class="layout">
          <nav class="glass sidebar">
            <div class="nav-item active">游戏库</div>
            <div class="nav-item">下载</div>
            <div class="nav-item">统计</div>
            <div class="nav-item">设置</div>
          </nav>

          <main class="content">
            <section class="glass hero">
              <h1>欢迎来到羽花</h1>
              <p>galgame 管理器 · 封面墙 / 元数据刮削 / 下载 — 骨架已就绪</p>
              <p class="status">{{ bootInfo }}</p>
            </section>

            <section class="glass panel">
              <h2>项目里程碑</h2>
              <ul>
                <li>✅ Mica 毛玻璃窗口 + 自定义标题栏（Win11 22H2+）</li>
                <li>⏳ 封面墙游戏库 + 元数据刮削（VNDB / Bangumi）</li>
                <li>⏳ 扫描导入 / 分类 / 搜索</li>
                <li>⏳ Rust 下载引擎整合（复用 FastDrop）</li>
                <li>⏳ LE 转区 / Magpie 缩放 / 游玩时长统计</li>
              </ul>
            </section>
          </main>
        </div>
      </div>
    </AntApp>
  </ConfigProvider>
</template>

<style scoped>
.app-shell {
  height: 100%;
  display: flex;
  flex-direction: column;
  color: rgba(255, 255, 255, 0.88);
}

.logo {
  font-weight: 600;
  font-size: 14px;
  letter-spacing: 0.5px;
}
.tag {
  margin-left: 8px;
  font-size: 12px;
  opacity: 0.55;
}

.layout {
  flex: 1;
  display: flex;
  gap: 12px;
  padding: 0 12px 12px;
  min-height: 0;
}

.sidebar {
  width: 200px;
  padding: 12px;
  position: relative;
}
.nav-item {
  padding: 10px 12px;
  border-radius: 8px;
  margin-bottom: 4px;
  cursor: pointer;
  color: rgba(255, 255, 255, 0.65);
  transition: background 0.15s ease, color 0.15s ease;
}
.nav-item:hover {
  background: rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.88);
}
.nav-item.active {
  background: rgba(64, 150, 255, 0.18);
  color: #69b1ff;
}

.content {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow-y: auto;
  min-width: 0;
}

.hero {
  position: relative;
  padding: 28px 24px;
}
.hero h1 {
  margin: 0 0 8px;
  font-size: 24px;
}
.hero p {
  margin: 0 0 4px;
  color: rgba(255, 255, 255, 0.6);
}
.hero .status {
  margin-top: 12px;
  font-size: 12px;
  color: #69b1ff;
}

.panel {
  position: relative;
  padding: 20px 24px;
}
.panel h2 {
  margin: 0 0 12px;
  font-size: 16px;
}
.panel li {
  margin-bottom: 6px;
  color: rgba(255, 255, 255, 0.72);
}
</style>