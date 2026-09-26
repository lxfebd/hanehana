<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { App as AntApp, ConfigProvider, Modal, message } from 'ant-design-vue'
import zhCN from 'ant-design-vue/es/locale/zh_CN'
import { ArrowUpFromLine, Download, Flower2, LayoutGrid, LibraryBig, List, ScanSearch, Search, Settings, X, ChevronLeft, Compass, Heart, CheckSquare, BarChart3, Gamepad2, Maximize2, Plus } from 'lucide-vue-next'
import { antdTheme } from './design/antdTheme'
import { categories, enterSelectMode, filteredGames, library, refreshGames, selectedGame, SMART_LISTS, startRunningSync, stopRunningSync, thumbUrl } from './stores/library'
import { addTask, downloads, initTasks, openSettings, report, reportRejection } from './stores/downloads'
import { ui, applyDarkFromSettings } from './stores/ui'
import { setLanguage, t } from './i18n'
import CoverGrid from './components/CoverGrid.vue'
import DetailPanel from './components/DetailPanel.vue'
import ScanDialog from './components/ScanDialog.vue'
import AddGameDialog from './components/AddGameDialog.vue'
import ScrapeDialog from './components/ScrapeDialog.vue'
import DownloadView from './components/DownloadView.vue'
import NewDownloadDialog from './components/NewDownloadDialog.vue'
import SettingsDialog from './components/SettingsDialog.vue'
import GameSites from './components/GameSites.vue'
import BatchEditOverlay from './components/BatchEditOverlay.vue'
import EditDialog from './components/EditDialog.vue'
import StatsView from './components/StatsView.vue'
import SteamImportDialog from './components/SteamImportDialog.vue'
import BackupDialog from './components/BackupDialog.vue'
import FullscreenView from './components/FullscreenView.vue'

const bootInfo = ref('')
let unsubPushes: Array<() => void> = []

/** 全屏模式（G11）：进入用主进程切真全屏，Esc/系统手势退出同步回渲染层 */
async function enterFullscreen(): Promise<void> {
  ui.page = 'library'
  ui.detailCollapsed = true
  const on = await window.hh.fullscreenSet(true).catch(() => false)
  // 主进程 win.isFullScreen() 立即生效；推送兜底（某些平台 enter 延迟）
  ui.fullscreen = on || true
}
async function exitFullscreen(): Promise<void> {
  await window.hh.fullscreenSet(false).catch(() => {})
  ui.fullscreen = false
}
/** 窄窗口（<1100px）时详情面板宽度会把内容区挤没，自动收起 */
let narrowMq: MediaQueryList | null = null
let narrowMqFn: ((e: MediaQueryListEvent) => void) | null = null

const filteredCount = computed(() => filteredGames.value.length)

/** 整窗动态底：自定义背景图 > 选中游戏封面（Steam 式）。无图时透明，露出系统 Mica。 */
const appBgImage = computed(() => {
  const custom = downloads.settings?.bg_image
  if (custom) return `url("file://${custom.replace(/\\/g, '/')}")`
  const g = selectedGame.value
  if (!g) return ''
  if (g.thumbPath) return `url("${thumbUrl(g)}")`
  if (g.coverPath) return `url("file://${g.coverPath.replace(/\\/g, '/')}")`
  return ''
})

/** 当前页：library | downloads | games */
const page = computed({
  get: () => ui.page,
  set: (v: 'library' | 'downloads' | 'games') => (ui.page = v),
})
const addSubmitKey = ref(0)

/** G14 导出菜单开关（工具栏箭头按钮下的小菜单：CSV / JSON） */
const exportMenuOpen = ref(false)

/** 点菜单外的任意处收起导出菜单（含切页/点工具栏其他按钮）。 */
function closeExportMenu(e: MouseEvent): void {
  if (!exportMenuOpen.value) return
  const wrap = document.querySelector('.export-wrap')
  if (wrap && wrap.contains(e.target as Node)) return
  exportMenuOpen.value = false
}
onMounted(() => document.addEventListener('click', closeExportMenu))
onUnmounted(() => document.removeEventListener('click', closeExportMenu))

/** G14 游戏库导出：调主进程弹保存对话框，成功后通知落盘位置 */
async function doExport(fmt: 'csv' | 'json'): Promise<void> {
  exportMenuOpen.value = false
  try {
    const r = await window.hh.exportGames(fmt)
    if (!r.ok) {
      library.error = r.error ?? '导出失败'
      return
    }
    if (r.canceled) return
    library.error = `已导出 ${fmt.toUpperCase()} 到：${r.path ?? ''}`
  } catch (e) {
    library.error = '导出失败：' + (e instanceof Error ? e.message : String(e))
  }
}

/**
 * 游戏站视图挂载过一次就留着（webview 的 src 一挂载就去加载站点首页，
 * v-show 只藏不销毁：切走再切回来，搜索结果、已打开的页面和登录会话都得在）。
 * 模板里 v-if 首次进入才挂载，之后 v-show 保活。
 * watch immediate 是不把正确性押在「切到 games 一定发生在 App 挂载之后」这条时序上。
 */
const gamesMounted = ref(false)
watch(
  () => ui.page,
  (p) => {
    if (p === 'games') gamesMounted.value = true
  },
  { immediate: true },
)

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
    // 填了但没生效的路径：主进程按「不存在」丢弃回落到旧值，这里点名让用户知道
    if (r.discarded?.length) {
      const names: Record<string, string> = {
        backup_dir: '备份目录',
        le_path: 'Locale Emulator 路径',
        magpie_path: 'Magpie 路径',
      }
      message.warning(
        `${r.discarded.map((k) => names[k] ?? k).join('、')} 不存在，未保存。请检查路径后重试。`,
      )
    }
    // 深浅/套件主题设置落盘后的渲染层同步（system 模式主进程已按系统校正 dark）
    applyDarkFromSettings(r.settings.dark, r.settings.theme_preset)
    ui.settingsOpen = false
  } catch (e) {
    reportRejection(e)
  }
}

onMounted(async () => {
  // 运行中状态轮询：游戏退出后 runningIds 收敛（主进程 handleRunning 清僵尸）
  startRunningSync()
  try {
    if (!window.hh?.hello) {
      bootInfo.value = '主进程桥未就绪（浏览器预览模式）'
      return
    }
    const info = await window.hh.hello()
    bootInfo.value = `v${info.version}`
    await refreshGames()
    unsubPushes = await initTasks()
    library.error = ''
    // G18 i18n：从设置应用界面语言（骨架：zh/en）
    const s = await window.hh.getSettings()
    if (s?.language === 'en' || s?.language === 'zh') setLanguage(s.language)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e ?? '')
    bootInfo.value = `连接主进程失败：${msg.trim() || '主进程未响应'}`
  }

  // 跟随系统：主进程在系统深浅切换时推送，渲染层实时换肤
  if (window.hh?.onThemeChanged) {
    unsubPushes.push(
      window.hh.onThemeChanged(({ dark }) => {
        applyDarkFromSettings(dark, ui.preset)
      }),
    )
  }

  // 全屏状态同步：主进程 enter/leave 时校正渲染层状态
  if (window.hh?.onFullscreenChanged) {
    unsubPushes.push(
      window.hh.onFullscreenChanged((on) => {
        ui.fullscreen = on
        if (on) ui.detailCollapsed = true
      }),
    )
  }

  // 窄窗口自动收起详情面板：360px 详情 + 208px 侧栏会把内容区挤没
  if ('matchMedia' in window) {
    narrowMq = window.matchMedia('(max-width: 1100px)')
    narrowMqFn = (e: MediaQueryListEvent) => {
      if (e.matches) ui.detailCollapsed = true
    }
    if (narrowMq.matches) ui.detailCollapsed = true
    narrowMq.addEventListener('change', narrowMqFn)
  }
})

onUnmounted(() => {
  stopRunningSync()
  narrowMq?.removeEventListener('change', narrowMqFn as EventListener)
  narrowMq = null
  narrowMqFn = null
  for (const unsub of unsubPushes) unsub()
})
</script>

<template>
  <ConfigProvider :locale="zhCN" :theme="antdTheme">
    <AntApp>
      <div class="app-shell">
        <div class="app-bg" :style="{ backgroundImage: appBgImage }" aria-hidden="true"></div>
        <header class="titlebar">
          <span class="logo"><Flower2 :size="15" class="logo-ic" />羽花 HaneHana</span>
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
              <span>{{ t('nav_library') }}</span>
              <span class="count">{{ library.games.length }}</span>
            </button>
            <button
              class="nav-item"
              :class="{ active: page === 'downloads' }"
              :aria-current="page === 'downloads' ? 'page' : undefined"
              @click="page = 'downloads'"
            >
              <Download :size="16" class="nav-ic" />
              <span>{{ t('nav_downloads') }}</span>
              <span class="count">{{ runningCount }}</span>
            </button>
            <button
              class="nav-item"
              :class="{ active: page === 'games' }"
              :aria-current="page === 'games' ? 'page' : undefined"
              @click="page = 'games'"
            >
              <Compass :size="16" class="nav-ic" />
              <span>{{ t('nav_games') }}</span>
            </button>
            <button
              class="nav-item"
              :class="{ active: page === 'stats' }"
              :aria-current="page === 'stats' ? 'page' : undefined"
              @click="page = 'stats'"
            >
              <BarChart3 :size="16" class="nav-ic" />
              <span>{{ t('nav_stats') }}</span>
            </button>

            <div class="nav-spacer"></div>
            <button class="nav-item" @click="enterFullscreen()">
              <Maximize2 :size="16" class="nav-ic" />
              <span>{{ t('nav_fullscreen') }}</span>
            </button>
            <button class="nav-item" @click="library.scanOpen = true">
              <ScanSearch :size="16" class="nav-ic" />
              <span>{{ t('lib_scan') }}</span>
            </button>
            <button class="nav-item" @click="ui.addGameOpen = true">
              <Plus :size="16" class="nav-ic" />
              <span>{{ t('lib_add_one') }}</span>
            </button>
            <button class="nav-item" @click="ui.steamImportOpen = true">
              <Gamepad2 :size="16" class="nav-ic" />
              <span>{{ t('nav_steam_import') }}</span>
            </button>
            <button class="nav-item" @click="openSettings()">
              <Settings :size="16" class="nav-ic" />
              <span>{{ t('nav_settings') }}</span>
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
                    :placeholder="library.searchRegex ? t('toolbar_search_regex_placeholder') : t('toolbar_search_placeholder')"
                  />
                  <button
                    class="regex-toggle"
                    :class="{ on: library.searchRegex }"
                    :title="t('toolbar_regex')"
                    :aria-pressed="library.searchRegex"
                    @click="library.searchRegex = !library.searchRegex"
                  >.*</button>
                </div>

                <div class="cat-chips">
                  <button
                    class="cat-chip"
                    :class="{ active: library.categoryFilter === '' }"
                    @click="library.categoryFilter = ''"
                  >{{ t('toolbar_all') }}</button>
                  <button
                    v-for="c in categories"
                    :key="c"
                    class="cat-chip"
                    :class="{ active: library.categoryFilter === c }"
                    @click="library.categoryFilter = library.categoryFilter === c ? '' : c"
                  >{{ c }}</button>
                </div>

                <!-- 智能列表（动态筛选，Playnite 式） -->
                <select v-model="library.smartList" class="smart-select" :title="t('toolbar_smart')">
                  <option v-for="l in SMART_LISTS" :key="l.id" :value="l.id">{{ l.label }}</option>
                </select>

                <button
                  class="tool-btn"
                  :class="{ active: library.favOnly }"
                  :title="t('toolbar_fav')"
                  :aria-pressed="library.favOnly"
                  @click="library.favOnly = !library.favOnly"
                ><Heart :size="15" /></button>

                <button
                  class="tool-btn"
                  :class="{ active: library.selectMode }"
                  :title="t('toolbar_select')"
                  :aria-pressed="library.selectMode"
                  @click="enterSelectMode(!library.selectMode)"
                ><CheckSquare :size="15" /></button>

                <div class="toolbar-count">{{ filteredCount }} {{ t('count_suffix') }}</div>

                <!-- G14 导出：箭头按钮 + 小菜单（CSV / JSON） -->
                <div class="export-wrap">
                  <button
                    class="tool-btn"
                    :class="{ active: exportMenuOpen }"
                    :title="t('toolbar_export')"
                    :aria-pressed="exportMenuOpen"
                    @click="exportMenuOpen = !exportMenuOpen"
                  ><ArrowUpFromLine :size="15" /></button>
                  <div v-if="exportMenuOpen" class="export-menu glass" @click.stop>
                    <button class="export-item" @click="doExport('csv')">{{ t('toolbar_export_csv') }}</button>
                    <button class="export-item" @click="doExport('json')">{{ t('toolbar_export_json') }}</button>
                  </div>
                </div>
                <button v-if="library.metaKey" class="meta-chip" @click="library.metaKey = ''; library.metaValue = ''" :title="t('lib_clear')">
                  <X :size="12" /> {{ library.metaKey === 'series' ? '系列：' : '开发商：' }}{{ library.metaValue }}
                </button>

                <div class="segmented">
                  <button
                    class="seg-btn"
                    :class="{ active: library.view === 'grid' }"
                    :title="t('toolbar_grid')"
                    @click="library.view = 'grid'"
                  ><LayoutGrid :size="16" /></button>
                  <button
                    class="seg-btn"
                    :class="{ active: library.view === 'list' }"
                    :title="t('toolbar_list')"
                    @click="library.view = 'list'"
                  ><List :size="16" /></button>
                </div>
              </div>

              <div class="cover-wrap">
                <CoverGrid :games="filteredGames" :view="library.view" @select="library.selectedId = $event" />
                <BatchEditOverlay @done="library.selectMode = false" />
              </div>

              <div v-if="library.error" class="error-banner glass">
                {{ library.error }}
                <button class="glass-btn" title="清除错误" @click="library.error = ''"><X :size="14" /></button>
              </div>
            </template>

            <template v-else-if="page === 'downloads'">
              <DownloadView />
            </template>

            <template v-else-if="page === 'stats'">
              <StatsView />
            </template>

            <!-- 游戏站：v-if 首次进入才挂载，之后 v-show 保活（webview 的会话与已打开页面不销毁）。
                 不能放进上面的 v-else 分支：v-if/v-else-if/v-else 链会让整个分支在别的页卸载，
                 v-show 就没机会生效 —— 切走再切回，webview 会重新加载、搜索结果全丢。 -->
            <GameSites v-if="gamesMounted" v-show="page === 'games'" />
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
        <AddGameDialog v-model:open="ui.addGameOpen" />
        <ScrapeDialog v-model:open="library.scrapeOpen" />
        <EditDialog v-model:open="library.editOpen" />
        <SteamImportDialog v-model:open="ui.steamImportOpen" />
        <BackupDialog v-model:open="library.backupOpen" />

        <!-- 全屏模式：覆盖整个窗口，独立于普通布局 -->
        <FullscreenView v-if="ui.fullscreen" @exit="exitFullscreen" />

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
  position: relative;
  height: 100%;
  display: flex;
  flex-direction: column;
  color: var(--hh-color-text-glow);
}

/* 动态封面底：铺满 + 120px 模糊 + 提饱和，scale 收边防模糊晕白；
   ::after 主题遮罩拉回对比度，文字才立得住。无图时整层透明，露出系统 Mica。
   必须 fixed：absolute + scale 会撑破祖先 scrollWidth（溢出误报），fixed 不参与滚动区域。 */
.app-bg {
  position: fixed;
  inset: 0;
  z-index: 0;
  background-size: cover;
  background-position: center;
  filter: blur(120px) saturate(1.8);
  transform: scale(1.12);
  opacity: 0.86;
  pointer-events: none;
}
.app-bg::after {
  content: '';
  position: absolute;
  inset: -12%;
  background: var(--hh-color-bg-scrim);
}
/* 标题栏与内容区抬到光晕底之上 */
.app-shell > .titlebar,
.app-shell > .layout {
  position: relative;
  z-index: 1;
}

.logo { display: flex; align-items: center; gap: 6px; font-weight: 700; font-size: 14px; letter-spacing: 0.5px; }
.logo-ic { color: var(--hh-color-accent); flex: none; }
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
/* 选中态：白底胶囊 + 深色文字，图标随文字压暗。此前用 12% 白底 + 近白字，浅色主题下几乎看不见 */
.nav-item.active {
  background: var(--hh-color-select-bg);
  color: var(--hh-color-select-text);
  font-weight: 600;
}
.nav-item.active .nav-ic { opacity: 1; color: var(--hh-color-select-icon); }
/* 不再画左侧 2px 指示条：胶囊底色已表达选中，直线条压在圆角上反而读成脱出的杂线 */
.nav-item .count {
  margin-left: auto;
  font-size: 11px;
  background: var(--hh-color-surface-mid);
  padding: 1px 7px;
  border-radius: 10px;
  color: var(--hh-color-text-mid-high);
}
.nav-item.active .count {
  background: var(--hh-color-select-bg);
  color: var(--hh-color-select-text);
  opacity: 0.75;
}
.nav-spacer { flex: 1; }

/* 极窄窗口：侧栏收成图标条（≤620px 时三列预算 208+12+12 也让内容区所剩无几）。
   放在 .sidebar/.nav-item 定义之后，才能覆盖前面的 width:208px。 */
@media (max-width: 620px) {
  .sidebar { width: 56px; padding: 12px 8px; align-items: center; }
  .nav-item { justify-content: center; padding: 0 6px; gap: 0; }
  .nav-item span { display: none; }
  .nav-item .count { display: flex; position: absolute; top: 3px; right: 2px; margin: 0; min-width: 16px; height: 16px; padding: 0 4px; align-items: center; justify-content: center; font-size: 9px; }
}

.content {
  flex: 1;
  /* 三列布局中 content 是唯一可收缩的列；给个保底下限，
     防止 flex 在极窄窗口把内容区压到 0 宽引发卡片横向溢出 */
  min-width: 220px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
  overflow: hidden;
}

/* 封面墙容器：相对定位承载批量编辑浮层（浮层 absolute 贴底） */
.cover-wrap {
  flex: 1;
  position: relative;
  min-height: 0;
}

/* 工具栏：搜索 + 分类 chips + 计数 + segmented（§5.3）。
   整条工具条收进一个卡片容器，与左右玻璃面板同层级——此前元素裸浮在玻璃上，
   与两侧面板断层，是"粗糙感"的主要来源之一。 */
.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  flex-wrap: wrap;
  border-radius: var(--hh-radius-md);
  border: 1px solid var(--hh-color-card-border);
  background: var(--hh-color-surface-bright);
  backdrop-filter: blur(12px) saturate(1.3);
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
  padding: 0 42px 0 34px;
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
/* G19 正则切换按钮：贴在输入框右侧（.* 符号） */
.regex-toggle {
  position: absolute;
  right: 6px;
  height: 22px;
  min-width: 30px;
  padding: 0 6px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--hh-color-text-dim);
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.regex-toggle:hover {
  background: var(--hh-color-surface-hover);
  color: var(--hh-color-text-bright);
}
.regex-toggle.on {
  background: var(--hh-color-accent-bg);
  color: var(--hh-color-accent);
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
  background: var(--hh-color-select-bg);
  border-color: var(--hh-color-accent-ring);
  color: var(--hh-color-select-text);
  font-weight: 600;
}
.toolbar-count { font-size: 12px; color: var(--hh-color-text-tertiary); white-space: nowrap; }

/* 智能列表下拉 + 收藏/多选工具按钮（与 seg-btn 同口径） */
.smart-select {
  height: 32px;
  border-radius: 10px;
  padding: 0 10px;
  border: 1px solid var(--hh-color-card-border);
  background: var(--hh-color-surface-bright);
  color: var(--hh-color-text-glow);
  font-size: 12.5px;
  cursor: pointer;
  outline: none;
  font-family: inherit;
}
.smart-select:focus {
  border-color: var(--hh-color-accent-focus-border);
  box-shadow: 0 0 0 3px var(--hh-color-accent-focus-ring);
}
.tool-btn {
  width: 32px; height: 32px;
  border: none;
  border-radius: 10px;
  background: transparent;
  color: var(--hh-color-text-mid);
  cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: background 0.15s ease, color 0.15s ease;
}
.tool-btn:hover { background: var(--hh-color-surface-mid); color: var(--hh-color-text-glow); }
.tool-btn.active {
  background: var(--hh-color-select-bg);
  color: var(--hh-color-select-text);
}

/* G14 导出：小菜单浮在按钮正下方（玻璃材质复用全局 .glass） */
.export-wrap {
  position: relative;
  display: flex;
  align-items: center;
}
.export-menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 30;
  min-width: 132px;
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.export-item {
  display: flex;
  align-items: center;
  height: 30px;
  padding: 0 10px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--hh-color-text-bright);
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
  transition: background 0.15s ease;
  text-align: left;
}
.export-item:hover { background: var(--hh-color-surface-mid); }

/* 元数据聚合筛选提示条（G12）：激活时显示，一键清除 */
.meta-chip {
  display: flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  padding: 0 10px;
  border-radius: 999px;
  border: 1px solid var(--hh-color-accent-ring);
  background: var(--hh-color-accent-soft);
  color: var(--hh-color-accent-text);
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.15s;
}
.meta-chip:hover { background: var(--hh-color-accent-chip-bg); }

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
.seg-btn.active {
  background: var(--hh-color-select-bg);
  color: var(--hh-color-select-text);
}

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
.glass-btn.active {
  background: var(--hh-color-select-bg);
  color: var(--hh-color-select-text);
}

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
  align-items: flex-start;
  justify-content: center;
  padding-top: 12px;
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