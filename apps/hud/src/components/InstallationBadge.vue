<script setup lang="ts">
import { MODE_BADGE, MODE_HINT, type InstallationInfo } from '../lib/installation.ts';

/** SVILUPPO or PRODUZIONE (D-098), always in the top bar. */
defineProps<{ info: InstallationInfo }>();
</script>

<template>
  <span
    class="inline-flex shrink-0 items-center rounded-[5px] border px-1.5 py-1 font-mono text-[10px] leading-none font-semibold tracking-[0.1em]"
    :class="info.mode === 'development' ? 'border-warn/70 bg-warn/10 text-warn' : 'border-ok/60 text-ok'"
    :title="`${MODE_HINT[info.mode]} · cartella ${info.home}${info.version === null ? '' : ` · ${info.version}`}`"
  >
    {{ MODE_BADGE[info.mode] }}
  </span>
</template>
