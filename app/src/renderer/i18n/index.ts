/**
 * i18n 骨架（G18）：轻量语言包。
 *
 * 只搭「词典 + t()」骨架，不全量翻译：核心导航/侧栏/按钮走 t()，
 * 长文案（设置页 hint、错误说明）仍用中文，后续按需补词条。
 * 词典是扁平键值，类型安全（key 必须两边都在）。
 */
import { ref, type Ref } from 'vue'
import type { UILanguage } from '../../shared/types'

const zh = {
  nav_library: '全部游戏',
  nav_downloads: '下载任务',
  nav_stats: '统计',
  nav_games: '游戏站',
  nav_settings: '设置',
  nav_fullscreen: '全屏模式',
  nav_steam_import: 'Steam 导入',
  toolbar_search_placeholder: '搜索游戏 / 标签 / 原文名…',
  toolbar_search_regex_placeholder: '正则匹配（如 ^恋.*＄）',
  toolbar_regex: '正则搜索',
  toolbar_export: '导出游戏库',
  toolbar_export_csv: '导出 CSV',
  toolbar_export_json: '导出 JSON',
  toolbar_fav: '只看收藏',
  toolbar_select: '多选模式',
  toolbar_grid: '网格视图',
  toolbar_list: '列表视图',
  toolbar_all: '全部',
  toolbar_smart: '智能列表',
  lib_empty: '游戏库还是空的',
  lib_empty_hint: '点「扫描导入」选择游戏目录，自动识别 exe 入库',
  lib_scan: '扫描导入',
  lib_add_one: '添加游戏',
  lib_no_match: '没有匹配的游戏',
  lib_clear: '清除筛选',
  detail_launch: '启动游戏',
  detail_running: '运行中',
  detail_scrape: '刮削',
  detail_edit: '编辑',
  detail_dir: '目录',
  detail_fav: '收藏',
  detail_faved: '已收藏',
  detail_backup: '备份',
  detail_backup_on: '备份已开',
  detail_backup_records: '备份记录',
  detail_empty: '点击封面查看详情',
  count_suffix: '款',
} as const

const en: Record<keyof typeof zh, string> = {
  nav_library: 'Library',
  nav_downloads: 'Downloads',
  nav_stats: 'Stats',
  nav_games: 'Sites',
  nav_settings: 'Settings',
  nav_fullscreen: 'Fullscreen',
  nav_steam_import: 'Steam Import',
  toolbar_search_placeholder: 'Search games / tags / titles…',
  toolbar_search_regex_placeholder: 'Regex pattern (e.g. ^Koi.*$)',
  toolbar_regex: 'Regex search',
  toolbar_export: 'Export library',
  toolbar_export_csv: 'Export CSV',
  toolbar_export_json: 'Export JSON',
  toolbar_fav: 'Favorites only',
  toolbar_select: 'Multi-select',
  toolbar_grid: 'Grid view',
  toolbar_list: 'List view',
  toolbar_all: 'All',
  toolbar_smart: 'Smart lists',
  lib_empty: 'Your library is empty',
  lib_empty_hint: 'Click "Scan Import" to pick a folder and auto-add games',
  lib_scan: 'Scan Import',
  lib_add_one: 'Add Game',
  lib_no_match: 'No matching games',
  lib_clear: 'Clear filters',
  detail_launch: 'Launch',
  detail_running: 'Running',
  detail_scrape: 'Scrape',
  detail_edit: 'Edit',
  detail_dir: 'Folder',
  detail_fav: 'Favorite',
  detail_faved: 'Favorited',
  detail_backup: 'Backup',
  detail_backup_on: 'Backup on',
  detail_backup_records: 'Backups',
  detail_empty: 'Click a cover to view details',
  count_suffix: 'items',
}

export type I18nKey = keyof typeof zh

const dicts: Record<UILanguage, Record<I18nKey, string>> = { zh, en }

/** 当前语言（响应式：切语言时 UI 自动重渲染）。 */
export const lang: Ref<UILanguage> = ref('zh')

export function setLanguage(l: UILanguage): void {
  lang.value = l
}

/** 取翻译。键不存在时回落 zh，再回落到键名（骨架期允许未翻译词条）。 */
export function t(key: I18nKey): string {
  const d: Record<string, string> = dicts[lang.value]
  if (key in d) return d[key]
  if (key in zh) return zh[key as keyof typeof zh]
  return key
}