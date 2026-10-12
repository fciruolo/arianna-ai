<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';

import { loadDesignStyle, loadSkill } from '../lib/api.ts';
import { studioErrorText } from '../lib/studio.ts';
import Icon from './Icon.vue';

/**
 * The whole text of a style (its DESIGN.md) or of a skill (its SKILL.md),
 * with the license notice at the head (I-20, D-185): opened from the line
 * that says what a variant was made with.
 */
const props = defineProps<{ kind: 'style' | 'skill'; id: string; title: string }>();
const emit = defineEmits<{ close: [] }>();

const text = ref<string | null>(null);
const problem = ref<string | null>(null);
const dialog = ref<HTMLElement | null>(null);

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close');
}
onMounted(async () => {
  window.addEventListener('keydown', onKey);
  dialog.value?.focus();
  try {
    text.value = props.kind === 'style' ? (await loadDesignStyle(props.id)).text : (await loadSkill(props.id)).text;
  } catch (cause) {
    problem.value = studioErrorText(cause);
  }
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey);
});
</script>

<template>
  <div class="fixed inset-0 z-[60] grid place-items-center bg-black/50 p-4" @click.self="emit('close')">
    <section ref="dialog" role="dialog" aria-modal="true" aria-labelledby="design-text-title" tabindex="-1" class="hud-card flex h-[min(760px,90vh)] w-full max-w-[820px] flex-col bg-surface outline-none">
      <header class="flex shrink-0 items-center gap-2.5 border-b border-line px-[15px] py-2.5">
        <span class="hud-title text-[10px]">{{ kind === 'style' ? 'Stile' : 'Skill' }}</span>
        <h2 id="design-text-title" class="min-w-0 flex-1 truncate font-medium">{{ title }}</h2>
        <button type="button" class="rounded-md p-1 text-muted hover:text-ink" aria-label="Chiudi" @click="emit('close')"><Icon name="close" :size="16" /></button>
      </header>
      <p v-if="problem !== null" class="p-[15px] text-sm text-danger" role="alert">{{ problem }}</p>
      <p v-else-if="text === null" class="p-[15px] text-sm text-muted">Leggo…</p>
      <pre v-else class="min-h-0 flex-1 overflow-auto p-[15px] font-mono text-[12px] leading-relaxed whitespace-pre-wrap">{{ text }}</pre>
    </section>
  </div>
</template>
