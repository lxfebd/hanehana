<script setup lang="ts">
import { Tag } from 'ant-design-vue'
import type { StatusBadge } from '../status'

defineProps<{ badge: StatusBadge }>()
</script>

<template>
  <Tag :color="badge.tone" class="st">{{ badge.label }}</Tag>
</template>

<style scoped>
.st {
  margin-inline-end: 0;
  font-size: 12px;
  line-height: 18px;
  border-radius: 6px;
  padding: 0 8px;
}
</style>