<script setup lang="ts">
/**
 * 统计页（G5 + B5 对标 ReinaManager statistics.png）。
 *
 * 结构：页头（面包屑 + 标题 + 导出海报动作）→ 周期切换（周/月）→ 6 张 KPI
 * → 总趋势折线（缺日补零）→ Top10 时长排行 → 时段分布（0–23 时）。
 *
 * 口径统一（基准「首页 1666h / 统计 538.6h」自相矛盾，我们不许）：
 * 所有周期 KPI 由同一份会话数据（sessions store）+ 同一周期边界派生，
 * 与主进程 computeOverview 的 weekMs/monthMs 同源同规则（按会话结束时间归段）。
 * 累计时长/已玩/Top10 仍取 overview 全量口径（那里含老库 playMs），
 * 这些是「历史总计」语义，与周期 KPI 分工不重叠；页面 subtitle 已说明是回顾。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import {
  BarChart3,
  CalendarCheck,
  Clock,
  Gamepad2,
  ImageDown,
  Layers,
  Sparkles,
  TrendingUp,
} from 'lucide-vue-next'
import type { DayStat, GameStat, OverviewStats } from '../../shared/types'
import { ONE_DAY_MS, dayStart, fmtDurMs } from '../../shared/format'
import { ui } from '../stores/ui'
import { message } from 'ant-design-vue'
import { t, tf } from '../i18n'
import { library } from '../stores/library'
import { dailyFromSessions, refreshActivity, sessionsState } from '../stores/sessions'
import { tokens } from '../design/tokens'
import PageHeader from './PageHeader.vue'
import KpiStrip, { type KpiItem } from './KpiStrip.vue'
import PlayChart from './PlayChart.vue'

type Period = 'week' | 'month'

const stats = ref<OverviewStats | null>(null)
const error = ref('')
const posterBusy = ref(false)
/** 周期切换：默认月（基准 statistics.png 也是月度视角）。 */
const period = ref<Period>('month')

onMounted(async () => {
  try {
    const [ov] = await Promise.all([window.hh.statsOverview(), refreshActivity()])
    stats.value = ov
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
})

/** 周期长度（天）：周 = 近 7 天，月 = 近 30 天，含今天。 */
const PERIOD_DAYS: Record<Period, number> = { week: 7, month: 30 }

/** 周期起点（当日零点）。切换周期或刷新会话时自动重算。 */
const periodStart = computed(() => {
  const now = Date.now()
  return dayStart(now) - (PERIOD_DAYS[period.value] - 1) * ONE_DAY_MS
})

/** 区间展示文案（{from} – {to}，mm-dd）。 */
const rangeLabel = computed(() => {
  const from = new Date(periodStart.value)
  const to = new Date()
  const f = `${String(from.getMonth() + 1).padStart(2, '0')}-${String(from.getDate()).padStart(2, '0')}`
  const d = `${String(to.getMonth() + 1).padStart(2, '0')}-${String(to.getDate()).padStart(2, '0')}`
  return tf('play_range', { from: f, to: d })
})

/** 周期内会话（结束时间 >= 周期起点）。 */
const periodSessions = computed(() => sessionsState.list.filter((s) => s.end >= periodStart.value))

/** 周期内总时长（ms）。与 overview.weekMs/monthMs 同源同规则。 */
const periodMs = computed(() => periodSessions.value.reduce((a, s) => a + s.ms, 0))

/** 周期内会话场次。 */
const sessionCount = computed(() => periodSessions.value.length)

/** 周期内玩过的游戏数（按 gameId 去重；同一天连开两场同一款算一款）。 */
const playedInPeriod = computed(() => new Set(periodSessions.value.map((s) => s.gameId)).size)

/** 周期内新增（addedAt 落在区间内）。库数据由 library store 持有。 */
const addedInPeriod = computed(() => {
  const from = periodStart.value
  const to = Date.now()
  return library.games.filter((g) => g.addedAt >= from && g.addedAt <= to).length
})

/** 周期内日序列（缺日补零、升序）——趋势线与活跃天数同源。 */
const daily = computed<DayStat[]>(() => dailyFromSessions(sessionsState.list, { fromTs: periodStart.value }))

/** 活跃天数（周期内有会话记录的天数）。 */
const activeDays = computed(() => daily.value.filter((d) => d.ms > 0).length)

/** 日均 = 周期内总时长 / 活跃天数（按活跃天算才可比：拿 30 天总时长除以
 *  7 天活跃天会得到比周视图更大的「日均」，同一张卡自己跟自己打架）。 */
const avgPerActiveDay = computed(() => (activeDays.value > 0 ? periodMs.value / activeDays.value : 0))

const kpiItems = computed<KpiItem[]>(() => [
  { key: 'kpi_total_time', value: fmtDurMs(periodMs.value), icon: Clock, sub: rangeLabel.value },
  { key: 'kpi_played', value: String(playedInPeriod.value), icon: Gamepad2, sub: rangeLabel.value },
  { key: 'kpi_sessions', value: String(sessionCount.value), icon: Layers, sub: rangeLabel.value },
  { key: 'kpi_new_added', value: String(addedInPeriod.value), icon: Sparkles, sub: rangeLabel.value },
  { key: 'kpi_active_days', value: String(activeDays.value), icon: CalendarCheck, sub: rangeLabel.value },
  { key: 'kpi_avg_day', value: fmtDurMs(avgPerActiveDay.value), icon: TrendingUp, sub: rangeLabel.value },
])

/** Top10：扩到 10 条，缩略图取自库内同一 id 的 thumb（没有就中性色块兜底）。 */
const topGames = computed<GameStat[]>(() => (stats.value?.topGames ?? []).slice(0, 10))
const topMax = computed(() => Math.max(1, ...topGames.value.map((g) => g.ms)))

/** 缩略图加载失败的组卡：换成中性色块（无封面的组不糊图）。 */
const thumbFailed = reactive<Record<string, boolean>>({})
function thumbOf(id: string): string {
  const g = library.games.find((it) => it.id === id)
  return g?.thumbPath ? `hh://thumb/${id}` : ''
}

/** 时段分布：0–23 时聚合（会话按结束时刻的本地小时归段）。 */
const hourBuckets = computed(() => {
  const bins = new Array(24).fill(0) as number[]
  for (const s of periodSessions.value) {
    if (!Number.isFinite(s.end) || s.ms <= 0) continue
    bins[new Date(s.end).getHours()] += s.ms
  }
  return bins
})
const hourMax = computed(() => Math.max(1, ...hourBuckets.value))

/** 空态引导 CTA：跳回游戏库（用户要去那儿启动游戏才会产生记录） */
function goLibrary(): void {
  ui.page = 'library'
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
    [t('st_today'), fmtDurMs(s.todayMs)],
    [t('st_week7'), fmtDurMs(s.weekMs)],
    [t('st_month30'), fmtDurMs(s.monthMs)],
    [t('st_total'), fmtDurMs(s.totalMs)],
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
    ctx.fillText(fmtDurMs(g.ms), PAD + 240 + rankW + 12, y + 16)
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

    <!-- 页头：面包屑 + 标题 + 导出海报（带文字的主操作） -->
    <PageHeader :crumbs="['nav_home', 'nav_stats']" title="nav_stats" :subtitle="t('st_page_sub')">
      <template #actions>
        <button class="poster-btn" :disabled="posterBusy" @click="exportPoster">
          <ImageDown :size="14" /> {{ posterBusy ? t('st_poster_busy') : t('st_export_poster') }}
        </button>
      </template>
    </PageHeader>

    <div v-if="!stats && !error" class="empty glass">
      <BarChart3 class="empty-icon" :size="36" :stroke-width="1.5" />
      <div class="empty-text">{{ t('st_loading') }}</div>
    </div>

    <template v-else-if="stats">
      <!-- 空态引导：库里一款都没玩过时 KPI 全是 0、曲线全平，一屏数字没有
           信息量。换成「怎么开始记录」的引导，把用户带到能产生数据的地方。 -->
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
        <!-- 周期切换：周 / 月。所有 KPI 与趋势线按同一周期重算 -->
        <div class="period-bar">
          <div class="period-seg">
            <button
              v-for="p in (['week', 'month'] as Period[])"
              :key="p"
              class="seg-chip"
              :class="{ active: period === p }"
              :aria-pressed="period === p"
              @click="period = p"
            >
              {{ p === 'week' ? t('st_period_wk') : t('st_period_mo') }}
            </button>
          </div>
          <span class="period-range">{{ rangeLabel }}</span>
        </div>

        <!-- 6 张 KPI（对标基准）；区间口径在各卡副行注明 -->
        <KpiStrip :items="kpiItems" />

        <!-- 总趋势：缺日补零（基准这里 X 轴跳日期，我们补零） -->
        <section class="panel glass">
          <div class="panel-head">
            <h2 class="panel-title">{{ t('st_trend') }}</h2>
            <span class="panel-sub">{{ rangeLabel }}</span>
          </div>
          <PlayChart :series="daily" :height="180" />
        </section>

        <!-- Top10 by play time（扩到 10 条，缩略图 + 横条） -->
        <section v-if="topGames.length" class="panel glass">
          <div class="panel-head">
            <h2 class="panel-title">{{ t('st_rank90') }}</h2>
            <span class="panel-sub">{{ t('st_played') }}</span>
          </div>
          <div class="top-list" role="img" :aria-label="t('st_aria_rank')">
            <div v-for="(g, i) in topGames" :key="g.gameId" class="top-row">
              <span class="top-rank num">{{ i + 1 }}</span>
              <span class="top-thumb" :class="{ 'no-thumb': !thumbOf(g.gameId) || thumbFailed[g.gameId] }">
                <img
                  v-if="thumbOf(g.gameId) && !thumbFailed[g.gameId]"
                  :src="thumbOf(g.gameId)"
                  :alt="g.title"
                  loading="lazy"
                  @error="thumbFailed[g.gameId] = true"
                />
              </span>
              <span class="top-name" :title="g.title">{{ g.title }}</span>
              <span class="top-bar">
                <span class="top-fill" :style="{ width: Math.max(2, (g.ms / topMax) * 100) + '%' }"></span>
              </span>
              <span class="top-val num">{{ fmtDurMs(g.ms) }}</span>
            </div>
          </div>
        </section>

        <!-- 时段分布：0–23 时聚合（基准底部 Play period distribution） -->
        <section class="panel glass">
          <div class="panel-head">
            <h2 class="panel-title">{{ t('st_hour_dist') }}</h2>
            <span class="panel-sub">{{ t('st_hour_axis_hint') }}</span>
          </div>
          <div class="hour-chart" role="img" :aria-label="t('st_hour_dist')">
            <div v-for="(ms, h) in hourBuckets" :key="h" class="hour-col" :title="`${h}:00 · ${fmtDurMs(ms)}`">
              <span class="hour-fill" :style="{ height: Math.max(2, (ms / hourMax) * 100) + '%' }"></span>
            </div>
          </div>
          <div class="hour-axis" aria-hidden="true">
            <span v-for="h in [0, 4, 8, 12, 16, 20]" :key="h" class="hour-tick num">{{ h }}</span>
          </div>
        </section>
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
/* 空态引导卡：替代全 0 的 KPI + 全平的曲线 */
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

/* ============ 周期切换 ============ */
.period-bar {
  display: flex;
  align-items: center;
  gap: var(--hh-space-x3);
  flex-wrap: wrap;
}
.period-seg {
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: var(--hh-radius-pill);
  background: var(--hh-color-surface-bright);
  border: 1px solid var(--hh-color-card-border);
  flex-shrink: 0;
}
.seg-chip {
  display: flex;
  align-items: center;
  gap: 5px;
  height: 30px;
  padding: 0 16px;
  border: none;
  border-radius: var(--hh-radius-pill);
  background: transparent;
  color: var(--hh-color-text-mid);
  font-size: var(--hh-font-caption-size);
  cursor: pointer;
  transition:
    background var(--hh-motion-med) ease,
    color var(--hh-motion-med) ease;
}
.seg-chip:hover {
  background: var(--hh-color-surface-mid);
  color: var(--hh-color-text-glow);
}
.seg-chip.active {
  background: var(--hh-color-select-bg);
  color: var(--hh-color-select-text);
  font-weight: 600;
}
.period-range {
  font-size: var(--hh-font-caption-size);
  color: var(--hh-color-text-dim);
  font-variant-numeric: tabular-nums;
}

/* ============ 面板 ============ */
.panel {
  border-radius: var(--hh-radius-panel);
  padding: 14px 16px;
}
.panel-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--hh-space-x3);
  margin-bottom: 10px;
  flex-wrap: wrap;
}
.panel-title {
  margin: 0;
  font-size: var(--hh-font-body-size);
  font-weight: 600;
  color: var(--hh-color-text-strong);
}
.panel-sub {
  font-size: var(--hh-font-caption-size);
  color: var(--hh-color-text-dim);
}

/* ============ Top10 排行 ============ */
.top-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.top-row {
  display: flex;
  align-items: center;
  gap: var(--hh-space-x2);
  min-width: 0;
}
.top-rank {
  flex: none;
  width: 18px;
  text-align: right;
  font-size: var(--hh-font-caption-size);
  font-weight: 700;
  color: var(--hh-color-accent-text);
}
/* 缩略图：竖版小图；无封面时中性色块（不糊图、不占位 emoji） */
.top-thumb {
  flex: none;
  width: 26px;
  height: 34px;
  border-radius: var(--hh-radius-sm);
  overflow: hidden;
  background: var(--hh-color-surface-strong);
  border: 1px solid var(--hh-color-card-border);
}
.top-thumb.no-thumb {
  background: var(--hh-color-surface-strong);
}
.top-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.top-name {
  flex: none;
  width: 30%;
  min-width: 0;
  font-size: var(--hh-font-caption-size);
  color: var(--hh-color-text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.top-bar {
  flex: 1;
  min-width: 40px;
  height: 10px;
  border-radius: var(--hh-radius-pill);
  background: var(--hh-color-surface-mid);
  overflow: hidden;
}
.top-fill {
  display: block;
  height: 100%;
  border-radius: var(--hh-radius-pill);
  background: var(--hh-color-accent);
}
.top-val {
  flex: none;
  width: 68px;
  text-align: right;
  font-size: var(--hh-font-caption-size);
  color: var(--hh-color-text-dim);
}

/* ============ 时段分布（0–23 时） ============ */
.hour-chart {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: 120px;
  padding-top: 4px;
}
.hour-col {
  flex: 1;
  min-width: 0;
  height: 100%;
  display: flex;
  align-items: flex-end;
}
.hour-fill {
  display: block;
  width: 100%;
  min-height: 2px;
  border-radius: var(--hh-radius-xs);
  background: var(--hh-color-accent);
  opacity: 0.85;
  transition: height var(--hh-motion-med) ease;
}
.hour-axis {
  display: flex;
  justify-content: space-between;
  margin-top: 6px;
  font-size: var(--hh-font-caption-size);
  color: var(--hh-color-text-dim);
}
.hour-tick {
  flex: none;
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
