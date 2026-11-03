<script setup lang="ts">
import { computed, onMounted, onUnmounted, provide, ref } from 'vue'
import { App as AntApp, ConfigProvider } from 'ant-design-vue'
import zhCN from 'ant-design-vue/es/locale/zh_CN'
import { X, ChevronLeft, Plus, ScanSearch, Settings } from 'lucide-vue-next'
import { antdTheme } from './design/antdTheme'
import { filteredGames, library, selectedGame, thumbUrl } from './stores/library'
import { addTask, downloads, openSettings } from './stores/downloads'
import { ui } from './stores/ui'
import { t, tf } from './i18n'
import { useBoot } from './composables/useBoot'
import { useGlobalShortcuts, shortcutHelpOpen } from './composables/useGlobalShortcuts'
import CoverGrid from './components/CoverGrid.vue'
import HomeView from './components/HomeView.vue'
import DetailPanel from './components/DetailPanel.vue'
import ScanDialog from './components/ScanDialog.vue'
import AddGameDialog from './components/AddGameDialog.vue'
import ScrapeDialog from './components/ScrapeDialog.vue'
import NewDownloadDialog from './components/NewDownloadDialog.vue'
import SettingsDialog from './components/SettingsDialog.vue'
import BatchEditOverlay from './components/BatchEditOverlay.vue'
import EditDialog from './components/EditDialog.vue'

import SteamImportDialog from './components/SteamImportDialog.vue'
import BackupDialog from './components/BackupDialog.vue'
import FullscreenView from './components/FullscreenView.vue'
import DialogShell from './components/DialogShell.vue'
import NavSidebar from './components/NavSidebar.vue'
import LibraryToolbar from './components/LibraryToolbar.vue'
import ShortcutHelp from './components/ShortcutHelp.vue'
import GameContextMenu from './components/GameContextMenu.vue'
import PageHeader from './components/PageHeader.vue'
import ActivityFeed from './components/ActivityFeed.vue'
import { defineAsyncComponent } from 'vue'

// 非首屏页面按需加载：统计/收藏夹/下载/游戏站都只在切到那一页时才需要，
// 但它们的 antd Select/Modal/Popconfirm 静态打进首包，等于给首帧加解析负担。
// 三个页面都由 v-if 页签控制，异步组件天然安全（不改它们任何行为）。
const StatsView = defineAsyncComponent(() => import('./components/StatsView.vue'))
const CollectionView = defineAsyncComponent(() => import('./components/CollectionView.vue'))
const DownloadView = defineAsyncComponent(() => import('./components/DownloadView.vue'))
const GameSites = defineAsyncComponent(() => import('./components/GameSites.vue'))


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

// 首屏 KPI 在 HomeView（仪表盘页）：一块合并面板 + 主进程 computeOverview 口径。
// 库页不再挂 KPI——基准 home.png 的分工就是「数字在 Home，工具在 Library」，
// 我们此前把两页的东西全堆在库页一屏上，用户批评「首页特别杂」的根源。

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

/** 当前页：home | library | collection | downloads | games | stats */
const page = computed({
  get: () => ui.page,
  set: (v: 'home' | 'library' | 'downloads' | 'games' | 'stats' | 'collection') => (ui.page = v),
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
        <!-- 顶栏（对标基准 home.png 顶部）：返回箭头 + 圆头像 + 应用名 + BETA
             芯片 + 右侧圆形设置钮。版本号收进头像/芯片的 title，不放正文——
             基准顶栏没有版本号，这是「一模一样」与「信息可见」的折中。 -->
        <header class="titlebar">
          <button
            class="tb-icon no-drag"
            type="button"
            :title="t('nav_home')"
            :aria-label="t('nav_home')"
            @click="page = 'home'"
          >
            <ChevronLeft :size="16" />
          </button>
          <span class="tb-avatar no-drag" :title="bootInfo" aria-hidden="true">羽</span>
          <span class="tb-name no-drag">{{ t('app_logo') }}</span>
          <span class="tb-beta no-drag" :title="bootInfo">BETA</span>
          <div class="titlebar-right no-drag">
            <button
              class="tb-round"
              type="button"
              :title="t('app_prefs')"
              :aria-label="t('app_prefs')"
              @click="openSettings()"
            >
              <Settings :size="15" />
            </button>
          </div>
        </header>

        <div class="layout">
          <!-- 左侧导航（G17 拆出 NavSidebar：状态自取 store，只有全屏回调经 emit） -->
          <NavSidebar @enter-fullscreen="enterFullscreen" />

          <!-- 中栏 -->
          <main class="content">
            <!-- 页面切换：<Transition mode="out-in">让两页不并存——退场快淡出，
                 进场淡入 + 6px 上浮落位（曲线见 global.css .page-*）。
                 GameSites 必须留在 Transition 之外：它 v-if 挂载 + v-show 保活，
                 进了 Transition 就会被当成「每一页」反复挂载。 -->
            <Transition name="page" mode="out-in">
              <!-- 首页仪表盘（B8，对标基准 home.png）：合并 KPI 面板 + Continue 卡
                   + 随机游戏卡。浏览工具（搜索/筛选/封面墙）不在首页——那是库页的事 -->
              <HomeView v-if="page === 'home'" key="home" />

              <div v-else-if="page === 'library'" key="library" class="page-col">
                <!-- 页头（面包屑 + 大标题 + 右上主操作）：页面要有名字，
                     工具栏是工具不是导航——此前工具栏直接顶到标题栏下的问题在这里修 -->
                <PageHeader :crumbs="['nav_home', 'nav_library']" :title="'nav_library'">
                  <template #actions>
                    <button class="tool-btn labeled" type="button" @click="library.scanOpen = true">
                      <ScanSearch :size="14" />
                      <span>{{ t('lib_scan') }}</span>
                    </button>
                    <button class="tool-btn labeled" type="button" @click="ui.addGameOpen = true">
                      <Plus :size="14" />
                      <span>{{ t('lib_add_one') }}</span>
                    </button>
                  </template>
                </PageHeader>

                <!-- 工具栏（G17 拆出 LibraryToolbar：搜索/分类/智能列表/导出/视图） -->
                <LibraryToolbar
                  :filtered-count="filteredCount"
                  :export-menu-open="exportMenuOpen"
                  @toggle-export="exportMenuOpen = !exportMenuOpen"
                  @export="doExport"
                  @clear-meta="clearMeta()"
                />

                <div class="cover-wrap">
                  <CoverGrid
                    :games="filteredGames"
                    :view="library.view"
                    @select="library.selectedId = $event"
                  />
                  <BatchEditOverlay @done="library.selectMode = false" />
                </div>

                <div v-if="library.error" class="error-banner glass">
                  {{ library.error }}
                  <button class="glass-btn" :title="t('app_clear_error')" @click="library.error = ''">
                    <X :size="14" />
                  </button>
                </div>
              </div>

              <!-- 收藏夹浏览页（B6）：按开发商/系列分组的浏览，不是库内又一个筛选开关 -->
              <CollectionView v-else-if="page === 'collection'" key="collection" />
              <DownloadView v-else-if="page === 'downloads'" key="downloads" />
              <StatsView v-else-if="page === 'stats'" key="stats" />
            </Transition>

            <!-- 游戏站：v-if 首次进入才挂载，之后 v-show 保活（webview 的会话与已打开页面不销毁）。
                 不能放进上面的 v-else 分支：v-if/v-else-if/v-else 链会让整个分支在别的页卸载，
                 v-show 就没机会生效 —— 切走再切回，webview 会重新加载、搜索结果全丢。 -->
            <GameSites v-if="gamesMounted" v-show="page === 'games'" />
          </main>

          <!-- 右栏（基准布局）：home → Activity（home.png 右栏）；
               library → 选中游戏时详情面板、未选中时 Activity（B4：右栏永远有内容）。
               库页选中态是库页的语境，首页不沿用——首页刚进去就是动态流。

               详情⇄动态流用 <Transition name="aside"> 就地交接：新内容淡入右滑、
               旧内容淡出（离场铺满右栏宽，不并排两列，所以中栏宽度不跳）。
               这里**不**用 out-in——右栏不该出现 167ms 的空档，那看起来像闪了一下。
               收起态整栏宽度动画到 28px（.aside.collapsed）。 -->
          <aside
            v-if="page === 'home' || page === 'library'"
            class="aside"
            :class="{ collapsed: ui.detailCollapsed }"
          >
            <Transition name="aside">
              <DetailPanel
                v-if="page === 'library' && !ui.detailCollapsed && selectedGame"
                key="detail"
                class="detail"
                @collapse="ui.detailCollapsed = true"
              />
              <ActivityFeed
                v-else-if="page === 'home' && !ui.detailCollapsed"
                key="feed"
                class="detail"
              />
              <span v-else key="blank" class="aside-blank" aria-hidden="true" />
            </Transition>
            <button
              v-if="ui.detailCollapsed"
              class="detail-collapsed"
              :title="t('app_expand_detail')"
              :aria-label="t('app_expand_detail')"
              @click="ui.detailCollapsed = false"
            >
              <ChevronLeft :size="14" />
            </button>
          </aside>
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
  z-index: var(--hh-layer-bg);
  background-size: cover;
  background-position: center;
  filter: blur(120px) saturate(1.8);
  transform: scale(1.12);
  opacity: var(--hh-app-bg-op, 0.86);
  pointer-events: none;
}
.app-bg::after {
  content: '';
  position: absolute;
  inset: -12%;
  background: var(--hh-color-bg-scrim);
}
/* 浅色主题：动态封面底退成近静态浅底（对标基准 ReinaManager 的页面底色） */
:root[data-theme='light'] .app-bg {
  opacity: 0.3;
}
/* 标题栏与内容区抬到光晕底之上 */
.app-shell > .titlebar,
.app-shell > .layout {
  position: relative;
  z-index: var(--hh-layer-base);
}

/* 顶栏内容（对标基准 home.png 顶部：返回箭头/头像/名称/BETA 芯片/右侧圆钮）。
   容器 .titlebar 的 flex 排列来自 design/global.css，这里只管条目样式。 */
.tb-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  margin-right: var(--hh-space-x2);
  border: none;
  border-radius: var(--hh-radius-sm);
  background: transparent;
  color: var(--hh-color-text-mid-high);
  cursor: pointer;
  transition: background var(--hh-motion-med);
}
.tb-icon:hover {
  background: var(--hh-color-surface-soft);
  color: var(--hh-color-text-glow);
}
.tb-avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  margin-right: var(--hh-space-x2);
  border-radius: var(--hh-radius-pill);
  background: var(--hh-color-accent);
  color: var(--hh-color-on-accent);
  font-size: var(--hh-font-caption-size);
  font-weight: 700;
  flex: none;
}
.tb-name {
  font-weight: 700;
  font-size: var(--hh-font-bodyLg-size);
  letter-spacing: 0.3px;
  color: var(--hh-color-text-bright);
}
.tb-beta {
  margin-left: var(--hh-space-x2);
  padding: 1px 7px;
  border-radius: var(--hh-radius-pill);
  background: var(--hh-color-accent-soft);
  color: var(--hh-color-accent-text);
  font-size: var(--hh-font-caption-size);
  font-weight: 700;
  letter-spacing: 0.5px;
}
.titlebar-right {
  flex: 1;
  display: flex;
  justify-content: flex-end;
}
.tb-round {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: 1px solid var(--hh-color-float-border);
  border-radius: var(--hh-radius-pill);
  background: var(--hh-color-panel-glass);
  color: var(--hh-color-text-mid-high);
  cursor: pointer;
  transition: background var(--hh-motion-med);
}
.tb-round:hover {
  background: var(--hh-color-surface-hover);
  color: var(--hh-color-text-glow);
}

.layout {
  flex: 1;
  display: flex;
  gap: 6px;
  padding: 0 6px 12px;
  min-height: 0;
}

.content {
  flex: 1;
  /* 三列布局中 content 是唯一可收缩的列；给个保底下限，
     防止 flex 在极窄窗口把内容区压到 0 宽引发卡片横向溢出 */
  min-width: 220px;
  display: flex;
  flex-direction: column;
  gap: 12px;
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

/* 中栏一页（库页等复合页）：纵向排页头/工具栏/封面墙/错误浮层，
   flex:1 + min-height:0 让 .cover-wrap 的 flex:1 高度链在 Transition 包裹下仍闭合 */
.page-col {
  display: flex;
  flex-direction: column;
  gap: 12px;
  flex: 1;
  min-height: 0;
}

/* 右栏容器：宽度交给 token，收起态动画到 28px（.aside.collapsed）。
   width 的 transition 是「连贯」的一部分——收起时中栏是平滑让宽的。

   高度链的最后一环在 .aside > .detail：.detail 是 flex item，flex stretch
   给的高度不是 definite height——里头若写 height:100%（ActivityFeed 就是），
   百分比会塌成 auto，子项不收缩，.af-body 的 flex:1 抢不到剩余空间，
   overflow-y:auto 永远不滚（详情面板当初 32px banner 的同一条病根）。
   align-self:stretch 显式化 + min-height:0 允许收缩，环才闭合。 */
.aside {
  width: var(--hh-layout-detail-w);
  /* 右栏固定宽：ActivityFeed 根的 flex:1 会把 width 顶掉（flex-basis 0 + grow），
     实测 361 token 被撑成 557，主列被挤到 555。基准 home.png 主列 699 : 活动 395。
     flex:none 让 token 宽度真正生效，主列自动吃剩余。 */
  flex: none;
  position: relative;
  align-self: stretch;
  min-height: 0;
  display: flex;
  flex-direction: column;
  transition: width var(--hh-motion-slow) var(--hh-motion-ease-slide);
}
.aside.collapsed {
  width: 28px;
}
.aside > .detail {
  width: 100%;
  flex: 1;
  position: relative;
  min-height: 0;
}
/* 详情整页展开：这一条必须写在 App.vue 里，而不是在组件内加大特异性。
   .aside > .detail（含 scoped 属性 = 0,3,0）与组件内 .detail-panel.is-expanded
   （同为 0,3,0）打平，产物里 App 的样式排在组件样式之后——面板虽然拿到了
   position:fixed，又被宽高/定位拽回抽屉尺寸（实测 rect 400x748、
   computed position=relative）。在这里显式让位。 */
.aside > .detail.is-expanded {
  width: auto;
  flex: none;
  position: fixed;
}

/* 右栏空态占位（收起时 Transition 里的第三个分支）：占满宽度保持结构，
   不显示任何东西。 */
.aside-blank {
  display: block;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

/* 页头右侧主操作：图标 + 文字（基准 §0-8）。带文字才叫「主操作」，
   纯图标按钮是工具栏 toggle 的待遇，不是页面级动作。 */
.tool-btn.labeled {
  display: inline-flex;
  align-items: center;
  gap: var(--hh-space-x2);
  height: 32px;
  padding: 0 var(--hh-space-x3);
  border: 1px solid var(--hh-color-float-border);
  border-radius: var(--hh-radius-sm);
  background: var(--hh-color-card);
  color: var(--hh-color-text-bright);
  font-size: var(--hh-font-body-size);
  cursor: pointer;
  white-space: nowrap;
  transition:
    background var(--hh-motion-med),
    color var(--hh-motion-med);
}
.tool-btn.labeled:hover {
  background: var(--hh-color-surface-hover);
  color: var(--hh-color-text-glow);
}
.tool-btn.labeled:first-child {
  background: var(--hh-color-accent-bg);
  border-color: var(--hh-color-accent-focus-border);
  color: var(--hh-color-accent-text);
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
/* 收起态：aside 只有 28px 宽，横向 margin 会被挤出容器（28 + 16 > 28），
   归零只留纵向间距。 */
.aside.collapsed .detail-collapsed {
  margin: 8px 0;
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
  z-index: var(--hh-layer-notice);
}
</style>
