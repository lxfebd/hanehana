<script setup lang="ts">
/**
 * 左侧导航栏 + 「更多」收纳菜单（从 App.vue 拆出，G17 大文件拆分）。
 *
 * 只渲染 <nav>（DOM 结构保持原样：header.titlebar 与 .layout 骨架仍在 App.vue，
 * 本组件插在 .layout 的第一个子槽位）。状态自取 store（ui/library/downloads），
 * 不设 props；与 App 的唯一通信是 enterFullscreen（需要 window.hh，留在 App）。
 * 「更多」菜单自持开关。模板只写单方法调用（prettier 会拆多语句表达式）。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import {
  BarChart3,
  Compass,
  Download,
  Gamepad2,
  Heart,
  House,
  LibraryBig,
  Maximize2,
  MoreHorizontal,
  Plus,
  ScanSearch,
  Settings,
} from 'lucide-vue-next'
import { library } from '../stores/library'
import { downloads, openSettings } from '../stores/downloads'
import { ui } from '../stores/ui'
import { t } from '../i18n'

const emit = defineEmits<{
  'enter-fullscreen': []
}>()

/** 侧栏 badge：下载页显示进行中数量（与 App 原逻辑一致） */
const runningCount = computed(
  () =>
    downloads.rows.filter(
      (r) =>
        r.snap?.state === 'downloading' || r.snap?.state === 'preparing' || (!r.snap && r.def.state === 'downloading'),
    ).length,
)

/** 收藏数（侧栏 badge） */
const favCount = computed(() => library.games.filter((g) => g.favorite).length)

/** 「更多」菜单开关 */
const moreMenuOpen = ref(false)

/** 点菜单外任意处收起「更多」菜单 */
function closeMore(e: MouseEvent): void {
  const more = document.querySelector('.more-wrap')
  const target = e.target as Node
  if (moreMenuOpen.value && more && !more.contains(target)) moreMenuOpen.value = false
}
onMounted(() => document.addEventListener('click', closeMore))
onUnmounted(() => document.removeEventListener('click', closeMore))

/** 切页 + 顺手收起菜单（单方法调用） */
function goPage(p: 'home' | 'library' | 'downloads' | 'games' | 'stats' | 'collection'): void {
  ui.page = p
  moreMenuOpen.value = false
}

/**
 * 收藏夹入口：切到收藏夹**浏览页**（按开发商/系列分组的卡片墙），
 * 不再是「库页 + favOnly 筛选」。
 *
 * 为什么换：筛选只是把库过滤一下，用户看不到「我有多少收藏、按什么
 * 归类」——基准 ReinaManager 的 Collection 是一个真正的浏览页（组卡 +
 * 计数），那才是收藏夹该有的形态。库里想纯看收藏仍然有心形 toggle。
 */
function goFavorites(): void {
  goPage('collection')
}

/** 「更多」菜单动作：先执行再收起菜单 */
function moreAction(fn: () => void): void {
  fn()
  moreMenuOpen.value = false
}
</script>

<template>
  <nav class="glass sidebar" :aria-label="t('app_nav_aria')">
    <!-- 首页仪表盘（B8，对标基准 Home）：KPI/Continue/Random/Activity。
         基准的导航顺序就是 Home 在 Library 前面——仪表盘先行、浏览其次。 -->
    <button
      class="nav-item"
      :class="{ active: ui.page === 'home' }"
      :aria-current="ui.page === 'home' ? 'page' : undefined"
      @click="goPage('home')"
    >
      <House :size="16" class="nav-ic" />
      <span>{{ t('nav_home') }}</span>
    </button>
    <button
      class="nav-item"
      :class="{ active: ui.page === 'library' }"
      :aria-current="ui.page === 'library' ? 'page' : undefined"
      @click="goPage('library')"
    >
      <LibraryBig :size="16" class="nav-ic" />
      <span>{{ t('nav_library') }}</span>
      <span class="count">{{ library.games.length }}</span>
    </button>
    <!-- 收藏夹入口：按开发商/系列分组的浏览页（CollectionView），
         计数 = 收藏数。库内纯收藏筛选仍在工具栏心形 toggle。 -->
    <button
      class="nav-item"
      :class="{ active: ui.page === 'collection' }"
      :aria-current="ui.page === 'collection' ? 'page' : undefined"
      @click="goFavorites"
    >
      <Heart :size="16" class="nav-ic" />
      <span>{{ t('nav_favorites') }}</span>
      <span class="count">{{ favCount }}</span>
    </button>
    <button
      class="nav-item"
      :class="{ active: ui.page === 'downloads' }"
      :aria-current="ui.page === 'downloads' ? 'page' : undefined"
      @click="goPage('downloads')"
    >
      <Download :size="16" class="nav-ic" />
      <span>{{ t('nav_downloads') }}</span>
      <span class="count">{{ runningCount }}</span>
    </button>

    <div class="nav-spacer"></div>
    <button class="nav-item" @click="library.scanOpen = true">
      <ScanSearch :size="16" class="nav-ic" />
      <span>{{ t('lib_scan') }}</span>
    </button>
    <button class="nav-item" @click="openSettings()">
      <Settings :size="16" class="nav-ic" />
      <span>{{ t('nav_settings') }}</span>
    </button>

    <!-- P1-4 更多：游戏站/统计/全屏/添加/Steam 收纳，只收不删 -->
    <div class="more-wrap">
      <button
        class="nav-item more-toggle"
        :class="{ active: moreMenuOpen || ui.page === 'stats' }"
        :aria-expanded="moreMenuOpen"
        @click="moreMenuOpen = !moreMenuOpen"
      >
        <MoreHorizontal :size="16" class="nav-ic" />
        <span>{{ t('nav_more') }}</span>
      </button>
      <div v-if="moreMenuOpen" class="more-menu glass">
        <button class="nav-item" :class="{ active: ui.page === 'games' }" @click="goPage('games')">
          <Compass :size="16" class="nav-ic" />
          <span>{{ t('nav_games') }}</span>
        </button>
        <button class="nav-item" :class="{ active: ui.page === 'stats' }" @click="goPage('stats')">
          <BarChart3 :size="16" class="nav-ic" />
          <span>{{ t('nav_stats') }}</span>
        </button>
        <button class="nav-item" @click="moreAction(() => emit('enter-fullscreen'))">
          <Maximize2 :size="16" class="nav-ic" />
          <span>{{ t('nav_fullscreen') }}</span>
        </button>
        <button class="nav-item" @click="moreAction(() => (ui.addGameOpen = true))">
          <Plus :size="16" class="nav-ic" />
          <span>{{ t('lib_add_one') }}</span>
        </button>
        <button class="nav-item" @click="moreAction(() => (ui.steamImportOpen = true))">
          <Gamepad2 :size="16" class="nav-ic" />
          <span>{{ t('nav_steam_import') }}</span>
        </button>
      </div>
    </div>

    <!-- 基准 home.png 左下角的作者署名（© huoshen80）。位置在侧栏最底部。 -->
    <p class="nav-copy">© huoshen80</p>
  </nav>
</template>

<style scoped>
/* ============ 侧栏 ============ */
.sidebar {
  /* 144px：图标 + 中文标签同排不换行（原 108px 下「全部游戏」会被挤到
     图标下一行，侧栏看起来成了竖排——基准 home.png 是横排条目）。
     窄窗 ≤620px 仍收成 56px 图标条，见文件末尾媒体查询。 */
  width: 144px;
  padding: 10px 8px;
  position: relative;
  /* .glass 的 backdrop-filter 会建立层叠上下文且 z-index 仍为 auto，
     内容区里后绘制的封面（position:absolute 行项）会盖住悬出的 .more-menu。
     抬到 2：压过内容区 z-index:auto 的定位子树，仍低于弹层 30/40。 */
  z-index: 2;
  display: flex;
  flex-direction: column;
  /* 不设 overflow-y:auto：overflow-x 会被算成 auto，把 .more-menu 伸出侧栏
     右侧的浮层裁掉（「更多」入口点不到）。侧栏条目少，竖向本就不需要滚。 */
  overflow: visible;
}
.nav-item {
  display: flex;
  justify-content: flex-start;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 8px;
  border-radius: var(--hh-radius-sm);
  margin-bottom: 2px;
  cursor: pointer;
  color: var(--hh-color-text-bright);
  transition:
    background var(--hh-motion-med) ease,
    color var(--hh-motion-med) ease;
  font-size: var(--hh-font-body-size);
  position: relative;
  /* button 重置：不加 border/背景，保持原玻璃观感 */
  border: none;
  background: transparent;
  text-align: left;
  width: 100%;
  font-family: inherit;
}
.nav-item .nav-ic {
  flex: none;
  opacity: 0.8;
}
.nav-item:hover {
  background: var(--hh-color-surface-soft);
  color: var(--hh-color-text-glow);
}
/* 选中态：低透明 accent 底 + accent 亮字 + 左侧 2px 亮线指示当前位置。
   不用 accent 实色铺满——高饱和粉大面积填充显廉价（"AI 味"），
   粉色只留在图标与指示线上。 */
.nav-item.active {
  background: var(--hh-color-select-bg);
  color: var(--hh-color-select-text);
  font-weight: 600;
}
.nav-item.active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  width: 2px;
  height: 18px;
  border-radius: var(--hh-radius-pill);
  background: var(--hh-color-accent);
}
.nav-item.active .nav-ic {
  opacity: 1;
  color: var(--hh-color-select-icon);
}
.nav-item .count {
  margin-left: auto;
  font-size: 11px;
  background: var(--hh-color-surface-mid);
  padding: 1px 7px;
  border-radius: var(--hh-radius-md);
  color: var(--hh-color-text-mid-high);
}
.nav-item.active .count {
  background: var(--hh-color-select-bg);
  color: var(--hh-color-select-text);
  opacity: 0.75;
}
.nav-spacer {
  flex: 1;
}

/* 侧栏底部署名（基准 left-bottom © huoshen80） */
.nav-copy {
  margin: var(--hh-space-x2) 0 0;
  text-align: center;
  font-size: 10px;
  color: var(--hh-color-text-dim);
  user-select: none;
  flex: none;
}

/* P1-4 「更多」收纳菜单：侧栏底部浮层，条目与 nav-item 同观感 */
.more-wrap {
  position: relative;
}
.more-menu {
  position: absolute;
  left: calc(100% + 8px);
  bottom: 0;
  min-width: 160px;
  padding: 6px;
  border-radius: var(--hh-radius-md);
  border: 1px solid var(--hh-color-panel-glass-border);
  z-index: 40;
  display: flex;
  flex-direction: column;
}
.more-menu .nav-item {
  margin-bottom: 0;
}

/* 极窄窗口：侧栏收成图标条（≤620px 时三列预算 208+12+12 也让内容区所剩无几）。
   放在 .sidebar/.nav-item 定义之后，才能覆盖前面的 width:208px。 */
@media (max-width: 620px) {
  .sidebar {
    width: 56px;
    padding: 12px 8px;
    align-items: center;
  }
  .nav-item {
    justify-content: center;
    padding: 0 6px;
    gap: 0;
  }
  .nav-item span {
    display: none;
  }
  .nav-item .count {
    display: flex;
    position: absolute;
    top: 3px;
    right: 2px;
    margin: 0;
    min-width: 16px;
    height: 16px;
    padding: 0 4px;
    align-items: center;
    justify-content: center;
    font-size: 9px;
  }
}
</style>