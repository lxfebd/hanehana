<script setup lang="ts">
/**
 * 游戏库工具栏（从 App.vue 拆出，G17 大文件拆分）。
 * 搜索 + 分类 chips + 智能列表 + 收藏/多选 + 计数 + 导出 + 视图切换。
 *
 * 数据流向：
 *   - library store 状态（keyword/categoryFilter/smartList/favOnly/selectMode/view）
 *     组件内直接读写（store 是单例响应式，双向往来天然成立）
 *   - filteredCount / exportMenuOpen / doExport / clearMeta 属 App 级（导出走
 *     window.hh、计数来自 filteredGames），经 props/emit 传入
 */
import { onBeforeUnmount, ref } from 'vue'
import { Heart, LayoutGrid, List, Search, CheckSquare, ArrowUpFromLine, X } from 'lucide-vue-next'
import { categories, enterSelectMode, library, SMART_LISTS } from '../stores/library'
import { useClickOutside } from '../composables/useClickOutside'
import { t } from '../i18n'

const props = defineProps<{
  filteredCount: number
  exportMenuOpen: boolean
}>()

const emit = defineEmits<{
  toggleExport: []
  export: [fmt: 'csv' | 'json']
  clearMeta: []
  closeExport: []
}>()

/**
 * 导出菜单的外层容器。点外面由**本组件自己的元素 ref** 判断，不再让 App.vue
 * 用 document.querySelector('.export-wrap') 跨组件抓 DOM：菜单的 DOM 在这里，
 * 判断也该在这里；App 只保留开关状态，收不收由这里通知（emit closeExport）。
 */
const exportWrapRef = ref<HTMLElement | null>(null)
useClickOutside(exportWrapRef, () => {
  if (props.exportMenuOpen) emit('closeExport')
})

/** 卸载时收回「菜单开着」这个 App 级状态。
 *  为什么必须在卸载时关：菜单的 DOM 在本组件（v-if），开关状态在 App（exportMenuOpen），
 *  两处不同生共死——本组件一卸载（切页等），DOM 没了，App 里那个 true 还活着；
 *  回到库页时组件重新挂载，v-if 拿着旧 true 又把菜单开出来，像是「自己开着的」。
 *  旧实现用全局 document 监听，切页那一下点击会顺手关掉它，所以这个空洞一直没暴露；
 *  收口到本组件的元素 ref 之后，不带鼠标的切页（快捷键 1/2/3、程序内跳转）就漏了
 *  （verify_click_outside.mjs 的快捷键分支就是抓这条）。
 *  为什么在子组件卸载钩子里清，而不是 App 侧 watch(ui.page)：宿主没了就该连状态一起
 *  收走，这对**任何**卸载原因（页面切换、以后的条件渲染）都成立；watch 页面名只
 *  覆盖「切页」这一种原因，组件因别的原因卸载时同样的空洞又会回来。 */
onBeforeUnmount(() => {
  if (props.exportMenuOpen) emit('closeExport')
})

/** 模板只写单方法调用（prettier 会拆多语句表达式） */
</script>

<template>
  <!-- 工具栏：搜索 + 分类 chips + 计数 + 视图 segmented -->
  <div class="toolbar">
    <div class="search-box">
      <Search :size="14" class="search-ic" />
      <input
        v-model="library.keyword"
        class="search-input"
        :placeholder="library.searchRegex ? t('toolbar_search_regex_placeholder') : t('toolbar_search_placeholder')"
      />
      <button
        class="regex-toggle"
        :class="{ on: library.searchRegex }"
        :title="t('toolbar_regex')"
        :aria-pressed="library.searchRegex"
        @click="library.searchRegex = !library.searchRegex"
      >
        .*
      </button>
    </div>

    <div class="cat-chips">
      <button class="cat-chip" :class="{ active: library.categoryFilter === '' }" @click="library.categoryFilter = ''">
        {{ t('toolbar_all') }}
      </button>
      <button
        v-for="c in categories"
        :key="c"
        class="cat-chip"
        :class="{ active: library.categoryFilter === c }"
        @click="library.categoryFilter = library.categoryFilter === c ? '' : c"
      >
        {{ c }}
      </button>
    </div>

    <!-- 智能列表（动态筛选，Playnite 式）：文案走 i18n 键，不存中文标签 -->
    <select v-model="library.smartList" class="smart-select" :title="t('toolbar_smart')">
      <option v-for="l in SMART_LISTS" :key="l.id" :value="l.id">{{ t(l.labelKey) }}</option>
    </select>

    <button
      class="tool-btn"
      :class="{ active: library.favOnly }"
      :title="t('toolbar_fav')"
      :aria-pressed="library.favOnly"
      @click="library.favOnly = !library.favOnly"
    >
      <Heart :size="15" />
    </button>

    <!-- 批量操作开关（基准库页头部口径：文字标签 + 药丸 toggle，主操作不许纯图标） -->
    <button
      class="batch-toggle"
      :class="{ on: library.selectMode }"
      :title="t('toolbar_select')"
      :aria-pressed="library.selectMode"
      @click="enterSelectMode(!library.selectMode)"
    >
      <CheckSquare :size="15" class="bt-ic" />
      <span class="bt-label">{{ t('toolbar_batch_actions') }}</span>
      <span class="bt-switch" aria-hidden="true"><i class="bt-knob" /></span>
    </button>

    <!-- G14 导出：主操作带文字（基准口径：图标 + 文字，不纯图标）+ 小菜单（CSV / JSON） -->
    <div ref="exportWrapRef" class="export-wrap">
      <button
        class="tool-btn labeled"
        :class="{ active: exportMenuOpen }"
        :title="t('toolbar_export')"
        :aria-pressed="exportMenuOpen"
        @click="emit('toggleExport')"
      >
        <ArrowUpFromLine :size="15" />
        <span class="tool-btn-label">{{ t('btn_export_short') }}</span>
      </button>
      <div v-if="exportMenuOpen" class="export-menu glass" @click.stop>
        <button class="export-item" @click="emit('export', 'csv')">{{ t('toolbar_export_csv') }}</button>
        <button class="export-item" @click="emit('export', 'json')">{{ t('toolbar_export_json') }}</button>
      </div>
    </div>
    <button v-if="library.metaKey" class="meta-chip" @click="emit('clearMeta')" :title="t('lib_clear')">
      <X :size="12" /> {{ library.metaKey === 'series' ? t('app_meta_series') : t('app_meta_developer')
      }}{{ library.metaValue }}
    </button>

    <div class="segmented">
      <button
        class="seg-btn"
        :class="{ active: library.view === 'grid' }"
        :title="t('toolbar_grid')"
        @click="library.view = 'grid'"
      >
        <LayoutGrid :size="16" />
      </button>
      <button
        class="seg-btn"
        :class="{ active: library.view === 'list' }"
        :title="t('toolbar_list')"
        @click="library.view = 'list'"
      >
        <List :size="16" />
      </button>
    </div>

    <!-- 计数压轴在最右（基准 library.png：左控件组 / 右「107 games total」） -->
    <div class="toolbar-count">{{ filteredCount }} {{ t('count_suffix') }}</div>
  </div>
</template>

<style scoped>
/* 工具栏：搜索 + 分类 chips + 计数 + segmented（§5.3）。
   整条工具条收进一个卡片容器，与左右玻璃面板同层级——此前元素裸浮在玻璃上，
   与两侧面板断层，是"粗糙感"的主要来源之一。 */
.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  flex-wrap: wrap;
  border-radius: var(--hh-radius-md);
  border: 1px solid var(--hh-color-card-border);
  background: var(--hh-color-surface-bright);
  backdrop-filter: blur(12px) saturate(1.3);
  /* backdrop-filter 会让本元素自建 stacking context，把内部 .export-menu 的
     z-index 关在工具栏内；工具栏在 .layout 层叠上下文里是 z-auto、先于后绘制的
     .cover-wrap，于是下拉菜单被下面的游戏卡片盖住（命中测试 regression:layers 曾捕获）。
     给 toolbar 自身一个正 z：整条工具栏（含其下拉）压过封面墙，仍低于真·弹层。 */
  position: relative;
  z-index: var(--hh-layer-popover);
}
.search-box {
  position: relative;
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 180px;
  max-width: 320px;
}
.search-ic {
  position: absolute;
  left: 12px;
  color: var(--hh-color-text-dim);
  pointer-events: none;
}
.search-input {
  width: 100%;
  height: 32px;
  border-radius: var(--hh-radius-md);
  padding: 0 42px 0 34px;
  border: 1px solid var(--hh-color-card-border);
  background: var(--hh-color-surface-bright);
  color: var(--hh-color-text-glow);
  font-size: var(--hh-font-body-size);
  outline: none;
  transition:
    border-color var(--hh-motion-slow),
    box-shadow var(--hh-motion-slow);
}
.search-input:focus {
  border-color: var(--hh-color-accent-focus-border);
  box-shadow: 0 0 0 3px var(--hh-color-accent-focus-ring);
}
/* G19 正则切换按钮：贴在输入框右侧（.* 符号） */
.regex-toggle {
  position: absolute;
  right: 6px;
  height: 22px;
  min-width: 30px;
  padding: 0 6px;
  border: none;
  border-radius: var(--hh-radius-xs);
  background: transparent;
  color: var(--hh-color-text-dim);
  font-family: ui-monospace, Consolas, monospace;
  font-size: var(--hh-font-caption-size);
  cursor: pointer;
  transition:
    background var(--hh-motion-med),
    color var(--hh-motion-med);
}
.regex-toggle:hover {
  background: var(--hh-color-surface-hover);
  color: var(--hh-color-text-bright);
}
.regex-toggle.on {
  background: var(--hh-color-accent-bg);
  color: var(--hh-color-accent);
}

/* 分类 chip 行：横向滚动无滚动条 */
.cat-chips {
  display: flex;
  align-items: center;
  gap: 6px;
  overflow-x: auto;
  scrollbar-width: none;
  min-width: 0;
  /* 容器充足时让猫 chips 吃掉剩余宽度；容器紧张时退回内容宽，
     把位置让给计数与视图切换，避免被 flex:1 压成一缕 28px。 */
  flex: 0 1 auto;
  max-width: 420px;
}
.cat-chips::-webkit-scrollbar {
  display: none;
}
.cat-chip {
  flex-shrink: 0;
  height: 32px;
  padding: 0 12px;
  border-radius: var(--hh-radius-pill);
  border: 1px solid var(--hh-color-card-border);
  background: var(--hh-color-surface-bright);
  color: var(--hh-color-text-mid-high);
  font-size: var(--hh-font-caption-size);
  cursor: pointer;
  transition:
    background var(--hh-motion-med) ease,
    color var(--hh-motion-med) ease;
}
.cat-chip:hover {
  background: var(--hh-color-surface-mid);
  color: var(--hh-color-text-glow);
}
/* 选中 chip：低透明 accent 底 + accent 亮字 + 同色亮边。
   不用实色粉铺满（高饱和大面积填充 = "AI 味"），粉色收窄到边框与文字。 */
.cat-chip.active {
  background: var(--hh-color-select-bg);
  border-color: var(--hh-color-accent-selected-border);
  color: var(--hh-color-select-text);
  font-weight: 600;
}
.toolbar-count {
  font-size: var(--hh-font-caption-size);
  color: var(--hh-color-text-tertiary);
  white-space: nowrap;
}

/* 批量操作开关（基准口径：标签 + 药丸 switch，收进同一控件）。
   关闭 = 描边卡底 + 灰 knob；开启 = select 态低透明 accent 底 + accent 实 knob。 */
.batch-toggle {
  display: flex;
  align-items: center;
  gap: 7px;
  height: 32px;
  padding: 0 8px 0 10px;
  border-radius: var(--hh-radius-pill);
  border: 1px solid var(--hh-color-card-border);
  background: var(--hh-color-surface-bright);
  color: var(--hh-color-text-mid);
  cursor: pointer;
  transition:
    background var(--hh-motion-med) ease,
    border-color var(--hh-motion-med) ease,
    color var(--hh-motion-med) ease;
}
.batch-toggle:hover {
  background: var(--hh-color-surface-mid);
  color: var(--hh-color-text-glow);
}
.bt-ic {
  flex-shrink: 0;
}
.bt-label {
  white-space: nowrap;
  font-size: var(--hh-font-caption-size);
  font-weight: 600;
}
.bt-switch {
  position: relative;
  width: 34px;
  height: 18px;
  border-radius: var(--hh-radius-pill);
  background: var(--hh-color-surface-mid);
  border: 1px solid var(--hh-color-card-border);
  transition: background var(--hh-motion-med) ease;
}
.bt-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--hh-color-text-tertiary);
  transition:
    transform var(--hh-motion-med) ease,
    background var(--hh-motion-med) ease;
}
.batch-toggle.on {
  background: var(--hh-color-select-bg);
  border-color: var(--hh-color-accent-selected-border);
  color: var(--hh-color-select-text);
}
.batch-toggle.on .bt-switch {
  background: var(--hh-color-accent);
  border-color: var(--hh-color-accent);
}
.batch-toggle.on .bt-knob {
  transform: translateX(16px);
  background: var(--hh-color-on-accent);
}

/* 智能列表下拉 + 收藏/多选工具按钮（与 seg-btn 同口径） */
.smart-select {
  height: 32px;
  border-radius: var(--hh-radius-md);
  padding: 0 10px;
  border: 1px solid var(--hh-color-card-border);
  background: var(--hh-color-surface-bright);
  color: var(--hh-color-text-glow);
  font-size: 12.5px;
  cursor: pointer;
  outline: none;
  font-family: inherit;
  -webkit-appearance: none;
  appearance: none;
}
.smart-select:focus {
  border-color: var(--hh-color-accent-focus-border);
  box-shadow: 0 0 0 3px var(--hh-color-accent-focus-ring);
}
.tool-btn {
  width: 32px;
  height: 32px;
  border: none;
  border-radius: var(--hh-radius-md);
  background: transparent;
  color: var(--hh-color-text-mid);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition:
    background var(--hh-motion-med) ease,
    color var(--hh-motion-med) ease;
}
.tool-btn:hover {
  background: var(--hh-color-surface-mid);
  color: var(--hh-color-text-glow);
}
/* 带文字的主操作按钮：图标 + 短文案（基准要求主操作不许纯图标） */
.tool-btn.labeled {
  width: auto;
  padding: 0 12px;
  gap: 6px;
}
.tool-btn-label {
  white-space: nowrap;
  font-size: var(--hh-font-caption-size);
  font-weight: 600;
}
/* 选中态统一口径：低透明 accent 底 + accent 亮字（实色粉铺满显廉价） */
.tool-btn.active {
  background: var(--hh-color-select-bg);
  color: var(--hh-color-select-text);
}

/* G14 导出：小菜单浮在按钮正下方（玻璃材质复用全局 .glass）。
   margin-left:auto：从这里起算「右侧组」（导出 / 视图切换 / 计数压最右），
   对齐基准 library.png 的「左控件组 … 右 107 games total」布局。 */.export-wrap {
  position: relative;
  display: flex;
  align-items: center;
  margin-left: auto;
}
.export-menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: var(--hh-layer-popover);
  min-width: 132px;
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.export-item {
  display: flex;
  align-items: center;
  height: 30px;
  padding: 0 10px;
  border: none;
  border-radius: var(--hh-radius-sm);
  background: transparent;
  color: var(--hh-color-text-bright);
  font-size: var(--hh-font-body-size);
  font-family: inherit;
  cursor: pointer;
  transition: background var(--hh-motion-med) ease;
  text-align: left;
}
.export-item:hover {
  background: var(--hh-color-surface-mid);
}

/* 元数据聚合筛选提示条（G12）：激活时显示，一键清除 */
.meta-chip {
  display: flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  padding: 0 10px;
  border-radius: var(--hh-radius-pill);
  border: 1px solid var(--hh-color-accent-ring);
  background: var(--hh-color-accent-soft);
  color: var(--hh-color-accent-text);
  font-size: var(--hh-font-caption-size);
  cursor: pointer;
  white-space: nowrap;
  transition: background var(--hh-motion-med);
}
.meta-chip:hover {
  background: var(--hh-color-accent-chip-bg);
}

/* 视图 segmented：pill 容器 card 底 */
.segmented {
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: var(--hh-radius-pill);
  background: var(--hh-color-surface-bright);
  border: 1px solid var(--hh-color-card-border);
}
.seg-btn {
  width: 32px;
  height: 32px;
  border: none;
  border-radius: var(--hh-radius-pill);
  background: transparent;
  color: var(--hh-color-text-mid);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition:
    background var(--hh-motion-med) ease,
    color var(--hh-motion-med) ease;
}
.seg-btn:hover {
  background: var(--hh-color-surface-mid);
  color: var(--hh-color-text-glow);
}
.seg-btn.active {
  background: var(--hh-color-select-bg);
  color: var(--hh-color-select-text);
}

</style>
