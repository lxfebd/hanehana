<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Modal, Spin } from 'ant-design-vue'
import { Star } from 'lucide-vue-next'
import { applyScrapeResult, library, runSearch } from '../stores/library'
import type { ScrapeCandidate } from '../../shared/types'
import { tokens } from '../design/tokens'

const open = defineModel<boolean>('open')
/** 刮削结果星色 = warning（bangumi 橙；reactive，切主题自动刷新） */
const starColor = computed(() => tokens.color.warning)

/** 候选封面图加载失败：隐藏破图，露出占位字母 */
function imgErr(e: Event): void {
  const img = e.target as HTMLImageElement
  img.style.display = 'none'
}

const query = ref('')
const searching = ref(false)
const selected = ref<ScrapeCandidate | null>(null)

const selectedKey = computed(() =>
  selected.value ? `${selected.value.provider}::${selected.value.id}` : '',
)

watch(open, (v) => {
  if (v) {
    query.value = library.scrapeQuery
    selected.value = null
    searching.value = true
    runSearch(query.value).finally(() => (searching.value = false))
  }
})

async function doSearch(): Promise<void> {
  if (!query.value.trim()) return
  selected.value = null
  searching.value = true
  await runSearch(query.value.trim())
  searching.value = false
}

/** 单选选中，不立即应用 */
function pick(r: ScrapeCandidate): void {
  const key = `${r.provider}::${r.id}`
  selected.value = selectedKey.value === key ? null : r
}

async function apply(): Promise<void> {
  if (!selected.value) return
  await applyScrapeResult(selected.value)
  open.value = false
}
</script>

<template>
  <Modal v-model:open="open" :footer="null" width="560" :centered="true" title="元数据刮削">
    <div class="scrape-body">
      <div class="row">
        <div class="search-box">
          <input v-model="query" class="path-input" placeholder="输入标题搜索（VNDB + Bangumi 双源）" @keyup.enter="doSearch" />
        </div>
        <button class="search-btn" :disabled="searching" @click="doSearch">搜索</button>
      </div>

      <div v-if="searching" class="center">
        <Spin /> <span class="spin-text">搜索中…</span>
      </div>

      <div v-if="library.scrapeWarnings.length" class="warnings">
        <div v-for="(w, i) in library.scrapeWarnings" :key="i" class="warning">{{ w }}</div>
      </div>

      <div v-if="library.scrapeResults.length" class="results">
        <div
          v-for="r in library.scrapeResults"
          :key="r.provider + r.id"
          class="result-card"
          :class="{ picked: selectedKey === r.provider + '::' + r.id }"
          @click="pick(r)"
        >
          <div class="r-cover">
            <img v-if="r.coverUrl" :src="r.coverUrl" loading="lazy" @error="imgErr" />
            <div v-else class="r-no-cover">{{ r.title.slice(0, 1) }}</div>
          </div>
          <div class="r-info">
            <div class="r-title">
              {{ r.title }}
              <span v-if="r.titleNative" class="r-native">{{ r.titleNative }}</span>
            </div>
            <div class="r-meta">
              <span class="r-badge" :class="r.provider">{{ r.provider }}</span>
              <span v-if="r.releaseDate">{{ r.releaseDate }}</span>
              <span v-if="r.rating"><Star :size="11" :fill="starColor" :stroke-width="0" /> {{ r.rating.toFixed(1) }}</span>
            </div>
            <div v-if="r.description" class="r-desc">{{ r.description.slice(0, 120) }}…</div>
          </div>
        </div>
      </div>

      <div v-else-if="!searching" class="center hint">没有结果。换关键词试试，或直接手动填写。</div>

      <div class="foot">
        <button class="apply-btn" :disabled="!selected" @click="apply">应用选中</button>
      </div>
    </div>
  </Modal>
</template>

<style scoped>
.scrape-body { display: flex; flex-direction: column; gap: 14px; }
.row { display: flex; gap: 8px; }
.search-box { flex: 1; }
.path-input {
  width: 100%;
  height: 38px;
  border-radius: 10px;
  padding: 0 14px;
  border: 1px solid var(--hh-color-border-ghost-soft);
  background: var(--hh-color-surface-soft);
  color: var(--hh-color-on-accent);
  font-size: 13px;
  outline: none;
}
.search-btn {
  height: 38px; padding: 0 20px;
  border: none; border-radius: 10px;
  background: var(--hh-color-accent-grad);
  color: var(--hh-color-on-accent); font-weight: 600; font-size: 13px;
  cursor: pointer;
}
.search-btn:disabled { opacity: 0.5; }
.center { text-align: center; padding: 20px 0; }
.spin-text { margin-left: 10px; font-size: 13px; color: var(--hh-color-text-mid-high); }
.hint { color: var(--hh-color-text-muted); font-size: 13px; }

.warnings { display: flex; flex-direction: column; gap: 4px; }
.warning { font-size: 12px; color: var(--hh-color-error-soft-text); background: var(--hh-color-error-soft-bg); padding: 6px 10px; border-radius: 8px; }

.results { display: flex; flex-direction: column; gap: 8px; max-height: 380px; overflow-y: auto; }
.result-card {
  display: flex; gap: 12px;
  padding: 10px;
  border-radius: 12px;
  border: 1px solid var(--hh-color-card-border);
  background: var(--hh-color-card);
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s;
}
.result-card:hover { background: var(--hh-color-accent-soft); border-color: var(--hh-color-accent-ring); }
.result-card.picked {
  border-color: var(--hh-color-accent);
  box-shadow: 0 0 0 2px var(--hh-color-accent-ring);
  background: var(--hh-color-accent-card-bg);
}
.r-cover {
  width: 44px; height: 66px;
  border-radius: 6px; overflow: hidden; flex-shrink: 0;
  background: var(--hh-color-cover-fallback);
  display: flex; align-items: center; justify-content: center;
}
.r-cover img { width: 100%; height: 100%; object-fit: cover; }
.r-no-cover { font-size: 20px; color: var(--hh-color-text-faint); }
.r-info { min-width: 0; flex: 1; }
.r-title { font-size: 14px; font-weight: 600; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.r-native { font-size: 12px; color: var(--hh-color-text-soft); font-weight: 400; }
.r-meta { display: flex; align-items: center; gap: 10px; margin: 5px 0; font-size: 12px; color: var(--hh-color-text-mid); }
.r-badge {
  font-size: 11px; text-transform: uppercase;
  padding: 1px 7px; border-radius: 6px; font-weight: 600;
}
.r-badge.vndb { background: var(--hh-color-select-bg); color: var(--hh-color-select-text); }
.r-badge.bangumi { background: var(--hh-color-warning-soft-bg); color: var(--hh-color-warning); }
.r-desc { font-size: 12px; color: var(--hh-color-text-muted); line-height: 1.5; }

.foot { display: flex; justify-content: flex-end; }
.apply-btn {
  height: 34px; padding: 0 24px;
  border: none; border-radius: 10px;
  background: var(--hh-color-accent-grad);
  color: var(--hh-color-on-accent); font-weight: 600; font-size: 13px;
  cursor: pointer;
  transition: opacity 0.12s;
}
.apply-btn:disabled { opacity: 0.4; cursor: not-allowed; }
</style>