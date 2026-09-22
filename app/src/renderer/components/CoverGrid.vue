<script setup lang="ts">
/**
 * 封面墙 —— 封面为主角（重构版）。
 *
 * 视觉要点：
 *   - 每张封面都有自己的一抹颜色：占位背景优先用刮削时提取的 g.color，
 *     没有才退回哈希调色板。
 *   - hover 抬起 + 封面微缩放（transform 走 GPU，不碰布局），
 *     选中态用主色描边 + 外发光。
 *   - 标题叠在封面底部渐晕上，白字带阴影，比放图下方干净。
 *   - 性能铁律不变：卡片内无 backdrop-filter。
 */
import { computed } from 'vue'
import type { Game } from '../../shared/types'
import { selectGame, state } from '../store'

const props = defineProps<{
  games: Game[]
  view: 'grid' | 'list'
}>()

const emit = defineEmits<{ select: [id: string] }>()
const games = computed(() => props.games)
const selected = computed(() => state.selectedId)

function coverSrc(g: Game): string {
  if (g.coverPath) return `file://${g.coverPath.replace(/\\/g, '/')}`
  return ''
}

/** 占位底色：优先封面主色，退回哈希调色板 */
function placeholderBg(g: Game): string {
  if (g.color) return g.color
  const palette = ['#3b4a6b', '#4a3b6b', '#3b6b5a', '#6b5a3b', '#6b3b4a', '#3b5a6b']
  let h = 0
  for (const ch of g.title) h = (h * 31 + ch.codePointAt(0)!) >>> 0
  return palette[h % palette.length]
}

function fmtPlay(ms: number): string {
  if (ms <= 0) return ''
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  return h > 0 ? `${h}h${m}m` : `${m}m`
}

function click(g: Game): void {
  selectGame(g.id)
  emit('select', g.id)
}
</script>

<template>
  <div class="cover-wall" :class="view">
    <!-- 空态 -->
    <div v-if="games.length === 0" class="empty glass">
      <div class="empty-icon">🌸</div>
      <div class="empty-title">游戏库还是空的</div>
      <div class="empty-hint">点左侧「扫描导入」选择游戏目录，自动识别 exe 入库</div>
    </div>

    <!-- 网格视图 -->
    <div v-else-if="view === 'grid'" class="grid">
      <div
        v-for="g in games"
        :key="g.id"
        class="cover-card"
        :class="{ selected: selected === g.id }"
        @click="click(g)"
      >
        <div class="cover-thumb" :style="{ background: placeholderBg(g) }">
          <img v-if="coverSrc(g)" :src="coverSrc(g)" loading="lazy" :alt="g.title" />
          <span v-else class="cover-letter">{{ g.title.slice(0, 1) }}</span>

          <div v-if="state.runningIds.has(g.id)" class="cover-running">▶ 运行中</div>
          <div v-if="g.rating" class="cover-rating">★ {{ g.rating.toFixed(1) }}</div>

          <div class="cover-shade"></div>
          <div class="cover-bottom">
            <div class="cover-title" :title="g.title">{{ g.title }}</div>
            <div class="cover-sub" v-if="fmtPlay(g.playMs)">{{ fmtPlay(g.playMs) }}</div>
          </div>
        </div>
      </div>
    </div>

    <!-- 列表视图 -->
    <div v-else class="list">
      <div
        v-for="g in games"
        :key="g.id"
        class="list-row"
        :class="{ selected: selected === g.id }"
        @click="click(g)"
      >
        <div class="list-thumb" :style="{ background: placeholderBg(g) }">
          <img v-if="coverSrc(g)" :src="coverSrc(g)" loading="lazy" :alt="g.title" />
          <span v-else class="list-letter">{{ g.title.slice(0, 1) }}</span>
          <div v-if="state.runningIds.has(g.id)" class="list-running">▶</div>
        </div>
        <div class="list-body">
          <div class="list-title" :title="g.title">{{ g.title }}</div>
          <div class="list-meta">
            <span v-if="g.releaseDate">{{ g.releaseDate }}</span>
            <span v-if="g.rating">★ {{ g.rating.toFixed(1) }}</span>
            <span v-if="fmtPlay(g.playMs)">已玩 {{ fmtPlay(g.playMs) }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cover-wall {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
  padding: 2px 2px 24px;
}

/* 空态 */
.empty {
  position: relative;
  margin: 60px auto;
  max-width: 380px;
  padding: 40px 30px;
  text-align: center;
  border-radius: 20px;
}
.empty-icon { font-size: 42px; margin-bottom: 12px; }
.empty-title { font-size: 16px; font-weight: 600; margin-bottom: 6px; }
.empty-hint { font-size: 13px; color: rgba(255, 255, 255, 0.5); }

/* ============ 网格 ============ */
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 18px 14px;
}
.cover-card {
  cursor: pointer;
  border-radius: 12px;
  padding: 4px;
  transition: transform 0.18s ease;
}
.cover-card:hover { transform: translateY(-4px); }
.cover-card.selected .cover-thumb {
  box-shadow:
    0 0 0 2px #4da3ff,
    0 0 24px rgba(77, 163, 255, 0.35),
    0 8px 24px rgba(0, 0, 0, 0.4);
}

.cover-thumb {
  aspect-ratio: 3 / 4;
  border-radius: 12px;
  overflow: hidden;
  position: relative;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.38);
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
  font-size: 40px; font-weight: 700; color: rgba(255, 255, 255, 0.45);
}

/* 运行中 / 评分徽章 */
.cover-running {
  position: absolute; top: 8px; left: 8px;
  background: rgba(94, 194, 105, 0.9);
  color: #fff; font-size: 11px; font-weight: 600;
  padding: 3px 9px; border-radius: 8px;
  z-index: 2;
}
.cover-rating {
  position: absolute; top: 8px; right: 8px;
  background: rgba(0, 0, 0, 0.55);
  color: #ffd666; font-size: 11px; font-weight: 600;
  padding: 3px 8px; border-radius: 8px;
  z-index: 2;
}

/* 底部渐晕 + 标题叠图 */
.cover-shade {
  position: absolute; left: 0; right: 0; bottom: 0; height: 45%;
  background: linear-gradient(to top, rgba(0, 0, 0, 0.78), transparent);
  z-index: 1;
}
.cover-bottom {
  position: absolute; left: 0; right: 0; bottom: 0;
  padding: 8px 12px 10px;
  z-index: 2;
}
.cover-title {
  font-size: 12.5px; font-weight: 600;
  color: rgba(255, 255, 255, 0.96);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  text-shadow: 0 1px 4px rgba(0, 0, 0, 0.6);
}
.cover-sub {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.65);
  margin-top: 2px;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.6);
}

/* ============ 列表 ============ */
.list-row {
  display: flex; align-items: center; gap: 14px;
  padding: 8px 10px;
  border-radius: 12px;
  cursor: pointer;
  transition: background 0.15s ease;
  margin-bottom: 2px;
}
.list-row:hover { background: rgba(255, 255, 255, 0.06); }
.list-row.selected { background: rgba(77, 163, 255, 0.14); }
.list-thumb {
  width: 48px; height: 64px;
  border-radius: 8px; overflow: hidden; flex-shrink: 0;
  position: relative;
  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.3);
}
.list-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.list-letter {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  font-size: 22px; font-weight: 700; color: rgba(255, 255, 255, 0.4);
}
.list-running {
  position: absolute; top: 4px; right: 4px;
  background: rgba(94, 194, 105, 0.9);
  width: 18px; height: 18px;
  border-radius: 6px;
  display: flex; align-items: center; justify-content: center;
  font-size: 10px; color: #fff;
}
.list-body { flex: 1; min-width: 0; }
.list-title {
  font-size: 13px; font-weight: 500;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.list-meta {
  display: flex; gap: 12px;
  font-size: 12px; color: rgba(255, 255, 255, 0.45);
  margin-top: 3px;
}
</style>
