<script setup lang="ts">
/**
 * 偏好设置：下载 / 通知 / 网络 / 外观四个页签。
 *
 * save() 必须逐个字段列出来（而不是 {...form}）：Settings 加了字段时这里
 * 漏一个，主进程会把它回落到默认值，用户会发现「勾了没保存」。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { FolderOpen, Image as ImageIcon, Plus, RefreshCw, Trash2 } from 'lucide-vue-next'
import { Button, Checkbox, Form, Input, InputNumber, Radio, TabPane, Tabs } from 'ant-design-vue'
import type { Settings, TrackEntry, UpdateStatus } from '../../shared/types'
import { proxyFormatError } from '../../shared/proxy'
import { fmtSpeed } from '../../shared/format'
import { THEME_PRESET_IDS } from '../design/tokens'
import { t, tf } from '../i18n'

import { themePresets } from '../design/tokens'

const props = defineProps<{ settings: Settings }>()
const emit = defineEmits<{ save: [s: Settings] }>()

const form = reactive<Settings>({ ...props.settings })

/**
 * 未保存角标：打开时的快照 vs 当前 form。
 * dirty 为真时保存按钮加「●」、弹窗标题旁给提示，避免「改了不点保存=白改」。
 * 对比用键序无关的规范化序列化：form 与快照可能来自不同来源（主进程
 * settings.json / save() payload），键序不同会让 JSON 字符串对比恒为 dirty。
 */
function stableSettingsJson(s: Settings): string {
  return JSON.stringify(
    Object.fromEntries([...Object.keys(s)].sort().map((k) => [k, (s as unknown as Record<string, unknown>)[k]])),
  )
}
const original = ref(stableSettingsJson(props.settings))
const dirty = computed(() => stableSettingsJson(form) !== original.value)

function presetName(id: (typeof THEME_PRESET_IDS)[number]): string {
  return themePresets[id].name
}
function presetDesc(id: (typeof THEME_PRESET_IDS)[number]): string {
  return themePresets[id].desc
}
function presetSwatch(id: (typeof THEME_PRESET_IDS)[number]): string {
  return themePresets[id].swatch
}

async function pickBg(): Promise<void> {
  const p = await window.hh.pickBgImage()
  if (p) form.bg_image = p
}

/**
 * 引擎自检结果（主进程 hello 顺带回来）。
 *
 * 引擎缺失时应用其余部分完全正常，只有下载会失败，而失败原因藏在任务行里——
 * 用户不会想到是引擎不在。所以设置页直接写明「不可用 + 怎么修」。
 */
const engine = ref<{ ok: boolean; path: string; hint: string } | null>(null)

/** 代理形状的校验与主进程同源（shared/proxy），免得出现「界面放行、主进程拒绝」。 */
const proxyError = computed(() => proxyFormatError(form.proxy))

/** 关于页展示：默认保存目录（与数据目录同源可读） */
const dataDirText = computed(() => form.download_dir || t('set_dir_unset'))

/** G15 便携模式：主进程算好的真实数据目录 + 是否便携（exe 旁有 PORTABLE 标记） */
const realDataDir = ref('')
const portable = ref(false)

/** 构建期注入的版本号（app/package.json） */
const appVersion: string = __APP_VERSION__

/** 自动更新状态（主进程推送）。dev 模式主进程直接推 idle，无需区分。 */
const updater = ref<UpdateStatus>({ phase: 'idle' })
const updaterBusy = ref(false)

// hello() 一次拿全：引擎自检 / 真实数据目录 / 便携标记（三条信息同源，
// 原来是三个 onMounted 各调一次 hello，等于同一请求发三遍）。
onMounted(async () => {
  try {
    const info = await window.hh.hello()
    engine.value = { ok: info.engine_ok, path: info.engine_path, hint: info.engine_hint }
    realDataDir.value = info.data_dir ?? ''
    portable.value = !!info.portable
  } catch {
    // hello 拿不到就不显示，不影响其他设置
    engine.value = null
  }
  window.hh.onUpdateStatus((s) => {
    updater.value = s
    updaterBusy.value = s.phase === 'checking' || s.phase === 'downloading'
  })
})

async function checkUpdateClick(): Promise<void> {
  if (updaterBusy.value) return
  updater.value = { phase: 'checking' }
  updaterBusy.value = true
  const r = await window.hh.checkUpdate()
  // 主进程的推送会接管后续状态；invoke 返回不代表已结束
  if (!r?.ok) {
    updater.value = { phase: 'idle', error: r?.error ?? t('set_check_fail') }
    updaterBusy.value = false
  }
}

function installUpdateClick(): void {
  void window.hh.installUpdate()
}

/** 下载进度百分比文案（progress 是 0..1）。 */
const updaterPct = computed(() =>
  updater.value.phase === 'downloading' && typeof updater.value.progress === 'number'
    ? Math.round(updater.value.progress * 100)
    : 0,
)

async function browseDir(): Promise<void> {
  const p = await window.hh.pickDir()
  if (p) form.download_dir = p
}

/** 备份根目录（G1）：选一个目录放所有游戏的快照 */
async function browseBackupDir(): Promise<void> {
  const p = await window.hh.pickDir()
  if (p) form.backup_dir = p
}

/** 工具路径（G2）：原生对话框选 exe */
async function pickExe(which: 'le' | 'magpie'): Promise<void> {
  const p = await window.hh.pickExe()
  if (p) {
    if (which === 'le') form.le_path = p
    else form.magpie_path = p
  }
}

// ---------------------------------------------------------------- 新作追踪（G16）
/** 订阅列表（VNDB 关键词）；设置页用独立页签管理，不走 Settings 落盘 */
const trackList = ref<TrackEntry[]>([])
const trackKeyword = ref('')
const trackBusy = ref(false)
const trackMsg = ref('')

/** 加载订阅（进设置页时拉一次最新） */
async function loadTracks(): Promise<void> {
  try {
    trackList.value = await window.hh.trackList()
  } catch {
    trackList.value = []
  }
}

/** 添加订阅词 */
async function addTrack(): Promise<void> {
  const kw = trackKeyword.value.trim()
  if (!kw) {
    trackMsg.value = t('set_track_kw')
    return
  }
  trackMsg.value = ''
  const r = await window.hh.trackAdd(kw)
  if (r?.ok && r.entry) {
    trackKeyword.value = ''
    await loadTracks()
    trackMsg.value = tf('set_tracked', { kw: r.entry.keyword })
  } else {
    trackMsg.value = r?.error ?? t('set_sub_fail')
  }
}

/** 删除订阅 */
async function removeTrack(id: string): Promise<void> {
  await window.hh.trackRemove(id)
  await loadTracks()
}

/** 手动触发一次检查（结果即时反馈） */
async function checkNow(): Promise<void> {
  trackBusy.value = true
  trackMsg.value = ''
  try {
    const r = await window.hh.trackCheck()
    if (!r?.ok) {
      trackMsg.value = r?.error ?? t('set_check_fail')
    } else if (r.fresh.length) {
      trackMsg.value = tf('set_fresh_n', { n: r.fresh.length })
    } else {
      trackMsg.value = t('set_no_fresh')
    }
  } catch (e) {
    trackMsg.value = e instanceof Error ? e.message : String(e)
  } finally {
    trackBusy.value = false
  }
}

onMounted(() => {
  void loadTracks()
})

function save(): void {
  const payload: Settings = {
    threads: form.threads,
    max_concurrent: form.max_concurrent,
    download_dir: form.download_dir.trim(),
    proxy: form.proxy.trim(),
    user_agent: form.user_agent.trim(),
    confirm_delete: form.confirm_delete,
    dark: form.dark,
    theme_mode: form.theme_mode,
    theme_preset: form.theme_preset,
    bg_image: form.bg_image,
    notify_on_finish: form.notify_on_finish,
    notify_on_error: form.notify_on_error,
    close_to_tray: form.close_to_tray,
    keep_awake: form.keep_awake,
    // 输入框允许清空（value 变 null），空/负数一律按「不限速」发出去
    rate_limit_kbps:
      Number.isFinite(form.rate_limit_kbps) && form.rate_limit_kbps > 0 ? Math.floor(form.rate_limit_kbps) : 0,
    auto_update_check: form.auto_update_check,
    // 存档备份（G1）
    backup_dir: form.backup_dir.trim(),
    backup_on_exit: form.backup_on_exit,
    backup_keep: Math.max(1, Math.floor(form.backup_keep) || 5),
    webdav_url: form.webdav_url.trim(),
    webdav_user: form.webdav_user.trim(),
    webdav_pass: form.webdav_pass,
    // 工具集成（G2）
    le_path: form.le_path.trim(),
    magpie_path: form.magpie_path.trim(),
    // 界面语言（G18）
    language: form.language === 'en' ? 'en' : 'zh',
  }
  emit('save', payload)
  // 保存成功后快照对齐（角标消失）
  original.value = stableSettingsJson(payload)
}
</script>

<template>
  <div class="dlg">
    <Tabs defaultActiveKey="download" tab-position="left">
      <TabPane key="download" :tab="t('set_tab_download')">
        <div v-if="engine && !engine.ok" class="card card-warn">
          <div class="lbl">{{ t('set_engine_unavailable') }}</div>
          <div class="hint">{{ engine.hint }}</div>
        </div>
        <div class="card">
          <Form layout="horizontal" :label-col="{ style: { width: 120 } }" :wrapper-col="{ flex: 1 }">
            <Form.Item :label="t('set_threads')">
              <InputNumber v-model:value="form.threads" :min="1" :max="32" style="width: 110px" />
            </Form.Item>
            <Form.Item :label="t('set_max_concurrent')">
              <InputNumber v-model:value="form.max_concurrent" :min="1" :max="20" style="width: 110px" />
            </Form.Item>
            <Form.Item :label="t('set_download_dir')">
              <div class="row">
                <Input v-model:value="form.download_dir" class="mono" />
                <Button @click="browseDir">
                  <template #icon><FolderOpen :size="14" /></template>
                  {{ t('common_browse') }}
                </Button>
              </div>
            </Form.Item>
            <Form.Item label=" " :colon="false">
              <Checkbox v-model:checked="form.confirm_delete">{{ t('set_confirm_delete') }}</Checkbox>
            </Form.Item>
            <Form.Item label=" " :colon="false">
              <Checkbox v-model:checked="form.close_to_tray">{{ t('set_close_tray') }}</Checkbox>
            </Form.Item>
            <Form.Item label=" " :colon="false">
              <Checkbox v-model:checked="form.keep_awake">{{ t('set_keep_awake') }}</Checkbox>
            </Form.Item>
          </Form>
        </div>
      </TabPane>
      <TabPane key="notify" :tab="t('set_tab_notify')">
        <div class="card">
          <Form layout="horizontal" :label-col="{ style: { width: 120 } }" :wrapper-col="{ flex: 1 }">
            <Form.Item label=" " :colon="false">
              <Checkbox v-model:checked="form.notify_on_finish">{{ t('set_notify_finish') }}</Checkbox>
            </Form.Item>
            <Form.Item label=" " :colon="false">
              <Checkbox v-model:checked="form.notify_on_error">{{ t('set_notify_error') }}</Checkbox>
            </Form.Item>
            <Form.Item label=" " :colon="false">
              <span class="hint">{{ t('set_notify_hint') }}</span>
            </Form.Item>
          </Form>
        </div>
      </TabPane>
      <TabPane key="net" :tab="t('set_tab_net')">
        <div class="card">
          <Form layout="horizontal" :label-col="{ style: { width: 120 } }" :wrapper-col="{ flex: 1 }">
            <Form.Item :label="t('set_proxy')">
              <Input
                v-model:value="form.proxy"
                :placeholder="t('set_proxy_system')"
                :status="proxyError ? 'error' : undefined"
                class="mono"
                allow-clear
              />
              <span v-if="proxyError" class="hint hint-err">{{ proxyError }}</span>
            </Form.Item>
            <Form.Item label=" " :colon="false">
              <span class="hint">{{ t('set_proxy_hint') }}</span>
            </Form.Item>
            <Form.Item label="User-Agent">
              <Input v-model:value="form.user_agent" :placeholder="t('set_ua_ph')" class="mono" />
            </Form.Item>
            <Form.Item :label="t('set_ratelimit')">
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
              <span class="hint">{{ t('set_ratelimit_hint') }}</span>
            </Form.Item>
          </Form>
        </div>
      </TabPane>
      <TabPane key="ui" :tab="t('set_tab_ui')">
        <div class="card">
          <div class="lbl" style="margin-bottom: 8px">{{ t('set_language') }}</div>
          <Radio.Group v-model:value="form.language">
            <Radio.Button value="zh">{{ t('set_lang_zh') }}</Radio.Button>
            <Radio.Button value="en">{{ t('set_lang_en') }}</Radio.Button>
          </Radio.Group>
          <div class="hint" style="margin-top: 8px">{{ t('set_lang_hint') }}</div>
        </div>

        <div class="card">
          <div class="lbl" style="margin-bottom: 8px">{{ t('set_theme_mode') }}</div>
          <Radio.Group v-model:value="form.theme_mode">
            <Radio.Button value="system">{{ t('set_theme_system') }}</Radio.Button>
            <Radio.Button value="dark">{{ t('set_theme_dark') }}</Radio.Button>
            <Radio.Button value="light">{{ t('set_theme_light') }}</Radio.Button>
          </Radio.Group>
          <div class="hint" style="margin-top: 8px">{{ t('set_theme_hint') }}</div>
        </div>

        <div class="card">
          <div class="lbl" style="margin-bottom: 8px">{{ t('set_theme_preset') }}</div>
          <div class="preset-row">
            <button
              v-for="id in THEME_PRESET_IDS"
              :key="id"
              class="preset-card"
              :class="{ active: form.theme_preset === id }"
              @click="form.theme_preset = id"
            >
              <span class="preset-swatch" :style="{ background: presetSwatch(id) }"></span>
              <span class="preset-name">{{ presetName(id) }}</span>
              <span class="preset-desc">{{ presetDesc(id) }}</span>
            </button>
          </div>
        </div>

        <div class="card">
          <div class="row-between">
            <div>
              <div class="lbl">{{ t('set_bg_image') }}</div>
              <div class="hint">{{ t('set_bg_hint') }}</div>
            </div>
            <div class="row">
              <Button @click="pickBg">
                <template #icon><ImageIcon :size="14" /></template>
                {{ form.bg_image ? t('set_bg_replace') : t('set_bg_pick') }}
              </Button>
              <Button v-if="form.bg_image" danger @click="form.bg_image = ''">
                <template #icon><Trash2 :size="14" /></template>
                {{ t('common_clear') }}
              </Button>
            </div>
          </div>
          <div v-if="form.bg_image" class="bg-path mono">{{ form.bg_image }}</div>
        </div>
      </TabPane>
      <TabPane key="backup" :tab="t('set_tab_backup')">
        <div class="card">
          <Form layout="horizontal" :label-col="{ style: { width: 120 } }" :wrapper-col="{ flex: 1 }">
            <Form.Item label=" " :colon="false">
              <Checkbox v-model:checked="form.backup_on_exit">{{ t('set_backup_on_exit') }}</Checkbox>
            </Form.Item>
            <Form.Item :label="t('set_keep_n')">
              <div class="row">
                <InputNumber v-model:value="form.backup_keep" :min="1" :max="100" style="width: 110px" />
                <span class="lbl">{{ t('set_keep_unit') }}</span>
              </div>
            </Form.Item>
            <Form.Item :label="t('set_backup_dir')">
              <div class="row">
                <Input v-model:value="form.backup_dir" :placeholder="t('set_backup_dir_ph')" class="mono" />
                <Button @click="browseBackupDir">
                  <template #icon><FolderOpen :size="14" /></template>
                  {{ t('common_browse') }}
                </Button>
              </div>
            </Form.Item>
            <Form.Item label=" " :colon="false">
              <span class="hint">{{ t('set_backup_hint') }}</span>
            </Form.Item>
            <Form.Item :label="t('set_webdav_url')">
              <Input v-model:value="form.webdav_url" class="mono" :placeholder="t('set_webdav_url_ph')" />
            </Form.Item>
            <Form.Item :label="t('set_webdav_user')">
              <Input v-model:value="form.webdav_user" class="mono" :placeholder="t('set_webdav_user_ph')" />
            </Form.Item>
            <Form.Item :label="t('set_webdav_pass')">
              <Input.Password v-model:value="form.webdav_pass" :placeholder="t('set_webdav_pass_ph')" />
            </Form.Item>
            <Form.Item label=" " :colon="false">
              <span class="hint">{{ t('set_webdav_hint') }}</span>
            </Form.Item>
          </Form>
        </div>
      </TabPane>
      <TabPane key="tools" :tab="t('set_tab_tools')">
        <div class="card">
          <Form layout="horizontal" :label-col="{ style: { width: 120 } }" :wrapper-col="{ flex: 1 }">
            <Form.Item :label="t('set_le_exe')">
              <div class="row">
                <Input v-model:value="form.le_path" :placeholder="t('set_le_ph')" class="mono" />
                <Button @click="pickExe('le')">
                  <template #icon><FolderOpen :size="14" /></template>
                  {{ t('common_browse') }}
                </Button>
              </div>
            </Form.Item>
            <Form.Item label=" " :colon="false">
              <span class="hint">{{ t('set_le_hint') }}</span>
            </Form.Item>
            <Form.Item label="Magpie">
              <div class="row">
                <Input v-model:value="form.magpie_path" :placeholder="t('set_le_ph')" class="mono" />
                <Button @click="pickExe('magpie')">
                  <template #icon><FolderOpen :size="14" /></template>
                  {{ t('common_browse') }}
                </Button>
              </div>
            </Form.Item>
            <Form.Item label=" " :colon="false">
              <span class="hint">{{ t('set_magpie_hint') }}</span>
            </Form.Item>
          </Form>
        </div>
      </TabPane>
      <TabPane key="track" :tab="t('set_tab_track')">
        <div class="card">
          <div class="track-add">
            <Input v-model:value="trackKeyword" :placeholder="t('set_track_ph')" @press-enter="addTrack" />
            <Button type="primary" :loading="trackBusy" @click="addTrack"
              ><template #icon><Plus :size="14" /></template>{{ t('set_subscribe') }}</Button
            >
            <Button :loading="trackBusy" @click="checkNow"
              ><template #icon><RefreshCw :size="14" /></template>{{ t('set_check_now') }}</Button
            >
          </div>
          <div v-if="trackMsg" class="track-msg">{{ trackMsg }}</div>
          <div class="track-list">
            <div v-for="track in trackList" :key="track.id" class="track-item">
              <span class="track-kw" :title="track.keyword">{{ track.keyword }}</span>
              <span class="track-meta">{{
                tf('set_track_last', { date: new Date(track.lastCheck).toLocaleDateString('zh-CN') })
              }}</span>
              <Button type="text" danger size="small" @click="removeTrack(track.id)"
                ><template #icon><Trash2 :size="13" /></template
              ></Button>
            </div>
            <div v-if="!trackList.length" class="track-empty">{{ t('set_track_empty') }}</div>
          </div>
          <div class="hint track-hint">{{ t('set_track_hint') }}</div>
        </div>
      </TabPane>
      <TabPane key="about" :tab="t('set_tab_about')">
        <div class="card">
          <div class="about-row">
            <span class="about-key">{{ t('set_about_version') }}</span>
            <span class="about-val">{{ appVersion }}</span>
          </div>
          <div class="about-row">
            <span class="about-key">{{ t('set_about_data_dir') }}</span>
            <span class="about-val mono">{{ dataDirText }}</span>
          </div>
          <div class="about-row" v-if="realDataDir">
            <span class="about-key">{{ portable ? t('set_about_portable') : t('set_about_config') }}</span>
            <span class="about-val mono" :title="realDataDir">{{ realDataDir }}</span>
          </div>
          <div class="about-row">
            <span class="about-key">{{ t('set_about_engine') }}</span>
            <span class="about-val">
              {{ t('set_about_engine_desc') }}·
              {{
                engine === null ? t('set_engine_checking') : engine.ok ? t('set_engine_ready') : t('set_engine_missing')
              }}
            </span>
          </div>
          <div v-if="engine" class="about-row">
            <span class="about-key">{{ t('set_about_engine_path') }}</span>
            <span class="about-val mono" :title="engine.path">{{ engine.path }}</span>
          </div>
          <div v-if="engine && !engine.ok" class="hint hint-err about-warn">{{ engine.hint }}</div>
          <div class="about-hint">{{ t('set_about_hint') }}</div>
          <div class="about-row updater">
            <span class="about-key">{{ t('set_auto_update') }}</span>
            <span class="about-val updater-val">
              <template v-if="updater.phase === 'checking'">{{ t('set_update_checking') }}</template>
              <template v-else-if="updater.phase === 'available'">
                {{ tf('set_update_downloading', { v: updater.version ?? '' }) }}
              </template>
              <template v-else-if="updater.phase === 'downloading'">
                {{ tf('set_update_pct', { pct: updaterPct }) }}
                <span v-if="updater.total">{{ fmtSpeed(updater.transferred || 0) }}/{{ fmtSpeed(updater.total) }}</span>
              </template>
              <template v-else-if="updater.phase === 'downloaded'">
                {{ tf('set_update_ready', { v: updater.version ?? '' }) }}
              </template>
              <template v-else-if="updater.phase === 'installing'">{{ t('set_update_installing') }}</template>
              <template v-else-if="updater.error">{{ updater.error }}</template>
              <template v-else>{{ t('set_update_idle') }}</template>
            </span>
          </div>
          <div class="updater-actions">
            <Button v-if="updater.phase === 'downloaded'" type="primary" size="small" @click="installUpdateClick">
              {{ t('set_install_restart') }}
            </Button>
            <Button v-else size="small" :loading="updaterBusy" @click="checkUpdateClick">
              {{ updater.phase === 'idle' && !updater.error ? t('set_check_update') : t('set_recheck_update') }}
            </Button>
          </div>
        </div>
      </TabPane>
    </Tabs>

    <div class="dlg-foot">
      <Button type="primary" :disabled="!!proxyError" @click="save">
        <template v-if="dirty" #icon><span class="save-dot" aria-hidden="true"></span></template>
        {{ t('common_save') }}
      </Button>
      <span v-if="dirty" class="save-hint dirty-hint">{{ t('set_unsaved_hint') }}</span>
      <span v-if="proxyError" class="save-hint">{{ t('set_proxy_invalid') }}</span>
    </div>
  </div>
</template>

<style scoped>
.dlg {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.card {
  background: var(--hh-color-surface-soft);
  border: 1px solid var(--hh-color-panel-glass-border);
  border-radius: var(--hh-radius-lg);
  padding: 16px;
}
.card-warn {
  margin-bottom: 12px;
  border-color: var(--hh-color-error);
}
.card-warn .lbl {
  color: var(--hh-color-error);
}
.about-warn {
  margin-top: 8px;
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
  font-size: var(--hh-font-bodyLg-size);
  color: var(--hh-color-text-glow);
}
.hint {
  font-size: var(--hh-font-caption-size);
  line-height: 1.7;
  color: var(--hh-color-text-muted);
}
.hint-err {
  display: block;
  color: var(--hh-color-error-danger);
}
.save-hint {
  font-size: var(--hh-font-caption-size);
  color: var(--hh-color-error-text);
}
.save-hint.dirty-hint {
  color: var(--hh-color-accent-text);
}
.save-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--hh-color-accent);
  box-shadow: 0 0 0 2px var(--hh-color-accent-soft);
}
.mono {
  font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
}
/* 主题卡片 */
.preset-row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.preset-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  width: 148px;
  padding: 10px 12px;
  border: 1px solid var(--hh-color-card-border);
  border-radius: var(--hh-radius-md);
  background: var(--hh-color-card);
  color: var(--hh-color-text);
  cursor: pointer;
  transition:
    border-color var(--hh-motion-fast) var(--hh-motion-ease-move),
    box-shadow var(--hh-motion-fast) var(--hh-motion-ease-move);
}
.preset-card:hover {
  border-color: var(--hh-color-accent-focus-border);
}
.preset-card.active {
  border-color: var(--hh-color-accent);
  box-shadow: 0 0 0 2px var(--hh-color-accent-ring);
}
.preset-swatch {
  width: 100%;
  height: 28px;
  border-radius: var(--hh-radius-xs);
  display: block;
}
.preset-name {
  font-size: var(--hh-font-body-size);
  font-weight: 600;
  color: var(--hh-color-text-glow);
}
.preset-desc {
  font-size: 11px;
  line-height: 1.5;
  color: var(--hh-color-text-dim);
}
.bg-path {
  margin-top: 8px;
  font-size: var(--hh-font-caption-size);
  color: var(--hh-color-text-secondary);
  word-break: break-all;
}
/* 关于页 */
.about-row {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  padding: 6px 0;
  font-size: var(--hh-font-body-size);
  border-bottom: 1px solid var(--hh-color-border-faint);
}
.about-key {
  color: var(--hh-color-text-tertiary);
  flex-shrink: 0;
}
.about-val {
  color: var(--hh-color-text-stronger);
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.about-hint {
  font-size: var(--hh-font-caption-size);
  color: var(--hh-color-text-dim);
  margin-top: 10px;
}
.updater-val {
  color: var(--hh-color-accent);
}
.updater-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 10px;
}
.dlg-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
/* 新作追踪（G16） */
.track-add {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}
.track-add .ant-input {
  flex: 1;
}
.track-msg {
  font-size: 12.5px;
  color: var(--hh-color-text-mid-high);
  margin-bottom: 10px;
}
.track-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 10px;
}
.track-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  border: 1px solid var(--hh-color-card-border);
  border-radius: var(--hh-radius-sm);
  background: var(--hh-color-surface-soft);
}
.track-kw {
  font-size: var(--hh-font-body-size);
  color: var(--hh-color-text-glow);
  font-weight: 600;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.track-meta {
  font-size: 11.5px;
  color: var(--hh-color-text-dim);
  white-space: nowrap;
}
.track-empty {
  font-size: 12.5px;
  color: var(--hh-color-text-tertiary);
  padding: 14px 0;
  text-align: center;
}
.track-hint {
  display: block;
  font-size: var(--hh-font-caption-size);
}
</style>
