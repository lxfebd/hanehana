<script setup lang="ts">
/**
 * 统计页（G5）：游玩时长日/周/月聚合 + 按游戏排行。
 * 图表全部自绘（SVG），不引入图表库依赖。
 */
import { computed, onMounted, ref } from 'vue'
import { BarChart3, Clock, Gamepad2, ImageDown, Trophy } from 'lucide-vue-next'
import type { OverviewStats } from '../../shared/types'
import { tokens } from '../design/tokens'
import { ui } from '../stores/ui'
import { message } from 'ant-design-vue'
import { t, tf } from '../i18n'

const stats = ref<OverviewStats | null>(null)
const error = ref('')
const posterBusy = ref(false)

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

/** 空态引导 CTA：跳回游戏库（用户要去那儿启动游戏才会产生记录） */
function goLibrary(): void {
  ui.page = 'library'
}

function fmtDur(ms: number): string {
  if (ms <= 0) return tf('dp_minutes', { m: 0 })
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  if (h <= 0) return tf('dp_minutes', { m })
  if (m === 0) return tf('st_hour', { h })
  return tf('dp_hours_min', { h, m })
}

function fmtShort(ms: number): string {
  if (ms <= 0) return '0m'
  const h = Math.floor(ms / 3600000)
  const m = Math.round((ms % 3600000) / 60000)
  if (h <= 0) return `${m}m`
  return `${h}h${m > 0 ? m : ''}`
}

/** 柱状图：30 根竖条 + hover 提示。
 *  内插的 d.date / g.title 来自统计与刮削源（用户可控），先转义再拼 SVG，
 *  不能直接进 v-html——否则一条 `<img onerror>` 或 `<foreignObject>` 标题就能
 *  在统计页注入内容（CSP 兜底但别依赖它）。 */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

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
        <title>${esc(d.date)} · ${fmtShort(d.ms)}</title>
      </rect>
    </g>`
  })
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${t('st_aria_bars')}">
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
      <text x="0" y="${y + 15}" font-size="12" fill="${textDim.value}">${esc(label)}</text>
      <rect x="150" y="${y + 4}" width="${w}" height="14" rx="3" fill="${accent.value}" opacity="0.8">
        <title>${esc(g.title)} · ${fmtDur(g.ms)}</title>
      </rect>
      <text x="496" y="${y + 15}" font-size="11" fill="${textDim.value}">${fmtShort(g.ms)}</text>
    </g>`
  })
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${t('st_aria_rank')}">
    ${parts.join('')}
  </svg>`
}

/** hex → rgba() 字符串（Canvas 合成透明色用，SVG/页面 CSS 变量在离屏画布上不存在）。 */
function hexA(hex: string, a: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex)
  if (!m) return hex
  const n = parseInt(m[1], 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
}

/**
 * 统计海报：直接在 Canvas 2D 上绘制（不用 SVG→<img>→canvas 那条路——
 * 后者在 Chromium 里对 SVG 文本做隔离栅格化，CJK 字形会碎裂错位）。
 * 颜色全部内联写死，不依赖页面 CSS 变量。竖版 800×1100：
 * 标题 + 5 KPI + 近 30 天柱状 + Top5 排行 + 水印。
 */
function drawPosterPng(): string {
  const s = stats.value
  if (!s) return ''
  const c = tokens.color
  const night = c.windowFallback
  const text = c.textHot ?? c.text
  const dim = c.textDim
  const W = 800
  const H = 1100
  const PAD = 56
  const innerW = W - PAD * 2
  const font = `"PingFang SC","Microsoft YaHei","Segoe UI",sans-serif`
  const now = new Date()
  const dateStr = tf('st_date', { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() })

  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''
  ctx.textBaseline = 'alphabetic'

  // 深色渐变底 + 装饰圆
  const bg = ctx.createLinearGradient(0, 0, 0, H)
  bg.addColorStop(0, night)
  bg.addColorStop(1, hexA(night, 0.85))
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, W, H)
  ctx.fillStyle = c.accent
  ctx.globalAlpha = 0.12
  ctx.beginPath()
  ctx.arc(W - 120, 140, 220, 0, Math.PI * 2)
  ctx.fill()
  ctx.globalAlpha = 0.08
  ctx.beginPath()
  ctx.arc(W - 60, 200, 120, 0, Math.PI * 2)
  ctx.fill()
  ctx.globalAlpha = 1

  // 标题 + 日期
  ctx.textAlign = 'left'
  ctx.fillStyle = text
  ctx.font = `800 38px ${font}`
  ctx.fillText(t('st_title'), PAD, 96)
  ctx.fillStyle = dim
  ctx.font = `14px ${font}`
  ctx.fillText(tf('st_poster_sub', { date: dateStr }), PAD, 130)

  // KPI 卡片：5 张横排
  const kpis: [string, string][] = [
    [t('st_today'), fmtDur(s.todayMs)],
    [t('st_week7'), fmtDur(s.weekMs)],
    [t('st_month30'), fmtDur(s.monthMs)],
    [t('st_total'), fmtDur(s.totalMs)],
    [t('st_played'), tf('st_played_n', { n: s.playedGames })],
  ]
  const kpiW = (innerW - 4 * 14) / 5
  kpis.forEach(([label, val], i) => {
    const x = PAD + i * (kpiW + 14)
    const cx = x + kpiW / 2
    ctx.fillStyle = hexA(c.accent, 0.14)
    ctx.beginPath()
    ctx.roundRect(x, 210, kpiW, 92, 16)
    ctx.fill()
    ctx.strokeStyle = hexA(c.accent, 0.35)
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.roundRect(x, 210, kpiW, 92, 16)
    ctx.stroke()
    const v = val.length > 9 ? val.slice(0, 9) + '…' : val
    ctx.textAlign = 'center'
    ctx.fillStyle = text
    ctx.font = `700 19px ${font}`
    ctx.fillText(v, cx, 246)
    ctx.fillStyle = dim
    ctx.font = `11.5px ${font}`
    ctx.fillText(label, cx, 272)
  })

  // 近 30 天柱状（海报版，更宽更高）
  const days = s.days
  const barMaxV = Math.max(1, ...days.map((d) => d.ms))
  const chartH = 240
  const bw = innerW / Math.max(1, days.length)
  days.forEach((d, i) => {
    const h = Math.max(2, (d.ms / barMaxV) * (chartH - 24))
    const x = PAD + i * bw
    const y = 560 + chartH - h
    const today = i === days.length - 1
    const grad = ctx.createLinearGradient(x, y, x, y + h)
    grad.addColorStop(0, c.accent)
    grad.addColorStop(1, hexA(c.accent, 0.55))
    ctx.fillStyle = today ? c.star : grad
    ctx.globalAlpha = today ? 1 : 0.85
    ctx.beginPath()
    ctx.roundRect(x + 1, y, Math.max(2, bw - 2), h, 2)
    ctx.fill()
    ctx.globalAlpha = 1
  })

  // 区块标题
  ctx.textAlign = 'left'
  ctx.fillStyle = text
  ctx.font = `700 18px ${font}`
  ctx.fillText(t('st_daily'), PAD, 540)
  ctx.fillStyle = dim
  ctx.font = `12px ${font}`
  ctx.textAlign = 'right'
  ctx.fillText(t('st_today_highlight'), W - PAD, 540)

  // Top5 排行
  const top = s.topGames.slice(0, 5)
  const maxTop = Math.max(1, ...top.map((g) => g.ms))
  const rankW = innerW - 240
  ctx.fillStyle = text
  ctx.textAlign = 'left'
  ctx.font = `700 18px ${font}`
  ctx.fillText(t('st_rank5'), PAD, 856)
  top.forEach((g, i) => {
    const w = Math.max(6, (g.ms / maxTop) * rankW)
    const y = 880 + i * 44
    const label = g.title.length > 16 ? g.title.slice(0, 16) + '…' : g.title
    ctx.fillStyle = i === 0 ? c.star : hexA(c.accent, 0.5)
    ctx.beginPath()
    ctx.arc(PAD + 12, y + 12, 13, 0, Math.PI * 2)
    ctx.fill()
    ctx.textAlign = 'center'
    ctx.fillStyle = i === 0 ? night : text
    ctx.font = `700 12px ${font}`
    ctx.fillText(String(i + 1), PAD + 12, y + 16)
    ctx.textAlign = 'left'
    ctx.fillStyle = text
    ctx.font = `13.5px ${font}`
    ctx.fillText(label, PAD + 34, y + 16)
    const grad = ctx.createLinearGradient(PAD + 240, y + 4, PAD + 240, y + 20)
    grad.addColorStop(0, c.accent)
    grad.addColorStop(1, hexA(c.accent, 0.55))
    ctx.fillStyle = grad
    ctx.globalAlpha = 0.85
    ctx.beginPath()
    ctx.roundRect(PAD + 240, y + 4, w, 16, 4)
    ctx.fill()
    ctx.globalAlpha = 1
    ctx.fillStyle = dim
    ctx.font = `12px ${font}`
    ctx.fillText(fmtShort(g.ms), PAD + 240 + rankW + 12, y + 16)
  })

  // 水印
  ctx.fillStyle = dim
  ctx.font = `11px ${font}`
  ctx.textAlign = 'right'
  ctx.fillText(t('st_watermark'), W - PAD, H - 40)

  return canvas.toDataURL('image/png')
}

async function exportPoster(): Promise<void> {
  if (posterBusy.value || !stats.value) return
  posterBusy.value = true
  try {
    const dataUrl = drawPosterPng()
    if (!dataUrl) throw new Error(t('st_render_fail'))
    const r = await window.hh.exportStatsPoster(dataUrl)
    if (!r.ok) {
      message.error(r.error || t('st_poster_fail'))
    } else if (!r.canceled && r.path) {
      message.success(tf('st_poster_saved', { path: r.path }))
    }
  } catch (e) {
    message.error(tf('st_poster_fail_detail', { msg: e instanceof Error ? e.message : String(e) }))
  } finally {
    posterBusy.value = false
  }
}
</script>

<template>
  <div class="stats-page">
    <div v-if="error" class="error-banner glass">{{ error }}</div>
    <div v-if="!stats && !error" class="empty glass">
      <BarChart3 class="empty-icon" :size="36" :stroke-width="1.5" />
      <div class="empty-text">{{ t('st_loading') }}</div>
    </div>
    <template v-else-if="stats">
      <!-- 空态引导：库里一款都没玩过时，5 个 KPI 全是 0、柱状图全平，
           一屏数字没有任何信息量。换成「怎么开始记录」的引导，
           把用户带到真正能产生数据的地方（启动游戏 / 扫描入库）。 -->
      <div v-if="stats.totalMs <= 0 && stats.playedGames === 0" class="empty-guide glass">
        <BarChart3 class="guide-ic" :size="40" :stroke-width="1.5" />
        <div class="guide-title">{{ t('st_empty_title') }}</div>
        <div class="guide-hint">{{ t('st_empty_hint') }}</div>
        <div class="guide-steps">
          <div class="guide-step">
            <span class="step-num num">1</span>
            <span>{{ t('st_empty_step1') }}</span>
          </div>
          <div class="guide-step">
            <span class="step-num num">2</span>
            <span>{{ t('st_empty_step2') }}</span>
          </div>
          <div class="guide-step">
            <span class="step-num num">3</span>
            <span>{{ t('st_empty_step3') }}</span>
          </div>
        </div>
        <button class="guide-cta" @click="goLibrary">{{ t('st_empty_cta') }}</button>
      </div>
      <template v-else>
      <div class="stats-head">
        <div class="stats-title">{{ t('st_title') }}</div>
        <button class="poster-btn" :disabled="posterBusy" @click="exportPoster">
          <ImageDown :size="14" /> {{ posterBusy ? t('st_poster_busy') : t('st_export_poster') }}
        </button>
      </div>
      <div class="kpi-row">
        <div class="kpi glass">
          <Clock :size="16" class="kpi-ic" />
          <div>
            <div class="kpi-num">{{ fmtDur(stats.todayMs) }}</div>
            <div class="kpi-label">{{ t('st_today') }}</div>
          </div>
        </div>
        <div class="kpi glass">
          <Clock :size="16" class="kpi-ic" />
          <div>
            <div class="kpi-num">{{ fmtDur(stats.weekMs) }}</div>
            <div class="kpi-label">{{ t('st_week7') }}</div>
          </div>
        </div>
        <div class="kpi glass">
          <Clock :size="16" class="kpi-ic" />
          <div>
            <div class="kpi-num">{{ fmtDur(stats.monthMs) }}</div>
            <div class="kpi-label">{{ t('st_month30') }}</div>
          </div>
        </div>
        <div class="kpi glass">
          <Trophy :size="16" class="kpi-ic" />
          <div>
            <div class="kpi-num">{{ fmtDur(stats.totalMs) }}</div>
            <div class="kpi-label">{{ t('st_total') }}</div>
          </div>
        </div>
        <div class="kpi glass">
          <Gamepad2 :size="16" class="kpi-ic" />
          <div>
            <div class="kpi-num">{{ tf('st_played_n', { n: stats.playedGames }) }}</div>
            <div class="kpi-label">{{ t('st_played') }}</div>
          </div>
        </div>
      </div>

      <div class="panel glass">
        <div class="panel-title">{{ t('st_daily') }}</div>
        <div class="chart-wrap" v-html="barChart()"></div>
      </div>

      <div class="panel glass" v-if="stats.topGames.length">
        <div class="panel-title">{{ t('st_rank90') }}</div>
        <div class="chart-wrap" v-html="topBars()"></div>
      </div>
      </template>
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
/* 空态引导卡：替代全 0 的 KPI + 全平的柱状图 */
.empty-guide {
  margin: 48px auto;
  max-width: 460px;
  padding: 40px 36px;
  text-align: center;
  border-radius: var(--hh-radius-panel);
}
.guide-ic {
  color: var(--hh-color-accent);
  opacity: 0.75;
  margin-bottom: 14px;
}
.guide-title {
  font-size: var(--hh-font-subtitle-size);
  font-weight: 700;
  color: var(--hh-color-text-glow);
  margin-bottom: 8px;
}
.guide-hint {
  font-size: var(--hh-font-body-size);
  color: var(--hh-color-text-mid);
  margin-bottom: 22px;
}
.guide-steps {
  display: flex;
  flex-direction: column;
  gap: 10px;
  text-align: left;
  margin-bottom: 24px;
}
.guide-step {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: var(--hh-font-body-size);
  color: var(--hh-color-text-secondary);
}
.step-num {
  flex: none;
  width: 22px;
  height: 22px;
  border-radius: var(--hh-radius-pill);
  background: var(--hh-color-select-bg);
  color: var(--hh-color-select-text);
  font-size: 12px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
}
.guide-cta {
  height: 34px;
  padding: 0 24px;
  border: none;
  border-radius: var(--hh-radius-md);
  background: var(--hh-color-accent);
  color: var(--hh-color-on-accent);
  font-size: var(--hh-font-body-size);
  font-weight: 600;
  cursor: pointer;
  transition: background var(--hh-motion-med) ease;
}
.guide-cta:hover {
  background: var(--hh-color-accent-hover);
}
.stats-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.stats-title {
  font-size: 15px;
  font-weight: 700;
  color: var(--hh-color-text-strong);
}
.poster-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 14px;
  border: 1px solid var(--hh-color-border-ghost-soft);
  border-radius: var(--hh-radius-md);
  background: transparent;
  color: var(--hh-color-text-strong);
  font-size: 12.5px;
  cursor: pointer;
}
.poster-btn:hover {
  background: var(--hh-color-surface-mid);
}
.poster-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
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
  border-radius: var(--hh-radius-lg);
}
.kpi-ic {
  color: var(--hh-color-accent);
  flex: none;
}
.kpi-num {
  font-size: 17px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--hh-color-text-glow);
}
.kpi-label {
  font-size: 11.5px;
  color: var(--hh-color-text-tertiary);
}
.panel {
  border-radius: var(--hh-radius-panel);
  padding: 14px 16px;
}
.panel-title {
  font-size: var(--hh-font-body-size);
  font-weight: 600;
  color: var(--hh-color-text-strong);
  margin-bottom: 10px;
}
.chart-wrap {
  width: 100%;
}
.chart-wrap :deep(svg) {
  display: block;
}
.empty {
  margin: 60px auto;
  max-width: 360px;
  padding: 36px 28px;
  text-align: center;
  border-radius: var(--hh-radius-panel);
}
.empty-icon {
  color: var(--hh-color-text-tertiary);
  margin-bottom: 10px;
}
.empty-text {
  font-size: var(--hh-font-body-size);
  color: var(--hh-color-text-mid);
}
.error-banner {
  padding: 10px 14px;
  border-radius: var(--hh-radius-md);
  color: var(--hh-color-error-text);
  font-size: var(--hh-font-body-size);
}
</style>
