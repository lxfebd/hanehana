<script setup lang="ts">
/**
 * 首页仪表盘（B8，对标基准 home.png）。
 *
 * 用户批评：库页把 页头/KPI/工具栏/hero/续读条/封面墙 全堆一屏，「首页太杂」。
 * 基准的 Home 是干净的仪表盘：一整条合并 KPI 面板 + 一张 Continue 大卡 +
 * 一张 Random 卡 + 右侧 Activity——浏览工具（搜索/筛选/封面墙）全部留给
 * Library 页。本页照这个分工做：
 *   - KPI 面板：**一整块面板内部分格**（基准样式），不是散成一排独立卡片；
 *     今日恒显示，末格在 周/月 之间切换。
 *   - Continue 卡 = LibraryHero（基准式重构，library-view 负责内部）。
 *   - Random 卡 = RandomCard。
 *   - 右栏 ActivityFeed 由 App 接线（与库页共用右侧栏）。
 *
 * 口径：KPI 取主进程 computeOverview（与统计页同一份聚合）——基准首页 1666h
 * 与统计页 538.6h 互相矛盾，我们不重演。
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { CalendarDays, Gamepad2, Timer } from 'lucide-vue-next'
import { library, overviewState, refreshOverview } from '../stores/library'
import { fmtDurMsKpi } from '../../shared/format'
import { t } from '../i18n'
import LibraryHero from './LibraryHero.vue'
import RandomCard from './RandomCard.vue'

type PeriodKey = 'week' | 'month'
const period = ref<PeriodKey>('month')

const ov = computed(() => overviewState.data)

// ---------------------------------------------------------------- KPI 数字滚动（count-up）

/**
 * KPI 是一个「仪表盘」，数字直接跳出来像静态截图；滚上去才有「刚统计完」的
 * 生命感。只滚数值、不滚单位：格式化仍走 fmtDurMsKpi，落点与不做动效时
 * 逐字相同（回归脚本读文本时动画早已结束，不会读到中间值）。
 */
interface KpiNums {
  games: number
  total: number
  today: number
  week: number
  month: number
}

const targets = computed<KpiNums>(() => ({
  games: library.games.length,
  total: ov.value?.totalMs ?? 0,
  today: ov.value?.todayMs ?? 0,
  week: ov.value?.weekMs ?? 0,
  month: ov.value?.monthMs ?? 0,
}))

const anim = ref<KpiNums | null>(null)
let raf = 0

/** 500ms easeOutCubic：起步快、收尾慢——数字是「滑」到位，不是匀速走表 */
function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3)
}

function tween(target: KpiNums): void {
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  if (reduce) {
    anim.value = target
    return
  }
  const from: KpiNums = anim.value ?? { games: 0, total: 0, today: 0, week: 0, month: 0 }
  const start = performance.now()
  cancelAnimationFrame(raf)
  const step = (now: number): void => {
    const t = Math.min(1, (now - start) / 500)
    const k = easeOutCubic(t)
    anim.value = {
      games: Math.round(from.games + (target.games - from.games) * k),
      total: Math.round(from.total + (target.total - from.total) * k),
      today: Math.round(from.today + (target.today - from.today) * k),
      week: Math.round(from.week + (target.week - from.week) * k),
      month: Math.round(from.month + (target.month - from.month) * k),
    }
    if (t < 1) raf = requestAnimationFrame(step)
  }
  raf = requestAnimationFrame(step)
}

watch(targets, (tg) => tween(tg), { immediate: true })
onUnmounted(() => cancelAnimationFrame(raf))

const kpiTotalGames = computed(() => String(anim.value?.games ?? targets.value.games))
const kpiTotalTime = computed(() => fmtDurMsKpi(anim.value?.total ?? targets.value.total))
const kpiToday = computed(() => fmtDurMsKpi(anim.value?.today ?? targets.value.today))
const kpiPeriod = computed(() =>
  fmtDurMsKpi(
    period.value === 'week'
      ? (anim.value?.week ?? targets.value.week)
      : (anim.value?.month ?? targets.value.month),
  ),
)

onMounted(() => {
  void refreshOverview()
})
</script>

<template>
  <div class="home-view">
    <!-- 合并 KPI 面板：一块面板、内部分格（基准 home.png 顶部那条） -->
    <section class="home-kpi glass" :aria-label="t('kpi_total_games')">
      <div class="hk-cell">
        <span class="hk-label"><Gamepad2 :size="15" /> {{ t('kpi_total_games') }}</span>
        <strong class="hk-val">{{ kpiTotalGames }}</strong>
      </div>
      <div class="hk-sep" aria-hidden="true"></div>
      <div class="hk-cell">
        <span class="hk-label"><Timer :size="15" /> {{ t('kpi_total_time') }}</span>
        <strong class="hk-val">{{ kpiTotalTime }}</strong>
      </div>
      <div class="hk-sep" aria-hidden="true"></div>
      <div class="hk-cell">
        <span class="hk-label"><CalendarDays :size="15" /> {{ t('kpi_today') }}</span>
        <strong class="hk-val">{{ kpiToday }}</strong>
      </div>
      <div class="hk-sep" aria-hidden="true"></div>
      <div class="hk-cell hk-period">
        <div class="hk-top">
          <!-- 周期格 label 不带图标：117px 内容宽里 icon+「本月」+toggle 会
               把文字挤掉一个字（截图实测只剩「本」）。其余三格保留图标。 -->
          <span class="hk-label">{{ period === 'week' ? t('kpi_week') : t('kpi_month') }}</span>
          <div class="hk-toggle" role="group">
            <button
              type="button"
              class="hk-seg"
              :class="{ on: period === 'week' }"
              :aria-pressed="period === 'week'"
              @click="period = 'week'"
            >
              {{ t('st_period_wk') }}
            </button>
            <button
              type="button"
              class="hk-seg"
              :class="{ on: period === 'month' }"
              :aria-pressed="period === 'month'"
              @click="period = 'month'"
            >
              {{ t('st_period_mo') }}
            </button>
          </div>
        </div>
        <strong class="hk-val">{{ kpiPeriod }}</strong>
      </div>
    </section>

    <!-- Continue 大卡（基准 home.png 的 Continue Game） -->
    <LibraryHero />

    <!-- 随机游戏卡（基准 home.png 的 Random Game / Shuffle） -->
    <RandomCard />
  </div>
</template>

<style scoped>
.home-view {
  display: flex;
  flex-direction: column;
  gap: var(--hh-space-x4);
  min-height: 0;
  overflow-y: auto;
}

/* ============ 合并 KPI 面板 ============ */
.home-kpi {
  display: flex;
  align-items: stretch;
  flex: none;
  border-radius: var(--hh-radius-panel);
  padding: var(--hh-space-x3) 0;
}
.hk-cell {
  flex: 1;
  min-width: 0;
  padding: 0 var(--hh-space-x3);
  display: flex;
  flex-direction: column;
  gap: var(--hh-space-x1);
}
/* 分格靠竖分隔线，不是卡片间隙——基准的一体感来自这里 */
.hk-sep {
  width: 1px;
  align-self: stretch;
  background: var(--hh-color-border-faint);
  flex: none;
}
.hk-label {
  display: flex;
  align-items: center;
  gap: var(--hh-space-x2);
  font-size: var(--hh-font-caption-size);
  color: var(--hh-color-text-mid);
  white-space: nowrap;
  overflow: hidden;
}
.hk-label svg {
  color: var(--hh-color-text-soft);
  flex: none;
}
.hk-val {
  /* 22px（title 档）不是 kpi 的 26px：窄窗里每格内容宽只有 ~117px，26px 的长
     时长会被裁。基准的 30px 大数是在 1806 宽的窗里，比例换过来就是这个档。
     宽窗（>1600）升回 kpi；窄窗的时长由 fmtDurMsKpi 收短，两者共同保证不截断。 */
  font-size: var(--hh-font-title-size);
  line-height: var(--hh-font-title-lh);
  font-weight: 700;
  color: var(--hh-color-text-glow);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
@media (min-width: 1600px) {
  .hk-val {
    font-size: var(--hh-font-kpi-size);
    line-height: var(--hh-font-kpi-lh);
  }
}
/* 周期格比其余三格更宽：label（本月）+ 周/月 toggle 同排，等宽时 label 会被挤成「本」 */
.hk-period {
  flex: 1.35;
  gap: var(--hh-space-x2);
}
.hk-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--hh-space-x2);
}
.hk-toggle {
  display: flex;
  background: var(--hh-color-surface-soft);
  border: 1px solid var(--hh-color-border-faint);
  border-radius: var(--hh-radius-pill);
  padding: 2px;
  flex: none;
}
.hk-seg {
  border: none;
  background: transparent;
  color: var(--hh-color-text-mid);
  font-size: var(--hh-font-caption-size);
  font-family: inherit;
  padding: 3px 10px;
  border-radius: var(--hh-radius-pill);
  cursor: pointer;
  transition:
    background var(--hh-motion-med),
    color var(--hh-motion-med);
}
.hk-seg:hover {
  color: var(--hh-color-text-glow);
}
.hk-seg.on {
  background: var(--hh-color-card-hover);
  color: var(--hh-color-text-glow);
  font-weight: 600;
}
</style>
