<script setup lang="ts">
/**
 * 左侧导航栏 + 「更多」收纳菜单（从 App.vue 拆出，G17 大文件拆分）。
 *
 * 只渲染 <nav>（DOM 结构保持原样：header.titlebar 与 .layout 骨架仍在 App.vue，
 * 本组件插在 .layout 的第一个子槽位）。状态自取 store（ui/library/downloads），
 * 不设 props；与 App 的唯一通信是 enterFullscreen（需要 window.hh，留在 App）。
 * 「更多」菜单自持开关。模板只写单方法调用（prettier 会拆多语句表达式）。
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
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

/**
 * 选中块指示器（滑动高亮）：不是每个 nav-item 各自亮底，而是**一块**
 * 统一的高亮块从旧位置滑到新位置——这是侧栏「连贯」的来源。
 * 位置在切页后 nextTick 量（DOM 已换好 active 类），窗口尺寸变化时重量。
 */
const navEl = ref<HTMLElement | null>(null)
const hl = ref({ top: 0, height: 0, visible: false })
function measureHl(): void {
  const nav = navEl.value
  const active = nav?.querySelector<HTMLElement>('.nav-item.active')
  if (!nav || !active) {
    hl.value = { ...hl.value, visible: false }
    return
  }
  // offsetTop/offsetHeight 相对 offsetParent（.sidebar 是 position:relative），
  // 不掺 scrollTop——侧栏本身不滚动，量出来就是最终位置。
  hl.value = { top: active.offsetTop, height: active.offsetHeight, visible: true }
}
watch(
  () => ui.page,
  () => {
    void nextTick(measureHl)
  },
)
watch(moreMenuOpen, () => {
  void nextTick(measureHl)
})
function onResize(): void {
  void nextTick(measureHl)
}
onMounted(() => {
  void nextTick(measureHl)
  window.addEventListener('resize', onResize)
})

/** 点菜单外任意处收起「更多」菜单 */
function closeMore(e: MouseEvent): void {
  const more = document.querySelector('.more-wrap')
  const target = e.target as Node
  if (moreMenuOpen.value && more && !more.contains(target)) moreMenuOpen.value = false
}
onMounted(() => document.addEventListener('click', closeMore))
onUnmounted(() => {
  document.removeEventListener('click', closeMore)
  window.removeEventListener('resize', onResize)
})

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
  <nav ref="navEl" class="glass sidebar" :aria-label="t('app_nav_aria')">
    <!-- 滑动选中块：一块高亮在条目间平移（不是每条各亮一次）。
         高度/位置由 measureHl 量当前 active 条目；opacity 管首帧淡入，
         避免挂载时高亮从 y=0 一路滑下来。 -->
    <span
      class="nav-hl"
      aria-hidden="true"
      :style="{
        transform: `translateY(${hl.top}px)`,
        height: hl.height + 'px',
        opacity: hl.visible ? 1 : 0,
      }"
    ></span>
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
  /* 滑动高亮的容器必须建层叠上下文：.nav-item 提升到 z-index 1 之上，
     指示块（z-index 0）才不会压住条目文字/图标。glass 已有 backdrop-filter
     会自建上下文，这里显式声明不依赖它。 */
  isolation: isolate;
  /* .glass 的 backdrop-filter 会建立层叠上下文且 z-index 仍为 auto，
     内容区里后绘制的封面（position:absolute 行项）会盖住悬出的 .more-menu。
     抬到 --hh-layer-sidebar：压过内容区 z-index:auto 的定位子树，仍低于弹层。 */
  z-index: var(--hh-layer-sidebar);
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
/* 选中态：颜色与权重留在条目上，**底**交给 .nav-hl 滑动块（见下）。
   不动 accent 实色铺满——高饱和粉大面积填充显廉价（"AI 味"），
   粉色只留在图标与指示块左侧亮线上。 */
.nav-item {
  z-index: 1;
}
.nav-item.active {
  color: var(--hh-color-select-text);
  font-weight: 600;
}
.nav-item.active .nav-ic {
  opacity: 1;
  color: var(--hh-color-select-icon);
}

/* 滑动选中块：整条侧栏只有这一块低透明 accent 底，靠 transform 平移。
   top 由 JS 量（translateY 驱动），height 随条目高度变化平滑过渡。
   左缘 2px 亮线嵌在块内，跟着块一起走——「连贯」的关键就在这。 */
.nav-hl {
  position: absolute;
  left: var(--hh-space-x2);
  right: var(--hh-space-x2);
  top: 0;
  z-index: 0;
  border-radius: var(--hh-radius-sm);
  background: var(--hh-color-select-bg);
  pointer-events: none;
  transition:
    transform var(--hh-motion-slow) var(--hh-motion-ease-slide),
    height var(--hh-motion-slow) var(--hh-motion-ease-slide),
    opacity var(--hh-motion-fast) var(--hh-motion-ease-fade);
}
.nav-hl::before {
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
  z-index: var(--hh-layer-popover);
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