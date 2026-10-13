<script setup lang="ts">
/**
 * One card of the settings page (D-071, revised in D-192): a plain box with
 * an optional title in the normal font, something on its right (a switch, a
 * pill) and a short description. Saving is not here: one bar per section,
 * shown only with edits (SettingsSaveBar).
 */
defineProps<{
  id?: string;
  title?: string;
  description?: string;
  /** Locked while saving: what is typed meanwhile would be overwritten by the answer. */
  busy?: boolean;
}>();
</script>

<template>
  <section :id="id" class="min-w-0 scroll-mt-4 rounded-xl border border-line bg-surface-2 p-4" :aria-labelledby="id !== undefined && title !== undefined ? `${id}-title` : undefined">
    <h2 v-if="title !== undefined || $slots.header" class="mb-1 flex flex-wrap items-center gap-2.5 text-[16px] font-semibold">
      <span v-if="title !== undefined" :id="id !== undefined ? `${id}-title` : undefined">{{ title }}</span>
      <span v-if="$slots.header" class="ml-auto flex flex-wrap items-center gap-2 text-[14px] font-normal text-muted"><slot name="header" /></span>
    </h2>
    <p v-if="description !== undefined" class="mb-3 max-w-[80ch] text-[14px] text-muted">{{ description }}</p>
    <fieldset :disabled="busy" class="m-0 flex min-w-0 flex-col gap-3 border-0 p-0" :class="{ 'mt-2': title !== undefined && description === undefined }">
      <slot />
    </fieldset>
  </section>
</template>
