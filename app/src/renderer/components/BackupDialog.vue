<script setup lang="ts">
/**
 * 存档备份/恢复对话框（G1）。
 *
 * 为该游戏列出全部本地快照（<backupRoot>/<gameId>/<ISO时间戳>/），可
 * 手动创建、恢复、删除；配置了 WebDAV 后每条快照可一键同步到云端。
 * 所有写操作走 window.hh 桥，失败用弹窗内置错误条展示（不滥用全局 message）。
 */
import { computed, h, ref, watch } from 'vue'
import { CloudUpload, DatabaseBackup, HardDriveDownload, RefreshCw, Trash2 } from 'lucide-vue-next'
import { Modal, message } from 'ant-design-vue'
import DialogShell from './DialogShell.vue'
import { library } from '../stores/library'
import type { BackupStats, SnapshotInfo } from '../../shared/types'
import { SNAPSHOT_MAX_FILE_MB, SNAPSHOT_MAX_TOTAL_GB } from '../../shared/snapshotLimits'
import { t, tf } from '../i18n'

const open = defineModel<boolean>('open')

const stats = ref<BackupStats | null>(null)
const loading = ref(false)
const busy = ref(false)
const error = ref('')
const busyAction = ref('')
/** 最近一次创建快照的跳过摘要（null = 没有文件被跳过）。 */
const skipStats = ref<{ count: number; bytes: number } | null>(null)

const game = computed(() => library.games.find((g) => g.id === library.selectedId) ?? null)

watch(open, (v) => {
  if (v) void reload()
})

/** 重新拉取该游戏的备份总览 */
async function reload(): Promise<void> {
  if (!game.value) return
  loading.value = true
  error.value = ''
  try {
    const list = await window.hh.backupsList()
    stats.value = list.find((b) => b.gameId === game.value!.id) ?? null
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function fmtCount(n: number): string {
  return tf('backup_files', { n })
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const pad = (x: number): string => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * 跳过提示文案（只在 skipped 非空时出现）。
 * 「200MB / 2GB」不再写死在这里：数字来自 shared/snapshotLimits（与主进程闸门
 * 同一份真值），改上限时文案自动跟着变。此前这两处各写一份，改常量文案就漂移
 * ——用户看到的规则与实际闸门对不上。
 */
function skipNoticeText(count: number, bytes: number): string {
  return tf('backup_skip_notice', {
    count,
    size: fmtSize(bytes),
    mb: SNAPSHOT_MAX_FILE_MB,
    gb: SNAPSHOT_MAX_TOTAL_GB,
  })
}

/** 可见提示文案：由跳过摘要计算得出，切语言时跟着变（空串 = 不显示）。 */
const skipNotice = computed(() => (skipStats.value ? skipNoticeText(skipStats.value.count, skipStats.value.bytes) : ''))

/**
 * 单条快照的「未纳入」提示：快照创建时被闸门拦下的文件不会记进 files 清单，
 * 恢复也回拷不到它们。列表里先亮出来，用户才知道这份快照不是全集——否则
 * 恢复完看到「已恢复 N 个」，会以为全部拿回来了。
 */
function snapSkipText(snap: SnapshotInfo): string {
  return tf('backup_snap_skip', { n: snap.skippedCount ?? 0, size: fmtSize(snap.skippedBytes ?? 0) })
}

/** 恢复成功提示：已恢复 N 个 +（快照本来有跳过时）「另有 N 个未纳入、未恢复」。 */
function restoreSuccessText(r: { restored: number; skippedCount?: number; skippedBytes?: number }): string {
  const base = tf('backup_restored', { n: r.restored })
  const skipped = r.skippedCount ?? 0
  return skipped > 0 ? base + tf('backup_restored_skip', { n: skipped, size: fmtSize(r.skippedBytes ?? 0) }) : base
}

async function createBackup(): Promise<void> {
  const g = game.value
  if (!g || busy.value) return
  busy.value = true
  busyAction.value = 'create'
  error.value = ''
  skipStats.value = null
  try {
    const snap = await window.hh.backupCreate(g.id)
    if (!snap) {
      error.value = t('backup_no_dir')
    } else {
      // 有文件被闸门拦下（超大/超预算/不可读）时必须提示：不提示的话
      // 「部分备份」看起来就是「全部备份」，等于回到静默丢件。
      if (snap.skippedCount && snap.skippedCount > 0) {
        skipStats.value = { count: snap.skippedCount, bytes: snap.skippedBytes ?? 0 }
        message.warning(skipNotice.value)
      }
      await reload()
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
    busyAction.value = ''
  }
}

function restoreSnapshot(snap: SnapshotInfo): void {
  const g = game.value
  if (!g || busy.value || !snap.dirPath) return
  const skipped = snap.skippedCount ?? 0
  Modal.confirm({
    title: t('backup_restore_title'),
    // 有跳过时把「这份快照本来就少了文件」写进确认文案：不写的话，用户恢复完
    // 只看到「已恢复 N 个」，会以为全都拿回来了。content 用 h() 包一层，只为
    // 给这句挂 data-testid——回归靶按语义钩子断言，不按中文文案匹配（文案随
    // 语言/措辞调整会假红）。仍然复用现有 Modal.confirm，不新增对话框组件。
    content:
      skipped > 0
        ? h('div', [
            h('div', t('backup_restore_confirm')),
            h(
              'div',
              { 'data-testid': 'backup-restore-skip', style: 'margin-top: 6px; color: var(--hh-color-warning)' },
              snapSkipText(snap),
            ),
          ])
        : t('backup_restore_confirm'),
    okText: t('backup_restore_ok'),
    cancelText: t('common_cancel'),
    okButtonProps: { danger: true },
    onOk: async () => {
      busy.value = true
      busyAction.value = 'restore-' + snap.dirPath
      error.value = ''
      try {
        const r = await window.hh.backupRestore(g.id, snap.dirPath!)
        if (!r.ok) {
          error.value = r.error
        } else {
          // 主进程随返回值带出 skippedCount/skippedBytes：恢复只回拷 files 清单，
          // 快照缺的那些不会回来，成功提示里必须补一句（toast 挂 data-testid 供回归靶断言）。
          message.success({
            content: h('span', { 'data-testid': 'backup-restore-toast' }, restoreSuccessText(r)),
          })
        }
      } catch (e) {
        error.value = e instanceof Error ? e.message : String(e)
      } finally {
        busy.value = false
        busyAction.value = ''
      }
    },
  })
}

function deleteSnapshot(snap: SnapshotInfo): void {
  const g = game.value
  if (!g || busy.value || !snap.dirPath) return
  Modal.confirm({
    title: t('backup_del_title'),
    content: t('backup_del_confirm'),
    okText: t('common_delete'),
    cancelText: t('common_cancel'),
    okButtonProps: { danger: true },
    onOk: async () => {
      busy.value = true
      busyAction.value = 'delete-' + snap.dirPath
      error.value = ''
      try {
        const r = await window.hh.backupDelete(g.id, snap.dirPath!)
        if (r && r.ok === false) {
          error.value = r.error || t('backup_del_fail')
        } else {
          await reload()
        }
      } catch (e) {
        error.value = e instanceof Error ? e.message : String(e)
      } finally {
        busy.value = false
        busyAction.value = ''
      }
    },
  })
}

async function syncSnapshot(snap: SnapshotInfo): Promise<void> {
  const g = game.value
  if (!g || busy.value || !snap.dirPath) return
  busy.value = true
  busyAction.value = 'sync-' + snap.dirPath
  error.value = ''
  try {
    const r = await window.hh.backupSync(g.id, snap.dirPath)
    if ('errors' in r) {
      if (r.errors.length) {
        error.value = tf('backup_sync_partial', { n: r.errors.length, first: r.errors[0] })
      } else {
        message.success(tf('backup_sync_ok', { up: r.uploaded, down: r.downloaded }))
      }
    } else if (!r.ok) {
      error.value = r.error
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
    busyAction.value = ''
  }
}
</script>

<template>
  <DialogShell v-model:open="open" :title="t('backup_title')" :width="600">
    <div class="backup-body">
      <div class="head-row">
        <div class="title-wrap">
          <div class="game-title">{{ game?.title ?? '' }}</div>
          <div class="hint" v-if="stats">{{ tf('backup_local_count', { n: stats.snapshots.length }) }}</div>
          <div class="hint" v-else>{{ t('backup_none') }}</div>
        </div>
        <button class="btn primary" :disabled="busy || !game" @click="createBackup">
          <DatabaseBackup :size="14" />
          {{ busy && busyAction === 'create' ? t('backup_busy') : t('backup_now') }}
        </button>
      </div>

      <div v-if="error" class="error-bar">{{ error }}</div>
      <div v-if="skipNotice" class="skip-bar">{{ skipNotice }}</div>
      <div v-if="loading" class="loading">{{ t('backup_loading') }}</div>

      <div v-if="!loading && stats?.snapshots.length" class="snap-list">
        <div v-for="snap in stats.snapshots" :key="snap.dirPath" class="snap-row">
          <div class="snap-info">
            <div class="snap-time">{{ fmtTime(snap.createdAt) }}</div>
            <div class="snap-meta">{{ fmtCount(snap.files) }} · {{ fmtSize(snap.totalBytes) }}</div>
            <!-- 不是全集的快照要在这里就说清：恢复只回拷 files 清单里的文件 -->
            <div v-if="snap.skippedCount && snap.skippedCount > 0" class="snap-skip" data-testid="backup-snap-skip">
              {{ snapSkipText(snap) }}
            </div>
          </div>
          <div class="snap-actions">
            <button class="btn ghost" :disabled="busy" :title="t('backup_sync_btn')" @click="syncSnapshot(snap)">
              <CloudUpload :size="13" />
              {{ busy && busyAction === 'sync-' + snap.dirPath ? t('backup_syncing') : t('backup_cloud') }}
            </button>
            <button
              class="btn ghost"
              data-testid="backup-snap-restore"
              :disabled="busy"
              :title="t('backup_restore_ok')"
              @click="restoreSnapshot(snap)"
            >
              <HardDriveDownload :size="13" />
              {{ busy && busyAction === 'restore-' + snap.dirPath ? t('backup_restoring') : t('backup_restore_ok') }}
            </button>
            <button class="btn ghost danger" :disabled="busy" :title="t('common_delete')" @click="deleteSnapshot(snap)">
              <Trash2 :size="13" />
              {{ busy && busyAction === 'delete-' + snap.dirPath ? t('backup_deleting') : t('common_delete') }}
            </button>
          </div>
        </div>
      </div>

      <div v-if="!loading && !stats?.snapshots.length" class="empty">
        <div class="empty-text">{{ t('backup_empty') }}</div>
      </div>

      <div class="foot-hint">
        <RefreshCw :size="11" class="foot-icon" />
        {{ tf('backup_rotation', { n: stats?.snapshots.length ?? 0 }) }}
      </div>
    </div>
  </DialogShell>
</template>

<style scoped>
.backup-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-top: 4px;
}
.head-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.title-wrap {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.game-title {
  font-size: var(--hh-font-bodyLg-size);
  font-weight: 600;
  color: var(--hh-color-text-glow);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hint {
  font-size: var(--hh-font-caption-size);
  color: var(--hh-color-text-dim);
}
.error-bar {
  font-size: 12.5px;
  color: var(--hh-color-error-text);
  background: var(--hh-color-error-soft-bg);
  border: 1px solid var(--hh-color-error);
  border-radius: var(--hh-radius-sm);
  padding: 8px 10px;
  word-break: break-all;
}
.skip-bar {
  font-size: 12.5px;
  color: var(--hh-color-warning);
  background: var(--hh-color-warning-soft-bg);
  border: 1px solid var(--hh-color-warning);
  border-radius: var(--hh-radius-sm);
  padding: 8px 10px;
  word-break: break-all;
}
.loading {
  font-size: var(--hh-font-body-size);
  color: var(--hh-color-text-dim);
  padding: 18px 0;
  text-align: center;
}
.snap-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 320px;
  overflow-y: auto;
}
.snap-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  background: var(--hh-color-surface-soft);
  border: 1px solid var(--hh-color-panel-glass-border);
  border-radius: var(--hh-radius-md);
  padding: 10px 12px;
}
.snap-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.snap-time {
  font-size: var(--hh-font-body-size);
  font-weight: 600;
  color: var(--hh-color-text-stronger);
  font-variant-numeric: tabular-nums;
}
.snap-meta {
  font-size: var(--hh-font-caption-size);
  color: var(--hh-color-text-dim);
}
/* 未纳入提示用小字 + 警告色：是提醒，不是错误条（错误条另有 .error-bar） */
.snap-skip {
  font-size: 11.5px;
  color: var(--hh-color-warning);
  line-height: 1.4;
}
.snap-actions {
  display: flex;
  gap: 6px;
  flex: none;
}
.empty {
  border: 1px dashed var(--hh-color-card-border);
  border-radius: var(--hh-radius-md);
  padding: 22px 14px;
  text-align: center;
}
.empty-text {
  font-size: 12.5px;
  color: var(--hh-color-text-muted);
}
.foot-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--hh-color-text-dim);
}
.foot-icon {
  flex: none;
  color: var(--hh-color-text-tertiary);
}
.btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 30px;
  padding: 0 12px;
  border-radius: var(--hh-radius-sm);
  font-size: 12.5px;
  cursor: pointer;
  border: none;
}
.btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.btn.primary {
  background: var(--hh-color-accent);
  color: var(--hh-color-on-accent);
  font-weight: 600;
}
.btn.ghost {
  background: var(--hh-color-surface-soft);
  border: 1px solid var(--hh-color-border-ghost-soft);
  color: var(--hh-color-text-strong);
}
.btn.danger {
  color: var(--hh-color-error-text);
}
</style>
