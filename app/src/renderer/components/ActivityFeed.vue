<script setup lang="ts">
/**
 * 右栏默认可见内容：游玩动态（按日分组的会话时间线）。
 *
 * 这是对标改造里**最大的视觉损失修复**：基准 ReinaManager 右栏永远有内容
 * （home.png 的 Activity 时间线），羽花此前只有一朵花图标 + 一句话，
 * 首屏右侧整块空白。数据早有（play-sessions.json + Ipc.StatsSessions），
 * 只缺渲染。
 *
 * 分组口径：今天/昨天用相对名（比绝对日期直观），更早的按 yyyy-mm-dd。
 * 每条 = 图标 + 「玩过 {title}」+ 「{n} 场会话 · {dur}」——与基准
 * 「Played 原神 · 1 session · 33 minutes」同结构。
 */
import { computed, onMounted } from 'vue'
import { History, RefreshCw, Timer } from 'lucide-vue-next'
import { t, tf } from '../i18n'
import type { PlaySession } from '../../shared/types'
import { groupByDay, refreshActivity, sessionsState, sumMs } from '../stores/sessions'
import { ONE_DAY_MS, fmtDurMs } from '../../shared/format'

/** 本周起点（周一）——与「本周时长」的周口径一致 */
const weekStart = computed(() => {
  const d = new Date()
  const dow = (d.getDay() + 6) % 7
  d.setHours(0, 0, 0, 0)
  return d.getTime() - dow * ONE_DAY_MS
})
const groups = computed(() => groupByDay(sessionsState.list))
const weekMs = computed(() => sumMs(sessionsState.list, weekStart.value))
const loading = computed(() => sessionsState.loading)

onMounted(() => {
  void refreshActivity()
})

/** 一天的总时长：组内会话累加（同一天的会话可能多条） */
function dayMs(items: PlaySession[]): number {
  return sumMs(items)
}
</script>

<template>
  <section class="activity-feed" :aria-label="t('act_title')">
    <header class="af-head">
      <span class="af-title"><History :size="15" /> {{ t('act_title') }}</span>
      <span class="af-week" :title="t('act_week_short')">
        <Timer :size="13" />
        <span class="af-week-label">{{ t('act_week_short') }}</span>
        <strong class="af-week-value">{{ fmtDurMs(weekMs) }}</strong>
      </span>
    </header>

    <div class="af-body">
      <p v-if="loading" class="af-empty">{{ t('act_refresh') }}…</p>
      <p v-else-if="!groups.length" class="af-empty">{{ t('act_empty') }}</p>
      <template v-else>
        <div v-for="g in groups" :key="g.key" class="af-day">
          <div class="af-day-head">
            <span class="af-day-name">
              {{ g.key === 'today' ? t('act_today') : g.key === 'yesterday' ? t('act_yesterday') : g.key }}
            </span>
            <span class="af-day-total">{{ fmtDurMs(dayMs(g.items)) }}</span>
          </div>
          <div v-for="s in g.items" :key="s.start" class="af-item">
            <span class="af-dot" aria-hidden="true"></span>
            <div class="af-main">
              <span class="af-title-line" :title="s.title">{{ tf('act_played', { title: s.title }) }}</span>
              <span class="af-meta">{{ tf('act_meta', { n: 1, dur: fmtDurMs(s.ms) }) }}</span>
            </div>
          </div>
        </div>
      </template>
    </div>

    <footer class="af-foot">
      <button class="af-refresh" type="button" :title="t('act_refresh')" :disabled="loading" @click="refreshActivity()">
        <RefreshCw :size="13" />
        <span>{{ t('act_refresh') }}</span>
      </button>
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

/* 时间线：竖线 + 圆点；圆点用 accent 弱化处理，避免满屏粉 */
.af-item {
  position: relative;
  display: flex;
  gap: var(--hh-space-x3);
  padding: var(--hh-space-x2) 0 var(--hh-space-x2) 0;
  align-items: flex-start;
}
.af-item::before {
  content: '';
  position: absolute;
  left: 4px;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--hh-color-border-faint);
}
.af-item:first-of-type::before {
  top: 14px;
}
.af-item:last-of-type::before {
  bottom: auto;
  height: 14px;
}
.af-dot {
  position: relative;
  z-index: 1;
  flex: none;
  margin-top: 5px;
  width: 9px;
  height: 9px;
  border-radius: var(--hh-radius-pill);
  background: var(--hh-color-accent);
  box-shadow: 0 0 0 3px var(--hh-color-accent-soft);
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
  max-width: 300px;
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
  padding: var(--hh-space-x2) var(--hh-space-x4);
  border-top: 1px solid var(--hh-color-border-faint);
}

.af-refresh {
  display: flex;
  align-items: center;
  gap: var(--hh-space-x2);
  border: none;
  background: transparent;
  color: var(--hh-color-text-mid);
  font-size: var(--hh-font-caption-size);
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
