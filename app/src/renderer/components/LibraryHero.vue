<script setup lang="ts">
/**
 * 首页「Continue」大卡（B8，对标基准 home.png 的 Continue Game 卡）。
 *
 * 结构（类名是 HomeView / verify 脚本的接线契约，不许随意改名）：
 *   aside.hero
 *     .hero-main 左列：.hero-kicker（继续游玩 chip）/ h2.hero-title（左置粗体
 *       sans，2 行 clamp）/ .hero-native（原名）/ .hero-meta（上次游玩 +
 *       本周·总计）/ .hero-actions（.hero-play 四态 + .hero-detail 跳库）/
 *       .hero-recent（最近游玩 chips，点击切换候选）
 *     .hero-cover 右列：竖版封面（var(--hh-layout-cover-ratio)），点击 = 跳库页选中；
 *       NSFW 未揭示时 blur 滤镜，点击临时揭示（与封面墙同口径）。
 *   候选全空 → 渲染 .hero-empty 文案（hero 缺席但页面不空洞）。
 *
 * 退役：顶部封面轨（picker/计数器）、续读进度玻璃条、RecentStrip——
 * 切换候选的职能由 .hero-recent 承接，全局 KPI 由 HomeView 顶部 KPI 面板承接。
 * 保留：候选集跟随 filteredGames 视图、键盘左右/首尾切换、启动四态、切换滑入动画。
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { Loader2, Play } from 'lucide-vue-next'
import type { Game } from '../../shared/types'
import { isNsfwGame } from '../../shared/nsfw'
import { selectGame, launchGame, thumbUrl, filteredGames, launchingGames, runningGames } from '../stores/library'
import { loadSessions, sumMs } from '../stores/sessions'
import { ui } from '../stores/ui'
import { ONE_DAY_MS, dayKey, dayStart, fmtDurMs } from '../../shared/format'
import { t, tf } from '../i18n'

/** 是否有可展示封面（thumb 或 cover） */
function hasCover(g: Game): boolean {
  return !!(g.thumbPath || g.coverPath)
}

/**
 * 候选集：跟随当前过滤视图（搜索/分类/智能列表/元数据聚合）。
 *
 * 刻意不做「视图为空时回退全量」：上面卡片在讲某部游戏、正文却写「没有匹配的
 * 游戏」是自相矛盾——卡片与封面墙必须说同一件事，视图空了就一起空。
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

/** 封面图 URL（thumb 优先，cover 兜底 encodeURI） */
function coverSrc(g: Game): string {
  if (g.thumbPath) return thumbUrl(g)
  if (g.coverPath) return `file://${encodeURI(g.coverPath.replace(/\\/g, '/'))}`
  return ''
}
const heroBg = computed(() => (heroGame.value ? coverSrc(heroGame.value) : ''))

/** 运行中状态 */
const running = computed(() => !!heroGame.value && runningGames.value.has(heroGame.value.id))

/** NSFW 临时揭示集合（点击封面解除，切换候选不重置——与封面墙同语义的单次揭示） */
const revealedNsfw = ref(new Set<string>())
function nsfwHidden(g: Game): boolean {
  return isNsfwGame(g.tags) && !revealedNsfw.value.has(g.id)
}

/** 最近游玩 chips：候选集中「玩过」的前 4 个（候选排序保证最近在前）。
 *  idx 记录其在候选集中的位置，点击 = 切换 hero 候选。 */
const recentChips = computed(() =>
  heroCandidates.value
    .map((g, idx) => ({ g, idx }))
    .filter(({ g }) => !!g.lastPlayed)
    .slice(0, 4),
)

/** 上次游玩的相对显示：今天 / 昨天 / 日期（yyyy-mm-dd）。
 *  「N 天前」需要词典新键，暂未加——先退到日期，语义不丢。 */
function fmtPlayed(ts?: number): string {
  if (!ts) return ''
  const k = dayKey(ts)
  if (k === dayKey(Date.now())) return t('recent_today')
  if (k === dayKey(Date.now() - ONE_DAY_MS)) return t('recent_yesterday')
  return k
}

/** 当前主角近 7 天（本周一 00:00 起）游玩时长：走会话明细 store，不自己造轮子 */
const weekMs = ref(0)
async function refreshHeroWeek(): Promise<void> {
  const g = heroGame.value
  if (!g) {
    weekMs.value = 0
    return
  }
  try {
    const list = await loadSessions({ gameId: g.id, limit: 500 })
    const now = Date.now()
    const dow = (new Date(now).getDay() + 6) % 7
    weekMs.value = sumMs(list, dayStart(now - dow * ONE_DAY_MS))
  } catch {
    weekMs.value = 0
  }
}
const weekText = computed(() => fmtDurMs(weekMs.value))
const totalText = computed(() => fmtDurMs(heroGame.value?.playMs ?? 0))

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

/** 键盘导航（左右切换 / Home End 首尾）。输入控件聚焦时不劫持按键——
 *  首页没有工具栏搜索框，但对话框/其他页输入框还在，方向键归输入框。 */
function onKeyDown(event: KeyboardEvent): void {
  const el = document.activeElement
  if (el instanceof HTMLElement && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return
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

function launch(): void {
  const g = heroGame.value
  if (g) void launchGame(g.id)
}

/** 跳库页并选中当前主角（首页没有右栏详情，详情在库里看） */
function goLibrary(): void {
  const g = heroGame.value
  if (!g) return
  ui.page = 'library'
  selectGame(g.id)
}

/** 封面点击：NSFW 未揭示 → 临时揭示；否则跳库页选中 */
function onCoverClick(): void {
  const g = heroGame.value
  if (!g) return
  if (nsfwHidden(g)) {
    revealedNsfw.value.add(g.id)
    return
  }
  goLibrary()
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

/** 主角换了就重取该款的会话明细（近 7 天时长挂在主角身上，跟着换） */
watch(heroGame, () => void refreshHeroWeek(), { immediate: true })
</script>

<template>
  <aside v-if="heroGame" class="hero glass" :class="{ running }">
    <div class="hero-bg" :style="heroBg ? { backgroundImage: `url(${heroBg})` } : {}" aria-hidden="true"></div>
    <div class="hero-scrim-v" aria-hidden="true"></div>
    <div class="hero-scrim-h" aria-hidden="true"></div>

    <!-- :key 随选中索引整体替换，进场播 slide-in（无离场，节点直接替换——
         刻意不用 out-in 过渡，旧节点残留会让 .hero-title 断言命中旧内容） -->
    <div :key="currentIndex" class="hero-animated" :style="{ '--slide-direction': slideDirection }">
      <div class="hero-main">
        <span class="hero-kicker">{{ t('home_continue') }}</span>
        <h2 class="hero-title" :title="heroGame.title">{{ heroGame.title }}</h2>
        <div
          v-if="heroGame.titleNative && heroGame.titleNative !== heroGame.title"
          class="hero-native"
          :title="heroGame.titleNative"
        >
          {{ heroGame.titleNative }}
        </div>
        <div class="hero-meta">
          <span v-if="heroGame.lastPlayed" class="hm-line">{{ tf('home_last_played', { date: dayKey(heroGame.lastPlayed) }) }}</span>
          <span class="hm-line">{{ tf('home_hero_meta', { week: weekText, total: totalText }) }}</span>
        </div>

        <div class="hero-actions">
          <button class="hero-play" :disabled="launching || running" :aria-busy="launching" @click="launch">
            <Loader2 v-if="launching" :size="16" class="hero-spin" />
            <Play v-else :size="16" :fill="'currentColor'" />
            {{ playLabel }}
          </button>
          <button class="hero-detail" @click="goLibrary">{{ t('hero_detail') }}</button>
        </div>
      </div>

      <!-- 最近游玩 chips：基准口径 = 卡底通栏一横排（只占封面左侧的区域），
           不是嵌在文本列里竖着堆。取代旧封面轨 + RecentStrip，点击切换主角 -->
      <div v-if="recentChips.length" class="hero-recent">
        <span class="hero-recent-label">{{ t('home_recent') }}</span>
        <div class="hero-recent-chips">
          <button
            v-for="chip in recentChips"
            :key="chip.g.id"
            type="button"
            class="hero-recent-chip"
            :class="{ current: chip.idx === currentIndex }"
            :title="chip.g.title"
            @click="selectIndex(chip.idx)"
          >
            <span class="hero-recent-thumb">
              <img
                v-if="coverSrc(chip.g)"
                :src="coverSrc(chip.g)"
                :alt="chip.g.title"
                loading="lazy"
                :class="{ 'nsfw-blur': nsfwHidden(chip.g) }"
              />
            </span>
            <span class="hero-recent-body">
              <span class="hero-recent-title">{{ chip.g.title }}</span>
              <span class="hero-recent-time">{{ fmtPlayed(chip.g.lastPlayed) }}</span>
            </span>
          </button>
        </div>
      </div>

      <button type="button" class="hero-cover" :title="heroGame.title" @click="onCoverClick">
        <img
          v-if="heroBg"
          :src="heroBg"
          :alt="heroGame.title"
          loading="lazy"
          :class="{ 'nsfw-blur': nsfwHidden(heroGame) }"
        />
        <span v-else class="hero-cover-letter">{{ heroGame.title.slice(0, 2) }}</span>
      </button>
    </div>
  </aside>

  <!-- 候选全空（库空或被过滤光）：hero 缺席但留一句人话，不渲染 .hero -->
  <div v-else class="hero-empty glass">{{ t('home_hero_empty') }}</div>
</template>

<style scoped>
/* ============ Continue 大卡 ============ */
/* 基准口径：左列文字 + 右列竖版封面，整卡一张圆角面板；
   氛围模糊底图 + 双层 scrim 只为左列文字可读，不再抢注意力。 */
.hero {
  position: relative;
  display: flex;
  flex: none;
  min-height: 280px;
  border-radius: var(--hh-radius-panel);
  overflow: hidden;
  padding: 0;
  isolation: isolate;
}

.hero-bg {
  position: absolute;
  inset: 0;
  background-size: cover;
  background-position: center 35%;
  filter: blur(30px) saturate(1.3);
  transform: scale(1.15);
  opacity: 0.28;
  pointer-events: none;
}

.hero-scrim-v {
  position: absolute;
  inset: 0;
  background: var(--hh-color-hero-scrim-v);
  pointer-events: none;
}

/* 横向遮罩：从右往左渐重，左列文字区最重、右侧封面区最轻 */
.hero-scrim-h {
  position: absolute;
  inset: 0;
  background: var(--hh-color-hero-scrim-h);
  pointer-events: none;
}

/* 基准口径的网格：右列封面通贯两行，左上文字、左下最近游玩通栏横排 */
.hero-animated {
  position: relative;
  z-index: 1;
  width: 100%;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 224px;
  grid-template-areas:
    'main cover'
    'recent cover';
  align-items: start;
  gap: var(--hh-space-x6) var(--hh-space-x8);
  padding: var(--hh-space-x6) var(--hh-space-x8);
  animation: hero-slide-in 300ms cubic-bezier(0.22, 1, 0.36, 1) both;
}
@keyframes hero-slide-in {
  from {
    opacity: 0;
    transform: translateX(calc(var(--slide-direction, 1) * 2%));
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
}
@media (prefers-reduced-motion: reduce) {
  .hero-animated {
    animation: none;
  }
}

/* 左列：基准口径 = 左置左对齐，不是居中大字 */
.hero-main {
  grid-area: main;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--hh-space-x2);
}

/* kicker chip：accent 实色（基准 Continue Game 蓝 chip 的口径） */
.hero-kicker {
  background: var(--hh-color-accent);
  color: var(--hh-color-on-accent);
  border-radius: var(--hh-radius-pill);
  padding: 4px 12px;
  font-size: var(--hh-font-caption-size);
  font-weight: 700;
  letter-spacing: 0.04em;
}

/* 大标题：sans 粗体 + 左对齐 + 2 行 clamp（衬线居中大字那套废弃） */
.hero-title {
  margin: 0;
  font-size: var(--hh-font-page-head-size);
  line-height: var(--hh-font-page-head-lh);
  font-weight: 700;
  color: var(--hh-color-on-cover-text);
  text-shadow: 0 2px 16px var(--hh-shade-text);
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  overflow-wrap: break-word;
}

.hero-native {
  max-width: 100%;
  font-size: var(--hh-font-caption-size);
  color: var(--hh-color-on-cover-text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.hero-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: var(--hh-font-caption-size);
  color: var(--hh-color-on-cover-text-soft);
  max-width: 100%;
}
.hm-line {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-variant-numeric: tabular-nums;
}

.hero-actions {
  display: flex;
  align-items: center;
  gap: var(--hh-space-x2);
  margin-top: var(--hh-space-x3);
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
  transition:
    background 180ms ease,
    box-shadow 180ms ease;
  box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.25);
}
.hero-play:hover {
  background: var(--hh-color-hero-btn-hover);
  box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.35);
}
.hero-play:focus-visible {
  outline: 2px solid white;
  outline-offset: 4px;
}
.hero-play:disabled {
  opacity: 0.6;
  cursor: wait;
}
/* 启动中：图标旋转，让空窗期有明确反馈（按钮禁用防重复启动） */
.hero-spin {
  animation: hero-spin 900ms linear infinite;
}
@keyframes hero-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .hero-spin {
    animation: none;
  }
}

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
.hero-detail:hover {
  background: var(--hh-color-on-cover-chip-bg);
}

/* ============ 最近游玩 chips（承接封面轨 + RecentStrip 的职能） ============ */
.hero-recent {
  grid-area: recent;
  width: 100%;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--hh-space-x2);
}
.hero-recent-label {
  font-size: var(--hh-font-caption-size);
  letter-spacing: 0.12em;
  font-weight: 600;
  color: var(--hh-color-on-cover-text-dim);
}
/* 基准是 4 枚一横排，但它的左区有 600px；我们 1280 窗里左区只有 ~320px，
   4 枚挤成 78px 宽、标题竖排成灾。改 2x2：单枚宽度与基准同款（~150px），
   只是排成两行——观感优先于行列数照抄。 */
.hero-recent-chips {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--hh-space-x2);
}
.hero-recent-chip {
  display: flex;
  align-items: center;
  gap: var(--hh-space-x2);
  min-width: 0;
  padding: 5px 10px 5px 5px;
  border: 1px solid var(--hh-color-on-cover-chip-border);
  border-radius: var(--hh-radius-md);
  background: var(--hh-color-on-cover-glass-bg);
  color: var(--hh-color-on-cover-text);
  cursor: pointer;
  text-align: left;
  transition:
    background var(--hh-motion-med) ease,
    border-color var(--hh-motion-med) ease;
}
.hero-recent-chip:hover {
  background: var(--hh-color-on-cover-chip-bg);
}
.hero-recent-chip.current {
  border-color: var(--hh-color-on-cover-rule);
}
.hero-recent-thumb {
  display: block;
  width: 34px;
  aspect-ratio: var(--hh-layout-cover-ratio);
  border-radius: var(--hh-radius-xs);
  overflow: hidden;
  flex-shrink: 0;
  background: var(--hh-color-surface-strong);
}
.hero-recent-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.hero-recent-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.hero-recent-title {
  font-size: var(--hh-font-body-size);
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.hero-recent-time {
  font-size: var(--hh-font-caption-size);
  color: var(--hh-color-on-cover-text-soft);
  font-variant-numeric: tabular-nums;
}

/* ============ 右列竖版封面（网格通贯两行，占满卡右侧全高） ============ */
.hero-cover {
  grid-area: cover;
  position: relative;
  z-index: 1;
  width: 224px;
  padding: 0;
  border: none;
  border-radius: var(--hh-radius-md);
  overflow: hidden;
  background: var(--hh-color-surface-strong);
  cursor: pointer;
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
/* NSFW：与封面墙同口径——模糊压住，点击临时揭示（chip 缩略图同理） */
.hero-cover img.nsfw-blur,
.hero-recent-thumb img.nsfw-blur {
  filter: blur(22px) saturate(0.9) brightness(0.8);
}
.hero-cover:focus-visible {
  outline: 2px solid var(--hh-color-on-cover-text);
  outline-offset: 2px;
}
/* 无封面兜底：大字标题占位（同封面墙海报口径） */
.hero-cover-letter {
  position: absolute;
  inset: 0;
  padding: var(--hh-space-x4);
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 4;
  overflow: hidden;
  justify-content: center;
  text-align: center;
  font-size: 28px;
  line-height: 1.3;
  font-weight: 700;
  color: var(--hh-color-on-cover-text);
  word-break: break-all;
}

/* ============ 空态 ============ */
.hero-empty {
  flex: none;
  padding: var(--hh-space-x8);
  border-radius: var(--hh-radius-panel);
  font-size: var(--hh-font-bodyLg-size);
  color: var(--hh-color-text-mid);
  text-align: center;
}

.hero.running .hero-play {
  background: var(--hh-success);
  color: var(--hh-on-success);
}

/* 窄窗：封面缩一档但保留（跳库入口 + NSFW 交互都在封面上） */
@media (max-width: 720px) {
  .hero-animated {
    grid-template-columns: minmax(0, 1fr) 150px;
    padding: var(--hh-space-x4) var(--hh-space-x6);
    gap: var(--hh-space-x4);
  }
  .hero-cover {
    width: 150px;
  }
  .hero-recent-chips {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
