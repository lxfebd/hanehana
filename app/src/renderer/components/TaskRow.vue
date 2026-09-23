<script setup lang="ts">
/**
 * 任务行（REDESIGN-SPEC §5.5 Motrix 化）：
 *   - 高 64，card 材质，margin-bottom 8，radius 12
 *   - 左：状态色点 4px 竖条 + 状态图标 16
 *   - 中：name 13 单行 + sub caption mono（速度·剩余·区间 / 错误行 / 完成信息）
 *   - 右：pct 13 mono + 自绘状态 chip（dot+label，替 antd Tag）
 *   - 进度条 absolute 行底 3px，下载中带流光（1.2s linear infinite）
 *   - hover 右上浮现 3 图标按钮（暂停或继续 / 文件夹 / 删除）167ms fade
 */
import { computed, type Component } from 'vue'
import {
  CircleCheck,
  CircleDot,
  CirclePause,
  CircleX,
  FolderOpen,
  Loader2,
  Pause,
  Play,
  RotateCw,
  ShieldCheck,
  Timer,
  Trash2,
} from 'lucide-vue-next'
import type { TaskDef, TaskSnapshot, TaskState } from '../../shared/types'
import { dirName, fileName, fmtEta, fmtRange, fmtSize, fmtSpeed, fmtTime } from '../../shared/format'
import { errorLine } from '../../shared/errors'
import { percentText, progressRatio, statusBadge, totalBytes } from '../status'

const props = defineProps<{
  def: TaskDef
  snap: TaskSnapshot | null
  selected: boolean
}>()

const emit = defineEmits<{
  select: []
  action: [action: string]
}>()

/** 引擎没启动过的任务 snap 为空，必须回落到 def.state，否则已完成的任务会画成排队中。 */
const state = computed<TaskState>(() => props.snap?.state ?? (props.def.state || 'queued'))

const checksumAlg = computed(() => (props.def.checksum || '').split(':')[0])
const verifiedDone = computed(() => state.value === 'done' && !!props.def.checksum)
const verifyTip = computed(() => (verifiedDone.value ? `已按 ${checksumAlg.value} 校验通过` : ''))

const icon: Component = computed(() => {
  if (state.value === 'downloading') return Loader2
  if (state.value === 'preparing') return Timer
  if (state.value === 'done') return verifiedDone.value ? ShieldCheck : CircleCheck
  if (state.value === 'error') return CircleX
  if (state.value === 'paused') return CirclePause
  return CircleDot
})

const name = computed(() => fileName(props.def.dest) || props.def.url)
const dir = computed(() => dirName(props.def.dest))

const segN = computed(() => props.snap?.segments.length || props.snap?.threads || props.def.threads)
const total = computed(() => totalBytes(props.snap, props.def.total))
const downloaded = computed(() => props.snap?.downloaded ?? props.def.downloaded ?? 0)
const finishedAt = computed(() => props.snap?.finished_at || props.def.finished_at)
const verifying = computed(() => props.snap?.verifying === true)
const sizeKnown = computed(() => total.value > 0)
const ratio = computed(() => progressRatio(props.snap, props.def))
const pctText = computed(() => percentText(ratio.value))
const pct = computed(() => Math.round((ratio.value ?? 0) * 100))
const badge = computed(() => statusBadge(state.value, props.snap, props.def))
const indeterminate = computed(
  () => !sizeKnown.value && !verifying.value && (state.value === 'downloading' || state.value === 'preparing'),
)

/**
 * 当前该显示的那条错误。原文和码必须取自同一份记录：混着取（快照的原文 +
 * 落盘定义的码）会在「重试后快照已清空、tasks.json 还没落盘」的窗口里
 * 把新错误配上旧病因。
 */
const err = computed(() => {
  const s = props.snap
  if (s?.error) return { raw: s.error, code: s.error_code, params: s.error_params }
  return { raw: props.def.error, code: props.def.error_code ?? '', params: props.def.error_params ?? null }
})

const sub = computed(() => {
  const got = fmtSize(downloaded.value)
  const range = sizeKnown.value ? fmtRange(downloaded.value, total.value) : `已下 ${got}`
  if (state.value === 'done') {
    const size = sizeKnown.value ? fmtSize(total.value) : got
    return finishedAt.value ? `${size} · 完成于 ${fmtTime(finishedAt.value)}` : `${size} · ${segN.value} 线程`
  }
  if (state.value === 'error') {
    return errorLine(err.value.raw, err.value.code, err.value.params) || '下载失败'
  }
  if (state.value === 'downloading' || state.value === 'preparing') {
    const s = props.snap
    const warn = s?.error ? ` · ${errorLine(s.error, s.error_code, s.error_params)}` : ''
    if (verifying.value) return `已下完 ${got} · 正在核对校验和`
    if (!sizeKnown.value) return `大小未知 · ${fmtSpeed(s?.speed ?? 0)} · 已下 ${got}${warn}`
    return `${fmtSpeed(s?.speed ?? 0)} · 剩余 ${fmtEta(s?.eta ?? 0)} · ${range}${warn}`
  }
  return `${range} · ${segN.value} 线程`
})

const canStart = computed(() => ['queued', 'paused', 'error', 'idle', 'cancelled'].includes(state.value))
const canPause = computed(() => state.value === 'downloading' || state.value === 'preparing')
const canOpen = computed(() => true)
const needsRetry = computed(() => state.value === 'done')
const primaryAction = computed(() => (needsRetry.value ? 'retry' : 'start'))
const primaryTitle = computed(() => {
  if (state.value === 'done') return '重新下载（会清掉现有文件）'
  if (state.value === 'error' || state.value === 'cancelled') return '继续下载（从断点续传）'
  if (state.value === 'paused') return '恢复下载'
  return '开始下载'
})

/** 状态色点颜色（真值在 tokens，经 CSS 变量引用） */
const dotColor = computed(() => {
  switch (state.value) {
    case 'downloading': return 'var(--hh-color-accent)'
    case 'preparing': return 'var(--hh-color-warning)'
    case 'done': return 'var(--hh-color-success)'
    case 'error': return 'var(--hh-color-error)'
    case 'paused': return 'var(--hh-color-neutral)'
    default: return 'var(--hh-color-neutral-dim)'
  }
})

/** 自绘状态 chip 颜色（dot+label） */
const chipTone = computed(() => {
  switch (badge.value.tone) {
    case 'success': return { dot: 'var(--hh-color-success)', text: 'var(--hh-color-success-text)' }
    case 'error': return { dot: 'var(--hh-color-error)', text: 'var(--hh-color-error-text)' }
    case 'warning': return { dot: 'var(--hh-color-warning)', text: 'var(--hh-color-warning)' }
    case 'blue': return { dot: 'var(--hh-color-accent)', text: 'var(--hh-color-accent-text)' }
    default: return { dot: 'var(--hh-color-neutral)', text: 'var(--hh-color-text-mid-high)' }
  }
})
</script>

<template>
  <div class="task-row" :class="{ selected, [state]: true }" @click="emit('select')">
    <span class="dot" :style="{ background: dotColor }"></span>

    <span class="cell-ic" :title="verifyTip">
      <component :is="icon" :size="16" :class="{ spin: state === 'downloading' }" />
    </span>

    <div class="cell-lead" :title="dir">
      <div class="name">{{ name }}</div>
      <div class="sub">{{ sub }}</div>
    </div>

    <span class="pct">{{ pctText }}</span>

    <span class="cell-tag">
      <span class="st-chip">
        <span class="st-dot" :style="{ background: chipTone.dot }"></span>
        <span class="st-label" :style="{ color: chipTone.text }">{{ badge.label }}</span>
      </span>
    </span>

    <!-- 进度条：行底绝对定位 3px -->
    <div class="prog">
      <div v-if="indeterminate" class="bar-fill indet" />
      <div
        v-else
        class="bar-fill"
        :class="{ full: pct >= 100 && !verifying, moving: state === 'downloading' }"
        :style="{ width: pct + '%' }"
      />
    </div>

    <span class="cell-actions">
      <button
        v-if="needsRetry"
        class="ibtn"
        title="重新下载（会清掉现有进度）"
        @click.stop="emit('action', 'retry')"
      >
        <RotateCw :size="14" />
      </button>
      <button v-else class="ibtn" :disabled="!canStart" :title="primaryTitle" @click.stop="emit('action', primaryAction)">
        <Play :size="14" :fill="'currentColor'" />
      </button>
      <button class="ibtn" :disabled="!canPause" title="暂停" @click.stop="emit('action', 'pause')">
        <Pause :size="14" :fill="'currentColor'" />
      </button>
      <button class="ibtn" :disabled="!canOpen" title="打开所在文件夹" @click.stop="emit('action', 'open')">
        <FolderOpen :size="14" />
      </button>
      <button class="ibtn danger" title="移除任务（可选连文件一起删）" @click.stop="emit('action', 'remove')">
        <Trash2 :size="14" />
      </button>
    </span>
  </div>
</template>

<style scoped>
.task-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  height: 64px;
  padding: 0 16px 0 12px;
  border-radius: 12px;
  margin-bottom: 8px;
  background: var(--hh-color-card);
  border: 1px solid var(--hh-color-card-border);
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
  overflow: hidden;
  box-sizing: border-box;
}
.task-row:hover {
  background: var(--hh-color-card-hover);
  border-color: var(--hh-color-surface-strong);
  box-shadow: var(--hh-shadow-row-hover);
}
.task-row.selected {
  background: var(--hh-color-accent-selected-bg);
  border-color: var(--hh-color-accent-selected-border);
}

/* 状态色点：左缘 4px 竖条 */
.dot {
  flex: none;
  width: 4px;
  align-self: stretch;
  border-radius: 2px;
  opacity: 0.85;
}
.task-row.downloading .dot {
  animation: dot-pulse 1.6s ease-in-out infinite;
}
@keyframes dot-pulse {
  0%, 100% { opacity: 0.45; }
  50% { opacity: 1; }
}

.cell-ic {
  flex: none;
  width: 26px;
  text-align: center;
  color: var(--hh-color-text-dim);
  display: flex;
  align-items: center;
  justify-content: center;
}
.cell-ic .spin { animation: ic-spin 1s linear infinite; }
@keyframes ic-spin {
  to { transform: rotate(360deg); }
}
/* 状态图标配色：真值在 tokens（--hh-color-*），状态类挂在 .task-row 根上 */
.task-row.downloading .cell-ic,
.task-row.preparing .cell-ic { color: var(--hh-color-accent); }
.task-row.done .cell-ic { color: var(--hh-color-success); }
.task-row.error .cell-ic { color: var(--hh-color-error); }

.cell-lead {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.name {
  font-size: 13px;
  font-weight: 500;
  line-height: 20px;
  color: var(--hh-color-text-glow);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sub {
  font-size: 12px;
  line-height: 18px;
  color: var(--hh-color-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
  font-variant-numeric: tabular-nums;
}

.pct {
  flex: none;
  min-width: 44px;
  text-align: right;
  font-size: 13px;
  font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
  font-variant-numeric: tabular-nums;
  color: var(--hh-color-text-bright);
}

/* 自绘状态 chip */
.cell-tag { flex: none; }
.st-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 22px;
  padding: 0 9px;
  border-radius: 999px;
  background: var(--hh-color-surface-mid);
  white-space: nowrap;
}
.st-dot {
  width: 6px; height: 6px;
  border-radius: 50%;
  flex: none;
}
.st-label {
  font-size: 11px;
  line-height: 1;
}

/* 进度条：absolute 行底 */
.prog {
  position: absolute;
  left: 12px; right: 12px; bottom: 0;
  height: 3px;
  border-radius: 2px;
  overflow: hidden;
  background: var(--hh-color-surface-mid);
}
.bar-fill {
  position: absolute;
  top: 0; left: 0; bottom: 0;
  background: linear-gradient(90deg, var(--hh-color-accent-grad-stop), var(--hh-color-accent));
  transition: width 0.15s linear;
  overflow: hidden;
}
.bar-fill.moving::after {
  content: '';
  position: absolute; inset: 0;
  background: linear-gradient(100deg, transparent 30%, var(--hh-color-shine-sweep) 50%, transparent 70%);
  transform: translateX(-100%);
  animation: bar-shine 1.2s linear infinite;
}
@keyframes bar-shine {
  to { transform: translateX(100%); }
}
.bar-fill.full {
  background: linear-gradient(90deg, var(--hh-color-success-deep), var(--hh-color-success));
}
.bar-fill.indet {
  width: 35%;
  animation: indet-slide 1.3s ease-in-out infinite alternate;
}
@keyframes indet-slide {
  from { transform: translateX(-20%); }
  to { transform: translateX(310%); }
}

/* hover 右上浮现操作按钮 */
.cell-actions {
  flex: none;
  display: flex;
  justify-content: flex-end;
  gap: 2px;
  opacity: 0;
  transition: opacity 0.167s ease;
}
.task-row:hover .cell-actions,
.task-row.selected .cell-actions,
.task-row .cell-actions:focus-within {
  opacity: 1;
}
.ibtn {
  width: 26px;
  height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--hh-color-text-mid);
  cursor: pointer;
  font-size: 14px;
  padding: 0;
  transition: background 0.15s, color 0.15s;
}
.ibtn:hover:not(:disabled) {
  background: var(--hh-color-surface-hover);
  color: var(--hh-color-text-hot);
}
.ibtn:disabled {
  color: var(--hh-color-text-ghost);
  cursor: not-allowed;
}
.ibtn.danger:hover:not(:disabled) {
  color: var(--hh-color-error);
  background: var(--hh-color-error-hover-bg);
}
</style>