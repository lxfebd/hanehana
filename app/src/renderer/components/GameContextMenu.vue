<script setup lang="ts">
/**
 * 封面卡右键菜单（桌面软件标配）。
 *
 * 为什么单独一个组件而不是塞进 CoverGrid：菜单要 Teleport 到 body 才不会被
 * RecycleScroller 的 overflow 裁掉；而虚拟化会在滚动时卸载卡片，
 * 菜单的「当前目标」必须存在 store 里而不是卡片 ref 上。
 *
 * 交互约定：
 *   - 右击卡片：在该位置开菜单，不改变当前选中
 *   - 左键点任意处 / Esc / 滚动封面墙：关菜单（桌面软件的一致预期）
 *   - 多选模式下不弹「单款」菜单，交给批量浮层（避免两套语义打架）
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  ClipboardCopy,
  FolderOpen,
  Heart,
  Pencil,
  Play,
  RefreshCw,
  Wand2,
} from 'lucide-vue-next'
import { message } from 'ant-design-vue'
import { library, openEdit, openScrape, refreshGames, toggleFavorite } from '../stores/library'
import { t } from '../i18n'

/** 菜单目标（游戏 id）+ 屏幕坐标。null = 关着的。 */
const target = ref<{ id: string; title: string; dir: string; favorite: boolean } | null>(null)
const pos = ref({ x: 0, y: 0 })
/** 菜单自身尺寸（定位后量），用来在贴边时翻转方向 */
const menuW = ref(180)
const menuH = ref(0)

const open = computed(() => target.value !== null)

/** 供 CoverGrid 在 contextmenu 时调用 */
function showAt(x: number, y: number, g: { id: string; title: string; dir: string; favorite: boolean }): void {
  target.value = { ...g }
  // 先给个初值，翻转在 mounted 后量真实尺寸
  pos.value = { x, y }
}

function close(): void {
  target.value = null
}

// 贴边翻转：右边不够往左，下边不够往上
function adjust(): void {
  const el = document.querySelector('.ctx-menu') as HTMLElement | null
  if (!el) return
  const r = el.getBoundingClientRect()
  menuW.value = r.width
  menuH.value = r.height
  const vw = window.innerWidth
  const vh = window.innerHeight
  let { x, y } = pos.value
  if (x + r.width > vw - 8) x = Math.max(8, x - r.width)
  if (y + r.height > vh - 8) y = Math.max(8, y - r.height)
  pos.value = { x, y }
}

// 关菜单的三个入口：左键、Esc、滚动（滚动时卡片会被虚拟化卸载，菜单必须跟着关）
function onDocClick(e: MouseEvent): void {
  if (!open.value) return
  const menu = document.querySelector('.ctx-menu')
  if (menu && !menu.contains(e.target as Node)) close()
}
function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') close()
}
function onScroll(): void {
  if (open.value) close()
}

onMounted(() => {
  document.addEventListener('click', onDocClick, true)
  document.addEventListener('keydown', onKey, true)
  // capture + passive：滚动容器任何一层滚都关，不用逐个容器绑
  document.addEventListener('scroll', onScroll, true)
})
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick, true)
  document.removeEventListener('keydown', onKey, true)
  document.removeEventListener('scroll', onScroll, true)
})

// 量尺寸：每次打开后下一帧（DOM 有了才能量）
watch(open, (on) => {
  if (on) requestAnimationFrame(adjust)
})

// ---------------------------------------------------------------- 菜单动作

async function actFavorite(): Promise<void> {
  const id = target.value?.id
  close()
  if (id) await toggleFavorite(id)
}

function actOpenDir(): void {
  const dir = target.value?.dir
  close()
  if (dir) void window.hh.openDir(dir)
}

async function actCopyTitle(): Promise<void> {
  const title = target.value?.title
  close()
  if (!title) return
  try {
    await navigator.clipboard.writeText(title)
    message.success(t('dp_copied'))
  } catch {
    message.error(t('dp_copy_fail'))
  }
}

function actLaunch(): void {
  const id = target.value?.id
  close()
  if (id) void window.hh.launchGame(id)
}

function actEdit(): void {
  const id = target.value?.id
  close()
  if (id) openEdit(id)
}

function actScrape(): void {
  const g = target.value
  close()
  if (!g) return
  const full = library.games.find((x) => x.id === g.id)
  openScrape(g.id, full?.rawTitle || g.title)
}

function actRefresh(): void {
  close()
  void refreshGames()
}

/** 暴露给 CoverGrid：右击时调用 */
defineExpose({ showAt, close })
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="ctx-menu glass"
      :style="{ left: pos.x + 'px', top: pos.y + 'px', minWidth: menuW + 'px' }"
      role="menu"
      @contextmenu.prevent
    >
      <button class="ctx-item" type="button" role="menuitem" @click="actLaunch">
        <Play :size="14" /> {{ t('detail_launch') }}
      </button>
      <button class="ctx-item" type="button" role="menuitem" @click="actFavorite">
        <Heart :size="14" :fill="target?.favorite ? 'currentColor' : 'none'" /> {{ target?.favorite ? t('detail_faved') : t('detail_fav') }}
      </button>
      <div class="ctx-sep"></div>
      <button class="ctx-item" type="button" role="menuitem" @click="actScrape">
        <Wand2 :size="14" /> {{ t('detail_scrape') }}
      </button>
      <button class="ctx-item" type="button" role="menuitem" @click="actEdit">
        <Pencil :size="14" /> {{ t('detail_edit') }}
      </button>
      <button class="ctx-item" type="button" role="menuitem" @click="actRefresh">
        <RefreshCw :size="14" /> {{ t('sc_refresh') }}
      </button>
      <div class="ctx-sep"></div>
      <button class="ctx-item" type="button" role="menuitem" @click="actOpenDir">
        <FolderOpen :size="14" /> {{ t('detail_dir') }}
      </button>
      <button class="ctx-item" type="button" role="menuitem" @click="actCopyTitle">
        <ClipboardCopy :size="14" /> {{ t('dp_copy') }}
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.ctx-menu {
  position: fixed;
  z-index: 1100;
  padding: 5px;
  border-radius: var(--hh-radius-md);
  display: flex;
  flex-direction: column;
  gap: 1px;
  box-shadow: var(--hh-shadow-float);
}
.ctx-item {
  display: flex;
  align-items: center;
  gap: 9px;
  height: 32px;
  padding: 0 10px;
  border: none;
  border-radius: var(--hh-radius-sm);
  background: transparent;
  color: var(--hh-color-text-bright);
  font-size: var(--hh-font-body-size);
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  white-space: nowrap;
}
.ctx-item:hover {
  background: var(--hh-color-select-bg);
  color: var(--hh-color-select-text);
}
.ctx-item svg {
  flex: none;
  opacity: 0.85;
}
.ctx-sep {
  height: 1px;
  margin: 4px 6px;
  background: var(--hh-color-border-faint);
}
</style>
