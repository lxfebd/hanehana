<script setup lang="ts">
/**
 * 统计页（G5）：游玩时长日/周/月聚合 + 按游戏排行。
 * 图表全部自绘（SVG），不引入图表库依赖。
 */
import { computed, onMounted, ref } from 'vue'
import { BarChart3, Clock, Gamepad2, Trophy } from 'lucide-vue-next'
import type { OverviewStats } from '../../shared/types'
import { tokens } from '../design/tokens'

const stats = ref<OverviewStats | null>(null)
const error = ref('')

onMounted(async () => {
  try {
    stats.value = await window.hh.statsOverview()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
})

const accent = computed(() => tokens.color.accent)
const textDim = computed(() => tokens.color.textTertiary)
const barMax = computed(() => Math.max(1, ...(stats.value?.days.map((d) => d.ms) ?? [1])))
const maxGameMs = computed(() => Math.max(1, ...(stats.value?.topGames.map((g) => g.ms) ?? [1])))

function fmtDur(ms: number): string {
  if (ms <= 0) return '0 分钟'
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  if (h <= 0) return `${m} 分钟`
  if (m === 0) return `${h} 小时`
  return `${h} 小时 ${m} 分钟`
}

function fmtShort(ms: number): string {
  if (ms <= 0) return '0m'
  const h = Math.floor(ms / 3600000)
  const m = Math.round((ms % 3600000) / 60000)
  if (h <= 0) return `${m}m`
  return `${h}h${m > 0 ? m : ''}`
}

/** 柱状图：30 根竖条 + hover 提示 */
function barChart(): string {
  const days = stats.value?.days ?? []
  const W = 640
  const H = 200
  const pad = 4
  const bw = (W - pad * 2) / Math.max(1, days.length)
  const parts = days.map((d, i) => {
    const h = Math.max(2, (d.ms / barMax.value) * (H - 30))
    const x = pad + i * bw
    const y = H - h - 8
    return `<g>
      <rect x="${x}" y="${y}" width="${bw - 2}" height="${h}" rx="2" fill="${accent.value}" opacity="0.85">
        <title>${d.date} · ${fmtShort(d.ms)}</title>
      </rect>
    </g>`
  })
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="近 30 天游玩时长柱状图">
    ${parts.join('')}
  </svg>`
}

function topBars(): string {
  const games = stats.value?.topGames ?? []
  const W = 640
  const H = games.length * 26 + 10
  const bw = 340
  const parts = games.map((g, i) => {
    const w = Math.max(4, (g.ms / maxGameMs.value) * bw)
    const y = i * 26
    const label = g.title.length > 14 ? g.title.slice(0, 14) + '…' : g.title
    return `<g>
      <text x="0" y="${y + 15}" font-size="12" fill="${textDim.value}">${label}</text>
      <rect x="150" y="${y + 4}" width="${w}" height="14" rx="3" fill="${accent.value}" opacity="0.8">
        <title>${g.title} · ${fmtDur(g.ms)}</title>
      </rect>
      <text x="496" y="${y + 15}" font-size="11" fill="${textDim.value}">${fmtShort(g.ms)}</text>
    </g>`
  })
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="游戏时长排行">
    ${parts.join('')}
  </svg>`
}
</script>

<template>
  <div class="stats-page">
    <div v-if="error" class="error-banner glass">{{ error }}</div>
    <div v-if="!stats && !error" class="empty glass">
      <BarChart3 class="empty-icon" :size="36" :stroke-width="1.5" />
      <div class="empty-text">正在统计游玩时长…</div>
    </div>
    <template v-else-if="stats">
      <div class="kpi-row">
        <div class="kpi glass">
          <Clock :size="16" class="kpi-ic" />
          <div>
            <div class="kpi-num">{{ fmtDur(stats.todayMs) }}</div>
            <div class="kpi-label">今日</div>
          </div>
        </div>
        <div class="kpi glass">
          <Clock :size="16" class="kpi-ic" />
          <div>
            <div class="kpi-num">{{ fmtDur(stats.weekMs) }}</div>
            <div class="kpi-label">近 7 天</div>
          </div>
        </div>
        <div class="kpi glass">
          <Clock :size="16" class="kpi-ic" />
          <div>
            <div class="kpi-num">{{ fmtDur(stats.monthMs) }}</div>
            <div class="kpi-label">近 30 天</div>
          </div>
        </div>
        <div class="kpi glass">
          <Trophy :size="16" class="kpi-ic" />
          <div>
            <div class="kpi-num">{{ fmtDur(stats.totalMs) }}</div>
            <div class="kpi-label">累计</div>
          </div>
        </div>
        <div class="kpi glass">
          <Gamepad2 :size="16" class="kpi-ic" />
          <div>
            <div class="kpi-num">{{ stats.playedGames }} 款</div>
            <div class="kpi-label">玩过</div>
          </div>
        </div>
      </div>

      <div class="panel glass">
        <div class="panel-title">近 30 天每日时长</div>
        <div class="chart-wrap" v-html="barChart()"></div>
      </div>

      <div class="panel glass" v-if="stats.topGames.length">
        <div class="panel-title">游戏时长排行（近 90 天）</div>
        <div class="chart-wrap" v-html="topBars()"></div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.stats-page {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-bottom: 16px;
}
.kpi-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 10px;
}
.kpi {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 16px;
  border-radius: 12px;
}
.kpi-ic { color: var(--hh-color-accent); flex: none; }
.kpi-num { font-size: 17px; font-weight: 700; font-variant-numeric: tabular-nums; color: var(--hh-color-text-glow); }
.kpi-label { font-size: 11.5px; color: var(--hh-color-text-tertiary); }
.panel {
  border-radius: 14px;
  padding: 14px 16px;
}
.panel-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--hh-color-text-strong);
  margin-bottom: 10px;
}
.chart-wrap { width: 100%; }
.chart-wrap :deep(svg) { display: block; }
.empty {
  margin: 60px auto;
  max-width: 360px;
  padding: 36px 28px;
  text-align: center;
  border-radius: 18px;
}
.empty-icon { color: var(--hh-color-text-tertiary); margin-bottom: 10px; }
.empty-text { font-size: 13px; color: var(--hh-color-text-mid); }
.error-banner {
  padding: 10px 14px;
  border-radius: 10px;
  color: var(--hh-color-error-text);
  font-size: 13px;
}
</style>
