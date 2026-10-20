<script setup lang="ts">
/**
 * 全屏模式（G11）—— BigBox 式客厅封面墙。
 *
 * 设计：
 *   - 纯黑/主题深色底，封面是唯一主角：卡片去掉边框卡片感，封面直接铺满
 *     （width 100% aspect 3/4），标题沉底渐变叠在封面上。
 *   - 顶部悬浮操作条：搜索、分类 chips、收藏切换、退出全屏。随鼠标移动浮现，
 *     静止 2.5s 淡出（客厅场景鼠标会离开）。
 *   - 手柄/键盘导航：方向键在封面间移动（grid 行列），Enter/A 启动，
 *     F/收藏，Esc/退出。Gamepad API 轮询左摇杆/十字键 + A/B 键。
 *
 * 交互映射（Playnite BigBox 习惯）：
 *   - 十字键 / 左摇杆：移动选中
 *   - A / Enter：启动游戏
 *   - X / F：收藏切换
 *   - B / Esc：退出全屏
 *   - 右摇杆：无（保留给未来缩放）
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { RecycleScroller } from 'vue-virtual-scroller'
import 'vue-virtual-scroller/dist/vue-virtual-scroller.css'
import { Heart, Play, Search, X } from 'lucide-vue-next'
import type { Game } from '../../shared/types'
import {
  categories,
  debouncedKeyword,
  filteredGames,
  launchGame,
  library,
  selectGame,
  thumbUrl,
  toggleFavorite,
} from '../stores/library'
import { FS_COLORS } from '../design/tokens'
import { t } from '../i18n'

const emit = defineEmits<{ exit: [] }>()

const containerRef = ref<HTMLElement | null>(null)
/** RecycleScroller 实例：类型声明只有 props，方法用松类型收（scrollToItem/getScroll 运行时存在） */
const scrollerRef = ref<{
  scrollToItem?: (_i: number) => void
  getScroll?: () => { scrollTop: number }
  $el?: HTMLElement
} | null>(null)
const cols = ref(1)
const focusIdx = ref(0)
const showBar = ref(true)
let ro: ResizeObserver | null = null
let hideTimer: ReturnType<typeof setTimeout> | null = null
let padTimer: ReturnType<typeof setInterval> | null = null
/** gamepadconnected 的监听引用：stopPadPoll 时移除，防止连接事件泄漏。 */
let onPadConnected: (() => void) | null = null
/** 手柄上次输入时间，防抖轮询内的重复触发 */
let lastPadAt = 0

/** 全屏里始终用网格视图 */
const games = computed(() => filteredGames.value)

/**
 * 虚拟化度量（P1-3，对照 CoverGrid §3.5）：
 *   卡槽 260（封面 240 + 列距 20）；封面 3:4 → 高 320；行距 20 → itemSize 340。
 *   标题叠在封面上，不占额外行高。
 */
const FS_SLOT = 260
const FS_CARD_W = 240
const FS_ROW_GAP = 20
const FS_ROW_H = Math.round((FS_CARD_W * 4) / 3) + FS_ROW_GAP // 340

/** 行 wrapper 宽度 = cols*260 - 20，与旧 CSS grid 1fr 布局观感一致 */
const fsGridW = computed(() => `${cols.value * FS_SLOT - FS_ROW_GAP}px`)

/** 筛选指纹：数量突变后强制重建 scroller（复用 CoverGrid 约定） */
const filterFingerprint = computed(
  () => `${debouncedKeyword.value}|${library.categoryFilter}|${library.favOnly}|${cols.value}`,
)

/** 网格列数：全屏铺满，卡槽 260px（封面 240 + 间距 20） */
function updateCols(): void {
  const el = containerRef.value
  if (!el) return
  cols.value = Math.max(1, Math.floor((el.clientWidth + FS_ROW_GAP) / FS_SLOT))
}

/** 按列数切行；行 key 带列数，避免窗口缩放后复用旧行 DOM */
const fsRows = computed(() => {
  const c = cols.value
  const rows: { k: string; items: { g: Game; i: number }[] }[] = []
  const list = games.value
  for (let i = 0; i < list.length; i += c) {
    const items: { g: Game; i: number }[] = []
    for (let j = i; j < Math.min(i + c, list.length); j++) items.push({ g: list[j]!, i: j })
    rows.push({ k: `${c}-${Math.floor(i / c)}`, items })
  }
  return rows
})

/** 键盘/手柄移动后把选中行滚进视口（RecycleScroller 不自动跟 focusIdx） */
function scrollFocusIntoView(): void {
  const row = Math.floor(focusIdx.value / Math.max(1, cols.value))
  const scroller = scrollerRef.value
  if (!scroller) return
  const el = (scroller as { $el?: HTMLElement }).$el
  const viewH = el?.clientHeight ?? 0
  const top =
    typeof scroller.getScroll === 'function'
      ? scroller.getScroll().scrollTop
      : ((scroller as unknown as { scrollTop?: number }).scrollTop ?? 0)
  const rowTop = row * FS_ROW_H
  const rowBottom = rowTop + FS_ROW_H
  // 行已在视口内只靠 scrollIntoView nearest；滚出视口才 scrollToItem（避免可见行也跳顶）
  if (!viewH || rowTop < top || rowBottom > top + viewH) {
    scroller.scrollToItem?.(row)
  }
}

let savedFilter: { keyword: string; category: string; fav: boolean } | null = null

onMounted(() => {
  // 进入全屏前保存普通库视图的过滤状态：全屏里改 keyword/categoryFilter/favOnly
  // 都是共享状态，退出时不恢复的话，用户在客厅筛选的「只收藏 Galgame」会把
  // 普通库视图也带进同一个筛选里，回来一脸懵。
  savedFilter = {
    keyword: library.keyword,
    category: library.categoryFilter,
    fav: library.favOnly,
  }
  updateCols()
  if (containerRef.value && 'ResizeObserver' in window) {
    ro = new ResizeObserver(updateCols)
    ro.observe(containerRef.value)
  }
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('mousemove', pokeBar)
  startPadPoll()
  // 进入时选中第一项
  if (games.value.length) {
    focusIdx.value = 0
    selectGame(games.value[0].id)
  }
})

onBeforeUnmount(() => {
  ro?.disconnect()
  ro = null
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('mousemove', pokeBar)
  stopPadPoll()
  if (hideTimer) clearTimeout(hideTimer)
  // 退出全屏：恢复进入时的过滤快照
  if (savedFilter) {
    library.keyword = savedFilter.keyword
    library.categoryFilter = savedFilter.category
    library.favOnly = savedFilter.fav
    savedFilter = null
  }
})

/** 鼠标一动就亮出操作条，2.5s 后淡出 */
function pokeBar(): void {
  showBar.value = true
  if (hideTimer) clearTimeout(hideTimer)
  hideTimer = setTimeout(() => {
    showBar.value = false
  }, 2500)
}

function selectAt(idx: number): void {
  const i = Math.max(0, Math.min(games.value.length - 1, idx))
  focusIdx.value = i
  const g = games.value[i]
  if (g) selectGame(g.id)
  pokeBar()
}

function moveFocus(next: number): void {
  selectAt(next)
  scrollFocusIntoView()
  // 滚动到可视区（容器滚动；虚拟化下目标卡可能尚未挂载，以行滚动为准）
  requestAnimationFrame(() => {
    const el = containerRef.value?.querySelector('[data-fs-selected="true"]')
    el?.scrollIntoView({ block: 'nearest' })
  })
}

function onKeydown(e: KeyboardEvent): void {
  // 输入源守卫：搜索框里打字（a/f/b/Enter）不能被全屏快捷键截胡——
  // 直接 return 让字母正常上屏，preventDefault 也不会吞掉输入。
  const t = e.target as HTMLElement | null
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
  if (e.key === 'ArrowRight') {
    e.preventDefault()
    moveFocus(focusIdx.value + 1)
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault()
    moveFocus(focusIdx.value - 1)
  } else if (e.key === 'ArrowDown') {
    e.preventDefault()
    moveFocus(focusIdx.value + cols.value)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    moveFocus(focusIdx.value - cols.value)
  } else if (e.key === 'Enter' || e.key === 'a' || e.key === 'A') {
    e.preventDefault()
    launchSel()
  } else if (e.key === 'f' || e.key === 'F') {
    e.preventDefault()
    favSel()
  } else if (e.key === 'Escape' || e.key === 'b' || e.key === 'B') {
    e.preventDefault()
    emit('exit')
  }
}

/** 启动当前选中。走 store.launchGame 而不是直接 window.hh.launchGame：
 *  后者不维护 runningIds（运行角标/停用「运行中」二次启动）也不收 error 文案，
 *  与详情页/列表的启动路径行为不一致。 */
function launchSel(): void {
  const g = games.value[focusIdx.value]
  if (g) void launchGame(g.id)
}

/** 收藏当前选中 */
function favSel(): void {
  const g = games.value[focusIdx.value]
  if (g) void toggleFavorite(g.id)
}

/** 手柄轮询：十字键/左摇杆移动，A=启动 X=收藏 B=退出（Playnite BigBox 布局）。
 *  60ms 空轮询只在「有可见手柄」时才开着：getGamepads 无手柄就停掉定时器，
 *  由 gamepadconnected 事件重新拉起——没接手柄时每个组件实例每秒白跑 ~16 次
 *  setInterval 回调，纯浪费。组件卸载时清定时器 + 移除连接监听（onBeforeUnmount）。 */
function startPadPoll(): void {
  if (padTimer) return
  const poll = (): void => {
    if (!('getGamepads' in navigator)) {
      stopPadPoll()
      return
    }
    const pads = navigator.getGamepads?.()
    const pad = [...(pads ?? [])].find((p) => p && p.connected)
    if (!pad) {
      // 没接手柄：停轮询，等连接事件再说。
      stopPadPoll()
      return
    }
    const now = Date.now()
    if (now - lastPadAt < 180) return
    const [lx, ly] = pad.axes ?? [0, 0]
    const btns = pad.buttons ?? []
    const dpadL = btns[14]?.pressed,
      dpadR = btns[15]?.pressed,
      dpadU = btns[12]?.pressed,
      dpadD = btns[13]?.pressed
    const aBtn = btns[0]?.pressed,
      xBtn = btns[2]?.pressed,
      bBtn = btns[1]?.pressed
    const moved =
      (Math.abs(lx) > 0.5 ? (lx < 0 ? -1 : 1) : 0) + (Math.abs(ly) > 0.5 ? (ly < 0 ? -cols.value : cols.value) : 0)
    if (dpadL) moveFocus(focusIdx.value - 1)
    else if (dpadR) moveFocus(focusIdx.value + 1)
    else if (dpadU) moveFocus(focusIdx.value - cols.value)
    else if (dpadD) moveFocus(focusIdx.value + cols.value)
    else if (moved !== 0) moveFocus(focusIdx.value + moved)
    else if (aBtn) launchSel()
    else if (xBtn) favSel()
    else if (bBtn) emit('exit')
    if (moved !== 0 || dpadL || dpadR || dpadU || dpadD || aBtn || xBtn || bBtn) lastPadAt = now
  }
  onPadConnected = (): void => {
    // 断开后停掉的轮询，手柄重新接入时拉起
    if (!padTimer) startPadPoll()
  }
  window.addEventListener('gamepadconnected', onPadConnected)
  padTimer = setInterval(poll, 60)
}

function stopPadPoll(): void {
  if (padTimer) {
    clearInterval(padTimer)
    padTimer = null
  }
  if (onPadConnected) {
    window.removeEventListener('gamepadconnected', onPadConnected)
    onPadConnected = null
  }
}

function placeholderBg(g: Game): string {
  if (g.color) return g.color
  // 深色客厅空间的兜底调色板：低饱和的夜色系（全屏层不随主题变浅）
  const palette = FS_COLORS.palette
  let h = 0
  for (const ch of g.title) h = (h * 31 + ch.codePointAt(0)!) >>> 0
  return palette[h % palette.length]
}

/** 当前选中的游戏（剧照舞台主角） */
const stageGame = computed(() => games.value[focusIdx.value] ?? null)
/** 剧照舞台左侧 ghost（前一款） */
const stagePrev = computed(() => {
  const i = focusIdx.value - 1
  return i >= 0 && i < games.value.length ? games.value[i]! : null
})
/** 剧照舞台右侧 ghost（后一款） */
const stageNext = computed(() => {
  const i = focusIdx.value + 1
  return i >= 0 && i < games.value.length ? games.value[i]! : null
})

function fmtSub(g: Game): string {
  if (g.releaseDate) return g.releaseDate
  if (g.playMs <= 0) return ''
  const h = Math.floor(g.playMs / 3600000)
  const m = Math.floor((g.playMs % 3600000) / 60000)
  return h > 0 ? `${h}h${m}m` : `${m}m`
}

function imgErr(e: Event): void {
  ;(e.target as HTMLImageElement).style.display = 'none'
}
</script>

<template>
  <div ref="containerRef" class="fs-root">
    <!-- 顶部悬浮操作条 -->
    <div class="fs-bar" :class="{ hidden: !showBar }">
      <div class="fs-search">
        <Search :size="14" class="fs-search-ic" />
        <input v-model="library.keyword" class="fs-search-input" :placeholder="t('fs_search_ph')" />
      </div>
      <div class="fs-chips">
        <button class="fs-chip" :class="{ active: library.categoryFilter === '' }" @click="library.categoryFilter = ''">
          {{ t('toolbar_all') }}
        </button>
        <button
          v-for="c in categories"
          :key="c"
          class="fs-chip"
          :class="{ active: library.categoryFilter === c }"
          @click="library.categoryFilter = library.categoryFilter === c ? '' : c"
        >
          {{ c }}
        </button>
      </div>
      <button
        class="fs-btn"
        :class="{ active: library.favOnly }"
        :title="t('fs_fav')"
        :aria-pressed="library.favOnly"
        @click="library.favOnly = !library.favOnly"
      >
        <Heart :size="15" />
      </button>
      <button class="fs-btn" :title="t('fs_exit')" @click="emit('exit')"><X :size="16" /></button>
    </div>

    <!-- 空态 -->
    <div v-if="games.length === 0" class="fs-empty">
      <div class="fs-empty-title">{{ library.games.length ? t('lib_no_match') : t('lib_empty') }}</div>
      <div class="fs-empty-hint">{{ t('fs_empty') }}</div>
    </div>

    <!-- 剧照舞台（aurora 式客厅主视觉）：中央大封面 + 左右 ghost + 大标题 + 启动胶囊。
         封面墙缩为底部一条封面轨。选中变化时舞台整体随 :key 重挂载播 slide-in。 -->
    <template v-else>
      <div :key="`stage-${focusIdx}`" class="fs-stage">
        <!-- 背景光晕：选中封面模糊铺底 + 径向光晕 -->
        <div class="fs-stage-bg" :style="stageGame && thumbUrl(stageGame) ? { backgroundImage: `url(${thumbUrl(stageGame)})` } : {}"></div>
        <div class="fs-stage-glow" :style="stageGame ? { background: `radial-gradient(60% 60% at 30% 20%, ${placeholderBg(stageGame)}66, transparent 70%), radial-gradient(60% 60% at 70% 80%, ${placeholderBg(stageGame)}44, transparent 70%)` } : {}"></div>

        <!-- 中央封面堆叠：ghost 左 / 主角 / ghost 右 -->
        <div class="fs-stage-stack">
          <div v-if="stagePrev" class="fs-ghost left" :style="{ backgroundImage: thumbUrl(stagePrev) ? `url(${thumbUrl(stagePrev)})` : '' }"></div>
          <div class="fs-stage-cover">
            <img
              v-if="stageGame && thumbUrl(stageGame)"
              :src="thumbUrl(stageGame)"
              :alt="stageGame.title"
              :key="stageGame.id"
            />
            <span v-else class="fs-stage-letter">{{ stageGame ? stageGame.title.slice(0, 2) : '' }}</span>
          </div>
          <div v-if="stageNext" class="fs-ghost right" :style="{ backgroundImage: thumbUrl(stageNext) ? `url(${thumbUrl(stageNext)})` : '' }"></div>
        </div>

        <!-- 大标题 + 元数据 + 启动胶囊 -->
        <div class="fs-stage-meta">
          <div class="fs-stage-title" v-if="stageGame">{{ stageGame.title }}</div>
          <div class="fs-stage-sub" v-if="stageGame">
            <span v-if="stageGame.developer">{{ stageGame.developer }}</span>
            <span v-if="stageGame.rating" class="num">★ {{ stageGame.rating.toFixed(1) }}</span>
            <span v-if="fmtSub(stageGame)">{{ fmtSub(stageGame) }}</span>
          </div>
          <div class="fs-stage-actions">
            <button class="fs-stage-play" @click="launchSel">
              <Play :size="18" :fill="'currentColor'" />
              <span>{{ t('detail_launch') }}</span>
            </button>
            <button class="fs-stage-fav" :data-faved="!!stageGame?.favorite" @click="favSel">
              <Heart :size="16" :fill="stageGame?.favorite ? 'currentColor' : 'none'" />
            </button>
          </div>
        </div>
      </div>

      <!-- 封面墙：缩为底部一条封面轨（行级虚拟化） -->
      <RecycleScroller
        ref="scrollerRef"
        :key="`fs-${filterFingerprint}`"
        class="fs-scroller"
        :items="fsRows"
        :item-size="FS_ROW_H"
        key-field="k"
        :page-mode="false"
        :buffer="400"
        item-class="fs-row-item"
      >
        <template #default="{ item }">
          <div class="fs-row" :style="{ width: fsGridW }">
            <div
              v-for="entry in item.items"
              :key="entry.g.id"
              class="fs-card"
              :class="{ selected: focusIdx === entry.i }"
              :data-fs-selected="focusIdx === entry.i"
              role="button"
              :tabindex="focusIdx === entry.i ? 0 : -1"
              @click="selectAt(entry.i)"
              @dblclick="launchSel()"
              @keydown.enter.prevent="launchSel()"
            >
              <div class="fs-thumb" :style="{ background: placeholderBg(entry.g) }">
                <img v-if="thumbUrl(entry.g)" :src="thumbUrl(entry.g)" :alt="entry.g.title" @error="imgErr" />
                <span v-else class="fs-letter">{{ entry.g.title.slice(0, 2) }}</span>
                <div v-if="entry.g.favorite" class="fs-fav">
                  <Heart :size="11" :fill="'currentColor'" :stroke-width="0" />
                </div>
                <div class="fs-shade"></div>
                <div class="fs-title-zone">
                  <div class="fs-title" :title="entry.g.title">{{ entry.g.title }}</div>
                  <div class="fs-sub" v-if="fmtSub(entry.g)">{{ fmtSub(entry.g) }}</div>
                </div>
              </div>
            </div>
          </div>
        </template>
      </RecycleScroller>
    </template>

    <!-- 底部操作提示（客厅场景） -->
    <div class="fs-hints" :class="{ hidden: !showBar }">
      <span><kbd>←↑↓→</kbd> {{ t('fs_move') }}</span>
      <span><kbd>Enter</kbd> {{ t('fs_launch') }}</span>
      <span><kbd>F</kbd> {{ t('fs_favorite') }}</span>
      <span><kbd>Esc</kbd> {{ t('fs_quit') }}</span>
    </div>
  </div>
</template>

<style scoped>
/* 全屏层是独立深色客厅空间：不随主题变浅。
   局部 CSS 变量覆盖全局 token（值取自深色主题语义），组件内不再出现散落色值字面量。 */
.fs-root {
  --fs-bg: var(--hh-fs-bg);
  --fs-glass: rgba(255, 255, 255, 0.08);
  --fs-glass-hover: rgba(255, 255, 255, 0.16);
  --fs-glass-border: rgba(255, 255, 255, 0.18);
  --fs-ink: rgba(255, 255, 255, 0.85);
  --fs-ink-dim: rgba(255, 255, 255, 0.5);
  --fs-ink-faint: rgba(255, 255, 255, 0.3);
  --fs-ink-fill: var(--hh-fs-ink-fill);
  --fs-scrim: linear-gradient(to top, rgba(0, 0, 0, 0.85), transparent);
  --fs-bar-bg: linear-gradient(to bottom, rgba(0, 0, 0, 0.85), transparent);
  --fs-thumb-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
  --fs-fav-bg: rgba(0, 0, 0, 0.5);
  --fs-hints-bg: rgba(0, 0, 0, 0.6);
  --fs-title-shadow: 0 1px 4px rgba(0, 0, 0, 0.6);
  --fs-kbd-bg: rgba(255, 255, 255, 0.15);

  position: fixed;
  inset: 0;
  z-index: 1000;
  background: var(--fs-bg);
  overflow: hidden;
  color: var(--fs-ink-fill);
  display: flex;
  flex-direction: column;
}

.fs-bar {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px 20px;
  background: var(--fs-bar-bg);
  transition: opacity var(--hh-motion-slow) ease;
}
.fs-bar.hidden {
  opacity: 0;
  pointer-events: none;
}

.fs-search {
  position: relative;
  display: flex;
  align-items: center;
}
.fs-search-ic {
  position: absolute;
  left: 12px;
  color: var(--fs-ink-dim);
  pointer-events: none;
}
.fs-search-input {
  width: 220px;
  height: 36px;
  border-radius: var(--hh-radius-md);
  padding: 0 12px 0 34px;
  border: 1px solid var(--fs-glass-border);
  background: var(--fs-glass);
  color: var(--fs-ink-fill);
  font-size: var(--hh-font-bodyLg-size);
  outline: none;
}
.fs-search-input:focus {
  border-color: var(--hh-color-accent);
}

.fs-chips {
  display: flex;
  align-items: center;
  gap: 6px;
  overflow-x: auto;
  scrollbar-width: none;
  flex: 1;
  min-width: 0;
}
.fs-chips::-webkit-scrollbar {
  display: none;
}
.fs-chip {
  flex-shrink: 0;
  height: 32px;
  padding: 0 14px;
  border-radius: var(--hh-radius-pill);
  border: 1px solid var(--fs-glass-border);
  background: var(--fs-glass);
  color: var(--fs-ink);
  font-size: 12.5px;
  cursor: pointer;
  transition:
    background var(--hh-motion-med) ease,
    color var(--hh-motion-med) ease;
}
.fs-chip:hover {
  background: var(--fs-glass-hover);
}
.fs-chip.active {
  background: var(--hh-color-accent);
  border-color: var(--hh-color-accent);
  color: var(--fs-ink-fill);
  font-weight: 600;
}

.fs-btn {
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  border-radius: var(--hh-radius-md);
  border: 1px solid var(--fs-glass-border);
  background: var(--fs-glass);
  color: var(--fs-ink);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background var(--hh-motion-med) ease;
}
.fs-btn:hover {
  background: var(--fs-glass-hover);
}
.fs-btn.active {
  background: var(--hh-color-accent);
  color: var(--fs-ink-fill);
}

/* 封面墙：缩为底部封面轨（舞台 flex:1 占大头，封面轨固定高）。
   max 用 34vh 兜底矮窗口：固定 340px 在 720p 矮屏会把剧照舞台挤扁。 */
.fs-scroller {
  flex: none;
  height: min(340px, 34vh);
  min-height: 0;
}
.fs-row {
  display: flex;
  gap: 20px;
  margin: 0 auto;
  padding: 8px 0 90px;
  box-sizing: border-box;
}
.fs-row-item {
  display: block;
}
.fs-card {
  flex: 1;
  min-width: 0;
  cursor: pointer;
  border-radius: var(--hh-radius-panel);
  outline: none;
  transition: transform var(--hh-motion-med) ease;
}
.fs-card.selected {
  transform: translateY(-6px) scale(1.02);
}
.fs-card:focus-visible {
  box-shadow: 0 0 0 3px var(--hh-color-accent);
}

.fs-thumb {
  position: relative;
  aspect-ratio: 3 / 4;
  border-radius: var(--hh-radius-lg);
  overflow: hidden;
  box-shadow: var(--fs-thumb-shadow);
}
.fs-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.fs-card.selected .fs-thumb {
  box-shadow:
    0 0 0 2px var(--hh-color-accent),
    0 10px 40px var(--hh-color-accent-selected-ring);
}
.fs-letter {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 40px;
  font-weight: 700;
  color: var(--fs-ink-faint);
}
.fs-fav {
  position: absolute;
  top: 10px;
  right: 10px;
  color: var(--hh-color-star);
  background: var(--fs-fav-bg);
  width: 26px;
  height: 26px;
  border-radius: var(--hh-radius-sm);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2;
}
.fs-shade {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 45%;
  background: var(--fs-scrim);
  z-index: 1;
}
.fs-title-zone {
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: 10px;
  z-index: 2;
}
.fs-title {
  font-size: 15px;
  font-weight: 600;
  line-height: 1.3;
  color: var(--fs-ink-fill);
  text-shadow: var(--fs-title-shadow);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.fs-sub {
  font-size: var(--hh-font-caption-size);
  color: var(--fs-ink);
  font-variant-numeric: tabular-nums;
  margin-top: 2px;
}

.fs-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--fs-ink);
}
.fs-empty-title {
  font-size: var(--hh-font-title-size);
  font-weight: 600;
}
.fs-empty-hint {
  font-size: var(--hh-font-body-size);
  color: var(--fs-ink-dim);
}

/* ============ 剧照舞台（aurora 式客厅主视觉） ============ */
/* 舞台占满剩余空间，封面轨缩为底部一条。选中变化整层重挂载播 slide-in。 */
.fs-stage {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 18px;
  overflow: hidden;
  animation: fs-stage-in 300ms cubic-bezier(0.22, 1, 0.36, 1) both;
}
@keyframes fs-stage-in {
  from { opacity: 0; transform: scale(0.985); }
  to { opacity: 1; transform: scale(1); }
}
/* 背景：选中封面模糊铺底 */
.fs-stage-bg {
  position: absolute;
  inset: 0;
  background-size: cover;
  background-position: center 30%;
  filter: blur(70px) saturate(1.4);
  transform: scale(1.15);
  opacity: 0.4;
  pointer-events: none;
}
/* 径向光晕：选中封面的主色双光斑 */
.fs-stage-glow {
  position: absolute;
  inset: 0;
  filter: blur(40px);
  opacity: 0.5;
  pointer-events: none;
}
/* 中央封面堆叠 */
.fs-stage-stack {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  height: min(46vh, 380px);
}
.fs-stage-cover {
  position: relative;
  z-index: 2;
  height: 100%;
  aspect-ratio: 3 / 4;
  border-radius: var(--hh-radius-lg);
  overflow: hidden;
  box-shadow:
    0 30px 60px rgba(0, 0, 0, 0.55),
    0 0 0 1px var(--fs-glass-border),
    0 0 80px rgba(255, 255, 255, 0.06);
  transition: transform 300ms cubic-bezier(0.22, 1, 0.36, 1);
}
.fs-stage-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.fs-stage-letter {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 64px;
  font-weight: 700;
  color: var(--fs-ink-faint);
}
/* 左右 ghost 封面：旋转 + 压暗，制造「剧照堆叠」纵深 */
.fs-ghost {
  position: absolute;
  top: 50%;
  width: 58%;
  aspect-ratio: 3 / 4;
  background-size: cover;
  background-position: center;
  border-radius: var(--hh-radius-lg);
  filter: blur(1.5px) brightness(0.7) saturate(0.9);
  opacity: 0.55;
  box-shadow: 0 20px 40px rgba(0, 0, 0, 0.4);
  transform: translateY(-50%);
  transition: opacity var(--hh-motion-med) ease;
}
.fs-ghost.left {
  left: 6%;
  transform: translateY(-50%) translateX(-18%) scale(0.92) rotate(-5deg);
}
.fs-ghost.right {
  right: 6%;
  transform: translateY(-50%) translateX(18%) scale(0.92) rotate(5deg);
}
/* 大标题 + 元数据 + 启动胶囊 */
.fs-stage-meta {
  position: relative;
  z-index: 3;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  text-align: center;
  max-width: 70%;
}
.fs-stage-title {
  font-family: 'Instrument Serif', 'Noto Serif SC', 'Source Han Serif SC', 'Songti SC', 'SimSun', Georgia, serif;
  font-size: clamp(30px, 4vw, 52px);
  font-weight: 600;
  line-height: 1.05;
  color: var(--fs-ink-fill);
  text-shadow: 0 2px 24px rgba(0, 0, 0, 0.6);
  letter-spacing: 0.01em;
}
.fs-stage-sub {
  display: flex;
  align-items: center;
  gap: 14px;
  font-size: var(--hh-font-bodyLg-size);
  color: var(--fs-ink);
  text-shadow: 0 1px 8px rgba(0, 0, 0, 0.5);
  font-variant-numeric: tabular-nums;
}
.fs-stage-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 6px;
}
/* 发光胶囊启动键（aurora 式） */
.fs-stage-play {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 14px 34px;
  border: none;
  border-radius: var(--hh-radius-pill);
  background: var(--fs-ink-fill);
  color: var(--fs-bg);
  font-size: var(--hh-font-bodyLg-size);
  font-weight: 700;
  cursor: pointer;
  transition:
    transform 180ms ease,
    box-shadow 180ms ease;
  box-shadow:
    0 0 0 4px rgba(255, 255, 255, 0.14),
    0 12px 36px rgba(0, 0, 0, 0.4);
}
.fs-stage-play:hover {
  transform: translateY(-2px);
  box-shadow:
    0 0 0 4px rgba(255, 255, 255, 0.22),
    0 18px 48px rgba(0, 0, 0, 0.5);
}
.fs-stage-fav {
  width: 48px;
  height: 48px;
  border-radius: var(--hh-radius-pill);
  border: 1px solid var(--fs-glass-border);
  background: var(--fs-glass);
  color: var(--fs-ink);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background var(--hh-motion-med) ease;
}
.fs-stage-fav:hover {
  background: var(--fs-glass-hover);
}
.fs-stage-fav[data-faved='true'] {
  color: var(--hh-color-star);
}

/* 底部操作提示 */
.fs-hints {
  position: fixed;
  bottom: 20px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 10px 20px;
  border-radius: var(--hh-radius-lg);
  background: var(--fs-hints-bg);
  font-size: var(--hh-font-caption-size);
  color: var(--fs-ink);
  transition: opacity var(--hh-motion-slow) ease;
}
.fs-hints.hidden {
  opacity: 0;
  pointer-events: none;
}
.fs-hints kbd {
  display: inline-block;
  padding: 2px 6px;
  border-radius: var(--hh-radius-xs);
  background: var(--fs-kbd-bg);
  font-size: 11px;
  color: var(--fs-ink-fill);
  font-family: inherit;
}
</style>
