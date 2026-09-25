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
import { Heart, Search, X } from 'lucide-vue-next'
import type { Game } from '../../shared/types'
import { categories, filteredGames, library, selectGame, thumbUrl, toggleFavorite } from '../stores/library'
import { t } from '../i18n'

const emit = defineEmits<{ exit: [] }>()

const containerRef = ref<HTMLElement | null>(null)
const cols = ref(1)
const focusIdx = ref(0)
const showBar = ref(true)
let ro: ResizeObserver | null = null
let hideTimer: ReturnType<typeof setTimeout> | null = null
let padTimer: ReturnType<typeof setInterval> | null = null
/** 手柄上次输入时间，防抖轮询内的重复触发 */
let lastPadAt = 0

/** 全屏里始终用网格视图 */
const games = computed(() => filteredGames.value)

/** 网格列数：全屏铺满，卡槽 260px（封面 240 + 间距 20） */
function updateCols(): void {
  const el = containerRef.value
  if (!el) return
  cols.value = Math.max(1, Math.floor((el.clientWidth + 20) / 260))
}

onMounted(() => {
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
  // 滚动到可视区（容器滚动）
  const el = containerRef.value?.querySelector('[data-fs-selected="true"]')
  el?.scrollIntoView({ block: 'nearest' })
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'ArrowRight') {
    e.preventDefault(); moveFocus(focusIdx.value + 1)
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault(); moveFocus(focusIdx.value - 1)
  } else if (e.key === 'ArrowDown') {
    e.preventDefault(); moveFocus(focusIdx.value + cols.value)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault(); moveFocus(focusIdx.value - cols.value)
  } else if (e.key === 'Enter' || e.key === 'a' || e.key === 'A') {
    e.preventDefault(); launchSel()
  } else if (e.key === 'f' || e.key === 'F') {
    e.preventDefault(); favSel()
  } else if (e.key === 'Escape' || e.key === 'b' || e.key === 'B') {
    e.preventDefault(); emit('exit')
  }
}

/** 启动当前选中 */
function launchSel(): void {
  const g = games.value[focusIdx.value]
  if (g) void window.hh.launchGame(g.id)
}

/** 收藏当前选中 */
function favSel(): void {
  const g = games.value[focusIdx.value]
  if (g) void toggleFavorite(g.id)
}

/** 手柄轮询：十字键/左摇杆移动，A=启动 X=收藏 B=退出（Playnite BigBox 布局） */
function startPadPoll(): void {
  if (padTimer) return
  padTimer = setInterval(() => {
    if (!('getGamepads' in navigator)) return
    const pads = navigator.getGamepads?.()
    const pad = [...(pads ?? [])].find((p) => p && p.connected)
    if (!pad) return
    const now = Date.now()
    if (now - lastPadAt < 180) return
    const [lx, ly] = pad.axes ?? [0, 0]
    const btns = pad.buttons ?? []
    const dpadL = btns[14]?.pressed, dpadR = btns[15]?.pressed, dpadU = btns[12]?.pressed, dpadD = btns[13]?.pressed
    const aBtn = btns[0]?.pressed, xBtn = btns[2]?.pressed, bBtn = btns[1]?.pressed
    const moved =
      (Math.abs(lx) > 0.5 ? (lx < 0 ? -1 : 1) : 0) +
      (Math.abs(ly) > 0.5 ? (ly < 0 ? -cols.value : cols.value) : 0)
    if (dpadL) moveFocus(focusIdx.value - 1)
    else if (dpadR) moveFocus(focusIdx.value + 1)
    else if (dpadU) moveFocus(focusIdx.value - cols.value)
    else if (dpadD) moveFocus(focusIdx.value + cols.value)
    else if (moved !== 0) moveFocus(focusIdx.value + moved)
    else if (aBtn) launchSel()
    else if (xBtn) favSel()
    else if (bBtn) emit('exit')
    if (moved !== 0 || dpadL || dpadR || dpadU || dpadD || aBtn || xBtn || bBtn) lastPadAt = now
  }, 60)
}

function stopPadPoll(): void {
  if (padTimer) {
    clearInterval(padTimer)
    padTimer = null
  }
}

function placeholderBg(g: Game): string {
  if (g.color) return g.color
  // 深色客厅空间的兜底调色板：低饱和的夜色系（全屏层不随主题变浅）
  const palette = ['#5b6478', '#5f4d70', '#3f5a6b', '#4a6b5a', '#6b4f4f', '#6b6240']
  let h = 0
  for (const ch of g.title) h = (h * 31 + ch.codePointAt(0)!) >>> 0
  return palette[h % palette.length]
}

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
        <input v-model="library.keyword" class="fs-search-input" placeholder="搜索游戏…" />
      </div>
      <div class="fs-chips">
        <button
          class="fs-chip"
          :class="{ active: library.categoryFilter === '' }"
          @click="library.categoryFilter = ''"
        >全部</button>
        <button
          v-for="c in categories"
          :key="c"
          class="fs-chip"
          :class="{ active: library.categoryFilter === c }"
          @click="library.categoryFilter = library.categoryFilter === c ? '' : c"
        >{{ c }}</button>
      </div>
      <button
        class="fs-btn"
        :class="{ active: library.favOnly }"
        title="只看收藏（F）"
        :aria-pressed="library.favOnly"
        @click="library.favOnly = !library.favOnly"
      ><Heart :size="15" /></button>
      <button class="fs-btn" title="退出全屏（Esc / B）" @click="emit('exit')"><X :size="16" /></button>
    </div>

    <!-- 空态 -->
    <div v-if="games.length === 0" class="fs-empty">
      <div class="fs-empty-title">{{ library.games.length ? t('lib_no_match') : t('lib_empty') }}</div>
      <div class="fs-empty-hint">Esc 退出全屏，先到普通视图扫描导入游戏</div>
    </div>

    <!-- 封面墙：CSS grid 自适应列，天然适合全屏 -->
    <div v-else class="fs-grid" :style="{ gridTemplateColumns: `repeat(${cols}, 1fr)` }">
      <div
        v-for="(g, i) in games"
        :key="g.id"
        class="fs-card"
        :class="{ selected: focusIdx === i }"
        :data-fs-selected="focusIdx === i"
        role="button"
        :tabindex="focusIdx === i ? 0 : -1"
        @click="selectAt(i)"
        @dblclick="launchSel()"
        @keydown.enter.prevent="launchSel()"
      >
        <div class="fs-thumb" :style="{ background: placeholderBg(g) }">
          <img v-if="thumbUrl(g)" :src="thumbUrl(g)" :alt="g.title" @error="imgErr" />
          <span v-else class="fs-letter">{{ g.title.slice(0, 2) }}</span>
          <div v-if="g.favorite" class="fs-fav"><Heart :size="11" :fill="'currentColor'" :stroke-width="0" /></div>
          <div class="fs-shade"></div>
          <div class="fs-title-zone">
            <div class="fs-title" :title="g.title">{{ g.title }}</div>
            <div class="fs-sub" v-if="fmtSub(g)">{{ fmtSub(g) }}</div>
          </div>
        </div>
      </div>
    </div>

    <!-- 底部操作提示（客厅场景） -->
    <div class="fs-hints" :class="{ hidden: !showBar }">
      <span><kbd>←↑↓→</kbd> 移动</span>
      <span><kbd>Enter</kbd> 启动</span>
      <span><kbd>F</kbd> 收藏</span>
      <span><kbd>Esc</kbd> 退出</span>
    </div>
  </div>
</template>

<style scoped>
/* 全屏层是独立深色客厅空间：不随主题变浅。
   局部 CSS 变量覆盖全局 token（值取自深色主题语义），组件内不再出现散落色值字面量。 */
.fs-root {
  --fs-bg: #0b0b10;
  --fs-glass: rgba(255,255,255,0.08);
  --fs-glass-hover: rgba(255,255,255,0.16);
  --fs-glass-border: rgba(255,255,255,0.18);
  --fs-ink: rgba(255,255,255,0.85);
  --fs-ink-dim: rgba(255,255,255,0.5);
  --fs-ink-faint: rgba(255,255,255,0.3);
  --fs-ink-fill: #fff;
  --fs-scrim: linear-gradient(to top, rgba(0,0,0,0.85), transparent);
  --fs-bar-bg: linear-gradient(to bottom, rgba(0,0,0,0.85), transparent);
  --fs-thumb-shadow: 0 8px 28px rgba(0,0,0,0.45);
  --fs-fav-bg: rgba(0,0,0,0.5);
  --fs-hints-bg: rgba(0,0,0,0.6);
  --fs-title-shadow: 0 1px 4px rgba(0,0,0,0.6);
  --fs-kbd-bg: rgba(255,255,255,0.15);

  position: fixed;
  inset: 0;
  z-index: 1000;
  background: var(--fs-bg);
  overflow-y: auto;
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
  transition: opacity 0.25s ease;
}
.fs-bar.hidden { opacity: 0; pointer-events: none; }

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
  border-radius: 10px;
  padding: 0 12px 0 34px;
  border: 1px solid var(--fs-glass-border);
  background: var(--fs-glass);
  color: var(--fs-ink-fill);
  font-size: 14px;
  outline: none;
}
.fs-search-input:focus { border-color: var(--hh-color-accent); }

.fs-chips {
  display: flex;
  align-items: center;
  gap: 6px;
  overflow-x: auto;
  scrollbar-width: none;
  flex: 1;
  min-width: 0;
}
.fs-chips::-webkit-scrollbar { display: none; }
.fs-chip {
  flex-shrink: 0;
  height: 32px;
  padding: 0 14px;
  border-radius: 999px;
  border: 1px solid var(--fs-glass-border);
  background: var(--fs-glass);
  color: var(--fs-ink);
  font-size: 12.5px;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}
.fs-chip:hover { background: var(--fs-glass-hover); }
.fs-chip.active {
  background: var(--hh-color-accent);
  border-color: var(--hh-color-accent);
  color: var(--fs-ink-fill);
  font-weight: 600;
}

.fs-btn {
  flex-shrink: 0;
  width: 36px; height: 36px;
  border-radius: 10px;
  border: 1px solid var(--fs-glass-border);
  background: var(--fs-glass);
  color: var(--fs-ink);
  cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: background 0.15s ease;
}
.fs-btn:hover { background: var(--fs-glass-hover); }
.fs-btn.active { background: var(--hh-color-accent); color: var(--fs-ink-fill); }

/* 封面墙 */
.fs-grid {
  flex: 1;
  display: grid;
  gap: 20px;
  padding: 8px 24px 90px;
  align-content: start;
}
.fs-card {
  cursor: pointer;
  border-radius: 14px;
  outline: none;
  transition: transform 0.18s ease;
}
.fs-card.selected { transform: translateY(-6px) scale(1.02); }
.fs-card:focus-visible { box-shadow: 0 0 0 3px var(--hh-color-accent); }

.fs-thumb {
  position: relative;
  aspect-ratio: 3 / 4;
  border-radius: 12px;
  overflow: hidden;
  box-shadow: var(--fs-thumb-shadow);
}
.fs-thumb img {
  width: 100%; height: 100%;
  object-fit: cover;
  display: block;
}
.fs-card.selected .fs-thumb {
  box-shadow:
    0 0 0 2px var(--hh-color-accent),
    0 10px 40px var(--hh-color-accent-selected-ring);
}
.fs-letter {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  font-size: 40px; font-weight: 700; color: var(--fs-ink-faint);
}
.fs-fav {
  position: absolute; top: 10px; right: 10px;
  color: var(--hh-color-star);
  background: var(--fs-fav-bg);
  width: 26px; height: 26px;
  border-radius: 8px;
  display: flex; align-items: center; justify-content: center;
  z-index: 2;
}
.fs-shade {
  position: absolute; left: 0; right: 0; bottom: 0; height: 45%;
  background: var(--fs-scrim);
  z-index: 1;
}
.fs-title-zone {
  position: absolute; left: 12px; right: 12px; bottom: 10px;
  z-index: 2;
}
.fs-title {
  font-size: 15px; font-weight: 600; line-height: 1.3;
  color: var(--fs-ink-fill);
  text-shadow: var(--fs-title-shadow);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.fs-sub {
  font-size: 12px; color: var(--fs-ink);
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
.fs-empty-title { font-size: 20px; font-weight: 600; }
.fs-empty-hint { font-size: 13px; color: var(--fs-ink-dim); }

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
  border-radius: 12px;
  background: var(--fs-hints-bg);
  font-size: 12px;
  color: var(--fs-ink);
  transition: opacity 0.25s ease;
}
.fs-hints.hidden { opacity: 0; pointer-events: none; }
.fs-hints kbd {
  display: inline-block;
  padding: 2px 6px;
  border-radius: 5px;
  background: var(--fs-kbd-bg);
  font-size: 11px;
  color: var(--fs-ink-fill);
  font-family: inherit;
}
</style>
