<script setup lang="ts">
/**
 * 浏览器扩展投递（native messaging）设置面板。
 *
 * 宿主注册、扩展目录与浏览器侧的「加载已解压的扩展程序」是两件事：
 * 这里负责把宿主注册进浏览器并把关键路径/扩展 ID 明示出来；浏览器里
 * 手动加载扩展仍由用户完成。
 */
import { computed, onMounted, ref } from 'vue'
import { Button, message } from 'ant-design-vue'
import { Copy, FolderOpen, RefreshCw } from 'lucide-vue-next'
import { NM_EXTENSION_ID, type NmBrowserId, type NmHostStatus } from '../../../shared/nmProtocol'
import { t, tf } from '../../i18n'

type FeedbackKind = 'success' | 'warning' | 'error'

interface PanelFeedback {
  kind: FeedbackKind
  text: string
  errors: string[]
}

const BROWSERS: readonly NmBrowserId[] = ['chrome', 'edge', 'brave', 'chromium']

const status = ref<NmHostStatus | null>(null)
const loading = ref(false)
const busyBrowser = ref<NmBrowserId | null>(null)
const feedback = ref<PanelFeedback | null>(null)

/** 状态接口暂时不可用时仍把固定 ID 显示出来，用户至少能核对/复制。 */
const extensionId = computed(() => status.value?.extensionId || NM_EXTENSION_ID)
const unregisteredBrowsers = computed(() => BROWSERS.filter((browser) => !status.value?.registered[browser]))
const hasUnregistered = computed(() => status.value !== null && unregisteredBrowsers.value.length > 0)

function browserLabel(browser: NmBrowserId): string {
  switch (browser) {
    case 'chrome':
      return t('nm_browser_chrome')
    case 'edge':
      return t('nm_browser_edge')
    case 'brave':
      return t('nm_browser_brave')
    case 'chromium':
      return t('nm_browser_chromium')
  }
}

function isRegistered(browser: NmBrowserId): boolean {
  return status.value?.registered[browser] === true
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function showFeedback(kind: FeedbackKind, text: string, errors: string[] = []): void {
  const cleanErrors = errors.map((item) => item.trim()).filter(Boolean)
  feedback.value = { kind, text, errors: cleanErrors }
  if (kind === 'success') message.success(text)
  else if (kind === 'warning') message.warning(text)
  else message.error(text)
}

async function loadStatus(): Promise<void> {
  loading.value = true
  try {
    status.value = await window.hh.nmStatus()
  } catch (error) {
    showFeedback('error', tf('nm_status_load_failed', { reason: errorText(error) }))
  } finally {
    loading.value = false
  }
}

async function installBrowser(browser: NmBrowserId): Promise<void> {
  busyBrowser.value = browser
  feedback.value = null
  try {
    const result = await window.hh.nmInstall([browser])
    if (result.status) status.value = result.status
    const errors = result.errors ?? []
    if (result.ok) {
      showFeedback(
        errors.length ? 'warning' : 'success',
        tf('nm_install_ok', { browser: browserLabel(browser) }),
        errors,
      )
    } else {
      showFeedback('error', result.error || t('nm_action_failed'), errors)
    }
  } catch (error) {
    showFeedback('error', tf('nm_action_failed_detail', { reason: errorText(error) }))
  } finally {
    busyBrowser.value = null
  }
}

async function uninstallBrowser(browser: NmBrowserId): Promise<void> {
  busyBrowser.value = browser
  feedback.value = null
  try {
    const result = await window.hh.nmUninstall([browser])
    if (result.status) status.value = result.status
    const errors = result.errors ?? []
    if (result.ok) {
      showFeedback(
        errors.length ? 'warning' : 'success',
        tf('nm_uninstall_ok', { browser: browserLabel(browser) }),
        errors,
      )
    } else {
      showFeedback('error', result.error || t('nm_action_failed'), errors)
    }
  } catch (error) {
    showFeedback('error', tf('nm_action_failed_detail', { reason: errorText(error) }))
  } finally {
    busyBrowser.value = null
  }
}

async function openExtensionDir(): Promise<void> {
  feedback.value = null
  try {
    const result = await window.hh.nmOpenExtDir()
    if (result.ok) showFeedback('success', t('nm_open_dir_ok'))
    else showFeedback('error', result.error || t('nm_open_dir_failed'))
  } catch (error) {
    showFeedback('error', tf('nm_open_dir_failed_detail', { reason: errorText(error) }))
  }
}

function copyWithFallback(text: string): boolean {
  const input = document.createElement('textarea')
  input.value = text
  input.setAttribute('readonly', '')
  input.style.position = 'fixed'
  input.style.opacity = '0'
  document.body.appendChild(input)
  input.select()
  const copied = document.execCommand('copy')
  document.body.removeChild(input)
  return copied
}

async function copyExtensionId(): Promise<void> {
  try {
    let copied = false
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(extensionId.value)
        copied = true
      } catch {
        copied = false
      }
    }
    if (!copied) copied = copyWithFallback(extensionId.value)
    if (!copied) throw new Error(t('nm_clipboard_unavailable'))
    showFeedback('success', t('nm_copy_id_ok'))
  } catch (error) {
    showFeedback('error', tf('nm_copy_id_failed', { reason: errorText(error) }))
  }
}

onMounted(() => {
  void loadStatus()
})
</script>

<template>
  <div class="nm-panel">
    <section class="nm-card">
      <div class="nm-card-head">
        <div>
          <div class="nm-title">{{ t('nm_status_title') }}</div>
          <div class="nm-hint">{{ t('nm_status_hint') }}</div>
        </div>
        <Button size="small" :loading="loading" @click="loadStatus">
          <template #icon><RefreshCw :size="14" /></template>
          {{ t('common_refresh') }}
        </Button>
      </div>
      <div class="nm-status-grid">
        <div class="nm-status-item">
          <span class="nm-status-label">{{ t('nm_bridge_title') }}</span>
          <span class="nm-status-badge" :class="status?.bridgeRunning ? 'nm-badge-ok' : 'nm-badge-idle'">
            {{ status ? (status.bridgeRunning ? t('nm_bridge_running') : t('nm_bridge_stopped')) : t('nm_loading') }}
          </span>
        </div>
        <div class="nm-status-item">
          <span class="nm-status-label">{{ t('nm_pending_title') }}</span>
          <span class="nm-status-value">
            {{ status ? tf('nm_pending_count', { n: status.pending }) : t('nm_loading') }}
          </span>
        </div>
        <div class="nm-status-item">
          <span class="nm-status-label">{{ t('nm_host_title') }}</span>
          <span class="nm-status-value mono">{{ status?.hostName ?? '—' }}</span>
        </div>
      </div>
    </section>

    <section class="nm-card">
      <div class="nm-title">{{ t('nm_browsers_title') }}</div>
      <div class="nm-hint">{{ t('nm_browsers_hint') }}</div>

      <div v-if="hasUnregistered" class="nm-guide">
        <div class="nm-guide-title">{{ t('nm_manual_load_title') }}</div>
        <div class="nm-hint">{{ t('nm_unregistered_hint') }}</div>
      </div>

      <div class="nm-browser-list">
        <div v-for="browser in BROWSERS" :key="browser" class="nm-browser-row">
          <div class="nm-browser-main">
            <span class="nm-browser-name">{{ browserLabel(browser) }}</span>
            <span
              v-if="status"
              class="nm-status-badge"
              :class="isRegistered(browser) ? 'nm-badge-ok' : 'nm-badge-idle'"
            >
              {{ isRegistered(browser) ? t('nm_registered') : t('nm_unregistered') }}
            </span>
            <span v-else class="nm-status-badge nm-badge-idle">{{ t('nm_loading') }}</span>
          </div>
          <Button
            v-if="isRegistered(browser)"
            size="small"
            danger
            :loading="busyBrowser === browser"
            :disabled="busyBrowser !== null && busyBrowser !== browser"
            @click="uninstallBrowser(browser)"
          >
            {{ t('nm_uninstall_host') }}
          </Button>
          <Button
            v-else
            size="small"
            type="primary"
            :loading="busyBrowser === browser"
            :disabled="loading || (busyBrowser !== null && busyBrowser !== browser)"
            @click="installBrowser(browser)"
          >
            {{ t('nm_install_host') }}
          </Button>
        </div>
      </div>
    </section>

    <section class="nm-card">
      <div class="nm-title">{{ t('nm_extension_title') }}</div>

      <div class="nm-field">
        <div class="nm-field-head">
          <span class="nm-field-label">{{ t('nm_extension_id') }}</span>
          <Button size="small" @click="copyExtensionId">
            <template #icon><Copy :size="14" /></template>
            {{ t('nm_copy_id') }}
          </Button>
        </div>
        <code class="nm-code">{{ extensionId }}</code>
        <div class="nm-hint">{{ t('nm_extension_id_hint') }}</div>
      </div>

      <div class="nm-field">
        <div class="nm-field-head">
          <span class="nm-field-label">{{ t('nm_extension_dir') }}</span>
          <Button size="small" @click="openExtensionDir">
            <template #icon><FolderOpen :size="14" /></template>
            {{ t('nm_open_dir') }}
          </Button>
        </div>
        <code v-if="status?.extensionDir" class="nm-code">{{ status.extensionDir }}</code>
        <div v-else class="nm-hint">{{ t('nm_extension_dir_missing') }}</div>
        <div class="nm-hint">{{ t('nm_open_dir_hint') }}</div>
      </div>
    </section>

    <div v-if="feedback" class="nm-feedback" :class="`nm-feedback-${feedback.kind}`">
      <div>{{ feedback.text }}</div>
      <ul v-if="feedback.errors.length" class="nm-error-list">
        <li v-for="(item, index) in feedback.errors" :key="`${index}-${item}`">{{ item }}</li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.nm-panel {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.nm-card {
  background: var(--hh-color-surface-soft);
  border: 1px solid var(--hh-color-panel-glass-border);
  border-radius: var(--hh-radius-lg);
  padding: 16px;
}
.nm-card-head,
.nm-field-head,
.nm-browser-row,
.nm-browser-main {
  display: flex;
  align-items: center;
}
.nm-card-head,
.nm-field-head,
.nm-browser-row {
  justify-content: space-between;
}
.nm-card-head {
  gap: 12px;
}
.nm-title {
  font-size: var(--hh-font-bodyLg-size);
  font-weight: 600;
  color: var(--hh-color-text-glow);
}
.nm-hint {
  margin-top: 4px;
  font-size: var(--hh-font-caption-size);
  line-height: 1.7;
  color: var(--hh-color-text-muted);
}
.nm-status-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin-top: 12px;
}
.nm-status-item {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 10px 12px;
  border: 1px solid var(--hh-color-border-faint);
  border-radius: var(--hh-radius-sm);
  background: var(--hh-color-surface-soft);
}
.nm-status-label,
.nm-field-label {
  font-size: var(--hh-font-caption-size);
  color: var(--hh-color-text-tertiary);
}
.nm-status-value {
  color: var(--hh-color-text-stronger);
  font-size: var(--hh-font-body-size);
}
.nm-status-badge {
  display: inline-flex;
  align-items: center;
  align-self: flex-start;
  padding: 2px 8px;
  border: 1px solid var(--hh-color-border-faint);
  border-radius: var(--hh-radius-pill);
  font-size: var(--hh-font-caption-size);
  line-height: 1.5;
}
.nm-badge-ok {
  color: var(--hh-color-success-text);
  background: var(--hh-color-success-bg);
  border-color: var(--hh-color-success-border);
}
.nm-badge-idle {
  color: var(--hh-color-text-muted);
  background: var(--hh-color-surface-soft);
}
.nm-guide {
  margin-top: 12px;
  padding: 10px 12px;
  border: 1px solid var(--hh-color-border-faint);
  border-radius: var(--hh-radius-sm);
  background: var(--hh-color-warning-soft-bg);
}
.nm-guide-title {
  font-size: var(--hh-font-body-size);
  font-weight: 600;
  color: var(--hh-color-warning);
}
.nm-browser-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 12px;
}
.nm-browser-row {
  gap: 12px;
  padding: 9px 10px;
  border: 1px solid var(--hh-color-card-border);
  border-radius: var(--hh-radius-sm);
  background: var(--hh-color-surface-soft);
}
.nm-browser-main {
  gap: 10px;
  min-width: 0;
}
.nm-browser-name {
  font-size: var(--hh-font-body-size);
  font-weight: 600;
  color: var(--hh-color-text-stronger);
}
.nm-field {
  margin-top: 14px;
}
.nm-field-head {
  gap: 12px;
}
.nm-code {
  display: block;
  margin-top: 7px;
  padding: 8px 10px;
  border: 1px solid var(--hh-color-border-faint);
  border-radius: var(--hh-radius-sm);
  background: var(--hh-color-surface-soft);
  color: var(--hh-color-text-secondary);
  font-family: var(--hh-font-mono);
  font-size: var(--hh-font-caption-size);
  overflow-wrap: anywhere;
  user-select: text;
}
.mono {
  font-family: var(--hh-font-mono);
}
.nm-feedback {
  padding: 10px 12px;
  border: 1px solid var(--hh-color-border-faint);
  border-radius: var(--hh-radius-sm);
  font-size: var(--hh-font-caption-size);
  line-height: 1.7;
}
.nm-feedback-success {
  color: var(--hh-color-success-text);
  background: var(--hh-color-success-bg);
  border-color: var(--hh-color-success-border);
}
.nm-feedback-warning {
  color: var(--hh-color-warning);
  background: var(--hh-color-warning-soft-bg);
  border-color: var(--hh-color-border-faint);
}
.nm-feedback-error {
  color: var(--hh-color-error-text);
  background: var(--hh-color-error-soft-bg);
  border-color: var(--hh-color-error);
}
.nm-error-list {
  margin: 6px 0 0;
  padding-left: 20px;
}
.nm-error-list li + li {
  margin-top: 4px;
}
@media (max-width: 720px) {
  .nm-status-grid {
    grid-template-columns: 1fr;
  }
}
</style>
