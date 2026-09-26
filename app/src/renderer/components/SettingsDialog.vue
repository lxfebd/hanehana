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
import { t } from '../i18n'

import { themePresets } from '../design/tokens'

const props = defineProps<{ settings: Settings }>()
const emit = defineEmits<{ save: [s: Settings] }>()

const form = reactive<Settings>({ ...props.settings })

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

onMounted(async () => {
  try {
    const info = await window.hh.hello()
    engine.value = { ok: info.engine_ok, path: info.engine_path, hint: info.engine_hint }
  } catch {
    engine.value = null
  }
})

/** 代理形状的校验与主进程同源（shared/proxy），免得出现「界面放行、主进程拒绝」。 */
const proxyError = computed(() => proxyFormatError(form.proxy))

/** 关于页展示：默认保存目录（与数据目录同源可读） */
const dataDirText = computed(() => form.download_dir || '（未设置）')

/** G15 便携模式：主进程算好的真实数据目录 + 是否便携（exe 旁有 PORTABLE 标记） */
const realDataDir = ref('')
const portable = ref(false)
onMounted(async () => {
  try {
    const info = await window.hh.hello()
    realDataDir.value = info.data_dir ?? ''
    portable.value = !!info.portable
  } catch {
    // hello 拿不到就不显示，不影响其他设置
  }
})

/** 构建期注入的版本号（app/package.json） */
const appVersion: string = __APP_VERSION__

/** 自动更新状态（主进程推送）。dev 模式主进程直接推 idle，无需区分。 */
const updater = ref<UpdateStatus>({ phase: 'idle' })
const updaterBusy = ref(false)

onMounted(async () => {
  try {
    const info = await window.hh.hello()
    engine.value = { ok: info.engine_ok, path: info.engine_path, hint: info.engine_hint }
  } catch {
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
    updater.value = { phase: 'idle', error: r?.error ?? '检查失败' }
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
    trackMsg.value = '请输入要追踪的关键词（开发商 / 系列名）'
    return
  }
  trackMsg.value = ''
  const r = await window.hh.trackAdd(kw)
  if (r?.ok && r.entry) {
    trackKeyword.value = ''
    await loadTracks()
    trackMsg.value = `已订阅「${r.entry.keyword}」`
  } else {
    trackMsg.value = r?.error ?? '订阅失败'
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
      trackMsg.value = r?.error ?? '检查失败'
    } else if (r.fresh.length) {
      trackMsg.value = `发现 ${r.fresh.length} 部新作，已通知`
    } else {
      trackMsg.value = '暂无新作'
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
  emit('save', {
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
      Number.isFinite(form.rate_limit_kbps) && form.rate_limit_kbps > 0
        ? Math.floor(form.rate_limit_kbps)
        : 0,
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
  })
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
      <TabPane key="notify" :tab="t('set_tab_notify')">
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
      <TabPane key="ui" :tab="t('set_tab_ui')">
        <div class="card">
          <div class="lbl" style="margin-bottom: 8px">{{ t('set_language') }}</div>
          <Radio.Group v-model:value="form.language">
            <Radio.Button value="zh">中文</Radio.Button>
            <Radio.Button value="en">English</Radio.Button>
          </Radio.Group>
          <div class="hint" style="margin-top: 8px">
            界面语言（骨架：导航与核心按钮已接入，设置页长文案仍为中文）。
          </div>
        </div>

        <div class="card">
          <div class="lbl" style="margin-bottom: 8px">{{ t('set_theme_mode') }}</div>
          <Radio.Group v-model:value="form.theme_mode">
            <Radio.Button value="system">{{ t('set_theme_system') }}</Radio.Button>
            <Radio.Button value="dark">{{ t('set_theme_dark') }}</Radio.Button>
            <Radio.Button value="light">{{ t('set_theme_light') }}</Radio.Button>
          </Radio.Group>
          <div class="hint" style="margin-top: 8px">
            跟随系统 = 随 Windows 深浅色自动切换；固定深/浅 = 不随系统变化。
            切换立即生效，无需保存。
          </div>
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
              <div class="hint">选择一张图片铺满窗口背景（无选中游戏封面时也生效）。留空 = 默认动态封面底。</div>
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
              <Checkbox v-model:checked="form.backup_on_exit">游戏退出时自动备份存档</Checkbox>
            </Form.Item>
            <Form.Item label="本地保留">
              <div class="row">
                <InputNumber v-model:value="form.backup_keep" :min="1" :max="100" style="width: 110px" />
                <span class="lbl">份</span>
              </div>
            </Form.Item>
            <Form.Item label="自定义目录">
              <div class="row">
                <Input v-model:value="form.backup_dir" placeholder="留空＝数据目录 backups\ 下" class="mono" />
                <Button @click="browseBackupDir">
                  <template #icon><FolderOpen :size="14" /></template>
                  {{ t('common_browse') }}
                </Button>
              </div>
            </Form.Item>
            <Form.Item label=" " :colon="false">
              <span class="hint">
                每款游戏独立子目录存放快照，保留最近 N 份，超出自动轮转删除。
                详情面板里可对单款游戏手动备份 / 恢复。
              </span>
            </Form.Item>
            <Form.Item label="WebDAV 地址">
              <Input v-model:value="form.webdav_url" class="mono" placeholder="https://dav.example.com/hanehana（留空＝仅本地备份）" />
            </Form.Item>
            <Form.Item label="WebDAV 账号">
              <Input v-model:value="form.webdav_user" class="mono" placeholder="用户名（可选）" />
            </Form.Item>
            <Form.Item label="WebDAV 密码">
              <Input.Password v-model:value="form.webdav_pass" placeholder="密码（可选）" />
            </Form.Item>
            <Form.Item label=" " :colon="false">
              <span class="hint">
                配置后快照可一键同步到云端（新者胜，同刻冲突保留两端），换电脑时可拉回。
                协议用原生 fetch 实现，无需额外依赖。
              </span>
            </Form.Item>
          </Form>
        </div>
      </TabPane>
            <TabPane key="tools" :tab="t('set_tab_tools')">
        <div class="card">
          <Form layout="horizontal" :label-col="{ style: { width: 120 } }" :wrapper-col="{ flex: 1 }">
            <Form.Item label="LE 执行器">
              <div class="row">
                <Input v-model:value="form.le_path" placeholder="留空＝自动探测常见安装位置" class="mono" />
                <Button @click="pickExe('le')">
                  <template #icon><FolderOpen :size="14" /></template>
                  {{ t('common_browse') }}
                </Button>
              </div>
            </Form.Item>
            <Form.Item label=" " :colon="false">
              <span class="hint">
                Locale Emulator（LEProc.exe）用于日文游戏转区启动。勾了「LE 转区」的游戏启动时
                会经它包装；找不到会明确报错，而不是静默用本机区域运行。
              </span>
            </Form.Item>
            <Form.Item label="Magpie">
              <div class="row">
                <Input v-model:value="form.magpie_path" placeholder="留空＝自动探测常见安装位置" class="mono" />
                <Button @click="pickExe('magpie')">
                  <template #icon><FolderOpen :size="14" /></template>
                  {{ t('common_browse') }}
                </Button>
              </div>
            </Form.Item>
            <Form.Item label=" " :colon="false">
              <span class="hint">
                Magpie 负责老游戏窗口放大/缩放渲染。勾了「Magpie」的游戏启动后会自动拉起它接管窗口。
              </span>
            </Form.Item>
          </Form>
        </div>
      </TabPane>
      <TabPane key="track" :tab="t('set_tab_track')">
        <div class="card">
          <div class="track-add">
            <Input v-model:value="trackKeyword" placeholder="开发商 / 系列名（如 柚子社、Yuzusoft）" @press-enter="addTrack" />
            <Button type="primary" :loading="trackBusy" @click="addTrack"><template #icon><Plus :size="14" /></template>订阅</Button>
            <Button :loading="trackBusy" @click="checkNow"><template #icon><RefreshCw :size="14" /></template>立即检查</Button>
          </div>
          <div v-if="trackMsg" class="track-msg">{{ trackMsg }}</div>
          <div class="track-list">
            <div v-for="track in trackList" :key="track.id" class="track-item">
              <span class="track-kw" :title="track.keyword">{{ track.keyword }}</span>
              <span class="track-meta">上次检查 {{ new Date(track.lastCheck).toLocaleDateString('zh-CN') }}</span>
              <Button type="text" danger size="small" @click="removeTrack(track.id)"><template #icon><Trash2 :size="13" /></template></Button>
            </div>
            <div v-if="!trackList.length" class="track-empty">还没有订阅。加一个开发商或系列名，VNDB 有新品时会收到系统通知。</div>
          </div>
          <div class="hint track-hint">检查基于 VNDB 发行日期（released ≥ 上次检查时间）；每款游戏只通知一次。数据存本地 tracking.json。</div>
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
            <span class="about-key">{{ portable ? '便携数据目录' : '配置与存档' }}</span>
            <span class="about-val mono" :title="realDataDir">{{ realDataDir }}</span>
          </div>
          <div class="about-row">
            <span class="about-key">{{ t('set_about_engine') }}</span>
            <span class="about-val">
              Rust 多线程下载引擎（FastDrop）·
              {{ engine === null ? t('set_engine_checking') : engine.ok ? t('set_engine_ready') : t('set_engine_missing') }}
            </span>
          </div>
          <div v-if="engine" class="about-row">
            <span class="about-key">{{ t('set_about_engine_path') }}</span>
            <span class="about-val mono" :title="engine.path">{{ engine.path }}</span>
          </div>
          <div v-if="engine && !engine.ok" class="hint hint-err about-warn">{{ engine.hint }}</div>
          <div class="about-hint">问题反馈与更新公告见项目仓库 README。</div>
          <div class="about-row updater">
            <span class="about-key">{{ t('set_auto_update') }}</span>
            <span class="about-val updater-val">
              <template v-if="updater.phase === 'checking'">{{ t('set_update_checking') }}</template>
              <template v-else-if="updater.phase === 'available'">
                发现新版本 {{ updater.version }}，正在下载…
              </template>
              <template v-else-if="updater.phase === 'downloading'">
                下载更新 {{ updaterPct }}%
                <span v-if="updater.total">{{ fmtSpeed(updater.transferred || 0) }}/{{ fmtSpeed(updater.total) }}</span>
              </template>
              <template v-else-if="updater.phase === 'downloaded'">
                新版本 {{ updater.version }} 已就绪
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
      <Button type="primary" :disabled="!!proxyError" @click="save">{{ t('common_save') }}</Button>
      <span v-if="proxyError" class="save-hint">代理格式不正确，无法保存</span>
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
.card-warn .lbl { color: var(--hh-color-error); }
.about-warn { margin-top: 8px; }
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
  transition: border-color var(--hh-motion-fast) var(--hh-motion-ease-move), box-shadow var(--hh-motion-fast) var(--hh-motion-ease-move);
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
.about-key { color: var(--hh-color-text-tertiary); flex-shrink: 0; }
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