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
function goPage(p: 'library' | 'downloads' | 'games' | 'stats'): void {
  ui.page = p
  moreMenuOpen.value = false
}

/** 收藏夹入口：切到库页 + 开 favOnly，并清掉可能冲突的筛选
 *  （智能列表/分类会与收藏叠加，用户点「收藏」时想看的就是纯收藏，
 *   叠加一个「近 30 天入库」会让计数和列表对不上，显得按钮失灵）。 */
function goFavorites(): void {
  ui.page = 'library'
  library.favOnly = true
  library.smartList = ''
  library.categoryFilter = ''
  moreMenuOpen.value = false
}

/** 「更多」菜单动作：先执行再收起菜单 */
function moreAction(fn: () => void): void {
  fn()
  moreMenuOpen.value = false
}
</script>

<template>
  <nav class="glass sidebar" :aria-label="t('app_nav_aria')">
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
    <!-- 收藏夹快速入口：favorite 数据早就有，但此前只能靠工具栏的心形按钮切，
         心形在工具栏最右、和「只看收藏」的状态关联也不直观。侧栏给一个常驻入口，
         计数 = 收藏数，点一下即筛。 -->
    <button
      class="nav-item"
      :class="{ active: ui.page === 'library' && library.favOnly }"
      :aria-current="ui.page === 'library' && library.favOnly ? 'page' : undefined"
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
  width: 208px;
  padding: 12px;
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
  gap: 8px;
  height: 34px;
  padding: 0 10px;
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