<script setup lang="ts">
/**
 * 详情面板（REDESIGN-SPEC §5.4，樱夜 hero 化）。
 *   - 横幅 224px hero：thumb `blur(32px) saturate(1.2) scale(1.2)` opacity .55 + scrim 渐变
 *   - 前景左 cover 104x156；右列标题 20/26 两行 clamp + 原名 + chips
 *   - 主按钮满宽 40（Play/运行中）、次行两 ghost 等宽（刮削/打开目录）
 *   - 元数据两栏：时长、上次、目录（link 色）、来源
 *   - 标签 chips（accentBg 底）；分类 toggle chips；简介 6 行 clamp + 展开/收起
 */
import { computed, ref, watch } from 'vue'
import {
  Activity,
  Archive,
  ClipboardCopy,
  DatabaseBackup,
  Flower2,
  FolderOpen,
  Heart,
  PanelRightClose,
  Pencil,
  Play,
  Star,
  Wand2,
} from 'lucide-vue-next'
import {
  applyPatch,
  launchGame,
  library,
  openEdit,
  openScrape,
  refreshGames,
  selectedGame,
  thumbUrl,
  toggleFavorite,
  filterByMeta,
} from '../stores/library'
import { t, tf } from '../i18n'
import { tokens } from '../design/tokens'

const emit = defineEmits<{ collapse: [] }>()
const g = computed(() => selectedGame.value)
const descExpanded = ref(false)
/** 评分星星色（真值 tokens；reactive，切主题自动刷新） */
const starColor = computed(() => tokens.color.star)

/** 横幅/封面图加载失败：置位 bannerFailed 触发 v-if 卸载（img 按 ref 记忆，
 *  display 按元素记的状态不再交叉错位）。banner-letter 的兜底同帧出现。 */
const bannerFailed = ref(false)
function imgErr(): void {
  bannerFailed.value = true
}
// 切到别的游戏时重来：banner-letter 的兜底状态不能带过去，简介展开态也要复位
watch(g, () => {
  bannerFailed.value = false
  descExpanded.value = false
})

function fmtPlay(ms: number): string {
  if (ms <= 0) return '—'
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  return h > 0 ? tf('dp_hours_min', { h, m }) : tf('dp_minutes', { m })
}

function fmtDate(ts?: number): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleDateString('zh-CN')
}

/** 平均通关时长：分钟 → 可读文本（VNDB length_minutes） */
const lengthText = computed(() => {
  const m = g.value?.lengthMinutes
  if (!m || m <= 0) return ''
  if (m < 60) return tf('dp_minutes', { m })
  const h = Math.floor(m / 60)
  const rem = m % 60
  return rem > 0 ? tf('dp_hours_min', { h, m: rem }) : tf('dp_hours', { h })
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

/** 简介是否超过 6 行阈值（粗略按字符估算，180 字约 6 行） */
const descTruncated = computed(() => !!g.value?.description && g.value.description.length > 180)

async function toggleCategory(): Promise<void> {
  const game = g.value
  if (!game) return
  // 乐观更新：先改本地镜像 + 拉回服务端新值，不触发全量重拉，避免闪烁与掉滚动位置
  const next = game.categories.includes('已通关')
    ? game.categories.filter((c) => c !== '已通关')
    : [...game.categories, '已通关']
  await applyPatch(game.id, { categories: next })
}

function openDir(): void {
  if (g.value) void window.hh.openDir(g.value.dir)
}

async function toggleFlag(flag: 'useLE' | 'useMagpie'): Promise<void> {
  if (!g.value) return
  await window.hh.updateGame(g.value.id, { [flag]: !g.value[flag] })
  await refreshGames()
}

/** 备份开关（G1）：单游戏 backupEnabled，需设置页全局 backup_on_exit 配合 */
async function toggleBackup(): Promise<void> {
  if (!g.value) return
  await window.hh.updateGame(g.value.id, { backupEnabled: !g.value.backupEnabled })
  await refreshGames()
}

/** G13+G17 变体切换：n=0 默认 exePath，n≥1 = variants[n-1]，改完静默更新本地镜像 */
async function setVariant(n: number): Promise<void> {
  if (!g.value) return
  await applyPatch(g.value.id, { activeVariant: n })
}

/** 当前启动目标的可读名（变体 chips 里的选中态与 meta） */
const variantName = computed(() => {
  const game = g.value
  if (!game) return ''
  const n = game.activeVariant ?? 0
  if (n >= 1 && game.variants && n <= game.variants.length) return game.variants[n - 1]?.label ?? game.title
  return game.title
})

/** 打开该游戏的备份/恢复对话框 */
function openBackups(): void {
  library.backupOpen = true
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
  if (game.lengthMinutes) rows.push(`${t('dp_length')}：${lengthText.value}`)
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
</script>

<template>
  <aside class="detail-panel glass">
    <button
      class="detail-collapse"
      :title="t('app_collapse_detail')"
      :aria-label="t('app_collapse_detail')"
      @click="emit('collapse')"
    >
      <PanelRightClose :size="14" />
    </button>
    <!-- 未选中空态 -->
    <div v-if="!g" class="empty-state">
      <Flower2 :size="36" :stroke-width="1.5" class="empty-icon" />
      <div class="empty-text">{{ t('detail_empty') }}</div>
    </div>

    <template v-else>
      <!-- 横幅 224px hero -->
      <div class="banner" :style="bannerImg() ? {} : { background: bannerFallback() }">
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
          </div>
        </div>
      </div>

      <!-- 动作栏：主按钮满宽 + 双 ghost 次行 -->
      <div class="actions">
        <button class="primary-btn" @click="launchGame(g.id)">
          <span v-if="library.runningIds.has(g.id)"><Activity :size="16" /> {{ t('detail_running') }}</span>
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

      <!-- G13+G17 版本/语言包切换：默认 exePath + 每个变体一个 chip -->
      <div v-if="g.variants?.length" class="variants">
        <span class="meta-key variants-key">{{ t('dp_version') }}</span>
        <div class="variants-chips">
          <button
            class="variant-chip"
            :class="{ on: (g.activeVariant ?? 0) === 0 }"
            :title="g.exePath"
            @click="setVariant(0)"
          >
            {{ t('dp_default') }}
          </button>
          <button
            v-for="(v, i) in g.variants"
            :key="i"
            class="variant-chip"
            :class="{ on: (g.activeVariant ?? 0) === i + 1 }"
            :title="v.exePath"
            @click="setVariant(i + 1)"
          >
            {{ v.label }}
          </button>
        </div>
      </div>

      <!-- 收藏行 -->
      <div class="fav-row">
        <button class="fav-btn" :class="{ on: g.favorite }" :aria-pressed="g.favorite" @click="toggleFavorite(g.id)">
          <Heart :size="13" :fill="g.favorite ? 'currentColor' : 'none'" />
          {{ g.favorite ? t('detail_faved') : t('detail_fav') }}
        </button>
        <button
          class="fav-btn"
          :class="{ on: g.backupEnabled }"
          :aria-pressed="!!g.backupEnabled"
          @click="toggleBackup"
        >
          <Archive :size="13" />
          {{ g.backupEnabled ? t('detail_backup_on') : t('detail_backup') }}
        </button>
        <button
          class="fav-btn"
          :class="{ on: library.backupOpen }"
          :aria-pressed="library.backupOpen"
          @click="openBackups"
        >
          <DatabaseBackup :size="13" />
          {{ t('detail_backup_records') }}
        </button>
      </div>

      <!-- 元数据两栏 -->
      <div class="meta">
        <div class="meta-row">
          <span class="meta-key">{{ t('dp_playtime') }}</span
          ><span class="meta-val">{{ fmtPlay(g.playMs) }}</span>
        </div>
        <div class="meta-row" v-if="lengthText">
          <span class="meta-key">{{ t('dp_length') }}</span
          ><span class="meta-val">{{ lengthText }}</span>
        </div>
        <div class="meta-row">
          <span class="meta-key">{{ t('dp_last_played') }}</span
          ><span class="meta-val">{{ fmtDate(g.lastPlayed) }}</span>
        </div>
        <div class="meta-row" v-if="g.variants?.length">
          <span class="meta-key">{{ t('dp_launch_target') }}</span>
          <span class="meta-val">{{ variantName }}</span>
        </div>
        <div class="meta-row" v-if="g.developer">
          <span class="meta-key">{{ t('dp_developer') }}</span>
          <a
            class="meta-val link"
            :title="t('dp_same_dev')"
            @click="filterByMeta('developer', g.developer as string)"
            >{{ g.developer }}</a
          >
        </div>
        <div class="meta-row">
          <span class="meta-key">{{ t('dp_dir') }}</span
          ><a class="meta-val link" @click="openDir">{{ g.dir.split(/[\\/]/).pop() }}</a>
        </div>
        <div class="meta-row" v-if="g.sources.length">
          <span class="meta-key">{{ t('dp_source') }}</span
          ><span class="meta-val">{{ g.sources.map((s) => s.provider).join(' / ') }}</span>
        </div>
      </div>

      <!-- 系列 chips（series 关联：前作/续作/外传，点击聚合筛选同系列） -->
      <div v-if="g.series?.length" class="series">
        <span class="meta-key series-key">{{ t('dp_series') }}</span>
        <div class="series-chips">
          <button
            v-for="s in g.series.slice(0, 6)"
            :key="s"
            class="series-chip"
            :class="{ on: library.metaKey === 'series' && library.metaValue === s }"
            :title="t('dp_same_series')"
            @click="filterByMeta('series', s)"
          >
            {{ s }}
          </button>
        </div>
      </div>

      <!-- 别名行 -->
      <div v-if="g.aliases?.length" class="aliases">
        <span class="meta-key">{{ t('dp_aliases') }}</span
        ><span class="aliases-text" :title="g.aliases.join('，')">{{ g.aliases.slice(0, 6).join('，') }}</span>
      </div>

      <!-- 标签 chips -->
      <div v-if="g.tags.length" class="tags">
        <span v-for="t in g.tags.slice(0, 12)" :key="t" class="tag-chip">{{ t }}</span>
      </div>

      <!-- 分类 toggle chips -->
      <div class="cats">
        <button class="cat-chip" :class="{ on: g.categories.includes('已通关') }" @click="toggleCategory">
          {{ t('batch_cleared') }}
        </button>
        <button class="cat-chip" :class="{ on: g.useLE }" @click="toggleFlag('useLE')">{{ t('dp_le') }}</button>
        <button class="cat-chip" :class="{ on: g.useMagpie }" @click="toggleFlag('useMagpie')">Magpie</button>
      </div>

      <!-- 简介：6 行 clamp + 展开/收起 -->
      <div v-if="g.description" class="desc-wrap">
        <p class="desc" :class="{ clamped: !descExpanded }">{{ g.description }}</p>
        <button v-if="descTruncated" class="desc-toggle" @click="descExpanded = !descExpanded">
          {{ descExpanded ? t('dp_collapse') : t('dp_expand') }}
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
.detail-collapse {
  position: sticky;
  top: 0;
  z-index: 5;
  align-self: flex-end;
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
    color var(--hh-motion-med);
  margin-bottom: -40px;
  flex: none;
}
.detail-collapse:hover {
  background: var(--hh-color-surface-hover);
  color: var(--hh-color-text-glow);
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

/* ============ 横幅 224px hero ============ */
.banner {
  border-radius: var(--hh-radius-panel);
  overflow: hidden;
  position: relative;
  height: 224px;
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
  width: 104px;
  height: 156px;
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
  transition: background var(--hh-motion-med);
}
.ghost-btn:hover {
  background: var(--hh-color-surface-hover-soft);
}

/* 收藏行 */
.fav-row {
  display: flex;
}
.fav-btn {
  flex: 1;
  height: 32px;
  border-radius: var(--hh-radius-sm);
  border: 1px solid var(--hh-color-border-ghost-soft);
  background: transparent;
  color: var(--hh-color-text-mid);
  font-size: 12.5px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  transition: all var(--hh-motion-med);
}
.fav-btn:hover {
  background: var(--hh-color-surface-mid);
  color: var(--hh-color-text-glow);
}
.fav-btn.on {
  background: var(--hh-color-warning-soft-bg);
  border-color: var(--hh-color-star);
  color: var(--hh-color-star);
  font-weight: 600;
}

/* ============ 元数据 ============ */
.meta {
  display: flex;
  flex-direction: column;
  gap: 7px;
  font-size: 12.5px;
}
.meta-row {
  display: flex;
  justify-content: space-between;
  gap: 10px;
}
.meta-key {
  color: var(--hh-color-text-dim-strong);
  flex-shrink: 0;
}
.meta-val {
  color: var(--hh-color-text-strong);
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.link {
  color: var(--hh-color-link);
  cursor: pointer;
  text-decoration: none;
}
.link:hover {
  text-decoration: underline;
}

/* ============ 版本/语言包切换（G13+G17） ============ */
.variants {
  display: flex;
  align-items: center;
  gap: 8px;
}
.variants-key {
  flex-shrink: 0;
}
.variants-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.variant-chip {
  font-size: 11.5px;
  padding: 4px 10px;
  border-radius: var(--hh-radius-sm);
  border: 1px solid var(--hh-color-surface-hover);
  background: transparent;
  color: var(--hh-color-text-mid-high);
  cursor: pointer;
  transition: all var(--hh-motion-med);
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.variant-chip:hover {
  background: var(--hh-color-surface-mid);
}
.variant-chip.on {
  background: var(--hh-color-select-bg);
  border-color: var(--hh-color-accent-selected-border);
  color: var(--hh-color-select-text);
  font-weight: 600;
}

/* ============ 标签 ============ */
.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.tag-chip {
  font-size: 11px;
  padding: 3px 9px;
  border-radius: var(--hh-radius-xs);
  background: var(--hh-color-accent-bg);
  color: var(--hh-color-accent-text);
}
/* ============ 系列（G12） ============ */
.series {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.series-key {
  font-size: 12.5px;
  color: var(--hh-color-text-dim-strong);
}
.series-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.series-chip {
  font-size: 11px;
  padding: 3px 9px;
  border-radius: var(--hh-radius-xs);
  background: var(--hh-color-accent-bg);
  color: var(--hh-color-accent-text);
  opacity: 0.85;
  border: 1px solid transparent;
  cursor: pointer;
  transition: all var(--hh-motion-med);
}
.series-chip:hover {
  opacity: 1;
  background: var(--hh-color-accent-chip-bg);
}
.series-chip.on {
  opacity: 1;
  border-color: var(--hh-color-accent-ring);
  color: var(--hh-color-accent);
  font-weight: 600;
}
.aliases {
  font-size: 11.5px;
  color: var(--hh-color-text-dim);
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
.aliases-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}
/* ============ 分类 ============ */
.cats {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.cat-chip {
  font-size: 11.5px;
  padding: 5px 10px;
  border-radius: var(--hh-radius-sm);
  border: 1px solid var(--hh-color-surface-hover);
  background: transparent;
  color: var(--hh-color-text-mid-high);
  cursor: pointer;
  transition: all var(--hh-motion-med);
}
.cat-chip:hover {
  background: var(--hh-color-surface-mid);
}
.cat-chip.on {
  background: var(--hh-color-success-bg);
  border-color: var(--hh-color-success-border);
  color: var(--hh-color-success-text);
}

/* ============ 简介 ============ */
.desc-wrap {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.desc {
  font-size: var(--hh-font-body-size);
  line-height: 20px;
  color: var(--hh-color-text-mid-high);
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
  font-size: var(--hh-font-caption-size);
  cursor: pointer;
  padding: 0;
}
.desc-toggle:hover {
  color: var(--hh-color-accent-hover);
}
</style>
