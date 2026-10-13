<script setup lang="ts">
/**
 * The common header of a page (D-194), the same shape as the sections of the
 * settings (Novità, Sviluppo): the title in the normal font at 21 px, with an
 * optional icon or character before it, one sentence under it saying what
 * the page is for, and the actions on the right. On a phone the actions go
 * under the title.
 */
defineProps<{
  title: string;
  /** Id of the h1, for an aria-labelledby of the page. */
  titleId?: string;
}>();
</script>

<template>
  <header class="flex flex-wrap items-start gap-x-4 gap-y-2">
    <div class="min-w-[min(260px,100%)] flex-1">
      <h1 :id="titleId" class="flex items-center gap-2.5 text-[21px] leading-tight font-semibold">
        <slot name="icon" />
        <span class="min-w-0">{{ title }}</span>
      </h1>
      <p v-if="$slots.default" class="mt-1 max-w-[720px] text-[14.5px] text-muted"><slot /></p>
    </div>
    <div v-if="$slots.actions" class="flex flex-wrap items-center gap-2 pt-0.5">
      <slot name="actions" />
    </div>
  </header>
</template>
