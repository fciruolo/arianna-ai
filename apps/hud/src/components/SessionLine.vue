<script setup lang="ts">
import { SESSION_LINE } from '../lib/commitments.ts';
</script>

<!-- The secretary (D-146): where the session Arianna reads begins. -->
<template>
  <p class="flex items-center gap-3 text-[11.5px] text-muted" role="separator">
    <span class="h-px flex-1 bg-line" aria-hidden="true"></span>{{ SESSION_LINE }}<span class="h-px flex-1 bg-line" aria-hidden="true"></span>
  </p>
</template>
