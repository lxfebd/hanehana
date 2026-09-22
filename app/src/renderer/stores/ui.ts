/**
 * 全局 UI 领域 store（REDESIGN-SPEC §3.2）。
 *
 * 页面切换与设置弹窗开关。深色主题固定唯一（dark 不再可配），
 * 保留字段语义便于将来扩展。
 */
import { reactive } from 'vue'

export const ui = reactive({
  page: 'library' as 'library' | 'downloads',
  settingsOpen: false,
  dark: true,
})
