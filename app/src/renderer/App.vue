<script setup lang="ts">
import { computed, onMounted, onUnmounted, provide, ref } from 'vue'
import { App as AntApp, ConfigProvider } from 'ant-design-vue'
import zhCN from 'ant-design-vue/es/locale/zh_CN'
import { Flower2, X, ChevronLeft } from 'lucide-vue-next'
import { antdTheme } from './design/antdTheme'
import { filteredGames, library, selectedGame, thumbUrl } from './stores/library'
import { addTask, downloads } from './stores/downloads'
import { ui } from './stores/ui'
import { t, tf } from './i18n'
import { useBoot } from './composables/useBoot'
import { useGlobalShortcuts, shortcutHelpOpen } from './composables/useGlobalShortcuts'
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
import DialogShell from './components/DialogShell.vue'
import NavSidebar from './components/NavSidebar.vue'
import LibraryToolbar from './components/LibraryToolbar.vue'
import ShortcutHelp from './components/ShortcutHelp.vue'
import GameContextMenu from './components/GameContextMenu.vue'

// 启动编排（hello/刷新/订阅/窄窗口折叠/全屏控制）收在 useBoot 里，
// 组件只拿结果：bootInfo 标题栏版本号、全屏/保存回调、gamesMounted 保活开关。
const { bootInfo, enterFullscreen, exitFullscreen, saveSettings, gamesMounted } = useBoot()

// 全局快捷键（Ctrl+F/Esc/Ctrl+A/Delete/F5/1-3/Space）。挂在 App 级一次生效，
// 各页面通用；防误触规则见 useGlobalShortcuts 顶部注释。
useGlobalShortcuts()

// 封面右键菜单：实例放这里（App 级单例），经 provide 给 CoverGrid 调。
// 不放 CoverGrid 内部是因为菜单 Teleport 到 body，且虚拟化滚动时要能
// 从外部关掉它——单例 + provide 比「每个封面墙各持一个」简单。
const gameCtxMenu = ref<InstanceType<typeof GameContextMenu> | null>(null)
provide('gameCtxMenu', gameCtxMenu)

const filteredCount = computed(() => filteredGames.value.length)

/** 整窗动态底：自定义背景图 > 选中游戏封面（Steam 式）。无图时透明，露出系统 Mica。 */
function fileUrl(p: string): string {
  // 路径进 CSS url() 必须编码：空格/中文/#/& 直接拼进去会让浏览器按
  // URL 语法解析（# 后当 fragment、& 当参数、空格当分隔符），背景图就裂了。
  // encodeURI 保留 :// 与斜杠，只编空格和特殊字符；Windows 盘符的冒号
  // 也在保留集里，file:///C:/… 不会被改坏。
  return `url("file://${encodeURI(p.replace(/\\/g, '/'))}")`
}
const appBgImage = computed(() => {
  const custom = downloads.settings?.bg_image
  if (custom) return fileUrl(custom)
  const g = selectedGame.value
  if (!g) return ''
  if (g.thumbPath) return `url("${thumbUrl(g)}")`
  if (g.coverPath) return fileUrl(g.coverPath)
  return ''
})

/** 当前页：library | downloads | games */
const page = computed({
  get: () => ui.page,
  set: (v: 'library' | 'downloads' | 'games' | 'stats') => (ui.page = v),
})

/** 清元数据筛选（系列/开发商 chip 上的 ×）：两字段一起清 */
function clearMeta(): void {
  library.metaKey = ''
  library.metaValue = ''
}
const addSubmitKey = ref(0)

/** G14 导出菜单开关（工具栏箭头按钮下的小菜单：CSV / JSON） */
const exportMenuOpen = ref(false)

/** 点菜单外的任意处收起导出菜单（含切页/点工具栏其他按钮）。 */
function closeExportMenu(e: MouseEvent): void {
  const wrap = document.querySelector('.export-wrap')
  const target = e.target as Node
  if (exportMenuOpen.value && wrap && !wrap.contains(target)) exportMenuOpen.value = false
}
onMounted(() => document.addEventListener('click', closeExportMenu))
onUnmounted(() => document.removeEventListener('click', closeExportMenu))

/** G14 游戏库导出：调主进程弹保存对话框，成功后通知落盘位置 */
async function doExport(fmt: 'csv' | 'json'): Promise<void> {
  exportMenuOpen.value = false
  try {
    const r = await window.hh.exportGames(fmt)
    if (!r.ok) {
      library.error = r.error ?? t('app_export_failed')
      return
    }
    if (r.canceled) return
    library.error = tf('app_export_ok', { fmt: fmt.toUpperCase(), path: r.path ?? '' })
  } catch (e) {
    library.error = tf('app_export_err', { msg: e instanceof Error ? e.message : String(e) })
  }
}

async function submitAddTask(input: {
  url: string
  dest: string
  threads: number
  note: string
  checksum: string
}): Promise<void> {
  const ok = await addTask(input)
  if (ok) downloads.addDialogOpen = false
}
</script>

<template>
  <ConfigProvider :locale="zhCN" :theme="antdTheme">
    <AntApp>
      <div class="app-shell">
        <div class="app-bg" :style="{ backgroundImage: appBgImage }" aria-hidden="true"></div>
        <header class="titlebar">
          <span class="logo"><Flower2 :size="15" class="logo-ic" />{{ t('app_logo') }}</span>
          <span class="no-drag tag">{{ bootInfo }}</span>
          <div class="titlebar-right no-drag"></div>
        </header>

        <div class="layout">
          <!-- 左侧导航（G17 拆出 NavSidebar：状态自取 store，只有全屏回调经 emit） -->
          <NavSidebar @enter-fullscreen="enterFullscreen" />

          <!-- 中栏 -->
          <main class="content">
            <template v-if="page === 'library'">
              <!-- 工具栏（G17 拆出 LibraryToolbar：搜索/分类/智能列表/导出/视图） -->
              <LibraryToolbar
                :filtered-count="filteredCount"
                :export-menu-open="exportMenuOpen"
                @toggle-export="exportMenuOpen = !exportMenuOpen"
                @export="doExport"
                @clear-meta="clearMeta()"
              />

              <div class="cover-wrap">
                <CoverGrid :games="filteredGames" :view="library.view" @select="library.selectedId = $event" />
                <BatchEditOverlay @done="library.selectMode = false" />
              </div>

              <div v-if="library.error" class="error-banner glass">
                {{ library.error }}
                <button class="glass-btn" :title="t('app_clear_error')" @click="library.error = ''">
                  <X :size="14" />
                </button>
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
          <DetailPanel
            v-if="page === 'library' && !ui.detailCollapsed"
            class="detail"
            @collapse="ui.detailCollapsed = true"
          />
          <button
            v-if="page === 'library' && ui.detailCollapsed"
            class="detail-collapsed"
            :title="t('app_expand_detail')"
            :aria-label="t('app_expand_detail')"
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

        <!-- 快捷键帮助（? / F1 呼出）：放在最后，z-index 1000 压过一切内容 -->
        <ShortcutHelp v-model:open="shortcutHelpOpen" />

        <!-- 封面右键菜单（单例，Teleport 到 body；CoverGrid 经 inject 调 showAt） -->
        <GameContextMenu ref="gameCtxMenu" />

        <DialogShell v-model:open="downloads.addDialogOpen" :title="t('dl_new')" :width="540">
          <NewDownloadDialog
            v-if="downloads.settings"
            :key="addSubmitKey"
            :settings="downloads.settings"
            @submit="submitAddTask"
          />
        </DialogShell>

        <DialogShell v-model:open="ui.settingsOpen" :title="t('app_prefs')" :width="680">
          <SettingsDialog v-if="downloads.settings" :settings="downloads.settings" @save="saveSettings" />
        </DialogShell>
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

.logo {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 700;
  font-size: var(--hh-font-bodyLg-size);
  letter-spacing: 0.5px;
}
.logo-ic {
  color: var(--hh-color-accent);
  flex: none;
}
.tag {
  margin-left: 12px;
  font-size: var(--hh-font-caption-size);
  opacity: 0.55;
}
.titlebar-right {
  flex: 1;
}

.layout {
  flex: 1;
  display: flex;
  gap: 12px;
  padding: 0 12px 12px;
  min-height: 0;
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

.glass-btn {
  width: 36px;
  height: 36px;
  border-radius: var(--hh-radius-md);
  border: 1px solid var(--hh-color-float-border);
  background: var(--hh-color-panel-glass);
  color: var(--hh-color-text-bright);
  cursor: pointer;
  font-size: 15px;
  transition: all var(--hh-motion-med);
}
.glass-btn:hover {
  background: var(--hh-color-surface-strong);
  color: var(--hh-color-on-accent);
}
.glass-btn.active {
  background: var(--hh-color-select-bg);
  color: var(--hh-color-select-text);
}

.detail {
  width: 360px;
  position: relative;
}

.detail-collapsed {
  width: 28px;
  align-self: stretch;
  flex: none;
  border: 1px solid var(--hh-color-panel-glass-border);
  border-radius: var(--hh-radius-md);
  background: var(--hh-color-surface-soft);
  color: var(--hh-color-text-mid);
  cursor: pointer;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 12px;
  transition:
    background var(--hh-motion-med),
    color var(--hh-motion-med);
  margin: 8px;
}
.detail-collapsed:hover {
  background: var(--hh-color-surface-hover);
  color: var(--hh-color-text-glow);
}

.error-banner {
  position: absolute;
  bottom: 16px;
  left: 50%;
  transform: translateX(-50%);
  padding: 10px 16px;
  border-radius: var(--hh-radius-lg);
  font-size: var(--hh-font-body-size);
  color: var(--hh-color-error-soft-text);
  display: flex;
  gap: 10px;
  align-items: center;
  z-index: 20;
}
</style>
