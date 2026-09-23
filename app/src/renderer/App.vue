<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { App as AntApp, ConfigProvider, Modal } from 'ant-design-vue'
import zhCN from 'ant-design-vue/es/locale/zh_CN'
import { Download, LayoutGrid, LibraryBig, List, ScanSearch, Search, Settings, X, ChevronLeft } from 'lucide-vue-next'
import { antdTheme } from './design/antdTheme'
import { categories, filteredGames, library, refreshGames } from './stores/library'
import { addTask, downloads, initTasks, openSettings, report, reportRejection } from './stores/downloads'
import { ui } from './stores/ui'
import CoverGrid from './components/CoverGrid.vue'
import DetailPanel from './components/DetailPanel.vue'
import ScanDialog from './components/ScanDialog.vue'
import ScrapeDialog from './components/ScrapeDialog.vue'
import DownloadView from './components/DownloadView.vue'
import NewDownloadDialog from './components/NewDownloadDialog.vue'
import SettingsDialog from './components/SettingsDialog.vue'

const bootInfo = ref('')
let unsubPushes: Array<() => void> = []

const filteredCount = computed(() => filteredGames.value.length)

/** 当前页：library | downloads */
const page = computed({
  get: () => ui.page,
  set: (v: 'library' | 'downloads') => (ui.page = v),
})
const addSubmitKey = ref(0)

/** 下载进行中数量（侧栏徽章） */
const runningCount = computed(
  () =>
    downloads.rows.filter(
      (r) => r.snap?.state === 'downloading' || r.snap?.state === 'preparing' || (!r.snap && r.def.state === 'downloading'),
    ).length,
)

async function submitAddTask(input: { url: string; dest: string; threads: number; note: string; checksum: string }): Promise<void> {
  const ok = await addTask(input)
  if (ok) downloads.addDialogOpen = false
}

async function saveSettings(s: unknown): Promise<void> {
  try {
    const r = await window.hh.saveSettings(s as never)
    if (!r.ok) {
      report(r as never)
      return
    }
    downloads.settings = r.settings
    ui.settingsOpen = false
  } catch (e) {
    reportRejection(e)
  }
}

onMounted(async () => {
  try {
    if (!window.hh?.hello) {
      bootInfo.value = '主进程桥未就绪（浏览器预览模式）'
      return
    }
    const info = await window.hh.hello()
    bootInfo.value = `${info.name} v${info.version}`
    await refreshGames()
    unsubPushes = await initTasks()
    library.error = ''
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e ?? '')
    bootInfo.value = `连接主进程失败：${msg.trim() || '主进程未响应'}`
  }
})

onUnmounted(() => {
  for (const unsub of unsubPushes) unsub()
})
</script>

<template>
  <ConfigProvider :locale="zhCN" :theme="antdTheme">
    <AntApp>
      <div class="app-shell">
        <header class="titlebar">
          <span class="logo">羽花 HaneHana</span>
          <span class="no-drag tag">{{ bootInfo }}</span>
          <div class="titlebar-right no-drag"></div>
        </header>

        <div class="layout">
          <!-- 左侧导航 -->
          <nav class="glass sidebar" aria-label="主导航">
            <button
              class="nav-item"
              :class="{ active: page === 'library' }"
              :aria-current="page === 'library' ? 'page' : undefined"
              @click="page = 'library'"
            >
              <LibraryBig :size="16" class="nav-ic" />
              <span>全部游戏</span>
              <span class="count">{{ library.games.length }}</span>
            </button>
            <button
              class="nav-item"
              :class="{ active: page === 'downloads' }"
              :aria-current="page === 'downloads' ? 'page' : undefined"
              @click="page = 'downloads'"
            >
              <Download :size="16" class="nav-ic" />
              <span>下载任务</span>
              <span class="count">{{ runningCount }}</span>
            </button>

            <div class="nav-spacer"></div>
            <button class="nav-item" @click="library.scanOpen = true">
              <ScanSearch :size="16" class="nav-ic" />
              <span>扫描导入</span>
            </button>
            <button class="nav-item" @click="openSettings()">
              <Settings :size="16" class="nav-ic" />
              <span>设置</span>
            </button>
          </nav>

          <!-- 中栏 -->
          <main class="content">
            <template v-if="page === 'library'">
              <!-- 工具栏：搜索 + 分类 chips + 计数 + 视图 segmented -->
              <div class="toolbar">
                <div class="search-box">
                  <Search :size="14" class="search-ic" />
                  <input
                    v-model="library.keyword"
                    class="search-input"
                    placeholder="搜索游戏 / 标签 / 原文名…"
                  />
                </div>

                <div class="cat-chips">
                  <button
                    class="cat-chip"
                    :class="{ active: library.categoryFilter === '' }"
                    @click="library.categoryFilter = ''"
                  >全部</button>
                  <button
                    v-for="c in categories"
                    :key="c"
                    class="cat-chip"
                    :class="{ active: library.categoryFilter === c }"
                    @click="library.categoryFilter = library.categoryFilter === c ? '' : c"
                  >{{ c }}</button>
                </div>

                <div class="toolbar-count">{{ filteredCount }} 款</div>

                <div class="segmented">
                  <button
                    class="seg-btn"
                    :class="{ active: library.view === 'grid' }"
                    title="网格视图"
                    @click="library.view = 'grid'"
                  ><LayoutGrid :size="16" /></button>
                  <button
                    class="seg-btn"
                    :class="{ active: library.view === 'list' }"
                    title="列表视图"
                    @click="library.view = 'list'"
                  ><List :size="16" /></button>
                </div>
              </div>

              <CoverGrid :games="filteredGames" :view="library.view" @select="library.selectedId = $event" />

              <div v-if="library.error" class="error-banner glass">
                {{ library.error }}
                <button class="glass-btn" title="清除错误" @click="library.error = ''"><X :size="14" /></button>
              </div>
            </template>

            <DownloadView v-else />
          </main>

          <!-- 右侧详情面板：只在游戏库页显示。收起时留竖条，点击展开 -->
          <DetailPanel v-if="page === 'library' && !ui.detailCollapsed" class="detail" @collapse="ui.detailCollapsed = true" />
          <button
            v-if="page === 'library' && ui.detailCollapsed"
            class="detail-collapsed"
            title="展开详情"
            :aria-label="'展开详情'"
            @click="ui.detailCollapsed = false"
          >
            <ChevronLeft :size="14" />
          </button>
        </div>

        <ScanDialog v-model:open="library.scanOpen" />
        <ScrapeDialog v-model:open="library.scrapeOpen" />

        <Modal
          v-model:open="downloads.addDialogOpen"
          :footer="null"
          :width="540"
          :destroy-on-close="true"
          title="新建下载"
        >
          <NewDownloadDialog
            v-if="downloads.settings"
            :key="addSubmitKey"
            :settings="downloads.settings"
            @submit="submitAddTask"
          />
        </Modal>

        <Modal
          v-model:open="ui.settingsOpen"
          :footer="null"
          :width="680"
          :destroy-on-close="true"
          title="偏好设置"
        >
          <SettingsDialog v-if="downloads.settings" :settings="downloads.settings" @save="saveSettings" />
        </Modal>
      </div>
    </AntApp>
  </ConfigProvider>
</template>

<style scoped>
.app-shell {
  height: 100%;
  display: flex;
  flex-direction: column;
  color: var(--hh-color-text-glow);
}

.logo { font-weight: 600; font-size: 14px; letter-spacing: 0.5px; }
.tag { margin-left: 12px; font-size: 12px; opacity: 0.55; }
.titlebar-right { flex: 1; }

.layout {
  flex: 1;
  display: flex;
  gap: 12px;
  padding: 0 12px 12px;
  min-height: 0;
}

.sidebar {
  width: 208px;
  padding: 12px;
  position: relative;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
}
.nav-item {
  display: flex;
  justify-content: flex-start;
  align-items: center;
  gap: 8px;
  height: 34px;
  padding: 0 10px;
  border-radius: 8px;
  margin-bottom: 2px;
  cursor: pointer;
  color: var(--hh-color-text-bright);
  transition: background 0.15s ease, color 0.15s ease;
  font-size: 13px;
  position: relative;
  /* button 重置：不加 border/背景，保持原玻璃观感 */
  border: none;
  background: transparent;
  text-align: left;
  width: 100%;
  font-family: inherit;
}
.nav-item .nav-ic { flex: none; opacity: 0.8; }
.nav-item:hover { background: var(--hh-color-surface-soft); color: var(--hh-color-text-glow); }
.nav-item.active { background: var(--hh-color-accent-bg); color: var(--hh-color-accent-text); }
.nav-item.active::before {
  content: '';
  position: absolute;
  left: 0; top: 6px; bottom: 6px;
  width: 2px;
  border-radius: 2px;
  background: var(--hh-color-accent);
}
.nav-item .count {
  margin-left: auto;
  font-size: 11px;
  background: var(--hh-color-surface-mid);
  padding: 1px 7px;
  border-radius: 10px;
  color: var(--hh-color-text-mid-high);
}
.nav-item.active .count { color: var(--hh-color-accent-text); }
.nav-spacer { flex: 1; }

.content {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

/* 工具栏：搜索 + 分类 chips + 计数 + segmented（§5.3） */
.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 4px 0;
  flex-wrap: wrap;
}
.search-box {
  position: relative;
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 180px;
  max-width: 320px;
}
.search-ic {
  position: absolute;
  left: 12px;
  color: var(--hh-color-text-dim);
  pointer-events: none;
}
.search-input {
  width: 100%;
  height: 32px;
  border-radius: 10px;
  padding: 0 12px 0 34px;
  border: 1px solid var(--hh-color-card-border);
  background: var(--hh-color-surface-bright);
  color: var(--hh-color-text-glow);
  font-size: 13px;
  outline: none;
  transition: border-color 0.2s, box-shadow 0.2s;
}
.search-input:focus {
  border-color: var(--hh-color-accent-focus-border);
  box-shadow: 0 0 0 3px var(--hh-color-accent-focus-ring);
}

/* 分类 chip 行：横向滚动无滚动条 */
.cat-chips {
  display: flex;
  align-items: center;
  gap: 6px;
  overflow-x: auto;
  scrollbar-width: none;
  min-width: 0;
  /* 容器充足时让猫 chips 吃掉剩余宽度；容器紧张时退回内容宽，
     把位置让给计数与视图切换，避免被 flex:1 压成一缕 28px。 */
  flex: 0 1 auto;
  max-width: 420px;
}
.cat-chips::-webkit-scrollbar { display: none; }
.cat-chip {
  flex-shrink: 0;
  height: 32px;
  padding: 0 12px;
  border-radius: 999px;
  border: 1px solid var(--hh-color-card-border);
  background: var(--hh-color-surface-bright);
  color: var(--hh-color-text-mid-high);
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}
.cat-chip:hover { background: var(--hh-color-surface-mid); color: var(--hh-color-text-glow); }
.cat-chip.active {
  background: var(--hh-color-accent-bg);
  border-color: var(--hh-color-accent-ring);
  color: var(--hh-color-accent-text);
}
.toolbar-count { font-size: 12px; color: var(--hh-color-text-tertiary); white-space: nowrap; }

/* 视图 segmented：pill 容器 card 底 */
.segmented {
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: 999px;
  background: var(--hh-color-surface-bright);
  border: 1px solid var(--hh-color-card-border);
}
.seg-btn {
  width: 32px; height: 32px;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: var(--hh-color-text-mid);
  cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: background 0.15s ease, color 0.15s ease;
}
.seg-btn:hover { background: var(--hh-color-surface-mid); color: var(--hh-color-text-glow); }
.seg-btn.active { background: var(--hh-color-accent-chip-bg); color: var(--hh-color-accent-text); }

.glass-btn {
  width: 36px; height: 36px;
  border-radius: 10px;
  border: 1px solid var(--hh-color-float-border);
  background: var(--hh-color-panel-glass);
  color: var(--hh-color-text-bright);
  cursor: pointer;
  font-size: 15px;
  transition: all 0.15s;
}
.glass-btn:hover { background: var(--hh-color-surface-strong); color: var(--hh-color-on-accent); }
.glass-btn.active { background: var(--hh-color-accent-chip-bg); color: var(--hh-color-accent-text); }

.detail { width: 360px; position: relative; }

.detail-collapsed {
  width: 28px;
  align-self: stretch;
  flex: none;
  border: 1px solid var(--hh-color-panel-glass-border);
  border-radius: 10px;
  background: var(--hh-color-surface-soft);
  color: var(--hh-color-text-mid);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s, color 0.15s;
  margin: 8px;
}
.detail-collapsed:hover {
  background: var(--hh-color-surface-hover);
  color: var(--hh-color-text-glow);
}

.error-banner {
  position: absolute;
  bottom: 16px; left: 50%;
  transform: translateX(-50%);
  padding: 10px 16px;
  border-radius: 12px;
  font-size: 13px;
  color: var(--hh-color-error-soft-text);
  display: flex; gap: 10px; align-items: center;
  z-index: 20;
}
</style>