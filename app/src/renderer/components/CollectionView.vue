<script setup lang="ts">
/**
 * 收藏夹浏览页（B6，对标基准 collection.png）。
 *
 * 基准是「浏览型页面」：分组 → 按开发商自动归类，每格带数量。收藏夹不是
 * 一个筛选开关（侧栏 favOnly 才是那个），这里要回答的问题是「我的收藏按
 * 什么聚在一起、各有多少」。
 *
 * 数据源用 library.games 而不是 filteredGames：filteredGames 带着当前搜索/
 * 分类/智能列表/meta 筛选，用户改一个搜索词这边分组就跟着变，语义不稳定；
 * 且从库里点开发商 chip 进来时 metaKey 已设上，filteredGames 已被筛成单组，
 * 分组页会自己把自己筛空。收藏夹要的是「收藏全集的分组」，与库页筛选状态
 * 解耦。
 *
 * 点组不自己做二级页：直接复用库页现成筛选链路（library.metaKey/metaValue
 * + ui.page='library'），点进去就是那一组的封面墙 + 可用的搜索/排序/详情，
 * 比复制一份栅格 + 一套筛选状态更少出错。「未分类」组没有可筛选的真实值
 * （developer 缺失/空），点了等于把库筛空，因此该组不可点。
 */
import { computed, ref } from 'vue'
import { Bookmark, FolderOpen } from 'lucide-vue-next'
import { library } from '../stores/library'
import { ui } from '../stores/ui'
import { t, tf } from '../i18n'
import PageHeader from './PageHeader.vue'

/** 分组维度：开发商 / 系列 */
type GroupKey = 'developer' | 'series'
const dim = ref<GroupKey>('developer')

interface FavGroup {
  /** 组名（真实值；'未分类' 兜底只在展示层） */
  name: string
  /** 是否为「未分类」兜底组（无真实筛选值，不可点） */
  fallback: boolean
  count: number
}

/**
 * 收藏（favorite=true）按当前维度分组。
 * 系列维度下一款游戏可属于多个系列，因此按系列展开后再计数；无开发商/无系列
 * 的进「未分类」。排序：款数降序，同数按组名——款数多的组是用户的主要收藏
 * 构成，放前面；组名兜底保证同数组顺序稳定（不随 games 顺序抖动）。
 */
const groups = computed<FavGroup[]>(() => {
  const favs = library.games.filter((g) => g.favorite)
  const tally = new Map<string, number>()
  for (const g of favs) {
    if (dim.value === 'developer') {
      const key = (g.developer ?? '').trim()
      const name = key || t('coll_other')
      tally.set(name, (tally.get(name) ?? 0) + 1)
    } else {
      const list = (g.series ?? []).map((s) => s.trim()).filter(Boolean)
      if (!list.length) {
        tally.set(t('coll_other'), (tally.get(t('coll_other')) ?? 0) + 1)
        continue
      }
      for (const s of list) tally.set(s, (tally.get(s) ?? 0) + 1)
    }
  }
  return [...tally.entries()]
    .map(([name, count]) => ({ name, count, fallback: name === t('coll_other') }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
})

const totalFav = computed(() => library.games.filter((g) => g.favorite).length)

const isEmpty = computed(() => groups.value.length === 0)

/** 点组：走库页现成 meta 筛选链路（不做二级页）。 */
function openGroup(name: string): void {
  if (name === t('coll_other')) return
  library.metaKey = dim.value
  library.metaValue = name
  ui.page = 'library'
}
</script>

<template>
  <div class="collection-page">
    <PageHeader
      :crumbs="['nav_home', 'nav_favorites']"
      title="nav_favorites"
      :subtitle="tf('coll_group_n', { n: totalFav })"
    >
      <template #actions>
        <!-- 分组维度切换：开发商 / 系列 -->
        <div class="dim-seg">
          <button
            class="seg-chip"
            :class="{ active: dim === 'developer' }"
            :aria-pressed="dim === 'developer'"
            @click="dim = 'developer'"
          >
            {{ t('coll_group_dev') }}
          </button>
          <button
            class="seg-chip"
            :class="{ active: dim === 'series' }"
            :aria-pressed="dim === 'series'"
            @click="dim = 'series'"
          >
            {{ t('coll_group_series') }}
          </button>
        </div>
      </template>
    </PageHeader>

    <!-- 空态 -->
    <div v-if="isEmpty" class="coll-empty glass">
      <Bookmark class="empty-ic" :size="40" :stroke-width="1.5" />
      <div class="empty-title">{{ t('nav_favorites') }}</div>
      <p class="empty-hint">{{ t('coll_empty') }}</p>
    </div>

    <!-- 分组栅格 -->
    <div v-else class="coll-grid">
      <button
        v-for="g in groups"
        :key="g.name"
        class="coll-card glass"
        :class="{ 'is-other': g.fallback }"
        type="button"
        @click="openGroup(g.name)"
      >
        <span class="card-ic"><FolderOpen :size="20" :stroke-width="1.5" /></span>
        <span class="card-name" :title="g.name">{{ g.name }}</span>
        <span class="card-count num">{{ tf('coll_group_n', { n: g.count }) }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.collection-page {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-bottom: 16px;
}

/* ============ 维度切换 segmented ============ */
.dim-seg {
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: var(--hh-radius-pill);
  background: var(--hh-color-surface-bright);
  border: 1px solid var(--hh-color-card-border);
}
.seg-chip {
  display: flex;
  align-items: center;
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

/* ============ 分组栅格 ============ */
.coll-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
  gap: var(--hh-space-x3);
  align-content: start;
}
.coll-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--hh-space-x2);
  padding: var(--hh-space-x4);
  border: 1px solid var(--hh-color-card-border);
  border-radius: var(--hh-radius-panel);
  background: var(--hh-color-card);
  text-align: left;
  cursor: pointer;
  transition:
    background var(--hh-motion-med) ease,
    border-color var(--hh-motion-med) ease;
}
.coll-card:hover {
  background: var(--hh-color-surface-mid);
  border-color: var(--hh-color-accent-focus-border);
}
/* 未分类组没有可筛选的真实值：不给可点视觉（点了等于把库筛空） */
.coll-card.is-other {
  cursor: default;
  background: var(--hh-color-surface-soft);
}
.coll-card.is-other:hover {
  background: var(--hh-color-surface-soft);
  border-color: var(--hh-color-card-border);
}
.card-ic {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: var(--hh-radius-md);
  background: var(--hh-color-surface-strong);
  color: var(--hh-color-accent-text);
}
.is-other .card-ic {
  color: var(--hh-color-text-dim);
}
.card-name {
  font-size: var(--hh-font-body-size);
  font-weight: 600;
  color: var(--hh-color-text-glow);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.card-count {
  font-size: var(--hh-font-caption-size);
  color: var(--hh-color-text-dim);
  font-variant-numeric: tabular-nums;
}

/* ============ 空态 ============ */
.coll-empty {
  margin: 48px auto;
  max-width: 440px;
  padding: 40px 32px;
  text-align: center;
  border-radius: var(--hh-radius-panel);
}
.empty-ic {
  color: var(--hh-color-text-tertiary);
  margin-bottom: 12px;
}
.empty-title {
  font-size: var(--hh-font-subtitle-size);
  font-weight: 700;
  color: var(--hh-color-text-glow);
  margin-bottom: 8px;
}
.empty-hint {
  margin: 0;
  font-size: var(--hh-font-body-size);
  color: var(--hh-color-text-mid);
  line-height: 1.6;
}
</style>
