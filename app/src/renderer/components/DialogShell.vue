<script setup lang="ts">
/**
 * 统一弹层壳（P2-2）：backdrop + 可选标题 + 正文/页脚插槽。
 * 替代各对话框里手写的 antd Modal，圆角/字号只走 tokens；
 * 关闭：点遮罩 / Esc（可关掉）。footer 默认空——多数对话框内容里自带按钮。
 */
import { onBeforeUnmount, onMounted, watch } from 'vue'
import { X } from 'lucide-vue-next'

const open = defineModel<boolean>('open')
const props = withDefaults(
  defineProps<{
    title?: string
    width?: number | string
    /** 点遮罩是否关闭（破坏性流程可关掉） */
    maskClosable?: boolean
  }>(),
  { maskClosable: true },
)

function close(): void {
  open.value = false
}

function onMaskClick(): void {
  if (props.maskClosable) close()
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && open.value) {
    e.stopPropagation()
    close()
  }
}

watch(open, (on) => {
  if (on) window.addEventListener('keydown', onKeydown, true)
  else window.removeEventListener('keydown', onKeydown, true)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown, true)
})
onMounted(() => {
  if (open.value) window.addEventListener('keydown', onKeydown, true)
})
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="ds-mask" @click.self="onMaskClick">
      <div
        class="ds-panel glass"
        role="dialog"
        aria-modal="true"
        :style="width ? { width: typeof width === 'number' ? `${width}px` : width } : undefined"
      >
        <header v-if="title || $slots.title" class="ds-head">
          <div class="ds-title">
            <slot name="title">{{ title }}</slot>
          </div>
          <button class="ds-close" type="button" title="关闭" aria-label="关闭" @click="close">
            <X :size="16" />
          </button>
        </header>
        <div class="ds-body">
          <slot />
        </div>
        <footer v-if="$slots.footer" class="ds-foot">
          <slot name="footer" />
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.ds-mask {
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
.ds-panel {
  display: flex;
  flex-direction: column;
  max-width: min(100%, calc(100vw - 48px));
  max-height: calc(100vh - 48px);
  border-radius: var(--hh-radius-modal);
  overflow: hidden;
  color: var(--hh-color-text-strong);
}
.ds-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 18px 0;
}
.ds-title {
  font-size: var(--hh-font-subtitle-size);
  font-weight: 600;
  color: var(--hh-color-text-glow);
}
.ds-close {
  flex: none;
  width: 30px;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: var(--hh-radius-sm);
  background: transparent;
  color: var(--hh-color-text-dim);
  cursor: pointer;
}
.ds-close:hover {
  background: var(--hh-color-surface-mid);
  color: var(--hh-color-text-strong);
}
.ds-body {
  padding: 14px 18px 18px;
  overflow: auto;
  min-height: 0;
}
.ds-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 0 18px 16px;
}
</style>
