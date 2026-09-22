<script setup lang="ts">
import { ref } from 'vue'
import { Modal } from 'ant-design-vue'
import { refreshGames } from '../store'

const open = defineModel<boolean>('open')
const dir = ref('')
const scanning = ref(false)
const result = ref('')
const picked = ref<{ dir: string; exePath: string; rawTitle: string }[]>([])

async function runScan(): Promise<void> {
  if (!dir.value) return
  scanning.value = true
  result.value = ''
  picked.value = []
  try {
    const r = await window.hh.scanDir(dir.value)
    picked.value = r.hits
    result.value = `扫描完成：发现 ${r.hits.length} 个游戏目录，新入库 ${r.added.length} 个（跳过 ${r.skipped} 个已有）`
    await refreshGames()
  } catch (e) {
    result.value = `扫描失败：${e instanceof Error ? e.message : String(e)}`
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
  <Modal v-model:open="open" :footer="null" width="640" :centered="true" title="扫描导入游戏">
    <div class="scan-body">
      <div class="row">
        <input v-model="dir" class="path-input" placeholder="游戏目录，如 D:\Games" @keyup.enter="runScan" />
        <button class="scan-btn ghost" @click="pickDir">浏览…</button>
        <button class="scan-btn" :disabled="scanning" @click="runScan">
          {{ scanning ? '扫描中…' : '开始扫描' }}
        </button>
      </div>

      <div v-if="result" class="result">{{ result }}</div>

      <div v-if="picked.length" class="hits">
        <div class="hits-title">发现的可执行文件（同目录 exe 已自动合并）：</div>
        <div v-for="h in picked.slice(0, 30)" :key="h.exePath" class="hit-row">
          <span class="hit-name">{{ h.rawTitle }}</span>
          <span class="hit-path">{{ h.exePath }}</span>
        </div>
        <div v-if="picked.length > 30" class="hits-more">… 还有 {{ picked.length - 30 }} 个</div>
      </div>

      <div class="hint">扫描会递归查找目录下所有 .exe/.bat/.lnk，自动排除汉化补丁、安装器等工具文件。</div>
    </div>
  </Modal>
</template>

<style scoped>
.scan-body { display: flex; flex-direction: column; gap: 14px; }
.row { display: flex; gap: 8px; }
.path-input {
  flex: 1;
  height: 38px;
  border-radius: 10px;
  padding: 0 14px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  background: rgba(255, 255, 255, 0.06);
  color: #fff;
  font-size: 13px;
  outline: none;
}
.scan-btn {
  height: 38px; padding: 0 20px;
  border: none;
  border-radius: 10px;
  background: linear-gradient(135deg, #4096ff, #2f6fed);
  color: #fff; font-weight: 600; font-size: 13px;
  cursor: pointer;
}
.scan-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.scan-btn.ghost {
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.16);
  color: rgba(255, 255, 255, 0.8);
  font-weight: 400;
}
.result { font-size: 13px; color: #7ed36a; }
.hits {
  max-height: 260px;
  overflow-y: auto;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 10px;
  padding: 10px 12px;
}
.hits-title { font-size: 12px; color: rgba(255, 255, 255, 0.5); margin-bottom: 8px; }
.hit-row {
  display: flex; justify-content: space-between; gap: 10px;
  font-size: 12.5px;
  padding: 4px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}
.hit-name { color: rgba(255, 255, 255, 0.85); white-space: nowrap; }
.hit-path { color: rgba(255, 255, 255, 0.4); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hits-more { font-size: 12px; color: rgba(255, 255, 255, 0.4); padding-top: 6px; }
.hint { font-size: 12px; color: rgba(255, 255, 255, 0.4); }
</style>