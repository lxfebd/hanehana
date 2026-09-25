<script setup lang="ts">
/**
 * 封面墙 —— 封面为主角（重构版）+ RecycleScroller 窗口化。
 *
 * 视觉要点：
 *   - 每张封面都有自己的一抹颜色：占位背景优先用刮削时提取的 g.color，
 *     没有才退回哈希调色板。
 *   - hover 抬起 + 封面微缩放（transform 走 GPU，不碰布局），
 *     选中态用主色描边 + 外发光。
 *   - 标题叠在封面底部渐晕上，白字带阴影，比放图下方干净。
 *   - 性能铁律：卡片内无 backdrop-filter；DOM 窗口化靠 RecycleScroller。
 *
 * 虚拟化度量（§3.5 固定）：
 *   - 网格：itemSize 332 = 封面 276 + 上间距 8 + 标题区 40 + 行距 8；
 *     itemSecondarySize 200 = 卡槽 184 + 间距 16；cols = floor((w+16)/200)。
 *   - 列表：itemSize 72 单列。
 *   - 居中留白：layer wrapper 宽度 = cols*200 - 16，margin auto 居中。
 *     item-view 是绝对定位 transform，居中必须收窄「定位坐标系」本身，
 *     不能靠 item 内 padding。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { RecycleScroller } from 'vue-virtual-scroller'
import 'vue-virtual-scroller/dist/vue-virtual-scroller.css'
import { Activity, Check, Flower2, Heart, Loader2, Star } from 'lucide-vue-next'
import type { Game } from '../../shared/types'
import { library, selectGame, thumbUrl, toggleSelect, debouncedKeyword } from '../stores/library'
import { t } from '../i18n'
import { tokens } from '../design/tokens'

const props = defineProps<{
  games: Game[]
  view: 'grid' | 'list'
}>()

const emit = defineEmits<{ select: [id: string] }>()
const games = computed(() => props.games)
const selected = computed(() => library.selectedId)
/** 库里根本没有游戏（而非被筛选过滤光）——两种空态文案不同 */
const filteredEmpty = computed(() => library.games.length === 0)
/** 评分星星色（真值 tokens；reactive，切主题自动刷新） */
const starColor = computed(() => tokens.color.star)

const containerRef = ref<HTMLElement | null>(null)
const cols = ref(1)
const focusIdx = ref(0)
let ro: ResizeObserver | null = null

/** 网格列数：容器宽 + 16（补回最右间距）÷ 200 卡槽 */
function updateCols(): void {
  const el = containerRef.value
  if (!el) return
  cols.value = Math.max(1, Math.floor((el.clientWidth + 16) / 200))
}

onMounted(() => {
  updateCols()
  if (containerRef.value && 'ResizeObserver' in window) {
    ro = new ResizeObserver(updateCols)
    ro.observe(containerRef.value)
  }
})

onBeforeUnmount(() => {
  ro?.disconnect()
  ro = null
})

/** 筛选指纹：搜索词/分类/收藏/智能列表/元数据聚合任一变化都重建 scroller
 *  （RecycleScroller 在 items 数量突变后会复用旧行，必须换 key 强制重建）。
 *  搜索词必须用防抖后的值：用实时 keyword 的话，120ms 防抖窗口内先按旧结果
 *  重建一次，随后 debouncedKeyword 更新但指纹不变，scroller 不会重建，残留旧行。 */
const filterFingerprint = computed(
  () => `${debouncedKeyword.value}|${library.categoryFilter}|${library.favOnly}|${library.smartList}|${library.metaKey}:${library.metaValue}`,
)

/** 网格 wrapper 宽度 = cols*200 - 16，居中留白 */
const gridWrapperW = computed(() => `${cols.value * 200 - 16}px`)

/** 按当前列数把游戏切分成多行（一行一个 RecycleScroller item）。
 *   行 key 必须带上列数 c：窗口缩放列数变化时，同一行号的内容已完全不同，
 *   不带 c 的话 RecycleScroller 按 key 复用旧行 DOM，残留上一档列数的卡片。 */
const gridRows = computed(() => {
  const c = cols.value
  const rows: { k: string; games: Game[] }[] = []
  for (let i = 0; i < games.value.length; i += c) {
    rows.push({ k: `${c}-${Math.floor(i / c)}`, games: games.value.slice(i, i + c) })
  }
  return rows
})

/** 行内卡片要知道自己在全集里的 index（roving tabindex / 方向键） */
function gIdx(id: string): number {
  return games.value.findIndex((g) => g.id === id)
}

/** 占位底色：优先封面主色，退回哈希调色板（reactive，切主题自动刷新） */
function placeholderBg(g: Game): string {
  if (g.color) return g.color
  const palette = tokens.color.palette
  let h = 0
  for (const ch of g.title) h = (h * 31 + ch.codePointAt(0)!) >>> 0
  return palette[h % palette.length]
}

/** 副行：发行年 or 时长（tabular-nums） */
function fmtSub(g: Game): string {
  if (g.releaseDate) return g.releaseDate
  return fmtPlay(g.playMs)
}

function fmtPlay(ms: number): string {
  if (ms <= 0) return ''
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  return h > 0 ? `${h}h${m}m` : `${m}m`
}

function click(g: Game, idx: number): void {
  if (library.selectMode) {
    toggleSelect(g.id)
    return
  }
  focusIdx.value = idx
  selectGame(g.id)
  emit('select', g.id)
}

/** 缩略图加载失败：隐藏破图，露出底下的占位字母/占位色 */
function imgErr(e: Event): void {
  const img = e.target as HTMLImageElement
  img.style.display = 'none'
}

/** roving tabindex：方向键移动（grid 按列、list 按行），Enter 选中。
 *  移动后必须真的把焦点交到新卡片：只改 tabindex 不 focus，键盘用户停在原地，
 *  下一次按键仍然作用在旧卡片上，roving 就死了。 */
function moveFocus(next: number): void {
  focusIdx.value = Math.max(0, Math.min(games.value.length - 1, next))
  // focusIdx 变了之后，dom 上唯一 tabindex=0 的就是目标卡片
  const el = containerRef.value?.querySelector('[tabindex="0"]')
  if (el instanceof HTMLElement) el.focus()
}

function onKeydown(e: KeyboardEvent, idx: number): void {
  if (e.key === 'ArrowRight') {
    e.preventDefault()
    moveFocus(idx + 1)
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault()
    moveFocus(idx - 1)
  } else if (e.key === 'ArrowDown') {
    e.preventDefault()
    moveFocus(idx + (props.view === 'grid' ? cols.value : 1))
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    moveFocus(idx - (props.view === 'grid' ? cols.value : 1))
  } else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    click(games.value[idx], idx)
  }
}
</script>

<template>
  <div ref="containerRef" class="cover-wall" :class="view">
    <!-- 加载中：骨架提示（games 为空但还在拉库，别闪"库是空的"） -->
    <div v-if="library.loading" class="empty glass">
      <Loader2 class="empty-icon spin" :size="40" :stroke-width="1.5" />
      <div class="empty-title">正在加载游戏库…</div>
    </div>

    <!-- 空态：库里确实没有游戏 -->
    <div v-else-if="games.length === 0 && filteredEmpty" class="empty glass">
      <Flower2 class="empty-icon" :size="40" :stroke-width="1.5" />
      <div class="empty-title">{{ t('lib_empty') }}</div>
      <div class="empty-hint">{{ t('lib_empty_hint') }}</div>
      <button class="empty-cta" @click="library.scanOpen = true">{{ t('lib_scan') }}</button>
    </div>

    <!-- 空态：有游戏但被搜索/分类过滤光了 -->
    <div v-else-if="games.length === 0" class="empty glass">
      <div class="empty-title">{{ t('lib_no_match') }}</div>
      <div class="empty-hint">换换关键词或分类试试</div>
      <button class="empty-cta ghost" @click="library.keyword = ''; library.categoryFilter = ''">{{ t('lib_clear') }}</button>
    </div>

    <!-- 网格视图：行级窗口化 + 每行 flex 自己排列（grid 位置由 CSS 响应式驱动，
        不依赖 RecycleScroller 的 grid 模式——它的 grid-items 变化后不刷新视图位置，
        窗口缩放会留下旧列数时的横向残留 transform，直接溢出容器） -->
    <RecycleScroller
      v-else-if="view === 'grid'"
      :key="`grid-${cols}-${filterFingerprint}`"
      class="scroller"
      :items="gridRows"
      :item-size="332"
      key-field="k"
      :page-mode="false"
      :buffer="400"
      item-class="grid-row-item"
    >
      <template #default="{ item }">
        <div class="grid-row">
          <div
            v-for="g in item.games"
            :key="g.id"
            class="cover-card"
            :class="{ selected: selected === g.id, multi: library.selectMode, checked: library.selectMode && library.selection.includes(g.id) }"
            role="gridcell"
            :tabindex="focusIdx === gIdx(g.id) ? 0 : -1"
            @click="click(g, gIdx(g.id))"
            @keydown="onKeydown($event, gIdx(g.id))"
          >
            <div class="cover-thumb" :style="{ background: placeholderBg(g) }">
              <img v-if="thumbUrl(g)" :src="thumbUrl(g)" loading="lazy" :alt="g.title" @error="imgErr" />
              <span v-else class="cover-letter">{{ g.title.slice(0, 2) }}</span>

              <div v-if="library.runningIds.has(g.id)" class="cover-running">
                <Activity :size="10" :stroke-width="2.5" /> {{ t('detail_running') }}
              </div>
              <div v-if="g.favorite" class="cover-fav" :title="t('detail_faved')">
                <Heart :size="10" :fill="'currentColor'" :stroke-width="0" />
              </div>
              <div v-if="library.selectMode && library.selection.includes(g.id)" class="cover-check">
                <Check :size="13" :stroke-width="3" />
              </div>

              <!-- 压暗渐变只给真图用：占位色块上画只会糊出一团灰雾 -->
              <div v-if="thumbUrl(g)" class="cover-shade"></div>
            </div>
            <!-- 标题区 32px：标题 + 发行年/时长副行 -->
            <div class="cover-titlezone">
              <div class="cover-title" :title="g.title">{{ g.title }}</div>
              <div class="cover-sub" v-if="fmtSub(g)">{{ fmtSub(g) }}</div>
            </div>
          </div>
        </div>
      </template>
    </RecycleScroller>

    <!-- 列表视图：单列窗口化。itemSize 80 = 行 72 + 上下 margin 4+4（8px 行距，与网格一致）；
        RecycleScroller 按 itemSize 精确排位，item-view 内的 margin 不参与兄弟间距，
        行距只能靠 itemSize 让步，否则行会紧贴。 -->
    <RecycleScroller
      v-else
      class="scroller"
      :items="games"
      :item-size="80"
      key-field="id"
      :page-mode="false"
      :buffer="400"
      item-class="list-item-view"
    >
      <template #default="{ item, index }">
        <div
          class="list-row"
          :class="{ selected: selected === item.id, multi: library.selectMode, checked: library.selectMode && library.selection.includes(item.id) }"
          role="row"
          :tabindex="focusIdx === index ? 0 : -1"
          @click="click(item, index)"
          @keydown="onKeydown($event, index)"
        >
          <div class="list-thumb" :style="{ background: placeholderBg(item) }">
            <img v-if="thumbUrl(item)" :src="thumbUrl(item)" loading="lazy" :alt="item.title" @error="imgErr" />
            <span v-else class="list-letter">{{ item.title.slice(0, 1) }}</span>
            <div v-if="library.runningIds.has(item.id)" class="list-running">
              <Activity :size="10" :stroke-width="2.5" />
            </div>
            <div v-if="item.favorite" class="list-fav" :title="t('detail_faved')">
              <Heart :size="9" :fill="'currentColor'" :stroke-width="0" />
            </div>
            <div v-if="library.selectMode && library.selection.includes(item.id)" class="list-check">
              <Check :size="12" :stroke-width="3" />
            </div>
          </div>
          <div class="list-body">
            <div class="list-title" :title="item.title">{{ item.title }}</div>
            <div class="list-meta">
              <span v-if="item.releaseDate || fmtPlay(item.playMs)">{{ fmtSub(item) }}</span>
            </div>
          </div>
          <!-- 右侧三列 caption tabular-nums：发行 / 评分 / 时长 -->
          <div class="list-cols">
            <span v-if="item.releaseDate">{{ item.releaseDate }}</span>
            <span v-else></span>
            <span v-if="item.rating"><Star class="num" :size="11" :fill="starColor" :stroke-width="0" /> {{ item.rating.toFixed(1) }}</span>
            <span v-else></span>
            <span v-if="fmtPlay(item.playMs)">{{ fmtPlay(item.playMs) }}</span>
            <span v-else></span>
          </div>
        </div>
      </template>
    </RecycleScroller>
  </div>
</template>

<style scoped>
.cover-wall {
  flex: 1;
  overflow: hidden;
  min-height: 0;
  position: relative;
}

/* RecycleScroller 自己滚：撑满容器 */
.scroller {
  height: 100%;
}

/* 空态：单 CTA */
.empty {
  position: relative;
  margin: 60px auto;
  max-width: 380px;
  padding: 40px 30px;
  text-align: center;
  border-radius: 20px;
}
.empty-icon {
  color: var(--hh-color-text-tertiary);
  margin-bottom: 12px;
}
.empty-icon.spin { animation: ic-spin 1s linear infinite; }
@keyframes ic-spin {
  to { transform: rotate(360deg); }
}
.empty-title { font-size: 16px; font-weight: 600; margin-bottom: 6px; color: var(--hh-color-text-glow); }
.empty-hint { font-size: 13px; color: var(--hh-color-text-mid); margin-bottom: 0; }
.empty-cta {
  margin-top: 18px;
  height: 34px;
  padding: 0 22px;
  border-radius: 10px;
  border: none;
  background-image: var(--hh-color-accent-grad);
  color: var(--hh-color-on-accent);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: filter 0.15s ease;
}
.empty-cta:hover { filter: brightness(1.08); }
.empty-cta.ghost {
  background: transparent;
  border: 1px solid var(--hh-color-border-ghost);
  color: var(--hh-color-text-muted-pure);
  font-weight: 500;
}
.empty-cta.ghost:hover { background: var(--hh-color-surface-mid); }

/* ============ 网格 ============ */
/* 行级虚拟化：scroller 只纵向窗口化行，行内 flex 自己排列。
   卡片槽宽 200（184 封面 + 16 间距），行宽 = cols*200 - 16，margin auto 居中，
   窗口缩放列数变化时行结构由 Vue 重建，不会残留旧位置。 */
.grid-row {
  display: flex;
  gap: 16px;
  width: v-bind(gridWrapperW);
  margin: 0 auto;
  padding: 8px 0 0;
  box-sizing: border-box;
}
.grid-row-item {
  display: block;
}
.cover-card {
  flex: none;
  width: 184px;
  cursor: pointer;
  border-radius: 12px;
  padding: 4px;
  background: var(--hh-color-card);
  border: 1px solid var(--hh-color-card-border);
  transition: transform 0.18s ease, background 0.18s ease, border-color 0.18s ease;
  /* 焦点环交给全局 :focus-visible（WCAG 2.4.11），不留 outline:none 掐死它 */
}
.cover-card:hover {
  transform: translateY(-4px);
  background: var(--hh-color-card-hover);
  border-color: var(--hh-color-surface-hover);
}
.cover-card.multi { cursor: pointer; }
.cover-card.checked {
  background: var(--hh-color-accent-selected-bg);
  border-color: var(--hh-color-accent);
  box-shadow:
    0 0 0 1px var(--hh-color-accent),
    0 8px 24px var(--hh-color-accent-selected-ring);
}
.cover-card.selected {
  background: var(--hh-color-accent-soft);
  border-color: var(--hh-color-accent);
  box-shadow:
    0 0 0 1px var(--hh-color-accent),
    0 8px 24px var(--hh-color-accent-selected-ring);
}

.cover-thumb {
  aspect-ratio: 3 / 4;
  border-radius: 8px;
  overflow: hidden;
  position: relative;
  box-shadow: 0 6px 20px var(--hh-color-thumb-shadow);
  transition: box-shadow 0.18s ease;
}
.cover-thumb img {
  width: 100%; height: 100%;
  object-fit: cover;
  display: block;
  transition: transform 0.35s cubic-bezier(0.22, 0.61, 0.36, 1);
}
.cover-card:hover .cover-thumb img { transform: scale(1.06); }
.cover-letter {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  font-size: 24px; font-weight: 600; color: var(--hh-color-text-mid);
}

/* 运行中徽章（评分不上卡） */
.cover-running {
  position: absolute; top: 8px; left: 8px;
  background: var(--hh-color-success-opaque);
  color: var(--hh-color-on-accent); font-size: 11px; font-weight: 600;
  padding: 3px 9px; border-radius: 8px;
  z-index: 2;
  display: flex; align-items: center; gap: 3px;
}
/* 收藏角标：右上角小爱心 */
.cover-fav {
  position: absolute; top: 8px; right: 8px;
  color: var(--hh-color-star);
  background: var(--hh-color-surface-strong);
  width: 20px; height: 20px;
  border-radius: 7px;
  display: flex; align-items: center; justify-content: center;
  z-index: 2;
}
/* 多选勾选角标：右下角实心对勾 */
.cover-check {
  position: absolute; bottom: 8px; right: 8px;
  background: var(--hh-color-accent);
  color: var(--hh-color-on-accent);
  width: 22px; height: 22px;
  border-radius: 999px;
  display: flex; align-items: center; justify-content: center;
  z-index: 2;
}

/* 封面底部轻渐晕（标题在封面下，只做视觉过渡） */
.cover-shade {
  position: absolute; left: 0; right: 0; bottom: 0; height: 35%;
  background: linear-gradient(to top, var(--hh-color-shade-thumb), transparent);
  z-index: 1;
}

/* 标题区 40px：封面下方，非叠图 */
.cover-titlezone {
  padding: 5px 2px 0;
  height: 40px;
  box-sizing: border-box;
  overflow: hidden;
}
.cover-title {
  font-size: 13px; line-height: 18px; font-weight: 600;
  color: var(--hh-color-text-glow);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.cover-sub {
  font-size: 12px; line-height: 16px;
  color: var(--hh-color-text-tertiary);
  font-variant-numeric: tabular-nums;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

/* ============ 列表 ============ */
.list-row {
  display: flex; align-items: center; gap: 10px;
  height: 72px;
  padding: 0 10px;
  border-radius: 12px;
  cursor: pointer;
  transition: background 0.15s ease;
  margin: 4px 0;
  box-sizing: border-box;
}
.list-row:hover { background: var(--hh-color-surface-soft); }
.list-row.selected { background: var(--hh-color-accent-selected-bg); }
.list-row.checked { background: var(--hh-color-accent-selected-bg); }
.list-thumb {
  width: 44px; height: 66px;
  border-radius: 6px; overflow: hidden; flex-shrink: 0;
  position: relative;
  box-shadow: 0 3px 10px var(--hh-color-thumb-shadow-soft);
}
.list-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.list-letter {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  font-size: 22px; font-weight: 700; color: var(--hh-color-text-dim);
}
.list-running {
  position: absolute; top: 4px; right: 4px;
  background: var(--hh-color-success-opaque);
  width: 18px; height: 18px;
  border-radius: 6px;
  display: flex; align-items: center; justify-content: center;
  font-size: 11px; color: var(--hh-color-on-accent);
}
.list-fav {
  position: absolute; bottom: 3px; right: 3px;
  color: var(--hh-color-star);
  width: 15px; height: 15px;
  border-radius: 5px;
  background: var(--hh-color-surface-strong);
  display: flex; align-items: center; justify-content: center;
}
.list-check {
  position: absolute; top: 4px; left: 4px;
  background: var(--hh-color-accent);
  color: var(--hh-color-on-accent);
  width: 18px; height: 18px;
  border-radius: 999px;
  display: flex; align-items: center; justify-content: center;
  font-size: 11px;
}
.list-body { flex: 1; min-width: 0; }
.list-title {
  font-size: 13px; font-weight: 500;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.list-meta {
  font-size: 12px; color: var(--hh-color-text-muted);
  margin-top: 3px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
/* 右侧三列 caption tabular-nums：发行 / 评分 / 时长。
   窄视口下永不挤压标题区：左、中两列可整体收缩换行，右列为空时让位。 */
.list-cols {
  display: flex; align-items: center; gap: 12px;
  font-size: 12px; color: var(--hh-color-text-tertiary);
  font-variant-numeric: tabular-nums;
  min-width: 0;
  flex-shrink: 0;
}
.list-cols span {
  flex-shrink: 1;
  flex-basis: auto;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.list-cols .num { vertical-align: -1px; }

/* 窄视口让位：次要列逐级退场，标题区永远保有足够宽度。
   时长列先退，评分列再退，最低只留发行年。 */
@media (max-width: 1100px) {
  .list-cols span:nth-child(3) { display: none; }
}
@media (max-width: 960px) {
  .list-cols span:nth-child(2) { display: none; }
}
</style>
