<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import { parseMockup, readEditable } from '../lib/studio-dom.ts';
import { EDIT_STYLES, EDIT_TEXT_MAX, STUDIO_EDIT_CHANGED, STYLE_HINT, STYLE_LABEL, validStyle, type EditStyle, type StudioEdit } from '../lib/studio.ts';
import Icon from './Icon.vue';

/**
 * The direct edit of one element (I-19, D-184, O6): its text, when it holds
 * text alone, and the allowed styles, read from the source of the file (not
 * from the live frame). "Salva" hands the edit to the page, which writes it
 * with the `base` it read.
 */
const props = defineProps<{ source: string; selector: string; tag: string; excerpt: string; saving: boolean }>();
const emit = defineEmits<{ save: [edit: StudioEdit]; close: [] }>();

const editable = computed(() => readEditable(parseMockup(props.source), props.selector, props.excerpt));
const text = ref('');
const segments = ref<string[]>([]);
const styles = ref<Record<EditStyle, string>>(Object.fromEntries(EDIT_STYLES.map((name) => [name, ''])) as Record<EditStyle, string>);

watch(
  editable,
  (value) => {
    text.value = value?.text ?? '';
    segments.value = [...(value?.segments ?? [])];
    styles.value = { ...(value?.styles ?? (Object.fromEntries(EDIT_STYLES.map((name) => [name, ''])) as Record<EditStyle, string>)) };
  },
  { immediate: true },
);

const segmentsChanged = computed(() => segments.value.some((piece, at) => piece.trim() !== (editable.value?.segments[at] ?? '')));
const invalid = computed(() => EDIT_STYLES.filter((name) => !validStyle(name, styles.value[name])));
const changed = computed(() => {
  const value = editable.value;
  if (value === undefined) return false;
  return (value.textEditable && text.value !== value.text) || segmentsChanged.value || EDIT_STYLES.some((name) => styles.value[name].trim() !== value.styles[name]);
});

function save(): void {
  const value = editable.value;
  if (value === undefined || !value.matches || invalid.value.length > 0 || text.value.length > EDIT_TEXT_MAX) return;
  const changedStyles: StudioEdit['styles'] = {};
  for (const name of EDIT_STYLES) if (styles.value[name].trim() !== value.styles[name]) changedStyles[name] = styles.value[name].trim();
  emit('save', {
    selector: props.selector,
    ...(value.textEditable && text.value !== value.text ? { text: text.value } : {}),
    ...(segmentsChanged.value ? { segments: segments.value.map((piece) => piece.trim()) } : {}),
    styles: changedStyles,
  });
}
</script>

<template>
  <section class="flex flex-col gap-3 rounded-xl border border-line bg-surface p-3 text-[13px]" aria-label="Modifica diretta">
    <header class="flex items-center gap-2">
      <Icon name="rename" :size="14" />
      <h3 class="flex-1 font-medium">Modifica <code class="font-mono text-[12px]">&lt;{{ tag }}&gt;</code></h3>
      <button type="button" class="rounded-md p-1 text-muted hover:bg-surface-2 hover:text-ink" aria-label="Chiudi la modifica" @click="emit('close')"><Icon name="close" :size="14" /></button>
    </header>
    <p class="truncate font-mono text-[10.5px] text-muted" :title="selector">{{ selector }}</p>
    <p v-if="editable === undefined" class="text-xs text-warn">
      Questo elemento non c’è nel file: l’hanno aggiunto gli script della pagina. Scegline un altro, o chiedi la modifica al Designer con un commento.
    </p>
    <p v-else-if="!editable.matches" class="text-xs text-warn" role="alert">{{ STUDIO_EDIT_CHANGED }}</p>
    <template v-else>
      <label v-if="editable.textEditable" class="flex flex-col gap-1">
        <span class="text-xs text-muted">Testo</span>
        <textarea v-model="text" class="field min-h-[64px] resize-y px-2.5 py-1.5" :maxlength="EDIT_TEXT_MAX" />
      </label>
      <template v-else-if="editable.segments.length > 0">
        <p class="text-xs text-muted">Il testo di questo elemento è diviso da altri elementi (per esempio un corsivo): qui cambi i suoi pezzi; quelli negli elementi interni li cambi scegliendo l’elemento.</p>
        <label v-for="(_, at) in segments" :key="at" class="flex flex-col gap-1">
          <span class="text-xs text-muted">Testo, pezzo {{ at + 1 }} di {{ segments.length }}</span>
          <textarea v-model="segments[at]" class="field min-h-[44px] resize-y px-2.5 py-1.5" :maxlength="EDIT_TEXT_MAX" />
        </label>
      </template>
      <p v-else class="text-xs text-muted">Il testo di questo elemento sta negli elementi interni: cambialo scegliendo l’elemento più interno.</p>
      <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label v-for="name in EDIT_STYLES" :key="name" class="flex flex-col gap-1">
          <span class="text-xs text-muted">{{ STYLE_LABEL[name] }}</span>
          <input
            v-model="styles[name]"
            type="text"
            class="field px-2.5 py-1 font-mono text-[12px]"
            :class="{ 'border-danger': invalid.includes(name) }"
            :placeholder="STYLE_HINT[name]"
            :aria-invalid="invalid.includes(name) ? 'true' : undefined"
            spellcheck="false"
          />
        </label>
      </div>
      <p v-if="invalid.length > 0" class="text-xs text-danger" role="alert">
        Valori non accettati: {{ invalid.map((name) => STYLE_LABEL[name]).join(', ') }}. Solo valori semplici (colori, misure in px, rem, em o %), niente url() né var().
      </p>
      <div class="flex items-center gap-2">
        <button type="button" class="btn btn-primary px-3 py-1.5 text-xs" :disabled="!changed || invalid.length > 0 || saving" @click="save">
          <Icon name="saved" :size="13" />{{ saving ? 'Salvo…' : 'Salva' }}
        </button>
        <span class="text-[11px] text-muted">Scrive nel file del progetto; il Designer vede la modifica al prossimo lavoro.</span>
      </div>
    </template>
  </section>
</template>
