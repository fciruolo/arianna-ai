<script setup lang="ts">
import { ICONS, type IconName } from '../icons.ts';

// Decorative by default: the button or link around it carries the name.
withDefaults(defineProps<{ name: IconName; size?: number }>(), { size: 18 });
</script>

<template>
  <component :is="ICONS[name]" :size="size" :stroke-width="1.7" aria-hidden="true" class="shrink-0" />
</template>
