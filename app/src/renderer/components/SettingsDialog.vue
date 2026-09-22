<script setup lang="ts">
/**
 * 偏好设置：下载 / 通知 / 网络 / 外观四个页签。
 *
 * save() 必须逐个字段列出来（而不是 {...form}）：Settings 加了字段时这里
 * 漏一个，主进程会把它回落到默认值，用户会发现「勾了没保存」。
 */
import { computed, reactive } from 'vue'
import { FolderOpen } from 'lucide-vue-next'
import { Button, Checkbox, Form, Input, InputNumber, Switch, TabPane, Tabs } from 'ant-design-vue'
import type { Settings } from '../../shared/types'
import { proxyFormatError } from '../../shared/proxy'

const props = defineProps<{ settings: Settings }>()
const emit = defineEmits<{ save: [s: Settings] }>()

const form = reactive<Settings>({ ...props.settings })

/** 代理形状的校验与主进程同源（shared/proxy），免得出现「界面放行、主进程拒绝」。 */
const proxyError = computed(() => proxyFormatError(form.proxy))

async function browseDir(): Promise<void> {
  const p = await window.hh.pickDir()
  if (p) form.download_dir = p
}

function save(): void {
  emit('save', {
    threads: form.threads,
    max_concurrent: form.max_concurrent,
    download_dir: form.download_dir.trim(),
    proxy: form.proxy.trim(),
    user_agent: form.user_agent.trim(),
    confirm_delete: form.confirm_delete,
    dark: form.dark,
    notify_on_finish: form.notify_on_finish,
    notify_on_error: form.notify_on_error,
    close_to_tray: form.close_to_tray,
    keep_awake: form.keep_awake,
    // 输入框允许清空（value 变 null），空/负数一律按「不限速」发出去
    rate_limit_kbps:
      Number.isFinite(form.rate_limit_kbps) && form.rate_limit_kbps > 0
        ? Math.floor(form.rate_limit_kbps)
        : 0,
    auto_update_check: form.auto_update_check,
  })
}
</script>

<template>
  <div class="dlg">
    <div class="dlg-head">
      <span class="dlg-title">偏好设置</span>
    </div>

    <Tabs defaultActiveKey="download">
      <TabPane key="download" tab="下载">
        <div class="card">
          <Form layout="horizontal" :label-col="{ style: { width: 120 } }" :wrapper-col="{ flex: 1 }">
            <Form.Item label="默认分片数">
              <InputNumber v-model:value="form.threads" :min="1" :max="32" style="width: 110px" />
            </Form.Item>
            <Form.Item label="同时下载任务数">
              <InputNumber v-model:value="form.max_concurrent" :min="1" :max="20" style="width: 110px" />
            </Form.Item>
            <Form.Item label="默认保存目录">
              <div class="row">
                <Input v-model:value="form.download_dir" class="mono" />
                <Button @click="browseDir">
                  <template #icon><FolderOpen :size="14" /></template>
                  浏览
                </Button>
              </div>
            </Form.Item>
            <Form.Item label=" " :colon="false">
              <Checkbox v-model:checked="form.confirm_delete">删除任务时确认</Checkbox>
            </Form.Item>
            <Form.Item label=" " :colon="false">
              <Checkbox v-model:checked="form.close_to_tray">
                关闭主窗口时缩到托盘（后台继续下载）
              </Checkbox>
            </Form.Item>
            <Form.Item label=" " :colon="false">
              <Checkbox v-model:checked="form.keep_awake">
                有任务在跑时阻止电脑休眠
              </Checkbox>
            </Form.Item>
          </Form>
        </div>
      </TabPane>
      <TabPane key="notify" tab="通知">
        <div class="card">
          <Form layout="horizontal" :label-col="{ style: { width: 120 } }" :wrapper-col="{ flex: 1 }">
            <Form.Item label=" " :colon="false">
              <Checkbox v-model:checked="form.notify_on_finish">下载完成时弹系统通知</Checkbox>
            </Form.Item>
            <Form.Item label=" " :colon="false">
              <Checkbox v-model:checked="form.notify_on_error">下载失败时弹系统通知</Checkbox>
            </Form.Item>
            <Form.Item label=" " :colon="false">
              <span class="hint">
                通知只在窗口失去焦点时弹（窗口就在面前还弹通知是骚扰）。点通知会跳回并选中那条任务。
              </span>
            </Form.Item>
          </Form>
        </div>
      </TabPane>
      <TabPane key="net" tab="网络">
        <div class="card">
          <Form layout="horizontal" :label-col="{ style: { width: 120 } }" :wrapper-col="{ flex: 1 }">
            <Form.Item label="代理">
              <Input
                v-model:value="form.proxy"
                placeholder="留空＝跟随系统代理"
                :status="proxyError ? 'error' : undefined"
                class="mono"
                allow-clear
              />
              <span v-if="proxyError" class="hint hint-err">{{ proxyError }}</span>
            </Form.Item>
            <Form.Item label=" " :colon="false">
              <span class="hint">
                代理对下载与站点抓取同时生效。填 http://127.0.0.1:7890
                或 socks5://127.0.0.1:7891 这种形式；留空则跟随系统代理（含 PAC 自动配置）。
              </span>
            </Form.Item>
            <Form.Item label="User-Agent">
              <Input v-model:value="form.user_agent" placeholder="留空使用内置 UA" class="mono" />
            </Form.Item>
            <Form.Item label="限速">
              <div class="row">
                <InputNumber
                  v-model:value="form.rate_limit_kbps"
                  :min="0"
                  :max="104857600"
                  :step="128"
                  style="width: 150px"
                />
                <span class="lbl">KiB/s</span>
              </div>
            </Form.Item>
            <Form.Item label=" " :colon="false">
              <span class="hint">
                0 = 不限速。每个下载任务各拿一份额度，1 MiB/s 填 1024。
                改完点保存就立刻生效，正在跑的任务不用重下。
              </span>
            </Form.Item>
          </Form>
        </div>
      </TabPane>
      <TabPane key="ui" tab="外观">
        <div class="card">
          <div class="row-between">
            <span class="lbl">深色模式</span>
            <Switch v-model:checked="form.dark" />
          </div>
        </div>
      </TabPane>
    </Tabs>

    <div class="dlg-foot">
      <Button type="primary" @click="save">保存</Button>
    </div>
  </div>
</template>

<style scoped>
.dlg {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.dlg-title {
  font-size: 16px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.88);
}
.card {
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 12px;
  padding: 16px;
}
.row {
  display: flex;
  gap: 8px;
  align-items: center;
}
.row-between {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.lbl {
  font-size: 14px;
  color: rgba(255, 255, 255, 0.88);
}
.hint {
  font-size: 12px;
  line-height: 1.7;
  color: rgba(255, 255, 255, 0.45);
}
.hint-err {
  display: block;
  color: #e05252;
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