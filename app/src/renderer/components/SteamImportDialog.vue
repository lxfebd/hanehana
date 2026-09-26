<script setup lang="ts">
/**
 * Steam 库导入对话框（G4）。
 *  - 「扫描 Steam 库」→ 主进程读 libraryfolders.vdf + appmanifest.acf
 *  - 候选列出（官方名 + 路径 + appid），勾选后批量导入
 */
import { ref } from 'vue'
import { Modal } from 'ant-design-vue'
import { RefreshCw } from 'lucide-vue-next'
import { refreshGames } from '../stores/library'
import type { SteamCandidate } from '../../shared/types'

const open = defineModel<boolean>('open')
const scanning = ref(false)
const candidates = ref<SteamCandidate[]>([])
const picked = ref<Set<string>>(new Set())
const result = ref('')
const error = ref(false)
const importing = ref(false)

async function runScan(): Promise<void> {
  scanning.value = true
  result.value = ''
  error.value = false
  candidates.value = []
  picked.value = new Set()
  try {
    const list = await window.hh.steamScan()
    candidates.value = list
    // 默认全选
    picked.value = new Set(list.map((c) => c.exePath))
    result.value = list.length ? `找到 ${list.length} 款未入库的 Steam 游戏` : '未找到新的 Steam 游戏（已导入过的会自动跳过）'
  } catch (e) {
    error.value = true
    result.value = e instanceof Error ? e.message : String(e)
  } finally {
    scanning.value = false
  }
}

function toggle(p: string): void {
  const n = new Set(picked.value)
  if (n.has(p)) n.delete(p)
  else n.add(p)
  picked.value = n
}

function isPicked(c: SteamCandidate): boolean {
  return picked.value.has(c.exePath)
}

async function doImport(): Promise<void> {
  const sel = candidates.value.filter((c) => picked.value.has(c.exePath))
  if (!sel.length) return
  importing.value = true
  try {
    // 解包成 plain object 再跨 IPC:Vue reactive proxy 含不可克隆内部槽,structured clone 会炸
    const r = await window.hh.steamImport(
      sel.map((c) => ({ dir: c.dir, exePath: c.exePath, rawTitle: c.rawTitle, appid: c.appid })),
    )
    result.value = `已导入 ${r.added} 款（跳过 ${r.skipped} 款已有）`
    candidates.value = []
    picked.value = new Set()
    await refreshGames()
  } catch (e) {
    error.value = true
    result.value = e instanceof Error ? e.message : String(e)
  } finally {
    importing.value = false
  }
}
</script>

<template>
  <Modal v-model:open="open" :footer="null" width="560" :centered="true" title="从 Steam 导入">
    <div class="steam-body">
      <div class="row">
        <button class="scan-btn" :disabled="scanning" @click="runScan">
          <RefreshCw :size="14" :class="{ spin: scanning }" /> {{ scanning ? '扫描中…' : '扫描 Steam 库' }}
        </button>
        <span class="hint">自动读取 Steam 安装目录的 libraryfolders.vdf 与 appmanifest</span>
      </div>

      <div v-if="result" class="result" :class="{ error }">{{ result }}</div>

      <div v-if="candidates.length" class="cands">
        <div class="cands-title">勾选要入库的游戏（{{ picked.size }}/{{ candidates.length }}）：</div>
        <div class="cand-list">
          <label v-for="c in candidates" :key="c.exePath" class="cand-row">
            <input type="checkbox" :checked="isPicked(c)" @change="toggle(c.exePath)" />
            <span class="cand-name">{{ c.rawTitle }}</span>
            <span v-if="c.appid" class="cand-appid">steam {{ c.appid }}</span>
            <span class="cand-path">{{ c.dir }}</span>
          </label>
        </div>
        <button class="scan-btn primary" :disabled="importing || !picked.size" @click="doImport">
          {{ importing ? '导入中…' : `导入所选（${picked.size}）` }}
        </button>
      </div>
    </div>
  </Modal>
</template>

<style scoped>
.steam-body { display: flex; flex-direction: column; gap: 14px; }
.row { display: flex; align-items: center; gap: 10px; }
.hint { font-size: var(--hh-font-caption-size); color: var(--hh-color-text-tertiary); }
.scan-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 34px;
  padding: 0 16px;
  border-radius: var(--hh-radius-sm);
  border: 1px solid var(--hh-color-border-ghost-soft);
  background: var(--hh-color-surface-soft);
  color: var(--hh-color-text-strong);
  font-size: var(--hh-font-body-size);
  cursor: pointer;
}
.scan-btn:hover { background: var(--hh-color-surface-mid); }
.scan-btn:disabled { opacity: 0.5; cursor: default; }
.scan-btn.primary {
  border: none;
  background-image: var(--hh-color-accent-grad);
  color: var(--hh-color-on-accent);
  font-weight: 600;
  align-self: flex-start;
}
.spin { animation: ic-spin 1s linear infinite; }
@keyframes ic-spin { to { transform: rotate(360deg); } }
.result { font-size: var(--hh-font-body-size); color: var(--hh-color-success-text); }
.result.error { color: var(--hh-color-error-text); }
.cands { display: flex; flex-direction: column; gap: 10px; }
.cands-title { font-size: var(--hh-font-body-size); color: var(--hh-color-text-strong); }
.cand-list {
  max-height: 280px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.cand-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 10px;
  border-radius: var(--hh-radius-sm);
  cursor: pointer;
  font-size: var(--hh-font-body-size);
}
.cand-row:hover { background: var(--hh-color-surface-soft); }
.cand-name { font-weight: 500; color: var(--hh-color-text-glow); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 200px; }
.cand-appid { font-size: 11px; color: var(--hh-color-accent-text); background: var(--hh-color-accent-bg); padding: 1px 7px; border-radius: var(--hh-radius-xs); flex: none; }
.cand-path { font-size: 11px; color: var(--hh-color-text-tertiary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-left: auto; max-width: 180px; }
</style>