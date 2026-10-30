/**
 * detailShared.ts —— 详情面板拆分后，元数据行 / 分页 pane / 父面板共用的小工具。
 * fmtPlay / fmtDate 与拆分前 DetailPanel.vue 内的实现逐字节一致；
 * lengthTextOf 由原 lengthText computed 展开为纯函数，判断分支与插值不变（调用方传同一个 game）。
 */
import { tf } from '../i18n'
import type { Game } from '../../shared/types'

export function fmtPlay(ms: number): string {
  if (ms <= 0) return '—'
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  return h > 0 ? tf('dp_hours_min', { h, m }) : tf('dp_minutes', { m })
}

export function fmtDate(ts?: number): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleDateString('zh-CN')
}

/** 平均通关时长：分钟 → 可读文本（VNDB length_minutes）。 */
export function lengthTextOf(game: Game | null | undefined): string {
  const m = game?.lengthMinutes
  if (!m || m <= 0) return ''
  if (m < 60) return tf('dp_minutes', { m })
  const h = Math.floor(m / 60)
  const rem = m % 60
  return rem > 0 ? tf('dp_hours_min', { h, m: rem }) : tf('dp_hours', { h })
}
