<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Heart, Star } from 'lucide-vue-next'
import { thumbUrl, toggleFavorite } from '../stores/library'
import { t } from '../i18n'
import { tokens } from '../design/tokens'
import { type Game } from '../../shared/types'

/**
 * DetailBanner.vue —— 详情面板的横幅 hero（右栏 180px / 整页 260px）与收藏 chip。
 * 自 DetailPanel.vue 拆出：横幅 + 收藏行的逻辑与样式整体搬来，DOM / 类名 / 文案不变。
 * 切游戏时复位 bannerFailed（拆分前写在父组件的 watch(g) 里）。
 */

const props = defineProps<{ game: Game | null }>()

/** 选中游戏（拆前父组件 v-else 保证非空；这里仍按可空处理，与拆分前一致）。 */
const g = computed(() => props.game)

/** 评分星星色（真值 tokens；reactive，切主题自动刷新） */
const starColor = computed(() => tokens.color.star)

/** 横幅/封面图加载失败：置位 bannerFailed 触发 v-if 卸载（img 按 ref 记忆，
 *  display 按元素记的状态不再交叉错位）。banner-letter 的兜底同帧出现。 */
const bannerFailed = ref(false)
function imgErr(): void {
  bannerFailed.value = true
}

/** 切到别的游戏要重来：banner-letter 兜底不能带到下一部。 */
watch(() => props.game, () => {
  bannerFailed.value = false
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
</script>

<template>
<!-- 横幅 180px hero（紧凑化：曲线要在首屏可见，见 CSS 注释） -->
<div v-if="g" class="banner" :style="bannerImg() ? {} : { background: bannerFallback() }">
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
      <!-- 收藏并入 chip 行：单独一条全宽收藏行白占 56px，
           把右栏最值钱的东西（曲线）挤出视口。类名保持 .fav-btn，
           verify 的收藏断言不换靶。 -->
      <button
        class="fav-btn chip chip-fav"
        :class="{ on: g.favorite }"
        :aria-pressed="g.favorite"
        @click="toggleFavorite(g.id)"
      >
        <Heart :size="12" :fill="g.favorite ? 'currentColor' : 'none'" />
        {{ g.favorite ? t('detail_faved') : t('detail_fav') }}
      </button>
    </div>
  </div>
</div>
</template>

<style scoped>
/* ============ 横幅 180px hero ============ */
.banner {
  border-radius: var(--hh-radius-panel);
  overflow: hidden;
  position: relative;
  height: 180px;
  /* 固定高度的 hero 不许被 flex 列压缩：面板内容（元数据/标签/分页/曲线）
     远超视口高度时，默认 flex-shrink:1 会把它压成一条（实测 32px），
     封面就没了。flex:none = 保持声明高度，溢出交给 .detail-panel 滚动。
     224→180：右栏总高预算 ≈780px，旧值把「游玩数据」tab 的曲线整个推出
     视口（截图实测曲线 top=826 > 782）——180 让曲线+区间 chip 默认在屏内。 */
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
  width: 88px;
  height: 132px;
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

/* 详情卡片在形态切换时由 View Transitions 接管（banner 单独命名 → 它会长大，
   其它内容淡入淡出）。旧浏览器/减少动效下直接切，不报错。 */
.banner {
  view-transition-name: dp-banner;
}
/* ============ 收藏（banner chip 行内的 chip 按钮） ============ */
/* 旧版是 banner 下面一条全宽 44px 收藏行——右栏高度预算里没有它的位置，
   曲线被推出视口。现在它和 发行日期/评分 同排（对标 detail.png 的
   Score chip 位置），类名 .fav-btn 不变，verify 断言不换靶。 */
.fav-btn {
  border: none;
  background: var(--hh-color-surface-strong);
  color: var(--hh-color-text-bright);
  font-family: inherit;
  cursor: pointer;
  transition: all var(--hh-motion-med);
}
.fav-btn:hover {
  background: var(--hh-color-surface-hover);
}
.fav-btn.on {
  background: var(--hh-color-warning-soft-bg);
  color: var(--hh-color-star);
  font-weight: 600;
}
</style>
