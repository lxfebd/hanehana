<script setup lang="ts">
/**
 * 详情面板（重构版）：
 *   - 全高封面色渐变横幅，封面缩略图 + 模糊光晕（毛玻璃质感）
 *   - 启动按钮强化为主角，hover 有发光
 *   - 信息分组：元数据 / 分类 / 简介
 *
 * 封面色板：优先 g.color（封面主色），退回固定渐变。
 */
import { computed } from 'vue'
import { Activity, Flower2, FolderOpen, Play, Star, Wand2 } from 'lucide-vue-next'
import { state, launchGame, openScrape, refreshGames, selectedGame } from '../store'

const g = computed(() => selectedGame.value)

function coverSrc(): string {
  if (!g.value?.coverPath) return ''
  return `file://${g.value.coverPath.replace(/\\/g, '/')}`
}

function fmtPlay(ms: number): string {
  if (ms <= 0) return '尚未游玩'
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  return h > 0 ? `${h} 小时 ${m} 分钟` : `${m} 分钟`
}

function fmtDate(ts?: number): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleDateString('zh-CN')
}

function bannerBg(): string {
  const c = g.value?.color ?? '#2a3a5f'
  return `linear-gradient(160deg, ${c}cc, ${c}22 60%, #1a1a1f 100%)`
}

async function toggleCategory(): Promise<void> {
  if (!g.value) return
  const cur = g.value.categories
  const next = cur.includes('已通关') ? cur.filter((c) => c !== '已通关') : [...cur, '已通关']
  await window.hh.updateGame(g.value.id, { categories: next })
  await refreshGames()
}

function openDir(): void {
  if (g.value) void window.hh.openDir(g.value.dir)
}

async function toggleFlag(flag: 'useLE' | 'useMagpie'): Promise<void> {
  if (!g.value) return
  await window.hh.updateGame(g.value.id, { [flag]: !g.value[flag] })
  await refreshGames()
}
</script>

<template>
  <aside class="detail-panel glass">
    <!-- 未选中 -->
    <div v-if="!g" class="empty-state">
      <Flower2 :size="36" :stroke-width="1.5" class="empty-icon" />
      <div class="empty-text">点击封面查看详情</div>
    </div>

    <template v-else>
      <!-- 全高横幅 -->
      <div class="banner" :style="{ background: bannerBg() }">
        <!-- 封面模糊光晕 -->
        <div v-if="coverSrc()" class="banner-blur" :style="{ backgroundImage: `url(${coverSrc()})` }"></div>
        <div class="banner-overlay"></div>

        <div class="banner-cover">
          <img v-if="coverSrc()" :src="coverSrc()" class="banner-img" />
          <div v-else class="banner-letter">{{ g.title.slice(0, 1) }}</div>
        </div>

        <div class="banner-meta">
          <div class="banner-title">{{ g.title }}</div>
          <div v-if="g.titleNative && g.titleNative !== g.title" class="banner-native">{{ g.titleNative }}</div>
          <div class="banner-sub" v-if="g.releaseDate || g.rating">
            <span v-if="g.releaseDate" class="banner-sub-chip">{{ g.releaseDate }}</span>
            <span v-if="g.rating" class="banner-rating">
              <Star :size="11" :fill="'#ffd666'" :stroke-width="0" /> {{ g.rating.toFixed(1) }}
            </span>
          </div>
        </div>
      </div>

      <!-- 动作栏 -->
      <div class="actions">
        <button class="primary-btn" @click="launchGame(g.id)">
          <span v-if="state.runningIds.has(g.id)"><Activity :size="16" /> 已在运行</span>
          <span v-else><Play :size="16" :fill="'currentColor'" /> 启动游戏</span>
        </button>
        <button class="ghost-btn" @click="openScrape(g.id, g.rawTitle || g.title)"><Wand2 :size="14" /> 刮削</button>
        <button class="ghost-btn" @click="openDir"><FolderOpen :size="14" /> 打开目录</button>
      </div>

      <!-- 元数据 -->
      <div class="meta">
        <div class="meta-row" v-if="g.playMs"><span class="meta-key">游玩时长</span><span class="meta-val">{{ fmtPlay(g.playMs) }}</span></div>
        <div class="meta-row"><span class="meta-key">上次游玩</span><span class="meta-val">{{ fmtDate(g.lastPlayed) }}</span></div>
        <div class="meta-row"><span class="meta-key">游戏目录</span><a class="meta-val link" @click="openDir">{{ g.dir.split(/[\\/]/).pop() }}</a></div>
        <div class="meta-row" v-if="g.sources.length"><span class="meta-key">数据来源</span><span class="meta-val">{{ g.sources.map((s) => s.provider).join(' / ') }}</span></div>
      </div>

      <!-- 标签 -->
      <div v-if="g.tags.length" class="tags">
        <span v-for="t in g.tags.slice(0, 12)" :key="t" class="tag-chip">{{ t }}</span>
      </div>

      <!-- 分类 -->
      <div class="cats">
        <button class="cat-chip" :class="{ on: g.categories.includes('已通关') }" @click="toggleCategory">已通关</button>
        <button class="cat-chip" @click="toggleFlag('useLE')" :class="{ on: g.useLE }">LE 转区</button>
        <button class="cat-chip" @click="toggleFlag('useMagpie')" :class="{ on: g.useMagpie }">Magpie</button>
      </div>

      <!-- 简介 -->
      <div class="desc" v-if="g.description">{{ g.description.slice(0, 300) }}{{ g.description.length > 300 ? '…' : '' }}</div>
    </template>
  </aside>
</template>

<style scoped>
.detail-panel {
  position: relative;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  scrollbar-gutter: stable;
}

.empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: rgba(255, 255, 255, 0.4);
}
.empty-icon { color: rgba(255, 255, 255, 0.4); }
.empty-text { font-size: 13px; }

/* ============ 全高横幅 ============ */
.banner {
  border-radius: 14px;
  overflow: hidden;
  position: relative;
  min-height: 180px;
  display: flex;
  align-items: flex-end;
  gap: 14px;
  padding: 16px;
}
.banner-blur {
  position: absolute; inset: 0;
  background-size: cover;
  background-position: center;
  filter: blur(28px) saturate(1.3);
  transform: scale(1.2);
  opacity: 0.5;
}
.banner-overlay {
  position: absolute; inset: 0;
  background: linear-gradient(to top, rgba(10, 10, 14, 0.85), rgba(10, 10, 14, 0.15) 60%, transparent);
}
.banner-cover {
  position: relative;
  width: 88px; height: 118px;
  border-radius: 10px;
  overflow: hidden;
  flex-shrink: 0;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.5);
  z-index: 1;
}
.banner-img { width: 100%; height: 100%; object-fit: cover; display: block; }
.banner-letter {
  width: 100%; height: 100%;
  display: flex; align-items: center; justify-content: center;
  font-size: 40px; font-weight: 700; color: rgba(255, 255, 255, 0.55);
}
.banner-meta {
  position: relative;
  z-index: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding-bottom: 2px;
}
.banner-title {
  font-size: 16px; font-weight: 700;
  line-height: 1.3;
  text-shadow: 0 1px 6px rgba(0, 0, 0, 0.5);
}
.banner-native {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.65);
  text-shadow: 0 1px 4px rgba(0, 0, 0, 0.5);
}
.banner-sub { display: flex; gap: 8px; margin-top: 2px; }
.banner-sub-chip {
  font-size: 11px;
  background: rgba(255, 255, 255, 0.14);
  padding: 2px 8px;
  border-radius: 7px;
}
.banner-rating {
  font-size: 11.5px; font-weight: 600;
  color: #ffd666;
  background: rgba(0, 0, 0, 0.35);
  padding: 2px 8px;
  border-radius: 7px;
  display: flex; align-items: center; gap: 3px;
}

/* ============ 动作栏 ============ */
.actions { display: flex; gap: 8px; }
.primary-btn {
  flex: 1;
  height: 40px;
  border: none;
  border-radius: 12px;
  background: linear-gradient(135deg, #4da3ff, #2f6fed);
  color: #fff;
  font-size: 14px; font-weight: 600;
  cursor: pointer;
  display: flex; align-items: center; justify-content: center; gap: 6px;
  transition: transform 0.12s, box-shadow 0.12s;
  box-shadow: 0 4px 16px rgba(77, 163, 255, 0.35);
}
.primary-btn:hover {
  transform: translateY(-1px);
  box-shadow: 0 6px 22px rgba(77, 163, 255, 0.5);
}
.primary-btn:active { transform: translateY(0); }
.ghost-btn {
  height: 40px; padding: 0 16px;
  border-radius: 12px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  background: rgba(255, 255, 255, 0.06);
  color: rgba(255, 255, 255, 0.8);
  font-size: 13px;
  cursor: pointer;
  display: flex; align-items: center; gap: 6px;
  transition: background 0.12s;
}
.ghost-btn:hover { background: rgba(255, 255, 255, 0.13); }

/* ============ 元数据 ============ */
.meta {
  display: flex; flex-direction: column; gap: 7px;
  font-size: 12.5px;
}
.meta-row { display: flex; justify-content: space-between; gap: 10px; }
.meta-key { color: rgba(255, 255, 255, 0.42); flex-shrink: 0; }
.meta-val { color: rgba(255, 255, 255, 0.8); text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.link { color: #69b1ff; cursor: pointer; text-decoration: none; }
.link:hover { text-decoration: underline; }

/* ============ 标签 ============ */
.tags { display: flex; flex-wrap: wrap; gap: 6px; }
.tag-chip {
  font-size: 11px;
  padding: 3px 9px;
  border-radius: 8px;
  background: rgba(77, 163, 255, 0.14);
  color: #7ec3ff;
}

/* ============ 分类 ============ */
.cats { display: flex; gap: 6px; flex-wrap: wrap; }
.cat-chip {
  font-size: 11.5px;
  padding: 5px 10px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: transparent;
  color: rgba(255, 255, 255, 0.6);
  cursor: pointer;
  transition: all 0.12s;
}
.cat-chip:hover { background: rgba(255, 255, 255, 0.08); }
.cat-chip.on {
  background: rgba(94, 194, 105, 0.18);
  border-color: rgba(94, 194, 105, 0.4);
  color: #8ad17e;
}

/* ============ 简介 ============ */
.desc {
  font-size: 12.5px;
  line-height: 1.7;
  color: rgba(255, 255, 255, 0.6);
}
</style>