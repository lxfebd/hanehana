<script setup lang="ts">
/**
 * 手动编辑单游戏信息（G7）。
 *  - 覆盖 title/titleNative/description/releaseDate/rating/tags/categories
 *  - 保存时标记 manualEdit=true：刮削不再覆盖用户手填字段（scraper.ts 里读它）
 *  - 弹窗内用 antd Input/InputNumber/Select（tags 用 mode=tags）
 */
import { ref, watch } from 'vue'
import { Input, InputNumber, Modal, Select } from 'ant-design-vue'
import { library, saveManualEdit } from '../stores/library'
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
    library.error = '标题不能为空'
    return
  }
  if (rating.value !== undefined && rating.value !== null && (Number.isNaN(rating.value) || rating.value < 0 || rating.value > 10)) {
    library.error = '评分需在 0 – 10 之间'
    return
  }
  const rd = releaseDate.value.trim()
  if (rd && !/^\d{4}-\d{2}-\d{2}$/.test(rd)) {
    library.error = '发行日期格式应为 yyyy-mm-dd'
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
  <Modal v-model:open="open" :footer="null" width="560" :centered="true" title="编辑游戏信息">
    <div class="edit-body">
      <label class="field">
        <span class="label">标题</span>
        <Input v-model:value="title" placeholder="主标题" />
      </label>
      <div class="field">
        <span class="label">启动路径</span>
        <div class="exe-row">
          <Input v-model:value="exePath" placeholder="启动 exe 绝对路径" class="exe-main" />
          <button type="button" class="mini-btn" @click="pickMainExe">浏览</button>
        </div>
        <span class="hint">文件被移动/改名后启动会报「文件不存在」——在这里重新指向存在的 exe 即可修复</span>
      </div>
      <label class="field">
        <span class="label">原文名</span>
        <Input v-model:value="titleNative" placeholder="日文原名（可选）" />
      </label>
      <label class="field">
        <span class="label">发行日期</span>
        <Input v-model:value="releaseDate" placeholder="yyyy-mm-dd（可选）" />
      </label>
      <label class="field">
        <span class="label">开发商</span>
        <Input v-model:value="developer" placeholder="开发/制作公司（可选）" />
      </label>
      <div class="field-row">
        <label class="field">
          <span class="label">评分</span>
          <InputNumber v-model:value="rating" :min="0" :max="10" :step="0.1" :precision="1" style="width: 120px" />
        </label>
        <label class="field">
          <span class="label">通关时长（分钟）</span>
          <InputNumber v-model:value="lengthMinutes" :min="0" :max="100000" :step="30" style="width: 140px" />
        </label>
      </div>
      <label class="field">
        <span class="label">系列</span>
        <Select v-model:value="series" mode="tags" placeholder="所属系列（可选）" :open="false" />
      </label>
      <label class="field">
        <span class="label">别名</span>
        <Select v-model:value="aliases" mode="tags" placeholder="别名（可选）" :open="false" />
      </label>
      <label class="field">
        <span class="label">标签</span>
        <Select v-model:value="tags" mode="tags" placeholder="回车添加标签" :open="false" />
      </label>
      <label class="field">
        <span class="label">分类</span>
        <Select v-model:value="categories" mode="tags" placeholder="回车添加分类" :open="false" />
      </label>
      <label class="field">
        <span class="label">启动前命令</span>
        <Input v-model:value="preLaunchCmd" placeholder="留空＝直接启动。如: D:\tools\enable_patch.cmd {dir}" />
      </label>
      <label class="field">
        <span class="label">启动后命令</span>
        <Input v-model:value="postLaunchCmd" placeholder="留空＝不挂接。如: D:\tools\LunaTranslator.exe" />
      </label>
      <div class="field-row">
        <span class="label hint">占位符：{exe} = 游戏 exe 路径，{dir} = 游戏目录；命令按空格拆分，含空格路径用双引号包裹</span>
      </div>

      <!-- G13+G17 多版本/语言包：同一游戏的另一个启动目标 + 点播切换 -->
      <div class="variants-section">
        <div class="variants-head">
          <span class="label">版本 / 语言包</span>
          <button class="mini-btn" @click="addVariant">+ 添加变体</button>
        </div>
        <div v-for="(v, i) in variants" :key="i" class="variant-row">
          <div class="variant-fields">
            <Input v-model:value="v.label" placeholder="标签（如 汉化整合版）" class="variant-label" />
            <Input v-model:value="v.exePath" placeholder="启动 exe 绝对路径" class="variant-exe" />
            <button class="mini-btn" @click="pickVariantExe(v)">浏览</button>
            <button class="mini-btn danger" @click="removeVariant(i)">×</button>
          </div>
          <Input v-model:value="v.preLaunchCmd" placeholder="该变体专属启动前命令（可选，如先打补丁）" />
        </div>
        <div class="field-row">
          <span class="label hint">启动时若选中变体，将使用变体 exe 启动；变体专属命令在游戏级启动前命令之后执行</span>
        </div>
      </div>

      <label class="field">
        <span class="label">简介</span>
        <Input.TextArea v-model:value="description" :rows="4" placeholder="游戏简介（可选）" />
      </label>
      <div class="actions">
        <button class="btn ghost" @click="open = false">取消</button>
        <button class="btn primary" @click="save">保存</button>
      </div>
    </div>
  </Modal>
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
  border-radius: 10px;
  background: var(--hh-color-surface-soft);
}
.variant-fields {
  display: flex;
  gap: 6px;
  align-items: center;
}
.variant-label { width: 150px; flex-shrink: 0; }
.variant-exe { flex: 1; min-width: 0; }
/* 主启动路径行：输入 + 浏览并排 */
.exe-row { display: flex; gap: 6px; align-items: center; }
.exe-main { flex: 1; min-width: 0; }
.mini-btn {
  height: 30px;
  padding: 0 10px;
  border: 1px solid var(--hh-color-card-border);
  border-radius: 8px;
  background: var(--hh-color-surface-bright);
  color: var(--hh-color-text-mid-high);
  font-size: 12.5px;
  cursor: pointer;
  white-space: nowrap;
  font-family: inherit;
  transition: background 0.15s;
}
.mini-btn:hover { background: var(--hh-color-surface-mid); color: var(--hh-color-text-glow); }
.mini-btn.danger { color: var(--hh-color-danger-text); }
.hint { font-size: 11.5px; color: var(--hh-color-text-dim); line-height: 1.5; }
.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 6px;
}
.btn {
  height: 34px;
  padding: 0 18px;
  border-radius: 9px;
  font-size: 13px;
  cursor: pointer;
  border: none;
}
.btn.primary {
  background-image: var(--hh-color-accent-grad);
  color: var(--hh-color-on-accent);
  font-weight: 600;
}
.btn.ghost {
  background: var(--hh-color-surface-soft);
  border: 1px solid var(--hh-color-border-ghost-soft);
  color: var(--hh-color-text-strong);
}
</style>
