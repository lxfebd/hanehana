<script setup lang="ts">
/**
 * 快捷键帮助面板（`?` / `F1` 呼出）。
 *
 * 存在的理由：快捷键实现了却没人知道 = 没实现。桌面软件（Steam/Playnite/VS Code）
 * 都把帮助做成「一个键随时能翻」的面板，而不是写在 README 里。
 * 内容与 useGlobalShortcuts 的实现一一对应——改快捷键必须同步这里，
 * 所以面板直接从同一份定义渲染（见 shortcutGroups 的来源注释）。
 */
import { computed } from 'vue'
import { t } from '../i18n'

const open = defineModel<boolean>('open', { default: false })

/**
 * 快捷键分组。i18n key 命名规则：sc_<分组>_<动作>，两组各一份中英文。
 * 不用 SHORTCUTS 常量导出的原因是：实现里按键判断有先后顺序和条件分支
 * （比如 Space 只在非 button 焦点生效），拆成常量反而容易和实现脱节；
 * 这里手写一份「用户视角」的表，加/改快捷键时实现与本面板同一次改动里更新。
 */
const groups = computed(() => [
  {
    title: t('sc_group_nav'),
    items: [
      { keys: ['1'], desc: t('sc_nav_library') },
      { keys: ['2'], desc: t('sc_nav_downloads') },
      { keys: ['3'], desc: t('sc_nav_sites') },
    ],
  },
  {
    title: t('sc_group_library'),
    items: [
      { keys: ['Ctrl', 'F'], desc: t('sc_focus_search') },
      { keys: ['Space'], desc: t('sc_launch') },
      { keys: ['Esc'], desc: t('sc_esc') },
      { keys: ['Ctrl', 'A'], desc: t('sc_select_all') },
      { keys: ['Delete'], desc: t('sc_remove') },
      { keys: ['F5'], desc: t('sc_refresh') },
      { keys: ['↑', '↓', '←', '→'], desc: t('sc_move') },
      { keys: ['Enter'], desc: t('sc_open_detail') },
    ],
  },
  {
    title: t('sc_group_help'),
    items: [
      { keys: ['?'], desc: t('sc_help_panel') },
      { keys: ['F1'], desc: t('sc_help_panel') },
    ],
  },
])
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="sc-mask" @click.self="open = false">
      <div class="sc-panel glass" role="dialog" aria-modal="true" :aria-label="t('sc_title')">
        <header class="sc-head">
          <div class="sc-title">{{ t('sc_title') }}</div>
          <button class="sc-close" type="button" :aria-label="t('common_close')" @click="open = false">✕</button>
        </header>
        <div class="sc-body">
          <section v-for="(grp, gi) in groups" :key="gi" class="sc-group">
            <h3 class="sc-group-title">{{ grp.title }}</h3>
            <div v-for="(it, ii) in grp.items" :key="ii" class="sc-row">
              <span class="sc-keys">
                <kbd v-for="(k, ki) in it.keys" :key="ki" :class="{ plus: ki > 0 }">{{ k }}</kbd>
              </span>
              <span class="sc-desc">{{ it.desc }}</span>
            </div>
          </section>
        </div>
        <footer class="sc-foot">{{ t('sc_foot') }}</footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.sc-mask {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(4px);
}
.sc-panel {
  width: 420px;
  max-width: calc(100vw - 48px);
  max-height: calc(100vh - 48px);
  display: flex;
  flex-direction: column;
  border-radius: var(--hh-radius-modal);
  overflow: hidden;
  color: var(--hh-color-text-strong);
}
.sc-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px 0;
}
.sc-title {
  font-size: var(--hh-font-subtitle-size);
  font-weight: 700;
  color: var(--hh-color-text-glow);
}
.sc-close {
  width: 28px;
  height: 28px;
  border: none;
  border-radius: var(--hh-radius-sm);
  background: transparent;
  color: var(--hh-color-text-dim);
  cursor: pointer;
}
.sc-close:hover {
  background: var(--hh-color-surface-mid);
  color: var(--hh-color-text-strong);
}
.sc-body {
  padding: 12px 18px;
  overflow-y: auto;
}
.sc-group {
  margin-bottom: 14px;
}
.sc-group:last-child {
  margin-bottom: 0;
}
.sc-group-title {
  margin: 0 0 8px;
  font-size: var(--hh-font-caption-size);
  font-weight: 600;
  color: var(--hh-color-text-dim);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.sc-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 4px 0;
}
.sc-keys {
  flex: none;
  display: flex;
  align-items: center;
  gap: 3px;
  min-width: 108px;
}
kbd {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 22px;
  height: 22px;
  padding: 0 6px;
  border: 1px solid var(--hh-color-border-ghost-soft);
  border-bottom-width: 2px;
  border-radius: var(--hh-radius-xs);
  background: var(--hh-color-surface-mid);
  color: var(--hh-color-text-strong);
  font-family: var(--hh-font-mono);
  font-size: 11px;
  line-height: 1;
}
kbd.plus::before {
  content: '+';
  margin-right: 3px;
  color: var(--hh-color-text-dim);
}
.sc-desc {
  font-size: var(--hh-font-body-size);
  color: var(--hh-color-text-secondary);
}
.sc-foot {
  padding: 10px 18px 14px;
  border-top: 1px solid var(--hh-color-border-faint);
  font-size: var(--hh-font-caption-size);
  color: var(--hh-color-text-dim);
}
</style>
