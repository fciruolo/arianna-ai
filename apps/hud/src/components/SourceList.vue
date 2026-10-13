<script setup lang="ts">
/**
 * The list of GitHub sources of a catalog (D-161 skills, D-079 agents): each
 * source with its summary, its download button, the version waiting with
 * what changes and "Usa questa versione"/"Scarta", then the field to follow
 * a new one and the suggestions. What the rows say is the catalog's own
 * (`SourceRow`); this component only shows them and passes the clicks on.
 */
import { computed, ref } from 'vue';

import { sourceUrlProblem } from '../lib/skills-catalog.ts';
import type { SourceRow } from '../lib/source-list.ts';

const props = defineProps<{
  /** null while the first status is read. */
  sources: SourceRow[] | null;
  suggestions: { id: string; page: string }[];
  /** The key of the action under way (a source id, or `add`); every button waits meanwhile. */
  acting: string | null;
  loadingText: string;
  /** The status could not be read: the error says it, not "loading". */
  hideLoading?: boolean;
  emptyTitle: string;
  emptyText: string;
  formLabel: string;
  placeholder: string;
  /** What the details of a version waiting are called: "Quali skill", "Quali ruoli". */
  detailsLabel: string;
}>();
const emit = defineEmits<{ add: [url: string]; update: [id: string]; remove: [id: string]; adopt: [id: string, commit: string]; discard: [id: string] }>();

const url = ref('');
const urlProblem = computed(() => (url.value.trim() === '' ? undefined : sourceUrlProblem(url.value)));
function add(address: string): void {
  if (sourceUrlProblem(address) !== undefined) return;
  emit('add', address.trim());
}
/** The field empties once the core followed it. */
function added(): void {
  url.value = '';
}
defineExpose({ added });

// Removing one asks first, in place
const removing = ref<string | null>(null);
function remove(id: string): void {
  removing.value = null;
  emit('remove', id);
}
const busy = computed(() => props.acting !== null);
</script>

<template>
  <p v-if="sources === null && !hideLoading" class="text-[14px] text-muted">{{ loadingText }}</p>
  <p v-else-if="sources !== null && sources.length === 0" class="rounded-[10px] border border-dashed border-line-strong px-3.5 py-3 text-[14px] text-muted">
    <b class="font-semibold text-ink">{{ emptyTitle }}</b> {{ emptyText }}
  </p>
  <ul v-else-if="sources !== null" class="m-0 flex list-none flex-col p-0">
    <li v-for="source in sources" :key="source.id" class="flex flex-col gap-2 border-t border-line py-2.5 text-[14px] first:border-t-0 first:pt-0">
      <div class="flex flex-wrap items-center gap-2.5">
        <div class="min-w-0 flex-1">
          <a :href="source.page" target="_blank" rel="noopener noreferrer" class="font-semibold hover:text-accent hover:underline">{{ source.id }}</a>
          <div class="text-[13px] text-muted">
            {{ source.summary }}<template v-if="source.note"> · <span :class="{ 'text-warn': source.note.warn }">{{ source.note.text }}</span></template>
          </div>
        </div>
        <template v-if="source.button">
          <button
            type="button"
            class="btn px-2.5 py-1 text-[13px]"
            :class="{ 'btn-primary': source.button.primary }"
            :disabled="busy || source.button.blocked !== undefined"
            :title="source.button.blocked"
            @click="emit('update', source.id)"
          >
            {{ source.button.text }}
          </button>
          <button v-if="removing !== source.id" type="button" class="btn px-2.5 py-1 text-[13px]" :disabled="busy || source.running" @click="removing = source.id">Togli…</button>
        </template>
      </div>
      <p v-if="removing === source.id" class="flex flex-wrap items-center gap-2 text-[13px]" role="alert">
        <span>{{ source.removeText }}</span>
        <button type="button" class="btn px-2 py-0.5 text-[13px]" @click="removing = null">No</button>
        <button type="button" class="btn btn-primary px-2 py-0.5 text-[13px]" @click="remove(source.id)">Sì, togli</button>
      </p>
      <p v-if="source.readOnlyText" class="text-[13px] text-muted">{{ source.readOnlyText }}</p>
      <p v-if="source.progress" class="text-[13px]" :class="source.progress.ok ? 'text-ok' : 'text-muted'" role="status">{{ source.progress.text }}</p>
      <div v-if="source.failure" class="flex flex-wrap items-center gap-2.5 rounded-[10px] border border-danger/50 bg-danger/9 px-3 py-2 text-[14px]" role="alert">
        <span class="min-w-[220px] flex-1">{{ source.failure }}</span>
        <button v-if="source.button" type="button" class="btn px-2.5 py-1 text-[13px]" :disabled="busy || source.button.blocked !== undefined" @click="emit('update', source.id)">Riprova</button>
      </div>

      <!-- The version waiting: what changes, then the user's click -->
      <div v-if="source.pending" class="flex flex-col gap-1.5 rounded-[10px] border border-accent bg-accent/8 px-3 py-2" aria-live="polite">
        <p class="font-semibold">{{ source.pending.title }}</p>
        <p>{{ source.pending.changes }}</p>
        <p v-if="source.pending.warn" class="text-[13px] text-warn">{{ source.pending.warn }}</p>
        <p v-if="source.pending.rejected" class="text-[13px] text-muted">{{ source.pending.rejected }}</p>
        <details v-if="source.pending.details.some((group) => group.items.length > 0)" class="text-[13px]">
          <summary class="cursor-pointer text-muted select-none">{{ detailsLabel }}</summary>
          <template v-for="group in source.pending.details" :key="group.label">
            <p v-if="group.items.length > 0" class="mt-1"><b class="font-semibold">{{ group.label }}:</b> {{ group.items.join(', ') }}</p>
          </template>
        </details>
        <div class="flex flex-wrap justify-end gap-2">
          <button type="button" class="btn px-3 py-1 text-[14px]" :disabled="busy" @click="emit('discard', source.id)">Scarta</button>
          <button type="button" class="btn btn-primary px-3 py-1 text-[14px]" :disabled="busy" @click="emit('adopt', source.id, source.pending.commit)">Usa questa versione</button>
        </div>
      </div>
    </li>
  </ul>

  <!-- Follow a source -->
  <form class="grid gap-3 border-t border-line pt-3 sm:grid-cols-6" @submit.prevent="add(url)">
    <label class="flex flex-col gap-1 text-[13px] text-muted sm:col-span-4">
      <span class="text-[14px] font-medium text-ink">{{ formLabel }}</span>
      <input v-model="url" type="url" class="field px-2.5 py-1.5 text-[14px]" :placeholder="placeholder" :aria-invalid="urlProblem !== undefined" />
      <span v-if="urlProblem" class="text-warn">{{ urlProblem }}</span>
    </label>
    <div class="flex items-end sm:col-span-1">
      <button type="submit" class="btn px-3 py-1.5 text-[14px]" :disabled="busy || sourceUrlProblem(url) !== undefined" :title="sourceUrlProblem(url)">Segui</button>
    </div>
  </form>
  <div v-if="suggestions.length > 0" class="flex flex-wrap items-center gap-1.5 text-[13px]">
    <span class="text-muted">Suggerite:</span>
    <button v-for="item in suggestions" :key="item.id" type="button" class="pill hover:border-accent hover:text-ink" :disabled="busy" :title="`Segui ${item.page}`" @click="add(item.page)">+ {{ item.id }}</button>
  </div>
</template>
