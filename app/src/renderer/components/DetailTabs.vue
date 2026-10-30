<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Check, ClipboardCopy, DatabaseBackup, FolderOpen, Pencil, Wand2 } from 'lucide-vue-next'
import { applyPatch, filterByMeta, library, openEdit, openScrape, refreshGames } from '../stores/library'
import { dailyFromSessions, loadSessions } from '../stores/sessions'
import PlayChart from './PlayChart.vue'
import { t, tf, type I18nKey } from '../i18n'
import { ONE_DAY_MS } from '../../shared/format'
import { type DayStat, type Game, type PlaySession } from '../../shared/types'
import { fmtDate, fmtPlay } from './detailShared'

/**
 * DetailTabs.vue —— 详情面板的分页（游玩数据 / 简介 / 编辑 / 存档）与四个 pane。
 * 自 DetailPanel.vue 拆出，多根节点（div.dp-tabs + Transition 四个 pane）。
 * 打开目录 / 复制游戏信息 / 复制完成态由父面板下发，用拆分前同一个父级实现；
 * 切游戏时 dpTab 回「游玩数据」、简介收起，与原 watch(g) 同帧复位。
 */

const props = defineProps<{
  game: Game | null
  openDir: () => void | Promise<void>
  copyGameInfo: () => void | Promise<void>
  copyDone: boolean
}>()

/** 选中游戏（父组件 v-else 保证非空；仍按可空处理）。 */
const g = computed(() => props.game)

const descExpanded = ref(false)

/**
 * 简介是否超过 6 行阈值（粗略按字符估算，180 字约 6 行）。
 * 按清洗后的正文算——剥掉的 BBCode 不该占行数。
 */
const descTruncated = computed(() => (cleanDesc.value ?? '').length > 180)

/**
 * BBCode 清洗（对基准的优势项）。
 *
 * 源站（VNDB/Bangumi/YMGal）的 description 是 BBCode 富文本：`[url=http://…]Wikipedia[/url]`、
 * `[b]`/`[i]`、`[quote]`、`[list]`/`[*]` 这类标记在 galgame 管理器里没有渲染器，
 * 直接上屏就是把「源码」给用户看。规则是「剥标记、留正文」：
 *   - `[url=x]text[/url]` → text（链接语义在窄栏里没用，文字留下）
 *   - `[img]…[/img]` 整块删（外链图在窄栏只会拖慢/破版）
 *   - 其余成对/自成标记一律剥掉，剩下纯正文
 */
function stripBbcode(src: string): string {
  let s = src
  // 源站自己写歪的变体也要吃下：VNDB 的 description 里出现过 `[From url=…]Wikipedia[/url]`
  // （标签名是 From 不是 url，严格 `[url=` 的正则会漏过去，把半截标记漏给用户）。
  s = s.replace(/\[[a-z][a-z0-9]*\s+url=([^\]]*)\]([\s\S]*?)\[\/url\]/gi, '$2')
  s = s.replace(/\[[a-z][a-z0-9]*\s+url=([^\]]*)\]/gi, '')
  s = s.replace(/\[url=([^\]]*)\]([\s\S]*?)\[\/url\]/gi, '$2')
  s = s.replace(/\[url\]([\s\S]*?)\[\/url\]/gi, '$1')
  s = s.replace(/\[img\][\s\S]*?\[\/img\]/gi, '')
  // 通用标记：[b]/[/b]、[color=…]、[size=20]、[quote]、[*]（列表项）…
  s = s.replace(/\[\/?[a-z][a-z0-9=#_:.-]*\]/gi, '')
  s = s.replace(/\[\/?\*\]/gi, '')
  // 连续 3 个以上换行压成两个：正文空段是分节不是排版
  s = s.replace(/\n{3,}/g, '\n\n')
  return s.trim()
}

const cleanDesc = computed(() => {
  const d = g.value?.description
  return d ? stripBbcode(d) : ''
})

async function toggleCategory(): Promise<void> {
  const game = g.value
  if (!game) return
  // 乐观更新：先改本地镜像 + 拉回服务端新值，不触发全量重拉，避免闪烁与掉滚动位置
  const next = game.categories.includes('已通关')
    ? game.categories.filter((c) => c !== '已通关')
    : [...game.categories, '已通关']
  await applyPatch(game.id, { categories: next })
}


async function toggleFlag(flag: 'useLE' | 'useMagpie'): Promise<void> {
  if (!g.value) return
  await window.hh.updateGame(g.value.id, { [flag]: !g.value[flag] })
  await refreshGames()
}

/** 备份开关（G1）：单游戏 backupEnabled，需设置页全局 backup_on_exit 配合 */
async function toggleBackup(): Promise<void> {
  if (!g.value) return
  await window.hh.updateGame(g.value.id, { backupEnabled: !g.value.backupEnabled })
  await refreshGames()
}

/** G13+G17 变体切换：n=0 默认 exePath，n≥1 = variants[n-1]，改完静默更新本地镜像 */
async function setVariant(n: number): Promise<void> {
  if (!g.value) return
  await applyPatch(g.value.id, { activeVariant: n })
}

/** 当前启动目标的可读名（变体 chips 里的选中态与 meta） */
const variantName = computed(() => {
  const game = g.value
  if (!game) return ''
  const n = game.activeVariant ?? 0
  if (n >= 1 && game.variants && n <= game.variants.length) return game.variants[n - 1]?.label ?? game.title
  return game.title
})

/** 打开该游戏的备份/恢复对话框 */
function openBackups(): void {
  library.backupOpen = true
}


type TabKey = 'stats' | 'intro' | 'edit' | 'saves'
const dpTab = ref<TabKey>('stats')
/** 四个 tab 的 i18n 键（顺序即展示顺序：游玩数据 / 简介 / 编辑 / 存档） */
const dpTabs: { key: TabKey; label: I18nKey }[] = [
  { key: 'stats', label: 'dp_tab_stats' },
  { key: 'intro', label: 'dp_tab_intro' },
  { key: 'edit', label: 'dp_tab_edit' },
  { key: 'saves', label: 'dp_tab_saves' },
]

/** 当前选中游戏的会话明细（最近 500 条；主进程 limit ≤ 500） */
const sessions = ref<PlaySession[]>([])
const sessionsLoading = ref(false)

async function loadFor(id: string): Promise<void> {
  sessionsLoading.value = true
  try {
    const list = await loadSessions({ gameId: id, limit: 500 })
    sessions.value = Array.isArray(list) ? list : []
  } catch {
    // 取数失败不弹窗：曲线退化为 act_empty 空态，小统计显示「—」
    sessions.value = []
  } finally {
    sessionsLoading.value = false
  }
}

// 选中游戏变化 → 重拉该游戏的会话（immediate：首次进入也要拉）
watch(
  g,
  (ng, old) => {
    if (ng && ng.id !== old?.id) void loadFor(ng.id)
    else if (!ng) sessions.value = []
  },
  { immediate: true },
)

type RangeKey = 'play_7d' | 'play_30d' | 'play_1y' | 'play_all'
const range = ref<RangeKey>('play_30d')
/** 区间切换（基准 Game Stats 右上角 7D/30D/M/1Y/ALL，我们用 7D/30D/1Y/ALL 键） */
const ranges: { key: RangeKey; label: I18nKey; days: number }[] = [
  { key: 'play_7d', label: 'play_7d', days: 7 },
  { key: 'play_30d', label: 'play_30d', days: 30 },
  { key: 'play_1y', label: 'play_1y', days: 365 },
  { key: 'play_all', label: 'play_all', days: 0 },
]

const rangeDays = computed(() => ranges.find((r) => r.key === range.value)?.days ?? 30)
const rangeFromTs = computed(() =>
  rangeDays.value > 0 ? Date.now() - rangeDays.value * ONE_DAY_MS : 0,
)

/**
 * 每游戏时长曲线序列：缺日补零、升序（dailyFromSessions 的契约）。
 * 空区间也给一条：PlayChart 全零序列仍画出日历轴，不会跳日期（基准在这里犯错）。
 */
const series = computed<DayStat[]>(() => {
  const game = g.value
  if (!game) return []
  return dailyFromSessions(sessions.value, { fromTs: rangeFromTs.value, gameId: game.id })
})

/** 区间两端日期（图表副行 play_range） */
const rangeFromText = computed(() => series.value[0]?.date?.replace(/-/g, '/') ?? '—')
const rangeToText = computed(() => series.value[series.value.length - 1]?.date?.replace(/-/g, '/') ?? '—')

/** 本周一 00:00（epoch ms）：小统计「本周」的口径 */
const weekStartTs = computed(() => {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  const dow = (d.getDay() + 6) % 7
  return d.getTime() - dow * ONE_DAY_MS
})

const gameSessions = computed(() => {
  const id = g.value?.id
  return id ? sessions.value.filter((s) => s.gameId === id) : []
})

const sessionCount = computed(() => gameSessions.value.length)
const weekMs = computed(() =>
  gameSessions.value.reduce((acc: number, s: PlaySession) => (s.end >= weekStartTs.value ? acc + (s.ms || 0) : acc), 0),
)

/** 切游戏复位：回到「游玩数据」、简介收起（拆分前写在父组件的 watch(g) 里）。 */
watch(() => props.game, () => {
  dpTab.value = 'stats'
  descExpanded.value = false
})
</script>

<template>
<!-- 分页：游玩数据 / 简介 / 编辑 / 存档（手写 segmented，不用 Modal 壳） -->
<div class="dp-tabs" role="tablist" :aria-label="t('dp_tab_stats')">
  <button
    v-for="tb in dpTabs"
    :key="tb.key"
    class="dp-tab"
    :class="{ active: dpTab === tb.key }"
    role="tab"
    :aria-selected="dpTab === tb.key"
    :aria-controls="'dp-pane-' + tb.key"
    type="button"
    @click="dpTab = tb.key"
  >
    {{ t(tb.label) }}
  </button>
</div>

<Transition name="pane" mode="out-in">
<!-- ============ 游玩数据 ============ -->
<div v-if="dpTab === 'stats' && g" id="dp-pane-stats" key="stats" class="dp-pane" role="tabpanel">
  <div class="pc-range">
    <button
      v-for="r in ranges"
      :key="r.key"
      class="range-chip"
      :class="{ on: range === r.key }"
      type="button"
      :aria-pressed="range === r.key"
      @click="range = r.key"
    >
      {{ t(r.label) }}
    </button>
    <!-- 区间两端日期并入 chip 行右侧：单独占一行（18px+间距）
         在右栏预算里就是曲线的头 -->
    <span class="pc-range-sub">{{ tf('play_range', { from: rangeFromText, to: rangeToText }) }}</span>
  </div>
  <PlayChart :series="series" :height="150" />
  <div class="dp-mini-stats">
    <div class="dp-mini">
      <span class="dp-mini-label">{{ t('dp_playtime') }}</span>
      <span class="dp-mini-val">{{ fmtPlay(g.playMs) }}</span>
    </div>
    <div class="dp-mini">
      <span class="dp-mini-label">{{ t('kpi_sessions') }}</span>
      <span class="dp-mini-val">{{ sessionCount || '—' }}</span>
    </div>
    <div class="dp-mini">
      <span class="dp-mini-label">{{ t('kpi_week') }}</span>
      <span class="dp-mini-val">{{ fmtPlay(weekMs) }}</span>
    </div>
  </div>
  <div v-if="sessionsLoading" class="dp-mini-note">{{ t('cg_loading') }}</div>
  <div v-if="g.lastPlayed" class="dp-mini-note">
    {{ t('dp_last_played') }}：{{ fmtDate(g.lastPlayed) }}
  </div>

  <!-- 工具与开关：基准藏在 More 菜单里，我们做成常驻小分组（不折叠，比基准更直接） -->
  <div class="dp-tools">
    <div class="dp-tools-title">{{ t('dp_more_tools') }}</div>
    <label class="dp-switch">
      <input :checked="!!g.useLE" type="checkbox" @change="toggleFlag('useLE')" />
      <span class="dp-switch-box" aria-hidden="true"></span>
      <span class="dp-switch-label">{{ t('dp_switch_le') }}</span>
    </label>
    <label class="dp-switch">
      <input :checked="!!g.useMagpie" type="checkbox" @change="toggleFlag('useMagpie')" />
      <span class="dp-switch-box" aria-hidden="true"></span>
      <span class="dp-switch-label">{{ t('dp_switch_magpie') }}</span>
    </label>
  </div>
</div>

<!-- ============ 简介（BBCode 已剥干净） ============ -->
<div v-else-if="dpTab === 'intro' && g" id="dp-pane-intro" key="intro" class="dp-pane" role="tabpanel">
  <!-- 系列 chips（series 关联：前作/续作/外传，点击聚合筛选同系列） -->
  <div v-if="g.series?.length" class="series">
    <span class="meta-key series-key">{{ t('dp_series') }}</span>
    <div class="series-chips">
      <button
        v-for="s in g.series.slice(0, 6)"
        :key="s"
        class="series-chip"
        :class="{ on: library.metaKey === 'series' && library.metaValue === s }"
        :title="t('dp_same_series')"
        @click="filterByMeta('series', s)"
      >
        {{ s }}
      </button>
    </div>
  </div>
  <!-- 别名行 -->
  <div v-if="g.aliases?.length" class="aliases">
    <span class="meta-key">{{ t('dp_aliases') }}</span
    ><span class="aliases-text" :title="g.aliases.join('，')">{{ g.aliases.slice(0, 6).join('，') }}</span>
  </div>
  <div v-if="cleanDesc" class="desc-wrap">
    <p class="desc" :class="{ clamped: !descExpanded }">{{ cleanDesc }}</p>
    <button v-if="descTruncated" class="desc-toggle" @click="descExpanded = !descExpanded">
      {{ descExpanded ? t('dp_collapse') : t('dp_expand') }}
    </button>
  </div>
  <p v-else class="dp-pane-empty">{{ t('act_empty') }}</p>
</div>

<!-- ============ 编辑（原文字段编辑：复用 EditDialog 触发） ============ -->
<div v-else-if="dpTab === 'edit' && g" id="dp-pane-edit" key="edit" class="dp-pane" role="tabpanel">
  <button class="dp-pane-btn" type="button" @click="openEdit(g.id)">
    <Pencil :size="14" /> {{ t('detail_edit') }}
  </button>
  <button class="dp-pane-btn" type="button" @click="openScrape(g.id, g.rawTitle || g.title)">
    <Wand2 :size="14" /> {{ t('detail_scrape') }}
  </button>
  <button class="dp-pane-btn" type="button" :title="t('dp_copy_title')" @click="copyGameInfo">
    <ClipboardCopy :size="14" /> {{ copyDone ? t('dp_copied') : t('dp_copy') }}
  </button>
  <button class="dp-pane-btn" type="button" @click="openDir">
    <FolderOpen :size="14" /> {{ t('dp_dir') }}
  </button>
  <!-- 已通关分类 toggle（原 cats 区的功能，随编辑能力一起收进本页） -->
  <button class="dp-pane-btn" type="button" :aria-pressed="g.categories.includes('已通关')" @click="toggleCategory">
    <Check :size="14" /> {{ t('batch_cleared') }}
  </button>
  <!-- G13+G17 版本/语言包切换：默认 exePath + 每个变体一个 chip -->
  <div v-if="g.variants?.length" class="variants">
    <span class="meta-key variants-key">{{ t('dp_version') }}</span>
    <div class="variants-chips">
      <button
        class="variant-chip"
        :class="{ on: (g.activeVariant ?? 0) === 0 }"
        :title="g.exePath"
        type="button"
        @click="setVariant(0)"
      >
        {{ t('dp_default') }}
      </button>
      <button
        v-for="(v, i) in g.variants"
        :key="i"
        class="variant-chip"
        :class="{ on: (g.activeVariant ?? 0) === i + 1 }"
        :title="v.exePath"
        type="button"
        @click="setVariant(i + 1)"
      >
        {{ v.label }}
      </button>
    </div>
  </div>
  <div class="dp-pane-note">
    {{ t('dp_launch_target') }}：{{ variantName }}
  </div>
</div>

<!-- ============ 存档（备份开关 + 备份记录入口） ============ -->
<div v-else-if="dpTab === 'saves' && g" id="dp-pane-saves" key="saves" class="dp-pane" role="tabpanel">
  <label class="dp-switch">
    <input :checked="!!g.backupEnabled" type="checkbox" @change="toggleBackup" />
    <span class="dp-switch-box" aria-hidden="true"></span>
    <span class="dp-switch-label">
      {{ g.backupEnabled ? t('detail_backup_on') : t('detail_backup') }}
    </span>
  </label>
  <button class="dp-pane-btn" type="button" :aria-pressed="!!library.backupOpen" @click="openBackups">
    <DatabaseBackup :size="14" /> {{ t('detail_backup_records') }}
  </button>
</div>
</Transition>
</template>

<style scoped>
/* ============ 分页（手写 segmented） ============ */
.dp-tabs {
  display: flex;
  gap: var(--hh-space-x1);
  padding: 3px;
  background: var(--hh-color-surface-soft);
  border: 1px solid var(--hh-color-border-faint);
  border-radius: var(--hh-radius-md);
  flex: none;
}
.dp-tab {
  flex: 1;
  min-width: 0;
  height: 30px;
  /* 边框常驻（透明）：激活态换色不改盒尺寸，四个 tab 不跳 */
  border: 1px solid transparent;
  border-radius: var(--hh-radius-sm);
  background: transparent;
  color: var(--hh-color-text-mid);
  font-size: var(--hh-font-caption-size);
  font-family: inherit;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition:
    background var(--hh-motion-med),
    color var(--hh-motion-med);
}
.dp-tab:hover {
  color: var(--hh-color-text-glow);
  background: var(--hh-color-surface-hover-soft);
}
.dp-tab.active {
  background: var(--hh-color-select-bg);
  border-color: var(--hh-color-accent-selected-border);
  color: var(--hh-color-select-text);
  font-weight: 600;
}

/* ============ 分页内容 ============ */
.dp-pane {
  display: flex;
  flex-direction: column;
  gap: var(--hh-space-x3);
}

/* 区间切换（7D/30D/1Y/ALL） */
.pc-range {
  display: flex;
  align-items: center;
  gap: var(--hh-space-x1);
  flex-wrap: wrap;
}
.range-chip {
  height: 26px;
  padding: 0 var(--hh-space-x2);
  border: 1px solid var(--hh-color-border-ghost-soft);
  border-radius: var(--hh-radius-xs);
  background: transparent;
  color: var(--hh-color-text-mid);
  font-size: var(--hh-font-caption-size);
  cursor: pointer;
  transition:
    background var(--hh-motion-med),
    color var(--hh-motion-med);
}
.range-chip:hover {
  background: var(--hh-color-surface-mid);
  color: var(--hh-color-text-glow);
}
.range-chip.on {
  background: var(--hh-color-select-bg);
  border-color: var(--hh-color-accent-selected-border);
  color: var(--hh-color-select-text);
  font-weight: 600;
}
.pc-range-sub {
  margin-left: auto;
  font-size: var(--hh-font-caption-size);
  color: var(--hh-color-text-dim);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* 小统计（总时长 / 场次 / 本周） */
.dp-mini-stats {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--hh-space-x2);
}
.dp-mini {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  padding: var(--hh-space-x2);
  background: var(--hh-color-card);
  border: 1px solid var(--hh-color-card-border);
  border-radius: var(--hh-radius-sm);
}
.dp-mini-label {
  font-size: var(--hh-font-caption-size);
  color: var(--hh-color-text-dim-strong);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dp-mini-val {
  font-size: var(--hh-font-bodyLg-size);
  font-weight: 600;
  color: var(--hh-color-text-glow);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dp-mini-note {
  font-size: var(--hh-font-caption-size);
  color: var(--hh-color-text-dim);
}

/* 工具与开关（基准的 More 菜单 → 常驻小分组） */
.dp-tools {
  display: flex;
  flex-direction: column;
  gap: var(--hh-space-x2);
  padding: var(--hh-space-x2) var(--hh-space-x3);
  background: var(--hh-color-card);
  border: 1px solid var(--hh-color-card-border);
  border-radius: var(--hh-radius-panel);
}
.dp-tools-title {
  font-size: var(--hh-font-caption-size);
  color: var(--hh-color-text-dim-strong);
}
.dp-switch {
  display: flex;
  align-items: center;
  gap: var(--hh-space-x2);
  cursor: pointer;
  font-size: var(--hh-font-body-size);
  color: var(--hh-color-text-strong);
  user-select: none;
}
/* 原生 checkbox：视觉隐藏但保留可聚焦与语义（读屏/键盘都能用） */
.dp-switch input {
  position: absolute;
  opacity: 0;
  width: 0;
  height: 0;
}
.dp-switch-box {
  flex: none;
  position: relative;
  width: 32px;
  height: 18px;
  border-radius: var(--hh-radius-pill);
  border: 1px solid var(--hh-color-border-ghost-soft);
  background: var(--hh-color-surface-soft);
  transition:
    background var(--hh-motion-med),
    border-color var(--hh-motion-med);
}
.dp-switch-box::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 12px;
  height: 12px;
  border-radius: var(--hh-radius-pill);
  background: var(--hh-color-text-mid);
  transition:
    transform var(--hh-motion-med),
    background var(--hh-motion-med);
}
.dp-switch input:checked + .dp-switch-box {
  background: var(--hh-color-select-bg);
  border-color: var(--hh-color-accent-selected-border);
}
.dp-switch input:checked + .dp-switch-box::after {
  transform: translateX(14px);
  background: var(--hh-color-accent);
}
.dp-switch input:focus-visible + .dp-switch-box {
  outline: 2px solid var(--hh-color-accent-ring);
  outline-offset: 2px;
}
.dp-switch-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ============ 元数据（简介页） ============ */
.meta-key {
  color: var(--hh-color-text-dim-strong);
  flex-shrink: 0;
}
.link {
  color: var(--hh-color-link);
  cursor: pointer;
  text-decoration: none;
}
.link:hover {
  text-decoration: underline;
}

/* ============ 版本/语言包切换（G13+G17） ============ */
.variants {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.variants-key {
  flex-shrink: 0;
  font-size: var(--hh-font-caption-size);
}
.variants-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.variant-chip {
  font-size: 11.5px;
  padding: 4px 10px;
  border-radius: var(--hh-radius-sm);
  border: 1px solid var(--hh-color-surface-hover);
  background: transparent;
  color: var(--hh-color-text-mid-high);
  cursor: pointer;
  transition: all var(--hh-motion-med);
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.variant-chip:hover {
  background: var(--hh-color-surface-mid);
}
.variant-chip.on {
  background: var(--hh-color-select-bg);
  border-color: var(--hh-color-accent-selected-border);
  color: var(--hh-color-select-text);
  font-weight: 600;
}

/* ============ 标签 ============ */
.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
/* ============ 系列（G12） ============ */
.series {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.series-key {
  font-size: var(--hh-font-caption-size);
  color: var(--hh-color-text-dim-strong);
}
.series-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.series-chip {
  font-size: 11px;
  padding: 3px 9px;
  border-radius: var(--hh-radius-xs);
  background: var(--hh-color-accent-bg);
  color: var(--hh-color-accent-text);
  opacity: 0.85;
  border: 1px solid transparent;
  cursor: pointer;
  transition: all var(--hh-motion-med);
}
.series-chip:hover {
  opacity: 1;
  background: var(--hh-color-accent-chip-bg);
}
.series-chip.on {
  opacity: 1;
  border-color: var(--hh-color-accent-ring);
  color: var(--hh-color-accent);
  font-weight: 600;
}
.aliases {
  font-size: 11.5px;
  color: var(--hh-color-text-dim);
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
.aliases .meta-key {
  font-size: inherit;
}
.aliases-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}

/* ============ 编辑/存档页按钮 ============ */
.dp-pane-btn {
  display: flex;
  align-items: center;
  gap: var(--hh-space-x2);
  height: 36px;
  padding: 0 var(--hh-space-x3);
  border: 1px solid var(--hh-color-border-ghost-soft);
  border-radius: var(--hh-radius-md);
  background: var(--hh-color-surface-soft);
  color: var(--hh-color-text-strong);
  font-size: var(--hh-font-body-size);
  font-family: inherit;
  cursor: pointer;
  transition: background var(--hh-motion-med);
}
.dp-pane-btn:hover {
  background: var(--hh-color-surface-hover-soft);
  color: var(--hh-color-text-glow);
}
/* 激活态（已通关 toggle / 备份记录入口）：成功色描边，不用 accent 实色铺满 */
.dp-pane-btn[aria-pressed='true'] {
  border-color: var(--hh-color-success-border);
  color: var(--hh-color-success-text);
  font-weight: 600;
}
.dp-pane-note,
.dp-pane-empty {
  margin: 0;
  font-size: var(--hh-font-caption-size);
  color: var(--hh-color-text-dim);
}

/* ============ 简介 ============ */
.desc-wrap {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex-shrink: 0;
}
.desc {
  font-size: var(--hh-font-body-size);
  line-height: 20px;
  color: var(--hh-color-text-mid-high);
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: break-word;
}
/* ============ 分页切换动效 ============ */
/* out-in：旧页 83ms 淡出后再入场，两页不叠帧。宽度不变所以不做位移横滑 */
.pane-enter-from {
  opacity: 0;
  transform: translateY(4px);
}
.pane-enter-active {
  transition:
    opacity var(--hh-motion-med) var(--hh-motion-ease-out),
    transform var(--hh-motion-slow) var(--hh-motion-ease-out);
}
.pane-leave-active {
  transition: opacity var(--hh-motion-fast) var(--hh-motion-ease-in);
}
.pane-leave-to {
  opacity: 0;
}

.desc.clamped {
  display: -webkit-box;
  -webkit-line-clamp: 6;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.desc-toggle {
  align-self: flex-start;
  border: none;
  background: none;
  color: var(--hh-color-accent);
  font-size: var(--hh-font-caption-size);
  cursor: pointer;
  padding: 0;
}
.desc-toggle:hover {
  color: var(--hh-color-accent-hover);
}
</style>
