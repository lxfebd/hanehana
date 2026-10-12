<script setup lang="ts">
/**
 * 手动添加游戏（T25）：选一个 exe 直接入库，不走目录扫描。
 * 主进程 handleAddOne 会校验文件存在、按 exe 去重，返回 { ok, game } 或 { ok:false, error }。
 */
import { computed, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import DialogShell from './DialogShell.vue'
import { refreshGames } from '../stores/library'
import { t, tf } from '../i18n'

const open = defineModel<boolean>('open')
const exePath = ref('')
const adding = ref(false)

// 重开时清空上次路径，避免旧值残留
watch(open, (on) => {
  if (on) {
    exePath.value = ''
    adding.value = false
  }
})

/** 从路径猜一个默认标题：去掉扩展名的文件名 */
const guessedTitle = computed(() => {
  const p = exePath.value.trim()
  if (!p) return ''
  const name = p.split(/[\\/]/).pop() ?? p
  return name.replace(/\.[^.]+$/, '')
})

async function pickExe(): Promise<void> {
  const p = await window.hh.pickExe()
  if (p) exePath.value = p
}

async function addOne(): Promise<void> {
  const p = exePath.value.trim()
  if (!p) {
    message.warning(t('add_exe_missing'))
    return
  }
  adding.value = true
  try {
    const r = await window.hh.addGameOne(p)
    if (!r.ok) {
      message.error(r.error || t('add_failed'))
    } else {
      message.success(tf('add_ok', { title: r.game?.title ?? guessedTitle.value }))
      open.value = false
      await refreshGames()
    }
  } catch (e) {
    message.error(tf('add_failed_detail', { msg: e instanceof Error ? e.message : String(e) }))
  } finally {
    adding.value = false
  }
}
</script>

<template>
  <DialogShell v-model:open="open" :title="t('add_title')" :width="480">
    <div class="add-body">
      <div class="row">
        <input v-model="exePath" class="path-input" :placeholder="t('add_exe_ph')" @keyup.enter="addOne" />
        <button class="add-btn ghost" @click="pickExe">{{ t('common_browse') }}…</button>
        <button class="add-btn" :disabled="adding || !exePath.trim()" @click="addOne">
          {{ adding ? t('add_adding') : t('add_add') }}
        </button>
      </div>

      <div v-if="guessedTitle" class="preview">
        <div class="preview-title">{{ t('add_preview') }}</div>
        <div class="preview-name">{{ guessedTitle }}</div>
        <div class="preview-path">{{ exePath }}</div>
      </div>

      <div class="hint">{{ t('add_hint') }}</div>
    </div>
  </DialogShell>
</template>

<style scoped>
.add-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.row {
  display: flex;
  gap: 8px;
}
.path-input {
  flex: 1;
  height: 38px;
  border-radius: var(--hh-radius-md);
  padding: 0 14px;
  border: 1px solid var(--hh-color-border-ghost-soft);
  background: var(--hh-color-surface-soft);
  color: var(--hh-color-text-strong);
  font-size: var(--hh-font-body-size);
  outline: none;
}
.add-btn {
  height: 38px;
  padding: 0 20px;
  border: none;
  border-radius: var(--hh-radius-md);
  background: var(--hh-color-accent);
  color: var(--hh-color-on-accent);
  font-weight: 600;
  font-size: var(--hh-font-body-size);
  cursor: pointer;
}
.add-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.add-btn.ghost {
  background: transparent;
  border: 1px solid var(--hh-color-border-ghost-soft);
  color: var(--hh-color-text-strong);
  font-weight: 400;
}
.preview {
  border: 1px solid var(--hh-color-panel-glass-border);
  border-radius: var(--hh-radius-md);
  padding: 10px 12px;
}
.preview-title {
  font-size: var(--hh-font-caption-size);
  color: var(--hh-color-text-soft);
  margin-bottom: 6px;
}
.preview-name {
  font-size: var(--hh-font-bodyLg-size);
  font-weight: 600;
  color: var(--hh-color-text-stronger);
}
.preview-path {
  font-size: var(--hh-font-caption-size);
  color: var(--hh-color-text-dim);
  margin-top: 4px;
  word-break: break-all;
}
.hint {
  font-size: var(--hh-font-caption-size);
  color: var(--hh-color-text-dim);
}
</style>
