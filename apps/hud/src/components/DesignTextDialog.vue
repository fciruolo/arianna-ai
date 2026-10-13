<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';

import { loadDesignStyle, loadSkill, loadStyleExamples, readStyleExample } from '../lib/api.ts';
import { studioErrorText } from '../lib/studio.ts';
import Icon from './Icon.vue';
import StudioFrame from './StudioFrame.vue';

/**
 * A style or a skill, opened from the line that says what a variant was made
 * with (I-20, D-185). A style shows its examples first (landing and
 * presentation written by Opus, in an isolated frame) when it has them, then
 * its DESIGN.md; a skill its SKILL.md. The license notice heads the text.
 */
const props = defineProps<{ kind: 'style' | 'skill'; id: string; title: string }>();
const emit = defineEmits<{ close: [] }>();

type View = 'landing' | 'deck' | 'text';
const view = ref<View>('text');
const hasExample = ref(false);
const text = ref<string | null>(null);
const example = ref<{ kind: 'landing' | 'deck'; text: string } | null>(null);
const problem = ref<string | null>(null);
const dialog = ref<HTMLElement | null>(null);

async function show(next: View): Promise<void> {
  view.value = next;
  problem.value = null;
  try {
    if (next === 'text') {
      text.value ??= props.kind === 'style' ? (await loadDesignStyle(props.id)).text : (await loadSkill(props.id)).text;
    } else if (example.value?.kind !== next) {
      example.value = null;
      example.value = { kind: next, text: await readStyleExample(props.id, next) };
    }
  } catch (cause) {
    problem.value = studioErrorText(cause);
  }
}

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close');
}
onMounted(async () => {
  window.addEventListener('keydown', onKey);
  dialog.value?.focus();
  if (props.kind === 'style') {
    hasExample.value = await loadStyleExamples().then(
      (status) => status.examples[props.id] !== undefined,
      () => false,
    );
  }
  await show(hasExample.value ? 'landing' : 'text');
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey);
});
</script>

<template>
  <div class="fixed inset-0 z-[60] grid place-items-center bg-black/50 p-4" @click.self="emit('close')">
    <section ref="dialog" role="dialog" aria-modal="true" aria-labelledby="design-text-title" tabindex="-1" class="hud-card flex h-[min(820px,92vh)] w-full max-w-[1000px] flex-col bg-surface outline-none">
      <header class="flex shrink-0 flex-wrap items-center gap-2.5 border-b border-line px-[15px] py-2.5">
        <span class="hud-title text-[12px]">{{ kind === 'style' ? 'Stile' : 'Skill' }}</span>
        <h2 id="design-text-title" class="min-w-0 flex-1 truncate font-medium">{{ title }}</h2>
        <span v-if="hasExample" class="flex gap-1" role="group" aria-label="Cosa vedi">
          <button v-for="item in (['landing', 'deck', 'text'] as const)" :key="item" type="button" class="rounded-md px-2.5 py-1 text-xs" :class="view === item ? 'bg-surface-2 text-ink' : 'text-muted hover:text-ink'" :aria-pressed="view === item" @click="show(item)">
            {{ item === 'landing' ? 'Landing' : item === 'deck' ? 'Presentazione' : 'Descrizione' }}
          </button>
        </span>
        <button type="button" class="rounded-md p-1 text-muted hover:text-ink" aria-label="Chiudi" @click="emit('close')"><Icon name="close" :size="16" /></button>
      </header>
      <p v-if="problem !== null" class="p-[15px] text-sm text-danger" role="alert">{{ problem }}</p>
      <template v-else-if="view === 'text'">
        <p v-if="kind === 'style' && !hasExample" class="border-b border-line px-[15px] py-2 text-xs text-muted">Questo stile non ha ancora esempi: si generano dalla finestra «Stile e skill» con «Genera esempio».</p>
        <p v-if="text === null" class="p-[15px] text-sm text-muted">Leggo…</p>
        <pre v-else class="min-h-0 flex-1 overflow-auto p-[15px] font-mono text-[13px] leading-relaxed whitespace-pre-wrap">{{ text }}</pre>
      </template>
      <p v-else-if="example === null" class="p-[15px] text-sm text-muted">Leggo…</p>
      <div v-else class="min-h-0 flex-1 p-2">
        <StudioFrame :key="`${id}-${example.kind}`" class="h-full" :source="example.text" :title="`Esempio ${title}`" />
      </div>
    </section>
  </div>
</template>
