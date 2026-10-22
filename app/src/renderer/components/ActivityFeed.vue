<script setup lang="ts">
/**
 * 右栏默认可见内容：游玩动态（基准 home.png 右栏 Activity 的仿制）。
 *
 * 对标要点（基准口径）：
 *   - 头部页签 全部/玩过/新增：事件流不止游玩会话，「入库」也是一等事件；
 *   - 每条带封面缩略图 + 图标（游戏手柄 / 加号），不是纯文字圆点；
 *   - 按日分组（今天/昨天/日期），组头带当日总时长；
 *   - 条目可点：跳到库页选中该游戏（基准点条目直接开详情）。
 * 我们的口径优势保留：本周时长常驻（基准没有，但这是「口径一致」主张的
 * 展示位——和首页 KPI、统计页同源取数）。
 */
import { computed, onMounted, ref } from 'vue'
import { Gamepad2, History, Plus, RefreshCw, Timer } from 'lucide-vue-next'
import { t, tf } from '../i18n'
import { library, thumbUrl } from '../stores/library'
import { dayBucketKey, refreshActivity, sessionsState, sumMs } from '../stores/sessions'
import { ONE_DAY_MS, fmtDurMs, fmtTime } from '../../shared/format'
import { ui } from '../stores/ui'

type FeedKind = 'all' | 'play' | 'added'
const feedKind = ref<FeedKind>('all')

/** 合并事件：play（会话）+ added（游戏入库）。ts 倒序；全部页签限 60 条，
 *  防库大时把会话事件全挤出首屏（基准 All 也是混合流 + 滚动加载） */
interface FeedItem {
  kind: 'play' | 'added'
  ts: number
  title: string
  gameId: string
  ms: number
}

const items = computed<FeedItem[]>(() => {
  const out: FeedItem[] = []
  if (feedKind.value !== 'added') {
    for (const s of sessionsState.list) out.push({ kind: 'play', ts: s.end, title: s.title, gameId: s.gameId, ms: s.ms })
  }
  if (feedKind.value !== 'play') {
    for (const g of library.games) {
      if (g.addedAt) out.push({ kind: 'added', ts: g.addedAt, title: g.title, gameId: g.id, ms: 0 })
    }
  }
  out.sort((a, b) => b.ts - a.ts)
  return feedKind.value === 'all' ? out.slice(0, 60) : out.slice(0, 120)
})

/** 按日分组（组键/排序与游玩动态既有口径一致：今天/昨天相对名，更早日期） */
const groups = computed(() => {
  const buckets = new Map<string, FeedItem[]>()
  for (const it of items.value) {
    const key = dayBucketKey(it.ts)
    const arr = buckets.get(key) ?? []
    arr.push(it)
    buckets.set(key, arr)
  }
  return [...buckets.entries()].map(([key, its]) => ({ key, items: its }))
})

const gamesById = computed(() => new Map(library.games.map((g) => [g.id, g])))

function coverOf(it: FeedItem): string {
  const g = gamesById.value.get(it.gameId)
  return g ? thumbUrl(g) : ''
}

function dayPlayMs(its: FeedItem[]): number {
  return its.reduce((a, it) => a + it.ms, 0)
}

/** 条目点击 = 库页选中该游戏（库已没有它就不跳——事件比库新的竞态很少但存在） */
function openGame(it: FeedItem): void {
  if (!gamesById.value.has(it.gameId)) return
  ui.page = 'library'
  library.selectedId = it.gameId
}

/** 本周起点（周一）——与「本周时长」的周口径一致 */
const weekStart = computed(() => {
  const d = new Date()
  const dow = (d.getDay() + 6) % 7
  d.setHours(0, 0, 0, 0)
  return d.getTime() - dow * ONE_DAY_MS
})
const weekMs = computed(() => sumMs(sessionsState.list, weekStart.value))
const loading = computed(() => sessionsState.loading)

onMounted(() => {
  void refreshActivity()
})

function dayName(key: string): string {
  return key === 'today' ? t('act_today') : key === 'yesterday' ? t('act_yesterday') : key
}

/** 「新增于」行的时间：只到日（入库事件没有时刻精度） */
function addedDate(ts: number): string {
  return fmtTime(ts)
}
</script>

<template>
  <section class="activity-feed" :aria-label="t('act_title')">
    <header class="af-head">
      <span class="af-title"><History :size="15" /> {{ t('act_title') }}</span>
      <div class="af-tabs" role="group">
        <button
          type="button"
          class="af-tab"
          :class="{ on: feedKind === 'all' }"
          :aria-pressed="feedKind === 'all'"
          @click="feedKind = 'all'"
        >
          {{ t('act_tab_all') }}
        </button>
        <button
          type="button"
          class="af-tab"
          :class="{ on: feedKind === 'play' }"
          :aria-pressed="feedKind === 'play'"
          @click="feedKind = 'play'"
        >
          {{ t('act_tab_played') }}
        </button>
        <button
          type="button"
          class="af-tab"
          :class="{ on: feedKind === 'added' }"
          :aria-pressed="feedKind === 'added'"
          @click="feedKind = 'added'"
        >
          {{ t('act_tab_added') }}
        </button>
      </div>
    </header>

    <div class="af-body">
      <p v-if="loading" class="af-empty">{{ t('act_refresh') }}…</p>
      <p v-else-if="!groups.length" class="af-empty">
        {{ feedKind === 'added' ? t('act_added_empty') : t('act_empty') }}
      </p>
      <template v-else>
        <div v-for="g in groups" :key="g.key" class="af-day">
          <div class="af-day-head">
            <span class="af-day-name">{{ dayName(g.key) }}</span>
            <span class="af-day-total">{{ fmtDurMs(dayPlayMs(g.items)) }}</span>
          </div>
          <button v-for="it in g.items" :key="`${it.kind}-${it.gameId}-${it.ts}`" class="af-item" type="button" @click="openGame(it)">
            <span class="af-ic" :class="{ 'af-ic-add': it.kind === 'added' }" aria-hidden="true">
              <Plus v-if="it.kind === 'added'" :size="12" />
              <Gamepad2 v-else :size="12" />
            </span>
            <span class="af-thumb">
              <img v-if="coverOf(it)" :src="coverOf(it)" :alt="it.title" loading="lazy" />
              <span v-else class="af-thumb-letter">{{ it.title.slice(0, 1) }}</span>
            </span>
            <span class="af-main">
              <span class="af-title-line" :title="it.title">
                {{ it.kind === 'added' ? tf('act_added', { title: it.title }) : tf('act_played', { title: it.title }) }}
              </span>
              <span class="af-meta">
                {{ it.kind === 'added' ? tf('act_added_meta', { date: addedDate(it.ts) }) : tf('act_meta', { n: 1, dur: fmtDurMs(it.ms) }) }}
              </span>
            </span>
          </button>
        </div>
      </template>
    </div>

    <footer class="af-foot">
      <button class="af-refresh" type="button" :title="t('act_refresh')" :disabled="loading" @click="refreshActivity()">
        <RefreshCw :size="13" />
        <span>{{ t('act_refresh') }}</span>
      </button>
      <span class="af-week" :title="t('act_week_short')">
        <Timer :size="13" />
        <span class="af-week-label">{{ t('act_week_short') }}</span>
        <strong class="af-week-value">{{ fmtDurMs(weekMs) }}</strong>
      </span>
    </footer>
  </section>
</template>

<style scoped>
.activity-feed {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--hh-color-panel-glass);
  border: 1px solid var(--hh-color-panel-glass-border);
  border-radius: var(--hh-radius-panel);
  overflow: hidden;
}

.af-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--hh-space-x3);
  padding: var(--hh-space-x3) var(--hh-space-x4);
  border-bottom: 1px solid var(--hh-color-border-faint);
  flex: none;
}

.af-title {
  display: flex;
  align-items: center;
  gap: var(--hh-space-x2);
  font-size: var(--hh-font-bodyLg-size);
  font-weight: 600;
  color: var(--hh-color-text-glow);
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
}

/* 全部/玩过/新增 页签（基准 Activity All|Played|Added 口径） */
.af-tabs {
  display: flex;
  background: var(--hh-color-surface-soft);
  border: 1px solid var(--hh-color-border-faint);
  border-radius: var(--hh-radius-pill);
  padding: 2px;
  flex: none;
}
.af-tab {
  border: none;
  background: transparent;
  color: var(--hh-color-text-mid);
  font-size: var(--hh-font-caption-size);
  font-family: inherit;
  padding: 3px 10px;
  border-radius: var(--hh-radius-pill);
  cursor: pointer;
  white-space: nowrap;
  transition:
    background var(--hh-motion-med),
    color var(--hh-motion-med);
}
.af-tab:hover {
  color: var(--hh-color-text-glow);
}
.af-tab.on {
  background: var(--hh-color-card-hover);
  color: var(--hh-color-text-glow);
  font-weight: 600;
}

.af-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--hh-space-x2) var(--hh-space-x4) var(--hh-space-x4);
}

.af-day + .af-day {
  margin-top: var(--hh-space-x2);
}

.af-day-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: var(--hh-space-x2) 0 var(--hh-space-x1);
  position: sticky;
  top: 0;
  background: var(--hh-color-panel-glass);
  z-index: 1;
}

.af-day-name {
  font-size: var(--hh-font-caption-size);
  font-weight: 600;
  color: var(--hh-color-text-bright);
}
.af-day-total {
  font-size: var(--hh-font-caption-size);
  color: var(--hh-color-text-dim);
  font-variant-numeric: tabular-nums;
}

/* 条目 = 按钮（可点开游戏）。时间线竖线沿图标列走 */
.af-item {
  position: relative;
  display: flex;
  gap: var(--hh-space-x3);
  padding: var(--hh-space-x2) var(--hh-space-x2) var(--hh-space-x2) 0;
  align-items: center;
  width: 100%;
  border: none;
  background: transparent;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  border-radius: var(--hh-radius-sm);
}
.af-item:hover {
  background: var(--hh-color-surface-soft);
}
.af-item::before {
  content: '';
  position: absolute;
  left: 11px;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--hh-color-border-faint);
}
.af-item:first-of-type::before {
  top: 18px;
}
.af-item:last-of-type::before {
  bottom: auto;
  height: 18px;
}

/* 事件图标：圆环 + 图标（基准 gamepad 圆圈的口径） */
.af-ic {
  position: relative;
  z-index: 1;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 23px;
  height: 23px;
  border-radius: var(--hh-radius-pill);
  background: var(--hh-color-accent-soft);
  color: var(--hh-color-select-text);
}
.af-ic-add {
  background: var(--hh-color-success-soft);
  color: var(--hh-color-success);
}

/* 封面缩略图：竖版 cover-ratio（基准每条带封面） */
.af-thumb {
  position: relative;
  z-index: 1;
  flex: none;
  width: 38px;
  aspect-ratio: var(--hh-layout-cover-ratio);
  border-radius: var(--hh-radius-xs);
  overflow: hidden;
  background: var(--hh-color-cover-fallback);
}
.af-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.af-thumb-letter {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--hh-font-bodyLg-size);
  font-weight: 700;
  color: var(--hh-color-text-mid);
}

.af-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

/* 标题：长游戏名 clamp 到一行（基准侧栏 Game Libr… 截断就是兜底缺失，我们不学） */
.af-title-line {
  font-size: var(--hh-font-body-size);
  color: var(--hh-color-text-glow);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.af-meta {
  font-size: var(--hh-font-caption-size);
  color: var(--hh-color-text-dim);
  font-variant-numeric: tabular-nums;
}

.af-empty {
  margin: 0;
  padding: var(--hh-space-x8) var(--hh-space-x4);
  text-align: center;
  font-size: var(--hh-font-body-size);
  color: var(--hh-color-text-dim);
}

.af-foot {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--hh-space-x3);
  padding: var(--hh-space-x2) var(--hh-space-x4);
  border-top: 1px solid var(--hh-color-border-faint);
}

/* 本周时长：小条不是 KPI 大卡——右栏通栏放不下 26px 数字 */
.af-week {
  display: flex;
  align-items: center;
  gap: var(--hh-space-x2);
  font-size: var(--hh-font-caption-size);
  color: var(--hh-color-text-mid);
}
.af-week-value {
  color: var(--hh-color-text-bright);
  font-variant-numeric: tabular-nums;
}

.af-refresh {
  display: flex;
  align-items: center;
  gap: var(--hh-space-x2);
  border: none;
  background: transparent;
  color: var(--hh-color-text-mid);
  font-size: var(--hh-font-caption-size);
  font-family: inherit;
  cursor: pointer;
  padding: var(--hh-space-x2);
  border-radius: var(--hh-radius-sm);
  transition: color var(--hh-motion-med), background var(--hh-motion-med);
}
.af-refresh:hover:not(:disabled) {
  color: var(--hh-color-select-text);
  background: var(--hh-color-surface-soft);
}
.af-refresh:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
