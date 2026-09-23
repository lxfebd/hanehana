<script setup lang="ts">
/**
 * 新建下载对话框：URL + 保存位置 + 分片数 + 校验和 + 备注。
 */
import { computed, reactive } from 'vue'
import { FolderOpen } from 'lucide-vue-next'
import { Button, Form, Input, InputNumber } from 'ant-design-vue'
import type { Settings } from '../../shared/types'
import { normalizeChecksum } from '../../shared/types'

const props = defineProps<{ settings: Settings }>()
const emit = defineEmits<{
  submit: [input: { url: string; dest: string; threads: number; note: string; checksum: string }]
}>()

const form = reactive({
  url: '',
  dest: props.settings.download_dir,
  threads: props.settings.threads,
  note: '',
  checksum: '',
})

/** 校验和当场判，不等主进程回错误：一串读不懂的东西存进任务，代价是十几个 GB 下完才报错。 */
const checksumError = computed(() =>
  normalizeChecksum(form.checksum) === null
    ? '读不懂这串校验和：需要 32 位（MD5）、40 位（SHA-1）或 64 位（SHA-256）十六进制，也可以写成 sha256:… 的形式'
    : '',
)

const canSubmit = computed(() => form.url.trim().length > 0 && !checksumError.value)

async function browse(): Promise<void> {
  const p = await window.hh.pickDir()
  if (p) form.dest = p
}

/** 同一次回车会经过两条路径，用原生事件对象去重，避免提交两遍。 */
let lastKeydown: Event | null = null

function submit(e?: Event): void {
  if (e && e === lastKeydown) return
  lastKeydown = e ?? null
  if (!canSubmit.value) return
  emit('submit', {
    url: form.url.trim(),
    dest: form.dest.trim(),
    threads: form.threads || props.settings.threads,
    note: form.note.trim(),
    checksum: normalizeChecksum(form.checksum) ?? '',
  })
}
</script>

<template>
  <div class="dlg">
    <div class="dlg-card">
      <Form layout="horizontal" :label-col="{ style: { width: 84 } }" :wrapper-col="{ flex: 1 }" @keydown.enter="submit">
        <Form.Item label="下载链接" required>
          <Input
            v-model:value="form.url"
            placeholder="https://example.com/file.zip"
            class="mono"
            allow-clear
            @press-enter="submit"
          />
        </Form.Item>

        <Form.Item label="保存到">
          <div class="row">
            <Input v-model:value="form.dest" class="mono" />
            <Button @click="browse">
              <template #icon><FolderOpen :size="14" /></template>
              浏览
            </Button>
          </div>
        </Form.Item>

        <Form.Item label="分片数">
          <div class="row">
            <InputNumber v-model:value="form.threads" :min="1" :max="32" style="width: 90px" />
            <span class="hint">越多越快，但小文件与不支持 Range 的站点会自动降为 1</span>
          </div>
        </Form.Item>

        <Form.Item label="校验和" :validate-status="checksumError ? 'error' : ''">
          <div class="cs-wrap">
            <Input
              v-model:value="form.checksum"
              placeholder="可选：粘贴站点给的 md5 / sha1 / sha256"
              class="mono"
              allow-clear
            />
            <span v-if="checksumError" class="cs-error">{{ checksumError }}</span>
            <span v-else class="hint">留空 = 不校验。只贴十六进制串也能认，按长度判断算法。</span>
          </div>
        </Form.Item>

        <Form.Item label="备注">
          <Input v-model:value="form.note" placeholder="可选" />
        </Form.Item>
      </Form>
    </div>

    <div class="dlg-foot">
      <Button @click="submit" :disabled="!canSubmit" type="primary">开始下载</Button>
    </div>
  </div>
</template>

<style scoped>
.dlg {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.dlg-card {
  background: var(--hh-color-surface-soft);
  border: 1px solid var(--hh-color-panel-glass-border);
  border-radius: 12px;
  padding: 16px;
}
.row {
  display: flex;
  gap: 8px;
  align-items: center;
}
.cs-wrap {
  display: flex;
  flex-direction: column;
  gap: 4px;
  align-items: stretch;
}
.cs-error {
  font-size: 12px;
  line-height: 1.6;
  color: var(--hh-color-error-danger);
}
.hint {
  font-size: 12px;
  color: var(--hh-color-text-muted);
}
.mono {
  font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
}
.dlg-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>