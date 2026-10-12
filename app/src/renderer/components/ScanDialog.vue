<script setup lang="ts">
import { ref, watch } from 'vue'
import DialogShell from './DialogShell.vue'
import { refreshGames, startBatchScrape } from '../stores/library'
import { t, tf } from '../i18n'

const open = defineModel<boolean>('open')
const dir = ref('')
const scanning = ref(false)
const result = ref('')
const scanError = ref(false)
const picked = ref<{ dir: string; exePath: string; rawTitle: string }[]>([])

// 重开时清空上次结果，避免旧命列表/旧提示残留
watch(open, (on) => {
  if (on) {
    result.value = ''
    scanError.value = false
    picked.value = []
  }
})

async function runScan(): Promise<void> {
  if (!dir.value) return
  scanning.value = true
  result.value = ''
  scanError.value = false
  picked.value = []
  try {
    const r = await window.hh.scanDir(dir.value)
    if (r && 'ok' in r && r.ok === false) {
      scanError.value = true
      result.value = tf('scan_failed', { msg: r.error })
      return
    }
    if (!r || !('hits' in r)) {
      scanError.value = true
      result.value = t('scan_bad_result')
      return
    }
    picked.value = r.hits
    result.value = tf('scan_done', { found: r.hits.length, added: r.added.length, skip: r.skipped })
    await refreshGames()
    // 新入库且还没有封面的：直接自动批量刮削（VNDB/Bangumi），不等用户再点
    const noCover = r.added.filter((g) => !g.coverPath).map((g) => g.id)
    if (noCover.length > 0) {
      void startBatchScrape(noCover)
    }
  } catch (e) {
    scanError.value = true
    result.value = tf('scan_failed', { msg: e instanceof Error ? e.message : String(e) })
  } finally {
    scanning.value = false
  }
}

async function pickDir(): Promise<void> {
  const p = await window.hh.pickDir()
  if (p) dir.value = p
}
</script>

<template>
  <DialogShell v-model:open="open" :title="t('scan_title')" :width="480">
    <div class="scan-body">
      <div class="row">
        <input v-model="dir" class="path-input" :placeholder="t('scan_ph')" @keyup.enter="runScan" />
        <button class="scan-btn ghost" @click="pickDir">{{ t('common_browse') }}…</button>
        <button class="scan-btn" :disabled="scanning" @click="runScan">
          {{ scanning ? t('scan_scanning') : t('scan_start') }}
        </button>
      </div>

      <div v-if="result" class="result" :class="{ error: scanError }">{{ result }}</div>

      <div v-if="picked.length" class="hits">
        <div class="hits-title">{{ t('scan_hits') }}</div>
        <div v-for="h in picked.slice(0, 30)" :key="h.exePath" class="hit-row">
          <span class="hit-name">{{ h.rawTitle }}</span>
          <span class="hit-path">{{ h.exePath }}</span>
        </div>
        <div v-if="picked.length > 30" class="hits-more">{{ tf('scan_more', { n: picked.length - 30 }) }}</div>
      </div>

      <div class="hint">{{ t('scan_hint') }}</div>
    </div>
  </DialogShell>
</template>

<style scoped>
.scan-body {
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
.scan-btn {
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
.scan-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.scan-btn.ghost {
  background: transparent;
  border: 1px solid var(--hh-color-border-ghost-soft);
  color: var(--hh-color-text-strong);
  font-weight: 400;
}
.result {
  font-size: var(--hh-font-body-size);
  color: var(--hh-color-success);
}
.result.error {
  color: var(--hh-color-error);
}
.hits {
  max-height: 260px;
  overflow-y: auto;
  border: 1px solid var(--hh-color-panel-glass-border);
  border-radius: var(--hh-radius-md);
  padding: 10px 12px;
}
.hits-title {
  font-size: var(--hh-font-caption-size);
  color: var(--hh-color-text-soft);
  margin-bottom: 8px;
}
.hit-row {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  font-size: 12.5px;
  padding: 4px 0;
  border-bottom: 1px solid var(--hh-color-border-faint);
}
.hit-name {
  color: var(--hh-color-text-stronger);
  white-space: nowrap;
}
.hit-path {
  color: var(--hh-color-text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hits-more {
  font-size: var(--hh-font-caption-size);
  color: var(--hh-color-text-dim);
  padding-top: 6px;
}
.hint {
  font-size: var(--hh-font-caption-size);
  color: var(--hh-color-text-dim);
}
</style>
