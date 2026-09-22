<script setup lang="ts">
import { ref, watch } from 'vue'
import { Modal, Spin } from 'ant-design-vue'
import { Star } from 'lucide-vue-next'
import { applyScrapeResult, library, runSearch } from '../stores/library'

const open = defineModel<boolean>('open')

const query = ref('')
const searching = ref(false)

watch(open, (v) => {
  if (v) {
    query.value = library.scrapeQuery
    searching.value = true
    runSearch(query.value).finally(() => (searching.value = false))
  }
})

async function doSearch(): Promise<void> {
  if (!query.value.trim()) return
  searching.value = true
  await runSearch(query.value.trim())
  searching.value = false
}

async function apply(r: { provider: string; id: string; title: string }): Promise<void> {
  await applyScrapeResult(r as never)
  open.value = false
}
</script>

<template>
  <Modal v-model:open="open" :footer="null" width="720" :centered="true" title="元数据刮削">
    <div class="scrape-body">
      <div class="row">
        <input v-model="query" class="path-input" placeholder="输入标题搜索（VNDB + Bangumi 双源）" @keyup.enter="doSearch" />
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
          @click="apply(r)"
        >
          <div class="r-cover">
            <img v-if="r.coverUrl" :src="r.coverUrl" loading="lazy" />
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
              <span v-if="r.rating"><Star :size="11" :fill="'#e8b450'" :stroke-width="0" /> {{ r.rating.toFixed(1) }}</span>
            </div>
            <div v-if="r.description" class="r-desc">{{ r.description.slice(0, 120) }}…</div>
          </div>
        </div>
      </div>

      <div v-else-if="!searching" class="center hint">没有结果。换关键词试试，或直接手动填写。</div>
    </div>
  </Modal>
</template>

<style scoped>
.scrape-body { display: flex; flex-direction: column; gap: 14px; }
.row { display: flex; gap: 8px; }
.path-input {
  flex: 1;
  height: 38px;
  border-radius: 10px;
  padding: 0 14px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  background: rgba(255, 255, 255, 0.06);
  color: #fff;
  font-size: 13px;
  outline: none;
}
.search-btn {
  height: 38px; padding: 0 20px;
  border: none; border-radius: 10px;
  background: linear-gradient(135deg, #4096ff, #2f6fed);
  color: #fff; font-weight: 600; font-size: 13px;
  cursor: pointer;
}
.search-btn:disabled { opacity: 0.5; }
.center { text-align: center; padding: 20px 0; }
.spin-text { margin-left: 10px; font-size: 13px; color: rgba(255, 255, 255, 0.6); }
.hint { color: rgba(255, 255, 255, 0.45); font-size: 13px; }

.warnings { display: flex; flex-direction: column; gap: 4px; }
.warning { font-size: 12px; color: #ff8f8f; background: rgba(255, 77, 79, 0.08); padding: 6px 10px; border-radius: 8px; }

.results { display: flex; flex-direction: column; gap: 8px; max-height: 420px; overflow-y: auto; }
.result-card {
  display: flex; gap: 12px;
  padding: 10px;
  border-radius: 12px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.04);
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s;
}
.result-card:hover { background: rgba(64, 150, 255, 0.1); border-color: rgba(64, 150, 255, 0.35); }
.r-cover {
  width: 68px; height: 90px;
  border-radius: 8px; overflow: hidden; flex-shrink: 0;
  background: #2a3a5f;
  display: flex; align-items: center; justify-content: center;
}
.r-cover img { width: 100%; height: 100%; object-fit: cover; }
.r-no-cover { font-size: 24px; color: rgba(255, 255, 255, 0.3); }
.r-info { min-width: 0; flex: 1; }
.r-title { font-size: 14px; font-weight: 600; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.r-native { font-size: 12px; color: rgba(255, 255, 255, 0.5); font-weight: 400; }
.r-meta { display: flex; align-items: center; gap: 10px; margin: 5px 0; font-size: 12px; color: rgba(255, 255, 255, 0.55); }
.r-badge {
  font-size: 10px; text-transform: uppercase;
  padding: 1px 7px; border-radius: 6px; font-weight: 600;
}
.r-badge.vndb { background: rgba(64, 150, 255, 0.2); color: #69b1ff; }
.r-badge.bangumi { background: rgba(233, 168, 80, 0.2); color: #e8b450; }
.r-desc { font-size: 12px; color: rgba(255, 255, 255, 0.45); line-height: 1.5; }
</style>