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
 * 5) B3：封面轨与主角封面统一竖版比例（var(--hh-layout-cover-ratio)）；标题/正文区在
 *    picker 之下分区不重叠；氛围 bloom 降一档；总时长类 KPI 并入首屏 KpiStrip，hero 只留续读进度。
 */

import { computed, ref, onMounted, onUnmounted, watch } from 'vue'
import { Loader2, Play, Star } from 'lucide-vue-next'
import type { Game } from '../../shared/types'
import { selectGame, launchGame, thumbUrl, filteredGames, launchingGames, runningGames } from '../stores/library'
import { t } from '../i18n'
import { tokens } from '../design/tokens'

/** 星级色（跟随主题 tokens，同 CoverGrid/DetailPanel 的评级星一致） */
const starColor = computed(() => tokens.color.star)

/** 续读进度：按「最近玩过」候选当前主角的 playMs 估算（无时长显示 0%）。
 *  首屏总时长/已玩/本月等 KPI 已并入 App.vue 的 KpiStrip（lead 负责），
 *  hero 只留这一条与"继续游玩"叙事直接相关的进度。 */
const continuePct = computed(() => {
  const g = heroGame.value
  if (!g || !g.playMs || g.playMs <= 0) return 0
  // 粗略锚点：10 小时视为「玩了很久」，进度条只是氛围不是精确统计
  return Math.min(100, Math.round((g.playMs / (10 * 3600000)) * 100))
})

/** 是否有可展示封面（thumb 或 cover） */
function hasCover(g: Game): boolean {
  return !!(g.thumbPath || g.coverPath)
}

/**
 * 候选集：跟随当前过滤视图（搜索/分类/智能列表/元数据聚合）。
 *
 * 刻意不做「视图为空时回退全量」：实测（用户截图）那样会出现上面横幅在讲
 * 某部游戏、下面正文却写「没有匹配的游戏」的自相矛盾画面——横幅与封面墙
 * 必须说同一件事，视图空了就一起空，空态由正文去表达。
 */
const heroCandidates = computed<Game[]>(() => {
  const games = filteredGames.value
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
const running = computed(() => !!heroGame.value && runningGames.value.has(heroGame.value.id))

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

/** 启动按钮文案四态：启动中 / 运行中 / 继续游玩 / 启动游戏 */
const launching = computed(() => !!heroGame.value && launchingGames.value.has(heroGame.value.id))
const playLabel = computed(() => {
  const g = heroGame.value
  if (!g) return t('hero_launch')
  if (launching.value) return t('hero_launching')
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
          <button class="hero-play" :disabled="launching || running" :aria-busy="launching" @click="launch">
            <Loader2 v-if="launching" :size="16" class="hero-spin" />
            <Play v-else :size="16" :fill="'currentColor'" />
            {{ playLabel }}
          </button>
          <button class="hero-detail" @click="openDetail">{{ t('hero_detail') }}</button>
        </div>
        <!-- 续读进度玻璃条：总时长/已玩/本月 KPI 已并入首屏 KpiStrip（App.vue），
             hero 只留与续读叙事挂钩的进度一条 -->
        <div class="hero-stats" aria-hidden="true">
          <div class="hs-prog">
            <div class="hs-prog-head">
              <span class="hs-cap">{{ t('hero_stat_continue') }}</span>
              <span class="num hs-pct">{{ continuePct }}%</span>
            </div>
            <div class="hs-bar"><div class="hs-fill" :style="{ width: `${continuePct}%` }"></div></div>
          </div>
        </div>
      </div>
  </div>
</template>

<style scoped>
/* 氛围横带：整条是一个圆角卡片，背景封面模糊铺满 + 双层 scrim 压对比。 */
/* 氛围横带：picker(170) 在上、内容(封面 132 + 底距 16) 在下，合计 340px。
   340 让默认视图第一眼更有剧照冲击（对比 gal-launcher 的 hero 占视口比例）；
   少于 340 会挤掉封面或让内容溢出 picker 区。 */
.hero {
  position: relative;
  flex: none;
  height: 340px;
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
  filter: blur(30px) saturate(1.3);
  transform: scale(1.15);
  /* 氛围层降一档：KPI 并入首屏 KpiStrip 后，hero 背景只是陪衬，
     大面积 bloom 会把注意力从主角封面抢走 */
  opacity: 0.35;
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
  width: 99px;
  /* 竖版封面统一走 token（99 × 4/3 = 132，与 .hero-animated 的构图注释一致） */
  aspect-ratio: var(--hh-layout-cover-ratio);
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
  align-items: center;
  justify-content: center;
  gap: 5px;
  text-align: center;
  padding: 0 12px;
}
/* tag 保持小写距但居中；标题保留衬线大字（剧照感的核心是居中大字） */
.hero-tag {
  text-align: center;
}

.hero-tag {
  font-size: var(--hh-font-caption-size);
  letter-spacing: 0.14em;
  color: var(--hh-color-on-cover-text-soft);
  font-weight: 600;
  /* 眉标是短标签（继续上次的故事…），绝不折行：折成三行会挤垮标题区 */
  white-space: nowrap;
}

.hero-title {
  font-family: 'Instrument Serif', 'Noto Serif SC', 'Source Han Serif SC', 'Songti SC', 'SimSun', Georgia, serif;
  font-size: 30px;
  line-height: 1.08;
  font-weight: 600;
  color: var(--hh-color-on-cover-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  text-shadow: 0 2px 16px var(--hh-shade-text);
  letter-spacing: 0.01em;
}

.hero-sub {
  display: flex;
  align-items: center;
  justify-content: center;
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
  height: 170px;
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
  /* 封面轨竖版化：宽高走 --hh-layout-cover-ratio（72 → 96；选中 96 → 128，
     128 + gap 8 + caption 18 + padding 8 = 162 ≤ picker 170，轨与文字区不重叠） */
  width: 72px;
  aspect-ratio: var(--hh-layout-cover-ratio);
  overflow: hidden;
  border: 1px solid var(--hh-color-on-cover-chip-border);
  border-radius: var(--hh-radius-md);
  background: rgba(0,0,0,0.35);
  box-shadow: 0 5px 16px rgba(0,0,0,0.25);
  opacity: 0.72;
  transition: width 280ms cubic-bezier(0.22, 1, 0.36, 1), height 280ms cubic-bezier(0.22, 1, 0.36, 1), opacity 180ms ease, box-shadow 180ms ease, border-color 180ms ease;
}
.hero-choice[aria-selected="true"] { flex-basis: 112px; }
.hero-choice[aria-selected="true"] .hero-thumb {
  width: 96px;
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
/* 启动中：图标旋转，让空窗期有明确反馈（按钮禁用防重复启动） */
.hero-spin { animation: hero-spin 900ms linear infinite; }
@keyframes hero-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .hero-spin { animation: none; } }

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

/* ============ 续读进度玻璃条（KPI 已并入首屏 KpiStrip，这里只留续读） ============ */
.hero-stats {
  position: relative;
  z-index: 1;
  flex-shrink: 0;
  width: 168px;
  padding: 12px 14px;
  border-radius: var(--hh-radius-md);
  border: 1px solid var(--hh-color-on-cover-glass-border);
  background: var(--hh-color-on-cover-glass-bg);
  backdrop-filter: blur(14px);
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.hs-cap {
  font-size: var(--hh-font-caption-size);
  letter-spacing: 0.1em;
  color: var(--hh-color-on-cover-text-soft);
  white-space: nowrap;
}
.hs-prog {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin-top: 2px;
}
.hs-prog-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}
.hs-pct {
  font-size: var(--hh-font-caption-size);
  font-weight: 600;
  color: var(--hh-color-on-cover-text);
}
.hs-bar {
  height: 4px;
  border-radius: var(--hh-radius-pill);
  background: var(--hh-color-on-cover-glass-border);
  overflow: hidden;
}
.hs-fill {
  height: 100%;
  border-radius: var(--hh-radius-pill);
  background: linear-gradient(90deg, var(--hh-color-accent), var(--hh-color-on-cover-text));
  box-shadow: 0 0 8px var(--hh-color-accent-shadow);
  transition: width 300ms cubic-bezier(0.22, 1, 0.36, 1);
}
/* 窄窗：统计卡隐藏（封面轨/内容优先） */
@media (max-width: 720px) {
  .hero-stats {
    display: none;
  }
}

.hero.running .hero-play {
  background: var(--hh-success);
  color: var(--hh-on-success);
}

/* 动画容器：承载背景/遮罩/前景/动作区的整体切换 */
/* 文案与动作区：绝对定位铺满，但顶部让出 picker 的 170px，
   内容贴底部；否则封面（132px 贴底）会与封面轨重叠 */
.hero-animated {
  position: absolute;
  inset: 0;
  z-index: 1;
  display: flex;
  flex-direction: row;
  align-items: flex-end;
  justify-content: flex-start;
  gap: 18px;
  padding: 170px 22px 16px;
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
  .hero-cover { width: 66px; }
  .hero-detail { display: none; }
  .hero-thumb { width: 54px; border-radius: var(--hh-radius-md); }
  .hero-choice { flex: 0 0 68px; }
  .hero-choice[aria-selected="true"] { flex-basis: 92px; }
  .hero-choice[aria-selected="true"] .hero-thumb { width: 66px; border-radius: var(--hh-radius-md); }
}
</style>
