<script setup lang="ts">
/**
 * 手动编辑单游戏信息（G7）。
 *  - 覆盖 title/titleNative/description/releaseDate/rating/tags/categories
 *  - 保存时标记 manualEdit=true：刮削不再覆盖用户手填字段（scraper.ts 里读它）
 *  - 弹窗内用 antd Input/InputNumber/Select（tags 用 mode=tags）
 */
import { ref, watch } from 'vue'
import { Input, InputNumber, Select } from 'ant-design-vue'
import DialogShell from './DialogShell.vue'
import { library, saveManualEdit } from '../stores/library'
import { t } from '../i18n'
import type { Game, GameVariant } from '../../shared/types'

const open = defineModel<boolean>('open')

const title = ref('')
/** 主启动路径：路径失效时在编辑框里自救（主进程过 existsSync 才落盘） */
const exePath = ref('')
const titleNative = ref('')
const description = ref('')
const releaseDate = ref('')
const rating = ref<number | undefined>(undefined)
const tags = ref<string[]>([])
const categories = ref<string[]>([])
const developer = ref('')
const series = ref<string[]>([])
const aliases = ref<string[]>([])
const lengthMinutes = ref<number | undefined>(undefined)
const preLaunchCmd = ref('')
const postLaunchCmd = ref('')
/** G13+G17 版本/语言包变体：标签 + exe + 可选专属启动前命令 */
const variants = ref<GameVariant[]>([])
const activeVariant = ref(0)

const target = ref<Game | null>(null)

watch(open, (v) => {
  if (!v) return
  target.value = library.games.find((g) => g.id === library.editTargetId) ?? null
  if (!target.value) return
  title.value = target.value.title
  exePath.value = target.value.exePath
  titleNative.value = target.value.titleNative ?? ''
  description.value = target.value.description ?? ''
  releaseDate.value = target.value.releaseDate ?? ''
  rating.value = target.value.rating ?? undefined
  tags.value = [...target.value.tags]
  categories.value = [...target.value.categories]
  developer.value = target.value.developer ?? ''
  series.value = [...(target.value.series ?? [])]
  aliases.value = [...(target.value.aliases ?? [])]
  lengthMinutes.value = target.value.lengthMinutes ?? undefined
  preLaunchCmd.value = target.value.preLaunchCmd ?? ''
  postLaunchCmd.value = target.value.postLaunchCmd ?? ''
  variants.value = (target.value.variants ?? []).map((v) => ({ ...v }))
  activeVariant.value = target.value.activeVariant ?? 0
})

/** G13+G17：添加一个空变体行（等待用户填 label/exe） */
function addVariant(): void {
  variants.value.push({ label: '', exePath: '', preLaunchCmd: '' })
}

/** G13+G17：移除某下标变体；若被移除的是当前激活项则回落到默认 */
function removeVariant(i: number): void {
  variants.value.splice(i, 1)
  if (activeVariant.value === i + 1) activeVariant.value = 0
  else if (activeVariant.value > i + 1) activeVariant.value--
}

/** G13+G17：原生对话框选变体 exe */
async function pickVariantExe(v: GameVariant): Promise<void> {
  const p = await window.hh.pickExe()
  if (p) v.exePath = p
}

/** 原生对话框选主启动 exe（路径失效时的自救入口） */
async function pickMainExe(): Promise<void> {
  const p = await window.hh.pickExe()
  if (p) exePath.value = p
}

async function save(): Promise<void> {
  const g = target.value
  if (!g) return
  if (!title.value.trim()) {
    library.error = t('ed_title_empty')
    return
  }
  if (
    rating.value !== undefined &&
    rating.value !== null &&
    (Number.isNaN(rating.value) || rating.value < 0 || rating.value > 10)
  ) {
    library.error = t('ed_rating_range')
    return
  }
  const rd = releaseDate.value.trim()
  if (rd && !/^\d{4}-\d{2}-\d{2}$/.test(rd)) {
    library.error = t('ed_date_format')
    return
  }
  // 先算「存盘后实际生效」的变体列表（与主进程 variants 的过滤一致：
  // label 空 / exe 空 都会被丢），并记住每项在原始数组里的下标。
  // activeVariant 必须按这份新列表重定位，不能拿原始数组下标硬塞——
  // 原下标在过滤后会错位，指向错的行。
  const keptVariants = variants.value
    .map((v, i) => ({
      origIndex: i,
      label: v.label.trim(),
      exePath: v.exePath.trim(),
      preLaunchCmd: v.preLaunchCmd?.trim() || undefined,
    }))
    .filter((v) => v.label && v.exePath)
  const patch: Partial<Game> = {
    title: title.value.trim(),
    // 清空输入框 = 维持原路径；新值由主进程 existsSync 校验，不合法会报错并保持弹窗打开
    exePath: exePath.value.trim() || g.exePath,
    titleNative: titleNative.value.trim(),
    description: description.value.trim(),
    releaseDate: rd,
    rating: rating.value ?? undefined,
    tags: tags.value.map((t) => t.trim()).filter(Boolean),
    categories: categories.value.map((c) => c.trim()).filter(Boolean),
    developer: developer.value.trim(),
    series: series.value.map((t) => t.trim()).filter(Boolean),
    aliases: aliases.value.map((t) => t.trim()).filter(Boolean),
    lengthMinutes: lengthMinutes.value ?? undefined,
    preLaunchCmd: preLaunchCmd.value.trim(),
    postLaunchCmd: postLaunchCmd.value.trim(),
    variants: keptVariants.map(({ label, exePath, preLaunchCmd }) => ({ label, exePath, preLaunchCmd })),
    // activeVariant 存盘语义：0 = 默认，n≥1 = 变体列表[n-1]。
    // 用户选中的原始变体若被过滤掉了，回退到 0（默认）而不是留一个错位的下标。
    activeVariant:
      activeVariant.value >= 1 && activeVariant.value <= variants.value.length
        ? keptVariants.findIndex((k) => k.origIndex === activeVariant.value - 1) + 1
        : 0,
  }
  const ok = await saveManualEdit(g.id, patch)
  if (ok) open.value = false
}
</script>

<template>
  <DialogShell v-model:open="open" :title="t('ed_title')" :width="560">
    <div class="edit-body">
      <label class="field">
        <span class="label">{{ t('ed_lb_title') }}</span>
        <Input v-model:value="title" :placeholder="t('ed_ph_title')" />
      </label>
      <div class="field">
        <span class="label">{{ t('ed_lb_exe') }}</span>
        <div class="exe-row">
          <Input v-model:value="exePath" :placeholder="t('ed_ph_exe')" class="exe-main" />
          <button type="button" class="mini-btn" @click="pickMainExe">{{ t('common_browse') }}</button>
        </div>
        <span class="hint">{{ t('ed_exe_hint') }}</span>
      </div>
      <label class="field">
        <span class="label">{{ t('ed_lb_native') }}</span>
        <Input v-model:value="titleNative" :placeholder="t('ed_ph_native')" />
      </label>
      <label class="field">
        <span class="label">{{ t('ed_lb_date') }}</span>
        <Input v-model:value="releaseDate" :placeholder="t('ed_ph_date')" />
      </label>
      <label class="field">
        <span class="label">{{ t('ed_lb_dev') }}</span>
        <Input v-model:value="developer" :placeholder="t('ed_ph_dev')" />
      </label>
      <div class="field-row">
        <label class="field">
          <span class="label">{{ t('ed_lb_rating') }}</span>
          <InputNumber v-model:value="rating" :min="0" :max="10" :step="0.1" :precision="1" style="width: 120px" />
        </label>
        <label class="field">
          <span class="label">{{ t('ed_lb_length') }}</span>
          <InputNumber v-model:value="lengthMinutes" :min="0" :max="100000" :step="30" style="width: 140px" />
        </label>
      </div>
      <label class="field">
        <span class="label">{{ t('ed_lb_series') }}</span>
        <Select v-model:value="series" mode="tags" :placeholder="t('ed_ph_series')" :open="false" />
      </label>
      <label class="field">
        <span class="label">{{ t('ed_lb_aliases') }}</span>
        <Select v-model:value="aliases" mode="tags" :placeholder="t('ed_ph_aliases')" :open="false" />
      </label>
      <label class="field">
        <span class="label">{{ t('ed_lb_tags') }}</span>
        <Select v-model:value="tags" mode="tags" :placeholder="t('ed_ph_tags')" :open="false" />
      </label>
      <label class="field">
        <span class="label">{{ t('ed_lb_cats') }}</span>
        <Select v-model:value="categories" mode="tags" :placeholder="t('ed_ph_cats')" :open="false" />
      </label>
      <label class="field">
        <span class="label">{{ t('ed_lb_pre') }}</span>
        <Input v-model:value="preLaunchCmd" :placeholder="t('ed_ph_pre')" />
      </label>
      <label class="field">
        <span class="label">{{ t('ed_lb_post') }}</span>
        <Input v-model:value="postLaunchCmd" :placeholder="t('ed_ph_post')" />
      </label>
      <div class="field-row">
        <span class="label hint">{{ t('ed_ph_tip') }}</span>
      </div>

      <!-- G13+G17 多版本/语言包：同一游戏的另一个启动目标 + 点播切换 -->
      <div class="variants-section">
        <div class="variants-head">
          <span class="label">{{ t('ed_variants') }}</span>
          <button class="mini-btn" @click="addVariant">{{ t('ed_add_variant') }}</button>
        </div>
        <div v-for="(v, i) in variants" :key="i" class="variant-row">
          <div class="variant-fields">
            <Input v-model:value="v.label" :placeholder="t('ed_ph_vlabel')" class="variant-label" />
            <Input v-model:value="v.exePath" :placeholder="t('ed_ph_exe')" class="variant-exe" />
            <button class="mini-btn" @click="pickVariantExe(v)">{{ t('common_browse') }}</button>
            <button class="mini-btn danger" @click="removeVariant(i)">×</button>
          </div>
          <Input v-model:value="v.preLaunchCmd" :placeholder="t('ed_ph_vpre')" />
        </div>
        <div class="field-row">
          <span class="label hint">{{ t('ed_variant_hint') }}</span>
        </div>
      </div>

      <label class="field">
        <span class="label">{{ t('ed_lb_desc') }}</span>
        <Input.TextArea v-model:value="description" :rows="4" :placeholder="t('ed_ph_desc')" />
      </label>
      <div class="actions">
        <button class="btn ghost" @click="open = false">{{ t('common_cancel') }}</button>
        <button class="btn primary" @click="save">{{ t('common_save') }}</button>
      </div>
    </div>
  </DialogShell>
</template>

<style scoped>
.edit-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding-top: 4px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.field-row {
  display: flex;
  gap: 16px;
}
.field-row .field {
  flex: 1;
}
.label {
  font-size: 12.5px;
  color: var(--hh-color-text-dim-strong);
}
/* G13+G17 变体编辑区 */
.variants-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.variants-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.variant-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border: 1px solid var(--hh-color-card-border);
  border-radius: var(--hh-radius-md);
  background: var(--hh-color-surface-soft);
}
.variant-fields {
  display: flex;
  gap: 6px;
  align-items: center;
}
.variant-label {
  width: 150px;
  flex-shrink: 0;
}
.variant-exe {
  flex: 1;
  min-width: 0;
}
/* 主启动路径行：输入 + 浏览并排 */
.exe-row {
  display: flex;
  gap: 6px;
  align-items: center;
}
.exe-main {
  flex: 1;
  min-width: 0;
}
.mini-btn {
  height: 30px;
  padding: 0 10px;
  border: 1px solid var(--hh-color-card-border);
  border-radius: var(--hh-radius-sm);
  background: var(--hh-color-surface-bright);
  color: var(--hh-color-text-mid-high);
  font-size: 12.5px;
  cursor: pointer;
  white-space: nowrap;
  font-family: inherit;
  transition: background var(--hh-motion-med);
}
.mini-btn:hover {
  background: var(--hh-color-surface-mid);
  color: var(--hh-color-text-glow);
}
.mini-btn.danger {
  color: var(--hh-color-danger-text);
}
.hint {
  font-size: 11.5px;
  color: var(--hh-color-text-dim);
  line-height: 1.5;
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 6px;
}
.btn {
  height: 34px;
  padding: 0 18px;
  border-radius: var(--hh-radius-sm);
  font-size: var(--hh-font-body-size);
  cursor: pointer;
  border: none;
}
.btn.primary {
  background: var(--hh-color-accent);
  color: var(--hh-color-on-accent);
  font-weight: 600;
}
.btn.ghost {
  background: var(--hh-color-surface-soft);
  border: 1px solid var(--hh-color-border-ghost-soft);
  color: var(--hh-color-text-strong);
}
</style>
