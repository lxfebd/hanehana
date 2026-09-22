<script setup lang="ts">
/**
 * 详情面板（REDESIGN-SPEC §5.4）。
 *   - 横幅 180px：thumb `blur(32px) saturate(1.2) scale(1.2)` opacity .55 + scrim 渐变
 *   - 前景左 cover 92x138；右列标题 16/22 两行 clamp + 原名 + chips
 *   - 主按钮满宽 40（Play/运行中）、次行两 ghost 等宽（刮削/打开目录）
 *   - 元数据两栏：时长、上次、目录（link 色）、来源
 *   - 标签 chips（accentBg 底）；分类 toggle chips；简介 6 行 clamp + 展开/收起
 */
import { computed, ref } from 'vue'
import { Activity, Flower2, FolderOpen, Play, Star, Wand2 } from 'lucide-vue-next'
import { launchGame, library, openScrape, refreshGames, selectedGame, thumbUrl } from '../stores/library'

const g = computed(() => selectedGame.value)
const descExpanded = ref(false)

function fmtPlay(ms: number): string {
  if (ms <= 0) return '—'
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  return h > 0 ? `${h} 小时 ${m} 分钟` : `${m} 分钟`
}

function fmtDate(ts?: number): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleDateString('zh-CN')
}

/** 横幅背景：thumb 预模糊位图（有 thumb 时），无则主色渐变兜底 */
function bannerImg(): string {
  if (!g.value) return ''
  if (g.value.thumbPath) return thumbUrl(g.value)
  if (g.value.coverPath) return `file://${g.value.coverPath.replace(/\\/g, '/')}`
  return ''
}

function bannerFallback(): string {
  const c = g.value?.color ?? '#2a3a5f'
  return `linear-gradient(160deg, ${c}cc, ${c}22 60%, #1a1a1f 100%)`
}

/** 简介是否超过 6 行阈值（粗略按字符估算，180 字约 6 行） */
const descTruncated = computed(() => !!g.value?.description && g.value.description.length > 180)

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
    <!-- 未选中空态 -->
    <div v-if="!g" class="empty-state">
      <Flower2 :size="36" :stroke-width="1.5" class="empty-icon" />
      <div class="empty-text">点击封面查看详情</div>
    </div>

    <template v-else>
      <!-- 横幅 180px -->
      <div class="banner" :style="bannerImg() ? {} : { background: bannerFallback() }">
        <div
          v-if="bannerImg()"
          class="banner-blur"
          :style="{ backgroundImage: `url(${bannerImg()})` }"
        ></div>
        <div
          v-if="bannerImg()"
          class="banner-tint"
          :style="{ background: bannerFallback() }"
        ></div>
        <div class="banner-scrim"></div>

        <div class="banner-cover">
          <img v-if="bannerImg()" :src="bannerImg()" class="banner-img" />
          <div v-else class="banner-letter">{{ g.title.slice(0, 1) }}</div>
        </div>

        <div class="banner-meta">
          <div class="banner-title">{{ g.title }}</div>
          <div v-if="g.titleNative && g.titleNative !== g.title" class="banner-native">{{ g.titleNative }}</div>
          <div class="banner-chips">
            <span v-if="g.releaseDate" class="chip">{{ g.releaseDate }}</span>
            <span v-if="g.rating" class="chip chip-rating">
              <Star :size="11" :fill="'#ffd666'" :stroke-width="0" /> {{ g.rating.toFixed(1) }}
            </span>
          </div>
        </div>
      </div>

      <!-- 动作栏：主按钮满宽 + 双 ghost 次行 -->
      <div class="actions">
        <button class="primary-btn" @click="launchGame(g.id)">
          <span v-if="library.runningIds.has(g.id)"><Activity :size="16" /> 运行中</span>
          <span v-else><Play :size="16" :fill="'currentColor'" /> 启动游戏</span>
        </button>
      </div>
      <div class="actions-sub">
        <button class="ghost-btn" @click="openScrape(g.id, g.rawTitle || g.title)"><Wand2 :size="14" /> 刮削</button>
        <button class="ghost-btn" @click="openDir"><FolderOpen :size="14" /> 打开目录</button>
      </div>

      <!-- 元数据两栏 -->
      <div class="meta">
        <div class="meta-row"><span class="meta-key">游玩时长</span><span class="meta-val">{{ fmtPlay(g.playMs) }}</span></div>
        <div class="meta-row"><span class="meta-key">上次游玩</span><span class="meta-val">{{ fmtDate(g.lastPlayed) }}</span></div>
        <div class="meta-row"><span class="meta-key">游戏目录</span><a class="meta-val link" @click="openDir">{{ g.dir.split(/[\\/]/).pop() }}</a></div>
        <div class="meta-row" v-if="g.sources.length"><span class="meta-key">数据来源</span><span class="meta-val">{{ g.sources.map((s) => s.provider).join(' / ') }}</span></div>
      </div>

      <!-- 标签 chips -->
      <div v-if="g.tags.length" class="tags">
        <span v-for="t in g.tags.slice(0, 12)" :key="t" class="tag-chip">{{ t }}</span>
      </div>

      <!-- 分类 toggle chips -->
      <div class="cats">
        <button class="cat-chip" :class="{ on: g.categories.includes('已通关') }" @click="toggleCategory">已通关</button>
        <button class="cat-chip" :class="{ on: g.useLE }" @click="toggleFlag('useLE')">LE 转区</button>
        <button class="cat-chip" :class="{ on: g.useMagpie }" @click="toggleFlag('useMagpie')">Magpie</button>
      </div>

      <!-- 简介：6 行 clamp + 展开/收起 -->
      <div v-if="g.description" class="desc-wrap">
        <p class="desc" :class="{ clamped: !descExpanded }">{{ g.description }}</p>
        <button v-if="descTruncated" class="desc-toggle" @click="descExpanded = !descExpanded">
          {{ descExpanded ? '收起' : '展开' }}
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

/* ============ 横幅 180px ============ */
.banner {
  border-radius: 14px;
  overflow: hidden;
  position: relative;
  height: 180px;
  display: flex;
  align-items: flex-end;
  gap: 14px;
  padding: 16px;
}
.banner-blur {
  position: absolute; inset: 0;
  background-size: cover;
  background-position: center;
  filter: blur(32px) saturate(1.2);
  transform: scale(1.2);
  opacity: 0.55;
}
.banner-tint {
  position: absolute; inset: 0;
  opacity: 0.35;
}
.banner-scrim {
  position: absolute; inset: 0;
  background: linear-gradient(to top, #1a1a1f 0%, rgba(26, 26, 31, 0.55) 55%, rgba(26, 26, 31, 0.2) 100%);
}
.banner-cover {
  position: relative;
  width: 92px; height: 138px;
  border-radius: 8px;
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
  gap: 6px;
  padding-bottom: 2px;
}
.banner-title {
  font-size: 16px; line-height: 22px; font-weight: 600;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  text-shadow: 0 1px 6px rgba(0, 0, 0, 0.5);
}
.banner-native {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.65);
  text-shadow: 0 1px 4px rgba(0, 0, 0, 0.5);
}
.banner-chips { display: flex; gap: 6px; margin-top: 2px; }
.chip {
  font-size: 11px;
  background: rgba(255, 255, 255, 0.14);
  padding: 2px 8px;
  border-radius: 7px;
  display: flex; align-items: center; gap: 3px;
}
.chip-rating { color: #ffd666; font-weight: 600; }

/* ============ 动作栏 ============ */
.actions { display: flex; }
.primary-btn {
  flex: 1;
  height: 40px;
  border: none;
  border-radius: 10px;
  background-image: linear-gradient(135deg, #4da3ff, #2f6fed);
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
.actions-sub { display: flex; gap: 8px; }
.ghost-btn {
  flex: 1;
  height: 36px;
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  background: rgba(255, 255, 255, 0.06);
  color: rgba(255, 255, 255, 0.8);
  font-size: 13px;
  cursor: pointer;
  display: flex; align-items: center; justify-content: center; gap: 6px;
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
  border-radius: 6px;
  background: rgba(77, 163, 255, 0.16);
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
.desc-wrap {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.desc {
  font-size: 13px;
  line-height: 20px;
  color: rgba(255, 255, 255, 0.6);
  margin: 0;
  white-space: pre-wrap;
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
  font-size: 12px;
  cursor: pointer;
  padding: 0;
}
.desc-toggle:hover { color: var(--hh-color-accent-hover); }
</style>