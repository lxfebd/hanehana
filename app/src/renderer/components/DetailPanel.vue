<script setup lang="ts">
/**
 * 详情面板（右栏选中态）。
 *
 * 结构对标基准 detail.png / stats.png 的右栏密度：
 *   - 横幅 224px hero：thumb `blur(32px) saturate(1.2) scale(1.2)` opacity .55 + scrim 渐变
 *   - 元数据行：数据来源 / 开发商 / 发售日 / 加入时间 / 预计时长 / 评分一行摊开
 *     （label caption 小灰字、值正文色；空值统一「—」）
 *   - 标签区：tag 全集 + 行内搜索（实时过滤）+ 清除 + 展开/收起（默认折叠到 8 个）
 *   - 四个分页（手写 segmented，无 Modal 闸）：游玩数据 / 简介 / 编辑 / 存档
 *   - 游玩数据页：7D/30D/1Y/ALL 区间切换 + 副行区间两端 + 每游戏时长曲线
 *     （缺日补零的日序列，交给 stores/sessions 的 dailyFromSessions）
 *   - 工具与开关：useLE / useMagpie 常驻小分组，不折进 More 菜单
 *
 * 对基准的优势项：简介里的 BBCode（[url=…][/url]、[b]/[i] 等源站标记）在渲染前
 * 剥干净只留正文——基准把 `[From url=…]Wikipedia[/url]]` 直接怼到界面上。
 */
import { computed, ref, watch } from 'vue'
import {
  Activity,
  Check,
  ClipboardCopy,
  DatabaseBackup,
  Flower2,
  FolderOpen,
  Heart,
  PanelRightClose,
  Pencil,
  Play,
  Search,
  Star,
  Wand2,
  X,
} from 'lucide-vue-next'
import {
  applyPatch,
  launchGame,
  library,
  openEdit,
  openScrape,
  refreshGames,
  runningGames,
  selectedGame,
  thumbUrl,
  toggleFavorite,
  filterByMeta,
} from '../stores/library'
import { dailyFromSessions, loadSessions } from '../stores/sessions'
import PlayChart from './PlayChart.vue'
import { t, tf, type I18nKey } from '../i18n'
import { tokens } from '../design/tokens'
import { ONE_DAY_MS } from '../../shared/format'
import type { DayStat, PlaySession } from '../../shared/types'

const emit = defineEmits<{ collapse: [] }>()
const g = computed(() => selectedGame.value)
const descExpanded = ref(false)
/** 评分星星色（真值 tokens；reactive，切主题自动刷新） */
const starColor = computed(() => tokens.color.star)

/** 横幅/封面图加载失败：置位 bannerFailed 触发 v-if 卸载（img 按 ref 记忆，
 *  display 按元素记的状态不再交叉错位）。banner-letter 的兜底同帧出现。 */
const bannerFailed = ref(false)
function imgErr(): void {
  bannerFailed.value = true
}
// 切到别的游戏时重来：banner-letter 的兜底状态不能带过去，展开态/搜索/tab 也复位
watch(g, () => {
  bannerFailed.value = false
  descExpanded.value = false
  tagQuery.value = ''
  tagsExpanded.value = false
  dpTab.value = 'stats'
})

function fmtPlay(ms: number): string {
  if (ms <= 0) return '—'
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  return h > 0 ? tf('dp_hours_min', { h, m }) : tf('dp_minutes', { m })
}

function fmtDate(ts?: number): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleDateString('zh-CN')
}

/** 平均通关时长：分钟 → 可读文本（VNDB length_minutes） */
const lengthText = computed(() => {
  const m = g.value?.lengthMinutes
  if (!m || m <= 0) return ''
  if (m < 60) return tf('dp_minutes', { m })
  const h = Math.floor(m / 60)
  const rem = m % 60
  return rem > 0 ? tf('dp_hours_min', { h, m: rem }) : tf('dp_hours', { h })
})

/** 横幅背景：thumb 预模糊位图（有 thumb 时），无则主色渐变兜底 */
function bannerImg(): string {
  if (!g.value) return ''
  if (g.value.thumbPath) return thumbUrl(g.value)
  if (g.value.coverPath) return `file://${g.value.coverPath.replace(/\\/g, '/')}`
  return ''
}

function bannerFallback(): string {
  const c = g.value?.color ?? tokens.color.coverFallback
  // 无图横幅：主色径向光晕打底 + 暗色渐变收边，不再是单色空洞。
  // 浅色主题下 coverFallback 是近白、渐变收边色也是浅的，光晕透明度低，不依赖主题态。
  return `radial-gradient(120% 90% at 15% 0%, ${c}55 0%, transparent 55%),
    radial-gradient(100% 80% at 85% 100%, ${c}44 0%, transparent 60%),
    linear-gradient(160deg, ${c}cc, ${c}22 60%, ${tokens.color.bannerBase} 100%)`
}

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

function openDir(): void {
  if (g.value) void window.hh.openDir(g.value.dir)
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

/**
 * 复制游戏信息到剪贴板（推荐/分享/贴评测用）。
 *
 * 格式是多行 key: value，空字段整行略过——复制出来直接能贴进聊天窗，
 * 不需要二次整理。用 navigator.clipboard（Electron 渲染进程在
 * file:// 下可用；失败兜底 document.execCommand 老路线并提示）。
 * copyDone 只做 1.2s 的「已复制」反馈，不弹 message（动作太轻，不该打断）。
 */
const copyDone = ref(false)
let copyTimer: ReturnType<typeof setTimeout> | null = null
async function copyGameInfo(): Promise<void> {
  const game = g.value
  if (!game) return
  const rows: string[] = [game.title]
  if (game.titleNative && game.titleNative !== game.title) rows.push(`${t('dp_name_native')}：${game.titleNative}`)
  if (game.rating) rows.push(`${t('dp_rating')}：${game.rating.toFixed(1)}`)
  if (game.developer) rows.push(`${t('dp_developer')}：${game.developer}`)
  if (game.releaseDate) rows.push(`${t('dp_release')}：${game.releaseDate}`)
  if (game.lengthMinutes) rows.push(`${t('dp_length')}：${lengthText.value}`)
  if (game.tags.length) rows.push(`${t('dp_tags')}：${game.tags.join('、')}`)
  if (game.series?.length) rows.push(`${t('dp_series')}：${game.series.join('、')}`)
  const text = rows.join('\n')
  try {
    await navigator.clipboard.writeText(text)
    flashCopied()
  } catch {
    // 老路线兜底：clipboard API 在少数环境（非安全上下文）不可用
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    if (ok) flashCopied()
    else library.error = t('dp_copy_fail')
  }
}
function flashCopied(): void {
  copyDone.value = true
  if (copyTimer) clearTimeout(copyTimer)
  copyTimer = setTimeout(() => {
    copyDone.value = false
    copyTimer = null
  }, 1200)
}

// ---------------------------------------------------------------- 分页（手写 segmented）

type TabKey = 'stats' | 'intro' | 'edit' | 'saves'
const dpTab = ref<TabKey>('stats')
/** 四个 tab 的 i18n 键（顺序即展示顺序：游玩数据 / 简介 / 编辑 / 存档） */
const dpTabs: { key: TabKey; label: I18nKey }[] = [
  { key: 'stats', label: 'dp_tab_stats' },
  { key: 'intro', label: 'dp_tab_intro' },
  { key: 'edit', label: 'dp_tab_edit' },
  { key: 'saves', label: 'dp_tab_saves' },
]

// ---------------------------------------------------------------- 标签全集 + 搜索

const tagQuery = ref('')
const tagsExpanded = ref(false)
/** 折叠阈值：约 2 行 chip（360px 栏宽下每行 3–4 个中文标签） */
const TAG_COLLAPSED = 8

const filteredTags = computed(() => {
  const all = g.value?.tags ?? []
  const q = tagQuery.value.trim().toLowerCase()
  return q ? all.filter((tag) => tag.toLowerCase().includes(q)) : all
})

const visibleTags = computed(() =>
  tagsExpanded.value ? filteredTags.value : filteredTags.value.slice(0, TAG_COLLAPSED),
)

/** 搜索结果为空时给一句「没有匹配的标签」，而不是一块空白 */
const tagsEmpty = computed(() => filteredTags.value.length === 0)
/** 过滤后仍超出折叠阈值才给展开按钮 */
const tagsOverflow = computed(() => filteredTags.value.length > TAG_COLLAPSED)

// ---------------------------------------------------------------- 游玩数据（曲线 + 小统计）

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
  gameSessions.value.reduce((acc, s) => (s.end >= weekStartTs.value ? acc + (s.ms || 0) : acc), 0),
)

// ---------------------------------------------------------------- 元数据行（一行摊开）

/** 数据来源：sources 第一个 provider 名（vndb/bangumi/ymgal…），无则「—」 */
const sourceText = computed(() => g.value?.sources?.[0]?.provider ?? '')
const releaseText = computed(() => g.value?.releaseDate ?? '')
const addedText = computed(() => (g.value?.addedAt ? fmtDate(g.value.addedAt) : ''))
const ratingText = computed(() => (g.value?.rating ? g.value.rating.toFixed(1) : ''))
</script>

<template>
  <aside class="detail-panel glass">
    <button
      class="detail-collapse"
      :title="t('app_collapse_detail')"
      :aria-label="t('app_collapse_detail')"
      @click="emit('collapse')"
    >
      <PanelRightClose :size="14" />
    </button>
    <!-- 未选中空态 -->
    <div v-if="!g" class="empty-state">
      <Flower2 :size="36" :stroke-width="1.5" class="empty-icon" />
      <div class="empty-text">{{ t('detail_empty') }}</div>
    </div>

    <template v-else>
      <!-- 横幅 224px hero -->
      <div class="banner" :style="bannerImg() ? {} : { background: bannerFallback() }">
        <div v-if="bannerImg()" class="banner-blur" :style="{ backgroundImage: `url(${bannerImg()})` }"></div>
        <div v-if="bannerImg()" class="banner-tint" :style="{ background: bannerFallback() }"></div>
        <div class="banner-noise"></div>
        <div class="banner-scrim"></div>

        <div class="banner-cover">
          <!-- 加载失败即卸载（bannerFailed 置位），切游戏复位后自动重挂载——
               不直接改 style.display，避免「display 按元素记、bannerFailed 按 ref 记」
               的错位（切到有图游戏封面仍隐藏的 bug 根源）。 -->
          <img v-if="bannerImg() && !bannerFailed" :src="bannerImg()" class="banner-img" @error="imgErr" />
          <div v-show="!bannerImg() || bannerFailed" class="banner-letter">{{ g.title.slice(0, 1) }}</div>
        </div>

        <div class="banner-meta">
          <div class="banner-title">{{ g.title }}</div>
          <div v-if="g.titleNative && g.titleNative !== g.title" class="banner-native">{{ g.titleNative }}</div>
          <div class="banner-chips">
            <span v-if="g.releaseDate" class="chip">{{ g.releaseDate }}</span>
            <span v-if="g.rating" class="chip chip-rating">
              <Star :size="11" :fill="starColor" :stroke-width="0" /> {{ g.rating.toFixed(1) }}
            </span>
          </div>
        </div>
      </div>

      <!-- 动作栏：主按钮满宽 + 双 ghost 次行 -->
      <div class="actions">
        <button class="primary-btn" @click="launchGame(g.id)">
          <span v-if="runningGames.has(g.id)"><Activity :size="16" /> {{ t('detail_running') }}</span>
          <span v-else><Play :size="16" :fill="'currentColor'" /> {{ t('detail_launch') }}</span>
        </button>
      </div>
      <div class="actions-sub">
        <button class="ghost-btn" @click="openScrape(g.id, g.rawTitle || g.title)">
          <Wand2 :size="14" /> {{ t('detail_scrape') }}
        </button>
        <button class="ghost-btn" @click="openEdit(g.id)"><Pencil :size="14" /> {{ t('detail_edit') }}</button>
        <button class="ghost-btn" @click="openDir"><FolderOpen :size="14" /> {{ t('detail_dir') }}</button>
        <!-- 复制信息：给朋友推荐/发群/贴评测时最常用的一步，
             此前要手动选中标题→再翻详情找开发商→再抄标签。 -->
        <button class="ghost-btn" :title="t('dp_copy_title')" @click="copyGameInfo">
          <ClipboardCopy :size="14" /> {{ copyDone ? t('dp_copied') : t('dp_copy') }}
        </button>
      </div>

      <!-- 元数据行：数据来源 / 开发商 / 发售日 / 加入时间 / 预计时长 / 评分（基准一行摊开） -->
      <div class="dp-meta" :aria-label="t('dp_source')">
        <div class="dp-meta-cell">
          <span class="dp-meta-key">{{ t('dp_source') }}</span>
          <span class="dp-meta-val" :title="sourceText || '—'">{{ sourceText || '—' }}</span>
        </div>
        <div class="dp-meta-cell">
          <span class="dp-meta-key">{{ t('dp_developer') }}</span>
          <a
            v-if="g.developer"
            class="dp-meta-val link"
            :title="t('dp_same_dev')"
            @click="filterByMeta('developer', g.developer)"
            >{{ g.developer }}</a
          >
          <span v-else class="dp-meta-val">—</span>
        </div>
        <div class="dp-meta-cell">
          <span class="dp-meta-key">{{ t('dp_release') }}</span>
          <span class="dp-meta-val" :title="releaseText || '—'">{{ releaseText || '—' }}</span>
        </div>
        <div class="dp-meta-cell">
          <span class="dp-meta-key">{{ t('dp_added') }}</span>
          <span class="dp-meta-val" :title="addedText || '—'">{{ addedText || '—' }}</span>
        </div>
        <div class="dp-meta-cell">
          <span class="dp-meta-key">{{ t('dp_length') }}</span>
          <span class="dp-meta-val" :title="lengthText || '—'">{{ lengthText || '—' }}</span>
        </div>
        <div class="dp-meta-cell">
          <span class="dp-meta-key">{{ t('dp_rating') }}</span>
          <span class="dp-meta-val dp-meta-num" :title="ratingText || '—'">
            <Star v-if="ratingText" :size="11" :fill="starColor" :stroke-width="0" class="dp-meta-star" />
            {{ ratingText || '—' }}
          </span>
        </div>
      </div>

      <!-- 标签区：tag 全集 + 行内搜索/清除 + 展开收起 -->
      <div class="dp-tags">
        <div class="dp-tags-head">
          <span class="dp-tags-title">{{ t('dp_tags') }}</span>
          <span class="dp-tags-count">{{ filteredTags.length }} / {{ g.tags.length }}</span>
        </div>
        <div class="dp-tags-search">
          <Search :size="13" class="dp-tags-search-icon" />
          <input
            v-model="tagQuery"
            class="dp-tags-input"
            type="text"
            :placeholder="t('dp_tags_search_ph')"
            :aria-label="t('dp_tags_search_ph')"
          />
          <button
            v-if="tagQuery"
            class="dp-tags-clear"
            type="button"
            :title="t('dp_tags_clear')"
            :aria-label="t('dp_tags_clear')"
            @click="tagQuery = ''"
          >
            <X :size="12" />
          </button>
        </div>
        <div class="dp-tags-chips">
          <span v-for="tag in visibleTags" :key="tag" class="tag-chip" :title="tag">{{ tag }}</span>
          <span v-if="tagsEmpty" class="dp-tags-none">{{ t('dp_tags_none') }}</span>
        </div>
        <button v-if="tagsOverflow" class="dp-tags-toggle" type="button" @click="tagsExpanded = !tagsExpanded">
          {{ tagsExpanded ? t('dp_tags_collapse') : t('dp_tags_expand') }}
        </button>
      </div>

      <!-- 收藏行 -->
      <div class="fav-row">
        <button class="fav-btn" :class="{ on: g.favorite }" :aria-pressed="g.favorite" @click="toggleFavorite(g.id)">
          <Heart :size="13" :fill="g.favorite ? 'currentColor' : 'none'" />
          {{ g.favorite ? t('detail_faved') : t('detail_fav') }}
        </button>
      </div>

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

      <!-- ============ 游玩数据 ============ -->
      <div v-if="dpTab === 'stats'" id="dp-pane-stats" class="dp-pane" role="tabpanel">
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
        </div>
        <div class="pc-range-sub">{{ tf('play_range', { from: rangeFromText, to: rangeToText }) }}</div>
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
      <div v-else-if="dpTab === 'intro'" id="dp-pane-intro" class="dp-pane" role="tabpanel">
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
      <div v-else-if="dpTab === 'edit'" id="dp-pane-edit" class="dp-pane" role="tabpanel">
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
      <div v-else id="dp-pane-saves" class="dp-pane" role="tabpanel">
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
    </template>
  </aside>
</template>

<style scoped>
.detail-panel {
  width: 360px;
  position: relative;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.detail-collapse {
  position: sticky;
  top: 0;
  z-index: 5;
  align-self: flex-end;
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: var(--hh-radius-sm);
  background: var(--hh-color-surface-soft);
  color: var(--hh-color-text-mid);
  cursor: pointer;
  transition:
    background var(--hh-motion-med),
    color var(--hh-motion-med);
  margin-bottom: -40px;
  flex: none;
}
.detail-collapse:hover {
  background: var(--hh-color-surface-hover);
  color: var(--hh-color-text-glow);
}

.empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--hh-color-text-mid);
}
.empty-icon {
  color: var(--hh-color-text-mid);
}
.empty-text {
  font-size: var(--hh-font-body-size);
}

/* ============ 横幅 224px hero ============ */
.banner {
  border-radius: var(--hh-radius-panel);
  overflow: hidden;
  position: relative;
  height: 224px;
  /* 固定高度的 hero 不许被 flex 列压缩：面板内容（元数据/标签/分页/曲线）
     远超视口高度时，默认 flex-shrink:1 会把它压成一条（实测 32px），
     封面就没了。flex:none = 保持 224px，溢出交给 .detail-panel 滚动。 */
  flex: none;
  display: flex;
  align-items: flex-end;
  gap: 14px;
  padding: 16px;
}
.banner-blur {
  position: absolute;
  inset: 0;
  background-size: cover;
  background-position: center;
  filter: blur(32px) saturate(1.2);
  transform: scale(1.2);
  opacity: 0.55;
}
.banner-tint {
  position: absolute;
  inset: 0;
  opacity: 0.35;
}
/* 无图兜底时仍有一点质感：胶片噪点，避免纯渐变显得发虚 */
.banner-noise {
  position: absolute;
  inset: 0;
  opacity: 0.5;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='120' height='120' filter='url(%23n)' opacity='0.35'/%3E%3C/svg%3E");
  mix-blend-mode: overlay;
}
.banner-scrim {
  position: absolute;
  inset: 0;
  background: var(--hh-color-banner-scrim);
}
.banner-cover {
  position: relative;
  width: 104px;
  height: 156px;
  border-radius: var(--hh-radius-md);
  overflow: hidden;
  flex-shrink: 0;
  box-shadow: 0 6px 20px var(--hh-color-shade-banner);
  z-index: 1;
}
.banner-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.banner-letter {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 48px;
  font-weight: 700;
  color: var(--hh-color-text-mid);
}
.banner-meta {
  position: relative;
  z-index: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-bottom: 2px;
}
.banner-title {
  font-size: var(--hh-font-title-size);
  line-height: 28px;
  font-weight: 700;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  text-shadow: 0 1px 6px var(--hh-color-shade-text);
}
.banner-native {
  font-size: var(--hh-font-caption-size);
  color: var(--hh-color-text-bright);
  text-shadow: 0 1px 4px var(--hh-color-shade-text);
}
.banner-chips {
  display: flex;
  gap: 6px;
  margin-top: 2px;
}
.chip {
  font-size: 11px;
  background: var(--hh-color-surface-strong);
  padding: 2px 8px;
  border-radius: var(--hh-radius-sm);
  display: flex;
  align-items: center;
  gap: 3px;
}
.chip-rating {
  color: var(--hh-color-star);
  font-weight: 600;
}

/* ============ 动作栏 ============ */
.actions {
  display: flex;
}
/* 主按钮：accent 实色 + 极轻阴影（不用渐变、不用 hover 位移抬升）。
   阴影只做"可点击"的层次暗示，不做彩色辉光。 */
.primary-btn {
  flex: 1;
  height: 40px;
  border: none;
  border-radius: var(--hh-radius-md);
  background: var(--hh-color-accent);
  color: var(--hh-color-on-accent);
  font-size: var(--hh-font-bodyLg-size);
  font-weight: 600;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  transition: background var(--hh-motion-med) ease;
}
.primary-btn:hover {
  background: var(--hh-color-accent-hover);
}
.actions-sub {
  display: flex;
  gap: 8px;
}
.ghost-btn {
  flex: 1;
  height: 36px;
  border-radius: var(--hh-radius-md);
  border: 1px solid var(--hh-color-border-ghost-soft);
  background: var(--hh-color-surface-soft);
  color: var(--hh-color-text-strong);
  font-size: var(--hh-font-body-size);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  transition: background var(--hh-motion-med);
}
.ghost-btn:hover {
  background: var(--hh-color-surface-hover-soft);
}

/* ============ 元数据行（数据来源/开发商/发售日/加入时间/时长/评分） ============ */
.dp-meta {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--hh-space-x2) var(--hh-space-x3);
  padding: var(--hh-space-x2) var(--hh-space-x3);
  background: var(--hh-color-card);
  border: 1px solid var(--hh-color-card-border);
  border-radius: var(--hh-radius-panel);
}
.dp-meta-cell {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.dp-meta-key {
  font-size: var(--hh-font-caption-size);
  color: var(--hh-color-text-dim-strong);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dp-meta-val {
  font-size: var(--hh-font-body-size);
  color: var(--hh-color-text-strong);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 数字要醒目（评分/时长）上一档字号，仍走 token 不硬写 */
.dp-meta-num {
  font-size: var(--hh-font-bodyLg-size);
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--hh-color-text-glow);
}
.dp-meta-star {
  color: var(--hh-color-star);
  flex: none;
}

/* ============ 标签区（全集 + 搜索 + 展开） ============ */
.dp-tags {
  display: flex;
  flex-direction: column;
  gap: var(--hh-space-x2);
}
.dp-tags-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--hh-space-x2);
}
.dp-tags-title {
  font-size: var(--hh-font-caption-size);
  color: var(--hh-color-text-dim-strong);
}
.dp-tags-count {
  font-size: var(--hh-font-caption-size);
  color: var(--hh-color-text-dim);
  font-variant-numeric: tabular-nums;
}
/* 行内嵌搜索框：与 chip 同一行开始，占满栏宽（不弹浮层、不压内容） */
.dp-tags-search {
  display: flex;
  align-items: center;
  gap: var(--hh-space-x2);
  height: 28px;
  padding: 0 var(--hh-space-x2);
  border: 1px solid var(--hh-color-border-ghost-soft);
  border-radius: var(--hh-radius-sm);
  background: var(--hh-color-surface-soft);
  color: var(--hh-color-text-mid);
}
.dp-tags-search:focus-within {
  border-color: var(--hh-color-accent-selected-border);
  background: var(--hh-color-surface-hover-soft);
}
.dp-tags-search-icon {
  flex: none;
}
.dp-tags-input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--hh-color-text-glow);
  font-size: var(--hh-font-caption-size);
  font-family: inherit;
}
.dp-tags-input::placeholder {
  color: var(--hh-color-text-dim);
}
.dp-tags-clear {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border: none;
  border-radius: var(--hh-radius-xs);
  background: var(--hh-color-surface-hover);
  color: var(--hh-color-text-mid);
  cursor: pointer;
  padding: 0;
}
.dp-tags-clear:hover {
  background: var(--hh-color-surface-strong);
  color: var(--hh-color-text-glow);
}
.dp-tags-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.tag-chip {
  font-size: 11px;
  padding: 3px 9px;
  border-radius: var(--hh-radius-xs);
  background: var(--hh-color-accent-bg);
  color: var(--hh-color-accent-text);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dp-tags-none {
  font-size: var(--hh-font-caption-size);
  color: var(--hh-color-text-dim);
}
.dp-tags-toggle {
  align-self: flex-start;
  border: none;
  background: none;
  color: var(--hh-color-accent);
  font-size: var(--hh-font-caption-size);
  cursor: pointer;
  padding: 0;
}
.dp-tags-toggle:hover {
  color: var(--hh-color-accent-hover);
}

/* ============ 收藏行 ============ */
.fav-row {
  display: flex;
}
.fav-btn {
  flex: 1;
  height: 32px;
  border-radius: var(--hh-radius-sm);
  border: 1px solid var(--hh-color-border-ghost-soft);
  background: transparent;
  color: var(--hh-color-text-mid);
  font-size: 12.5px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  transition: all var(--hh-motion-med);
}
.fav-btn:hover {
  background: var(--hh-color-surface-mid);
  color: var(--hh-color-text-glow);
}
.fav-btn.on {
  background: var(--hh-color-warning-soft-bg);
  border-color: var(--hh-color-star);
  color: var(--hh-color-star);
  font-weight: 600;
}

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
  font-size: var(--hh-font-caption-size);
  color: var(--hh-color-text-dim);
  font-variant-numeric: tabular-nums;
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
  word-wrap: break-word;
  hyphens: auto;
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
