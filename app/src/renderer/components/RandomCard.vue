<script setup lang="ts">
/**
 * 随机游戏卡（B8，对标基准 home.png 的 Random Game / Shuffle）。
 *
 * 作用不是「随机播放按钮」，是发现盲区：库越大越有人只玩最近那几款，
 * 角落里的收藏一辈子不点开。Shuffle 换一款，封面点击进库页选中看详情，
 * 启动直接开玩。
 *
 * 取样：全库均匀随机（有封面的优先——无封面的随机卡视觉上像空卡，
 * 随机性让位于「这一眼能勾起兴趣」）。连续两次不出同款。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { Dices, Info, Play, RefreshCw } from 'lucide-vue-next'
import { launchGame, library, thumbUrl } from '../stores/library'
import { isNsfwGame } from '../../shared/nsfw'
import type { Game } from '../../shared/types'
import { ui } from '../stores/ui'
import { t } from '../i18n'

const pick = ref<Game | null>(null)

const candidates = computed(() => {
  const withCover = library.games.filter((g) => g.thumbPath || g.coverPath)
  return withCover.length >= 3 ? withCover : library.games
})

function shuffle(): void {
  const pool = candidates.value
  if (!pool.length) {
    pick.value = null
    return
  }
  let next = pool[Math.floor(Math.random() * pool.length)]
  if (pool.length > 1 && pick.value && next.id === pick.value.id) {
    next = pool[(pool.indexOf(next) + 1) % pool.length]
  }
  pick.value = next
}

function openInLibrary(): void {
  if (!pick.value) return
  ui.page = 'library'
  library.selectedId = pick.value.id
}

const nsfwHidden = computed(() => !!pick.value && isNsfwGame(pick.value.tags))

onMounted(shuffle)

/**
 * 库是异步加载的：App 刚挂载时 library.games 往往还空着，只跑 onMounted
 * 的 shuffle 会把「空库」当真——12 款摆在眼前卡片却说“游戏库还是空的”。
 * 库一变长、而手头的 pick 还是空，就重新抽一次。
 */
watch(
  () => library.games.length,
  (n) => {
    if (n > 0 && !pick.value) shuffle()
  },
)
</script>

<template>
  <section class="random-card glass" :aria-label="t('home_random')">
    <header class="rc-head">
      <span class="rc-title"><Dices :size="16" /> {{ t('home_random') }}</span>
      <button class="rc-shuffle" type="button" @click="shuffle">
        <RefreshCw :size="14" />
        <span>{{ t('home_shuffle') }}</span>
      </button>
    </header>

    <div v-if="pick" class="rc-body">
      <button class="rc-cover" type="button" :title="t('hero_detail')" @click="openInLibrary">
        <img v-if="thumbUrl(pick)" :src="thumbUrl(pick)" loading="lazy" :alt="pick.title" />
        <span v-else class="rc-letter">{{ pick.title.slice(0, 2) }}</span>
        <span v-if="nsfwHidden" class="rc-nsfw"></span>
      </button>

      <div class="rc-info">
        <div class="rc-game-title" :title="pick.title">{{ pick.title }}</div>
        <div v-if="pick.developer" class="rc-sub">{{ pick.developer }}</div>
        <div v-if="pick.tags.length" class="rc-tags">
          <span v-for="tag in pick.tags.slice(0, 3)" :key="tag" class="rc-tag">{{ tag }}</span>
        </div>
      </div>

      <div class="rc-actions">
        <button class="rc-detail" type="button" @click="openInLibrary">
          <Info :size="15" />
          <span>{{ t('hero_detail') }}</span>
        </button>
        <button class="rc-launch" type="button" @click="launchGame(pick.id)">
          <Play :size="15" :fill="'currentColor'" />
          <span>{{ t('detail_launch') }}</span>
        </button>
      </div>
    </div>

    <p v-else class="rc-empty">{{ t('home_empty') }}</p>
  </section>
</template>

<style scoped>
.random-card {
  flex: none;
  border-radius: var(--hh-radius-panel);
  padding: var(--hh-space-x3) var(--hh-space-x4);
  display: flex;
  flex-direction: column;
  gap: var(--hh-space-x3);
}

.rc-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--hh-space-x3);
}

.rc-title {
  display: flex;
  align-items: center;
  gap: var(--hh-space-x2);
  font-size: var(--hh-font-bodyLg-size);
  font-weight: 600;
  color: var(--hh-color-text-glow);
}
.rc-title svg {
  color: var(--hh-color-select-icon);
}

.rc-shuffle {
  display: inline-flex;
  align-items: center;
  gap: var(--hh-space-x2);
  border: none;
  background: transparent;
  color: var(--hh-color-link);
  font-size: var(--hh-font-body-size);
  font-family: inherit;
  cursor: pointer;
  padding: var(--hh-space-x2);
  border-radius: var(--hh-radius-sm);
  transition: background var(--hh-motion-med);
}
.rc-shuffle:hover {
  background: var(--hh-color-surface-soft);
}

.rc-body {
  display: flex;
  align-items: center;
  gap: var(--hh-space-x4);
  min-width: 0;
}

/* 竖版封面（统一 cover-ratio token），点击 = 进库页选中 */
.rc-cover {
  position: relative;
  flex: none;
  width: 132px;
  aspect-ratio: var(--hh-layout-cover-ratio);
  border-radius: var(--hh-radius-md);
  overflow: hidden;
  border: none;
  padding: 0;
  background: var(--hh-color-cover-fallback);
  cursor: pointer;
}
.rc-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.rc-letter {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--hh-font-title-size);
  font-weight: 700;
  color: var(--hh-color-text-mid);
}
.rc-nsfw {
  position: absolute;
  inset: 0;
  backdrop-filter: blur(14px);
  background: var(--hh-color-surface-soft);
}

.rc-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--hh-space-x1);
}

.rc-game-title {
  font-size: var(--hh-font-subtitle-size);
  line-height: var(--hh-font-subtitle-lh);
  font-weight: 600;
  color: var(--hh-color-text-glow);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rc-sub {
  font-size: var(--hh-font-caption-size);
  color: var(--hh-color-text-mid);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rc-tags {
  display: flex;
  gap: var(--hh-space-x2);
  flex-wrap: wrap;
}
.rc-tag {
  font-size: var(--hh-font-caption-size);
  color: var(--hh-color-text-soft);
  background: var(--hh-color-surface-soft);
  border: 1px solid var(--hh-color-border-faint);
  border-radius: var(--hh-radius-pill);
  padding: 1px 8px;
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rc-actions {
  display: flex;
  align-items: center;
  gap: var(--hh-space-x2);
  flex: none;
}

.rc-detail {
  display: inline-flex;
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
  white-space: nowrap;
  transition: background var(--hh-motion-med);
}
.rc-detail:hover {
  background: var(--hh-color-surface-hover-soft);
}

.rc-launch {
  display: inline-flex;
  align-items: center;
  gap: var(--hh-space-x2);
  height: 36px;
  padding: 0 var(--hh-space-x4);
  border: none;
  border-radius: var(--hh-radius-md);
  background: var(--hh-color-accent);
  color: var(--hh-color-on-accent);
  font-size: var(--hh-font-body-size);
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  white-space: nowrap;
  transition: background var(--hh-motion-med);
}
.rc-launch:hover {
  background: var(--hh-color-accent-hover);
}

.rc-empty {
  margin: 0;
  font-size: var(--hh-font-body-size);
  color: var(--hh-color-text-dim);
}

@media (max-width: 760px) {
  .rc-body {
    flex-wrap: wrap;
  }
  .rc-actions {
    margin-left: auto;
  }
}
</style>
