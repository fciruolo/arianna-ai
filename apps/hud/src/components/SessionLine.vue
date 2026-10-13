<script setup lang="ts">
import { SESSION_LINE } from '../lib/commitments.ts';

withDefaults(defineProps<{ text?: string }>(), { text: SESSION_LINE });
</script>

<!-- The secretary (D-146), a direct chat with the Designer (D-185): where the session the agent reads begins. -->
<template>
  <p class="flex items-center gap-3 text-[12.5px] text-muted" role="separator">
    <span class="h-px flex-1 bg-line" aria-hidden="true"></span>{{ text }}<span class="h-px flex-1 bg-line" aria-hidden="true"></span>
  </p>
</template>
