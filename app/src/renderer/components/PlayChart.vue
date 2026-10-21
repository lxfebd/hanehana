<script setup lang="ts">
/**
 * 时长曲线（SVG 折线 + 面积）：日序列 → 平滑曲线。
 *
 * 契约：series 必须已「缺日补零、升序」（dailyFromSessions 的产物）。
 * 补零在数据层不在组件里——组件假定自己拿到的就是完整的日历轴，
 * 只把有记录的日子画进 X 轴的曲线会「形状说谎」（基准 ReinaManager 就这
 * 么错的：X 轴跳日期，一段空窗被画成斜坡）。
 *
 * 手写 SVG 不引图表库：一条折线 + 面积 + 三条网格线，引入 ECharts 级别的
 * 依赖是拿大炮打蚊子。
 */
import { computed } from 'vue'
import type { DayStat } from '../../shared/types'
import { fmtDurMs } from '../../shared/format'
import { t } from '../i18n'

const props = withDefaults(defineProps<{ series: DayStat[]; height?: number }>(), { height: 160 })
void props

const view = computed(() => {
  const s = props.series
  const W = 720
  const H = props.height
  const PAD_L = 44
  const PAD_R = 10
  const PAD_T = 12
  const PAD_B = 20
  const iw = W - PAD_L - PAD_R
  const ih = H - PAD_T - PAD_B
  const n = Math.max(1, s.length - 1)
  // 轴的 max 至少为 1ms：全零序列不能除出 NaN
  const max = Math.max(...s.map((d) => d.ms), 1)
  const pts = s.map((d, i) => [PAD_L + (n === 0 ? iw / 2 : (i / n) * iw), PAD_T + ih - (d.ms / max) * ih] as const)
  const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')
  const area = pts.length
    ? `${line} L${pts[pts.length - 1][0].toFixed(1)},${(PAD_T + ih).toFixed(1)} L${pts[0][0].toFixed(1)},${(PAD_T + ih).toFixed(1)} Z`
    : ''
  // x 轴刻度：≤8 个均匀取点，标签取日期 mm-dd
  const ticks: { x: number; label: string }[] = []
  const step = Math.max(1, Math.ceil(s.length / 8))
  for (let i = 0; i < s.length; i += step) {
    ticks.push({ x: PAD_L + (n === 0 ? iw / 2 : (i / n) * iw), label: s[i].date.slice(5) })
  }
  // 尾点必须补（右端是「今天」，不画就没有终点参照），但与上一刻度
  // 至少隔 34px 才补——否则两个 mm-dd 叠成「10-20-21」糊字。
  const last = s[s.length - 1]
  if (last && (ticks.length === 0 || ticks[ticks.length - 1].x <= PAD_L + iw - 34))
    ticks.push({ x: PAD_L + iw, label: last.date.slice(5) })
  return { W, H, PAD_L, PAD_T, ih, line, area, pts, ticks, max }
})
</script>

<template>
  <div class="play-chart">
    <div v-if="$slots.action" class="pc-head">
      <slot name="action" />
    </div>
    <svg
      v-if="series.length"
      class="pc-svg"
      :viewBox="`0 0 ${view.W} ${view.H}`"
      :style="{ height: height + 'px' }"
      preserveAspectRatio="none"
      role="img"
      :aria-label="series.length + ' days'"
    >
      <!-- 网格：三条水平线（max / mid / 0），线色走 borderFaint -->
      <line
        v-for="gy in [0, 0.5, 1]"
        :key="gy"
        :x1="view.PAD_L"
        :x2="view.W - 10"
        :y1="view.PAD_T + view.ih * gy"
        :y2="view.PAD_T + view.ih * gy"
        stroke="var(--hh-color-border-faint)"
        stroke-width="1"
      />
      <!-- 面积 + 折线：accent 色；面积低透明 -->
      <path v-if="view.area" :d="view.area" fill="var(--hh-color-accent)" opacity="0.14" />
      <path
        :d="view.line"
        fill="none"
        stroke="var(--hh-color-accent)"
        stroke-width="2"
        stroke-linejoin="round"
        stroke-linecap="round"
        vector-effect="non-scaling-stroke"
      />
      <circle
        v-for="(p, i) in view.pts"
        :key="i"
        :cx="p[0]"
        :cy="p[1]"
        r="1.6"
        fill="var(--hh-color-accent)"
        opacity="0.9"
      />
      <!-- 轴上标 max / mid -->
      <text :x="4" :y="view.PAD_T + 4" class="pc-axis">{{ fmtDurMs(view.max) }}</text>
      <text :x="4" :y="view.PAD_T + view.ih * 0.5 + 4" class="pc-axis">{{ fmtDurMs(view.max / 2) }}</text>
      <text v-for="(tk, i) in view.ticks" :key="i" :x="tk.x" :y="view.H - 4" class="pc-tick">
        {{ tk.label }}
      </text>
    </svg>
    <p v-else class="pc-empty">{{ t('act_empty') }}</p>
  </div>
</template>

<style scoped>
.play-chart {
  display: flex;
  flex-direction: column;
  gap: var(--hh-space-x2);
  min-width: 0;
}

.pc-head {
  display: flex;
  align-items: center;
  gap: var(--hh-space-x2);
  flex-wrap: wrap;
}

.pc-svg {
  width: 100%;
  overflow: visible;
}

.pc-axis,
.pc-tick {
  font-size: var(--hh-font-caption-size);
  fill: var(--hh-color-text-dim);
  font-family: var(--hh-font-mono);
}
.pc-tick {
  text-anchor: middle;
}

.pc-empty {
  margin: 0;
  padding: var(--hh-space-x6);
  text-align: center;
  font-size: var(--hh-font-caption-size);
  color: var(--hh-color-text-dim);
}
</style>
