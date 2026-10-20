<script setup lang="ts">
/**
 * 库顶氛围横带（P0 首屏冲击，对标 KoiPage 首页 hero）。
 *
 * 与旧版的关键差异：
 * 1) 候选集按「上次玩过的 → 从未玩过的」排序，首位即"上次玩过"时眉标显示"继续上次的故事"，
 *    翻到从未玩过的显示"从这里开始"，翻到已玩过别的显示"下一段故事" —— 对标 KoiPage 叙事文案。
 * 2) Hero 可交互切换：顶部封面轨可滚轮/拖拽/方向键切换，切换时封面与文案做 300ms 交叉滑入滑出。
 * 3) 压图可读性：双层定向 scrim（纵向上下压、横向从右往左渐重）+ 封面左右羽化（mask-image）。
 * 4) 主按钮白底黑字（压图最稳），次按钮玻璃拟态；启动按钮三态文案（启动中… / 运行中 / 继续游玩 / 启动游戏）。
 */

import { computed, ref, onMounted, onUnmounted, watch } from 'vue'
import { Play, Star } from 'lucide-vue-next'
import type { Game } from '../../shared/types'
import { library, selectGame, launchGame, thumbUrl } from '../stores/library'
import { t } from '../i18n'
import { tokens } from '../design/tokens'

/** 星级色（跟随主题 tokens，同 CoverGrid/DetailPanel 的评级星一致） */
const starColor = computed(() => tokens.color.star)

/** 是否有可展示封面（thumb 或 cover） */
function hasCover(g: Game): boolean {
  return !!(g.thumbPath || g.coverPath)
}

/** 候选集：上次玩过的优先（时间倒序），其次从未玩过的（收藏+评分+入库时间） */
const heroCandidates = computed<Game[]>(() => {
  const games = library.games
  if (!games.length) return []
  const played = games.filter((g) => hasCover(g) && !!g.lastPlayed).sort((a, b) => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0))
  const unplayed = games
    .filter((g) => hasCover(g) && !g.lastPlayed)
    .sort((a, b) => (b.favorite === a.favorite ? 0 : b.favorite ? -1 : 1)
      || (b.rating ?? 0) - (a.rating ?? 0)
      || b.addedAt - a.addedAt)
  return [...played, ...unplayed]
})

/** 当前选中的索引（响应式，驱动 hero 内容与选中态） */
const currentIndex = ref(0)
/** 动画方向：1 向右（下一张），-1 向左（上一张） */
const slideDirection = ref(1)

/** 当前主角 */
const heroGame = computed<Game | null>(() => heroCandidates.value[currentIndex.value] ?? null)

/** hero 背景图 URL（thumb 优先，cover 兜底 encodeURI） */
const heroBg = computed(() => {
  const g = heroGame.value
  if (!g) return ''
  if (g.thumbPath) return thumbUrl(g)
  if (g.coverPath) return `file://${encodeURI(g.coverPath.replace(/\\/g, '/'))}`
  return ''
})

/** 是否"上次玩过的" */
const isLastPlayed = computed(() => !!heroGame.value?.lastPlayed)
/** 是否"从未玩过" */
const isNeverPlayed = computed(() => !heroGame.value?.lastPlayed)

/** 运行中状态 */
const running = computed(() => !!heroGame.value && library.runningIds.has(heroGame.value.id))

/** 滚轮累积量节流（鼠标一格 = 1 次切换，触控板细颗粒累积） */
let wheelAccumulated = 0
let lastWheelAt = 0

function onWheel(event: WheelEvent): void {
  if (event.ctrlKey) return
  const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
  if (delta === 0) return
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerWidth : 1
  event.preventDefault()
  const now = performance.now()
  if (now - lastWheelAt > 180 || Math.sign(wheelAccumulated) !== Math.sign(delta)) wheelAccumulated = 0
  lastWheelAt = now
  wheelAccumulated += delta * unit
  if (Math.abs(wheelAccumulated) < 40) return
  const dir = wheelAccumulated > 0 ? 1 : -1
  wheelAccumulated = 0
  move(dir)
}

/** 切换到指定索引 */
function selectIndex(index: number): void {
  const clamped = Math.max(0, Math.min(index, heroCandidates.value.length - 1))
  if (clamped === currentIndex.value) return
  slideDirection.value = clamped > currentIndex.value ? 1 : -1
  currentIndex.value = clamped
}

/** 相对移动（循环） */
function move(dir: 1 | -1): void {
  if (heroCandidates.value.length < 2) return
  const next = (currentIndex.value + dir + heroCandidates.value.length) % heroCandidates.value.length
  selectIndex(next)
}

/** 键盘导航 */
function onKeyDown(event: KeyboardEvent): void {
  if (event.key === 'ArrowRight') { event.preventDefault(); move(1) }
  else if (event.key === 'ArrowLeft') { event.preventDefault(); move(-1) }
  else if (event.key === 'Home') { event.preventDefault(); selectIndex(0) }
  else if (event.key === 'End') { event.preventDefault(); selectIndex(heroCandidates.value.length - 1) }
}

/** 启动按钮文案三态：运行中 / 继续游玩 / 启动游戏 */
const playLabel = computed(() => {
  const g = heroGame.value
  if (!g) return t('hero_launch')
  if (running.value) return t('detail_running')
  return g.playMs > 0 ? t('hero_launch_ctd') : t('hero_launch')
})

/** 眉标叙事文案：继续上次的故事 / 从这里开始 / 下一段故事 */
const heroTag = computed(() => {
  if (!heroGame.value) return ''
  if (currentIndex.value === 0 && isLastPlayed.value) return t('hero_tag_ctd')
  if (isNeverPlayed.value) return t('hero_tag_fresh')
  return t('hero_tag_next')
})

function launch(): void {
  const g = heroGame.value
  if (g) void launchGame(g.id)
}

function openDetail(): void {
  const g = heroGame.value
  if (g) selectGame(g.id)
}

onMounted(() => {
  window.addEventListener('keydown', onKeyDown)
})
onUnmounted(() => {
  window.removeEventListener('keydown', onKeyDown)
})

/** 候选集变化（扫描/新增/删除）时，把索引收敛到合法范围 */
watch(heroCandidates, (candidates) => {
  if (!candidates.length) {
    currentIndex.value = 0
    return
  }
  if (currentIndex.value >= candidates.length) {
    currentIndex.value = candidates.length - 1
    slideDirection.value = -1
  }
})
</script>

<template>
  <div v-if="heroGame" class="hero glass" :class="{ running }">
    <!-- 静止的选择轨与计数器（不参与切换动画） -->
    <div class="hero-picker" @wheel.passive="onWheel" @keydown="onKeyDown">
      <button
        v-for="(game, index) in heroCandidates"
        :key="game.id"
        type="button"
        role="tab"
        :aria-selected="index === currentIndex"
        :tabindex="index === currentIndex ? 0 : -1"
        :title="game.title"
        class="hero-choice"
        @click="selectIndex(index)"
      >
        <span class="hero-thumb">
          <img
            v-if="game.thumbPath || game.coverPath"
            :src="game.thumbPath ? thumbUrl(game) : `file://${encodeURI(game.coverPath!.replace(/\\/g, '/'))}`"
            :alt="game.title"
            :loading="index < 10 ? 'eager' : 'lazy'"
            class="h-full w-full object-cover"
          />
        </span>
        <span class="hero-caption">{{ game.title }}</span>
      </button>
    </div>

    <!-- 底部计数器 + 进度条 -->
    <div class="hero-counter" v-if="heroCandidates.length > 1">
      <span aria-live="polite">{{ currentIndex + 1 }} / {{ heroCandidates.length }}</span>
      <div class="hero-progress">
        <div class="hero-progress-fill" :style="{ width: `${((currentIndex + 1) / heroCandidates.length) * 100}%` }"></div>
      </div>
    </div>

    <!-- 内容层：:key 随选中索引整体替换，进场播 slide-in 动画。
         刻意不用 Vue 的 out-in 过渡：离场节点会与新节点短暂并存，
         同一选择器（.hero-title 等）会随机命中旧内容，UI 与断言都不确定。 -->
    <div
      :key="currentIndex"
      class="hero-animated"
      :style="{ '--slide-direction': slideDirection }"
    >
        <div class="hero-bg" :style="heroBg ? { backgroundImage: `url(${heroBg})` } : {}"></div>
        <div class="hero-scrim-v"></div>
        <div class="hero-scrim-h"></div>
        <div class="hero-mask"></div>
        <div class="hero-cover">
          <img v-if="heroBg" :src="heroBg" :alt="heroGame.title" loading="lazy" />
        </div>
        <div class="hero-body">
          <div class="hero-tag">{{ heroTag }}</div>
          <div class="hero-title" :title="heroGame.title">{{ heroGame.title }}</div>
          <div class="hero-sub">
            <span v-if="heroGame.developer">{{ heroGame.developer }}</span>
            <span v-if="heroGame.rating" class="num">
              <Star :size="12" :fill="starColor" :stroke-width="0" /> {{ heroGame.rating.toFixed(1) }}
            </span>
          </div>
        </div>
        <div class="hero-actions">
          <button class="hero-play" @click="launch">
            <Play :size="16" :fill="'currentColor'" />
            {{ playLabel }}
          </button>
          <button class="hero-detail" @click="openDetail">{{ t('hero_detail') }}</button>
        </div>
      </div>
  </div>
</template>

<style scoped>
/* 氛围横带：整条是一个圆角卡片，背景封面模糊铺满 + 双层 scrim 压对比。 */
/* 氛围横带：picker(142) 在上、内容(封面 104 + 底距 16) 在下，合计 262px。
   少于 262 会挤掉封面或让内容溢出 picker 区。 */
.hero {
  position: relative;
  flex: none;
  height: 262px;
  border-radius: var(--hh-radius-panel);
  overflow: hidden;
  display: block;
  padding: 0;
  margin: 0 0 2px;
  isolation: isolate;
}

.hero-bg {
  position: absolute;
  inset: 0;
  background-size: cover;
  background-position: center 32%;
  filter: blur(34px) saturate(1.35);
  transform: scale(1.15);
  opacity: 0.5;
  pointer-events: none;
}

/* 纵向遮罩：上下压中间透
   变量名走 --hh-color-* 前缀：applyCssVars 对 color group 的键统一加 -color- 中缀 */
.hero-scrim-v {
  position: absolute;
  inset: 0;
  background: var(--hh-color-hero-scrim-v);
  pointer-events: none;
}

/* 横向遮罩：从右往左渐重，左下文字区最重 */
.hero-scrim-h {
  position: absolute;
  inset: 0;
  background: var(--hh-color-hero-scrim-h);
  pointer-events: none;
}

/* 封面左右羽化：mask-image 渐隐两侧，右侧 86% 开始透 */
.hero-mask {
  position: absolute;
  inset: 0;
  -webkit-mask-image: linear-gradient(90deg, transparent, var(--hh-color-hero-mask-black) 14%, var(--hh-color-hero-mask-black) 86%, transparent);
  mask-image: linear-gradient(90deg, transparent, var(--hh-color-hero-mask-black) 14%, var(--hh-color-hero-mask-black) 86%, transparent);
  pointer-events: none;
}

.hero-cover {
  position: relative;
  z-index: 1;
  width: 76px;
  height: 104px;
  border-radius: var(--hh-radius-sm);
  overflow: hidden;
  flex-shrink: 0;
  box-shadow:
    0 10px 28px var(--hh-color-shade-thumb),
    inset 0 0 0 1px var(--hh-color-border-ghost-soft);
}
.hero-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.hero-body {
  position: relative;
  z-index: 1;
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.hero-tag {
  font-size: var(--hh-font-caption-size);
  letter-spacing: 0.14em;
  color: var(--hh-color-on-cover-text-soft);
  font-weight: 600;
}

.hero-title {
  font-size: var(--hh-font-title-size);
  line-height: 28px;
  font-weight: 700;
  color: var(--hh-color-on-cover-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  text-shadow: 0 1px 8px var(--hh-shade-text);
}

.hero-sub {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: var(--hh-font-caption-size);
  color: var(--hh-color-on-cover-text-soft);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  text-shadow: 0 1px 6px var(--hh-shade-text);
}

/* 封面轨贴在 hero 顶部；绝对定位使其不受下方内容流影响 */
.hero-picker {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: 2;
  display: flex;
  align-items: flex-start;
  gap: 12px;
  height: 142px;
  padding: 8px 22px;
  overflow-x: auto;
  overflow-y: hidden;
  overscroll-behavior-x: contain;
  scrollbar-width: none;
  user-select: none;
}
.hero-picker::-webkit-scrollbar { display: none; }

.hero-choice {
  display: flex;
  flex: 0 0 76px;
  min-width: 0;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  color: var(--hh-color-on-cover-text);
  text-align: center;
  outline: none;
  background: none;
  border: none;
  cursor: pointer;
  transition: flex-basis 280ms cubic-bezier(0.22, 1, 0.36, 1);
}
.hero-thumb {
  display: block;
  width: 72px;
  height: 72px;
  overflow: hidden;
  border: 1px solid var(--hh-color-on-cover-chip-border);
  border-radius: var(--hh-radius-md);
  background: rgba(0,0,0,0.35);
  box-shadow: 0 5px 16px rgba(0,0,0,0.25);
  opacity: 0.72;
  transition: width 280ms cubic-bezier(0.22, 1, 0.36, 1), height 280ms cubic-bezier(0.22, 1, 0.36, 1), opacity 180ms ease, box-shadow 180ms ease, border-color 180ms ease;
}
.hero-choice[aria-selected="true"] { flex-basis: 106px; }
.hero-choice[aria-selected="true"] .hero-thumb {
  width: 100px;
  height: 100px;
  opacity: 1;
  border-color: white;
  box-shadow:
    0 0 0 3px rgba(8,12,25,0.5),
    0 0 0 5px rgba(255,255,255,0.88),
    0 8px 24px rgba(0,0,0,0.35);
}
.hero-choice:hover .hero-thumb { opacity: 1; }
.hero-choice:focus-visible .hero-thumb { outline: 3px solid var(--hh-accent-focus-ring); outline-offset: 7px; }
.hero-caption {
  width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  line-height: 18px;
  opacity: 0;
  transition: opacity 180ms ease;
}
.hero-choice[aria-selected="true"] .hero-caption,
.hero-choice:hover .hero-caption,
.hero-choice:focus-visible .hero-caption { opacity: 1; }

/* 计数器与进度条：贴 hero 右上（picker 区域内），避免与底部动作区重叠 */
.hero-counter {
  position: absolute;
  top: 8px;
  right: 22px;
  z-index: 3;
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 11px;
  color: var(--hh-color-on-cover-text-soft);
}
.hero-progress {
  flex: 1;
  height: 2px;
  background: var(--hh-color-on-cover-glass-border);
  border-radius: var(--hh-radius-pill);
  overflow: hidden;
}
.hero-progress-fill {
  height: 100%;
  background: var(--hh-color-on-cover-text);
  transition: width 300ms cubic-bezier(0.22, 1, 0.36, 1);
}

.hero-actions {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  /* body 之后靠右：actions 是 row 布局的最后一项 */
  margin-left: auto;
  padding-bottom: 4px;
}

/* 主按钮：白底黑字（压图最稳） */
.hero-play {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 38px;
  padding: 0 22px;
  border: none;
  border-radius: var(--hh-radius-pill);
  background: white;
  color: var(--hh-color-hero-btn-text);
  font-size: var(--hh-font-bodyLg-size);
  font-weight: 600;
  cursor: pointer;
  transition: background 180ms ease, box-shadow 180ms ease;
  box-shadow: 0 0 0 3px rgba(255,255,255,0.25);
}
.hero-play:hover { background: var(--hh-color-hero-btn-hover); box-shadow: 0 0 0 3px rgba(255,255,255,0.35); }
.hero-play:focus-visible { outline: 2px solid white; outline-offset: 4px; }
.hero-play:disabled { opacity: 0.6; cursor: wait; }

/* 次按钮：玻璃拟态 */
.hero-detail {
  height: 38px;
  padding: 0 16px;
  border: 1px solid var(--hh-color-on-cover-glass-border);
  border-radius: var(--hh-radius-pill);
  background: var(--hh-color-on-cover-glass-bg);
  color: var(--hh-color-on-cover-text);
  font-size: var(--hh-font-body-size);
  font-weight: 500;
  cursor: pointer;
  transition: background 180ms ease;
  backdrop-filter: blur(10px);
}
.hero-detail:hover { background: var(--hh-color-on-cover-chip-bg); }

.hero.running .hero-play {
  background: var(--hh-success);
  color: var(--hh-on-success);
}

/* 动画容器：承载背景/遮罩/前景/动作区的整体切换 */
/* 文案与动作区：绝对定位铺满，但顶部让出 picker 的 142px，
   内容贴底部；否则封面（104px 贴底）会与封面轨重叠 */
.hero-animated {
  position: absolute;
  inset: 0;
  z-index: 1;
  display: flex;
  flex-direction: row;
  align-items: flex-end;
  justify-content: flex-start;
  gap: 18px;
  padding: 142px 22px 16px;
}

/* 进场动画：:key 变化即重新挂载，animation 每次都会播放（无离场，节点直接替换） */
.hero-animated {
  animation: hero-slide-in 300ms cubic-bezier(0.22, 1, 0.36, 1) both;
}
@keyframes hero-slide-in {
  from { opacity: 0; transform: translateX(calc(var(--slide-direction, 1) * 2%)); }
  to { opacity: 1; transform: translateX(0); }
}

@media (prefers-reduced-motion: reduce) {
  .hero-animated { animation: none; }
}

/* 窄屏 */
@media (max-width: 720px) {
  /* 窄窗：封面轨 122 + 封面 88 + 底距 16 = 226 */
  .hero { height: 226px; }
  .hero-picker { height: 122px; gap: 10px; padding: 8px 16px; }
  .hero-counter { top: 6px; right: 16px; }
  .hero-animated { padding: 122px 16px 12px; gap: 12px; }
  .hero-cover { width: 62px; height: 88px; }
  .hero-detail { display: none; }
  .hero-thumb { width: 64px; height: 64px; border-radius: var(--hh-radius-md); }
  .hero-choice { flex: 0 0 68px; }
  .hero-choice[aria-selected="true"] { flex-basis: 92px; }
  .hero-choice[aria-selected="true"] .hero-thumb { width: 88px; height: 88px; border-radius: var(--hh-radius-md); }
}
</style>
