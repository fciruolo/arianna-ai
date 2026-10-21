<script setup lang="ts">
/**
 * Where a part moved to «Seguiti» (D-272) used to be: one line and the link
 * «Ora in Seguiti», which opens the page inside the app.
 */
import { FOLLOWED_PATH, openInside } from '../lib/route.ts';
import Icon from './Icon.vue';

defineProps<{ what: string }>();
</script>

<template>
  <p class="flex flex-wrap items-center gap-2 rounded-[10px] border border-line bg-surface-2 px-3 py-2.5 text-[14px]" role="note">
    <Icon name="followed" :size="16" class="text-muted" />
    <span class="min-w-[200px] flex-1 text-muted">{{ what }}</span>
    <a :href="FOLLOWED_PATH" class="font-medium text-accent hover:underline" @click="openInside($event, FOLLOWED_PATH)">Ora in Seguiti</a>
  </p>
</template>
