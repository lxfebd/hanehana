<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import {
  Activity,
  ChevronLeft,
  ChevronRight,
  ClipboardCopy,
  Flower2,
  FolderOpen,
  Maximize2,
  Minimize2,
  PanelRightClose,
  Pencil,
  Play,
  Wand2,
} from 'lucide-vue-next'
import {
  filterByMeta,
  filteredGames,
  launchGame,
  library,
  openEdit,
  openScrape,
  runningGames,
  selectedGame,
} from '../stores/library'
import { t, tf } from '../i18n'
import { type Game } from '../../shared/types'
import { lengthTextOf } from './detailShared'
import DetailBanner from './DetailBanner.vue'
import DetailMetaRow from './DetailMetaRow.vue'
import DetailTags from './DetailTags.vue'
import DetailTabs from './DetailTabs.vue'
import DetailSimilar from './DetailSimilar.vue'

/**
 * 详情面板外壳：右栏选中态与整页双形态。1885 行单文件已拆为 1 外壳 + 5 子组件，
 * 本文件只保留外壳与跨版块共用状态（双形态、上一部/下一部、快捷键、
 * 目录打开与复制信息——动作栏与编辑页共用）：
 *   - DetailBanner.vue   横幅 hero + 收藏 chip
 *   - DetailMetaRow.vue  元数据行（开发商点选 @filter 交回本件调 filterByMeta）
 *   - DetailTags.vue     标签区（搜索/展开状态在子件内，切游戏自行复位）
 *   - DetailTabs.vue     四个 pane：游玩数据 / 简介 / 编辑 / 存档
 *   - DetailSimilar.vue  右栏相似游戏（点选在子件内直写 library.selectedId）
 */

const emit = defineEmits<{ collapse: [] }>()
const g = computed(() => selectedGame.value)

/** 主动翻页标记：整页形态下按 ←/→ 换一部要留在整页里，别被 watch(g) 弹回抽屉 */
let keepExpandedOnSwitch = false
const expanded = ref(false)
/**
 * 右栏 ⇄ 整页展开。
 *
 * 用 View Transitions（Electron 里 Chromium 111+ 可用）让 banner 在两种形态间
 * **连续变形**——不是「关一个开一个」的硬切，用户看到的是同一张卡长大。
 * 不支持该 API、或用户开了「减少动效」时直接切：形态切换是功能，不是装饰，
 * 不能因为动效偏好就失效。
 */
function toggleExpand(): void {
  const doc = document as Document & {
    startViewTransition?: (_cb: () => void | Promise<void>) => unknown
  }
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  if (reduce || typeof doc.startViewTransition !== 'function') {
    expanded.value = !expanded.value
    return
  }
  void doc.startViewTransition(async () => {
    expanded.value = !expanded.value
    await nextTick()
  })
}

/** 切游戏复位整页形态：主动 ←/→ 翻页保留，其余收回右栏。
 *  子组件各自的内部状态（bannerFailed / tagQuery / dpTab / descExpanded）由子件自己的 watch 复位。 */
watch(g, () => {
  if (keepExpandedOnSwitch) keepExpandedOnSwitch = false
  else expanded.value = false
})

/** 打开目录：失败（目录被移动/删除）弹提示——静默失败时按钮「点了没反应」。 */
async function openDir(): Promise<void> {
  const game = g.value
  if (!game) return
  try {
    const why = await window.hh.openDir(game.dir)
    if (why) message.error(tf('dv_open_dir_fail', { why }))
  } catch (e) {
    message.error(tf('dv_open_dir_fail', { why: e instanceof Error ? e.message : String(e) }))
  }
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
  if (game.lengthMinutes) rows.push(`${t('dp_length')}：${lengthTextOf(game)}`)
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

// ---------------------------------------------------------------- 上一部 / 下一部

/**
 * 翻页顺序 = 当前筛选结果的顺序（filteredGames），不是全库顺序：
 * 用户从「最近玩过」或搜索结果里点开一部，期望的「下一部」就是列表里相邻的那张，
 * 而不是入库顺序的下一张（那两张在屏上根本不相邻）。
 */
const navPos = computed(() => filteredGames.value.findIndex((x) => x.id === g.value?.id))
const prevGame = computed(() => (navPos.value > 0 ? filteredGames.value[navPos.value - 1] : null))
const nextGame = computed(() =>
  navPos.value >= 0 && navPos.value < filteredGames.value.length - 1
    ? filteredGames.value[navPos.value + 1]
    : null,
)

function goGame(target: Game | null): void {
  if (!target) return
  keepExpandedOnSwitch = expanded.value
  library.selectedId = target.id
}

/** 输入框/文本域里打字时，快捷键要让位（否则 ctrl+E 会把展开态和输入一起搅乱） */
function isTypingTarget(el: EventTarget | null): boolean {
  const node = el as HTMLElement | null
  if (!node) return false
  return node.tagName === 'INPUT' || node.tagName === 'TEXTAREA' || node.isContentEditable
}

/** 整页形态下 Esc 收回（全屏的东西必须有一条不用找按钮的退路）；
 *  Ctrl/⌘+E 升降形态（与头部按钮同一函数，动效也同一套）；
 *  整页态下 ←/→ 翻上一部/下一部（抽屉态不抢方向键——那是列表滚动） */
function onKey(e: KeyboardEvent): void {
  if (isTypingTarget(e.target)) return
  if ((e.ctrlKey || e.metaKey) && (e.key === 'e' || e.key === 'E')) {
    if (!g.value) return
    e.preventDefault()
    toggleExpand()
    return
  }
  if (e.key === 'Escape' && expanded.value) {
    e.stopPropagation()
    expanded.value = false
    return
  }
  if (!expanded.value) return
  if (e.key === 'ArrowLeft' && prevGame.value) {
    e.preventDefault()
    goGame(prevGame.value)
  } else if (e.key === 'ArrowRight' && nextGame.value) {
    e.preventDefault()
    goGame(nextGame.value)
  }
}
onMounted(() => document.addEventListener('keydown', onKey))
onUnmounted(() => document.removeEventListener('keydown', onKey))

/** 元数据行的开发商/系列点选：沿用拆分前口径，直接调同一个 store 筛选。 */
function onFilterMeta(key: 'series' | 'developer', value: string): void {
  filterByMeta(key, value)
}
</script>

<template>
  <aside class="detail-panel glass" :class="{ 'is-expanded': expanded }">
    <!-- 头部动作：整页展开 ⇄ 收回，以及把右栏整条收成窄条。
         sticky + margin-bottom:-40px 让它浮在 banner 右上角，滚动时不跟着 content 走。 -->
    <div class="dp-head-actions">
      <template v-if="expanded">
        <button
          class="dp-icon-btn"
          type="button"
          :disabled="!prevGame"
          :title="t('dp_prev_game')"
          :aria-label="t('dp_prev_game')"
          @click="goGame(prevGame)"
        >
          <ChevronLeft :size="14" />
        </button>
        <button
          class="dp-icon-btn"
          type="button"
          :disabled="!nextGame"
          :title="t('dp_next_game')"
          :aria-label="t('dp_next_game')"
          @click="goGame(nextGame)"
        >
          <ChevronRight :size="14" />
        </button>
      </template>
      <button
        class="dp-icon-btn"
        type="button"
        :title="expanded ? t('dp_collapse_panel') : t('dp_expand_panel')"
        :aria-label="expanded ? t('dp_collapse_panel') : t('dp_expand_panel')"
        :aria-pressed="expanded"
        @click="toggleExpand"
      >
        <Minimize2 v-if="expanded" :size="14" />
        <Maximize2 v-else :size="14" />
      </button>
      <button
        class="dp-icon-btn"
        type="button"
        :title="t('app_collapse_detail')"
        :aria-label="t('app_collapse_detail')"
        @click="emit('collapse')"
      >
        <PanelRightClose :size="14" />
      </button>
    </div>
    <!-- 未选中空态 -->
    <div v-if="!g" class="empty-state">
      <Flower2 :size="36" :stroke-width="1.5" class="empty-icon" />
      <div class="empty-text">{{ t('detail_empty') }}</div>
    </div>

    <template v-else>
      <DetailBanner :game="g" />

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

      <!-- ============ 双栏：整页态左右两栏，抽屉态两个容器 display:contents
            （各自的孩子直接成为面板 flex item，视觉零变化） ============ -->
      <div class="dp-cols">
        <div class="dp-col dp-col-main">
          <DetailMetaRow :game="g" @filter="onFilterMeta" />
          <DetailTags :game="g" />
          <DetailTabs
            :game="g"
            :open-dir="openDir"
            :copy-game-info="copyGameInfo"
            :copy-done="copyDone"
          />
        </div>

        <!-- 右列（只给整页态：抽屉里它接在分页内容之后，滚到底才看到） -->
        <aside class="dp-col dp-col-side">
          <DetailSimilar :game="g" />
        </aside>
      </div>
    </template>
  </aside>
</template>

<style scoped>
.detail-panel {
  width: var(--hh-layout-detail-w);
  position: relative;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  /* 8px 列距：右栏各区块的间距 */
  gap: var(--hh-space-x2);
}
/* 头部动作组（展开整页 / 收成窄条）：sticky 让它浮在 banner 右上角，
   滚动时不跟着内容走；负 margin 让 banner 顶上来，不占布局高度。 */
.dp-head-actions {
  position: sticky;
  top: 0;
  z-index: var(--hh-layer-sticky);
  align-self: flex-end;
  display: flex;
  gap: 6px;
  margin-bottom: -40px;
  flex: none;
}
.dp-icon-btn {
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
    color var(--hh-motion-med),
    transform var(--hh-motion-fast) var(--hh-motion-ease-out);
}
.dp-icon-btn:hover {
  background: var(--hh-color-surface-hover);
  color: var(--hh-color-text-glow);
}
/* 按压回弹：40ms 内缩到 0.92，松开走 easeOut 回弹——手感比纯变色「实」 */
.dp-icon-btn:active {
  transform: scale(0.92);
}
/* 首/尾到头（没有上一部、下一部）：变淡且不吃 hover 高亮。
   按钮留在原位只是点不动，比直接藏掉更能说明「这里能翻，只是到头了」 */
.dp-icon-btn:disabled,
.dp-icon-btn:disabled:hover {
  opacity: 0.35;
  background: var(--hh-color-surface-soft);
  color: var(--hh-color-text-mid);
  cursor: default;
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
  min-width: 0;
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
  /* 不换行：四个标签里最长的 4 汉字 + 图标在四等分按钮里放得下。 */
  white-space: nowrap;
  transition: background var(--hh-motion-med);
}
.ghost-btn:hover {
  background: var(--hh-color-surface-hover-soft);
}

/* ============ 分栏容器 ============ */
/* 抽屉态：两层容器都不参与布局（display:contents），孩子直接落到面板的
   flex 列里——与拆分前逐像素一致，整页态再切成两栏。 */
.dp-cols {
  display: contents;
}
.dp-col {
  display: contents;
}
/* 整页态：左栏（元数据/标签/分页）宽一点，右栏（相似游戏）窄一点 */
.detail-panel.is-expanded .dp-cols {
  display: grid;
  grid-template-columns: minmax(0, 1.15fr) minmax(0, 0.85fr);
  gap: var(--hh-space-x4);
  flex: 1;
  min-height: 0;
}
.detail-panel.is-expanded .dp-col {
  display: flex;
  flex-direction: column;
  gap: var(--hh-space-x2);
  min-height: 0;
  overflow-y: auto;
  padding-right: var(--hh-space-x1);
}

/* ============ 整页形态 ============ */
/* fixed 铺满主区域而不是改布局：面板仍在右栏的 DOM 位置，只是视觉上接管
   整个窗口，收回时宽度回到 token，右栏布局零改动。
   左右 12px / 底部 12px 留呼吸，顶部让过标题栏。 */
.detail-panel.is-expanded {
  position: fixed;
  top: calc(var(--hh-layout-titlebar-h) + 8px);
  right: 12px;
  bottom: 12px;
  left: 12px;
  width: auto;
  z-index: var(--hh-layer-overlay);
  overflow: hidden;
  padding: var(--hh-space-x4);
  gap: var(--hh-space-x3);
  background: var(--hh-color-card);
  border: 1px solid var(--hh-color-panel-glass-border);
}
/* 整页态穿透子组件：拆分前这些规则的前段选择器是 .detail-panel.is-expanded，
   目标类写在各子组件内部；scoped 下父选择器不再穿透子组件，改用 :deep() 保持原语义。 */
/* 整页态的 banner 长高：hero 是「这一部游戏」的门面，全屏时给它 260px */
.detail-panel.is-expanded :deep(.banner) {
  height: 260px;
  flex: none;
}
.detail-panel.is-expanded :deep(.banner-cover) {
  width: 132px;
  height: 198px;
}
.detail-panel.is-expanded :deep(.dp-meta) {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}
.detail-panel.is-expanded :deep(.dp-similar-grid) {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}
/* 整页态简介多给行数：抽屉 400px 宽时 6 行够用，整页态有纵向空间，
   12 行能装完长篇简介，不必先点「展开」 */
.detail-panel.is-expanded :deep(.desc.clamped) {
  -webkit-line-clamp: 12;
}
</style>
