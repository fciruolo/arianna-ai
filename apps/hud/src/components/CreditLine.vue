<script setup lang="ts">
import { computed, ref } from 'vue';

import { loadDelegationFile } from '../lib/api.ts';
import { canPreview, codeFence } from '../lib/delegations.ts';
import { CHANGE_TEXT, creditText, filesTitle, previewErrorText } from '../lib/italian.ts';
import type { DelegationFile, FilePreview, MessageCredit } from '../lib/types.ts';
import Icon from './Icon.vue';
import MarkdownText from './MarkdownText.vue';

/**
 * Under an answer written in the cloud (D-082): who wrote it, on which
 * executor and model, in how long; for a report of the Coder, the files its
 * run changed, each shown on request as it is now in the approved project,
 * read only. Nothing here opens Finder or the folder.
 */
const props = defineProps<{ credit: MessageCredit }>();

const files = computed(() => props.credit.files ?? []);
const open = ref<number | null>(null);
const preview = ref<FilePreview | null>(null);
const loading = ref(false);
const problem = ref<string | null>(null);

const changeClass: Record<DelegationFile['change'], string> = {
  added: 'text-ok',
  modified: 'text-info',
  deleted: 'text-danger',
  renamed: 'text-warn',
};

async function show(index: number): Promise<void> {
  if (open.value === index) {
    open.value = null;
    return;
  }
  const id = props.credit.delegationId;
  if (id === null) return;
  open.value = index;
  preview.value = null;
  problem.value = null;
  loading.value = true;
  try {
    const file = await loadDelegationFile(id, index);
    if (open.value === index) preview.value = file;
  } catch (cause) {
    if (open.value === index) problem.value = previewErrorText(cause);
  } finally {
    if (open.value === index) loading.value = false;
  }
}
</script>

<template>
  <div class="flex flex-col gap-2">
    <p class="font-mono text-[10.5px] text-muted" title="Chi ha scritto questa risposta: esecutore, modello scelto e modello effettivo">
      {{ creditText(credit) }}
    </p>
    <details v-if="files.length > 0" class="rounded-lg border border-line bg-surface-2 text-[12.5px]">
      <summary class="flex cursor-pointer items-center gap-2 px-3 py-2 font-medium select-none">
        <Icon name="file" :size="14" />{{ filesTitle(files.length) }}
        <span v-if="credit.repo !== null" class="font-mono text-[10.5px] font-normal text-muted">· {{ credit.repo }}</span>
      </summary>
      <ul class="flex flex-col border-t border-line">
        <li v-for="(file, index) in files" :key="`${file.change}:${file.path}`" class="border-b border-line last:border-b-0">
          <button
            v-if="canPreview(file) && credit.delegationId !== null"
            type="button"
            class="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-surface"
            :aria-expanded="open === index"
            :title="`Mostra ${file.path} in sola lettura`"
            @click="show(index)"
          >
            <span class="w-[78px] shrink-0 font-mono text-[10.5px]" :class="changeClass[file.change]">{{ CHANGE_TEXT[file.change] }}</span>
            <span class="min-w-0 flex-1 truncate font-mono text-[11.5px]">{{ file.path }}</span>
            <span v-if="file.from !== undefined" class="truncate font-mono text-[10.5px] text-muted">da {{ file.from }}</span>
          </button>
          <div v-else class="flex items-center gap-2 px-3 py-1.5">
            <span class="w-[78px] shrink-0 font-mono text-[10.5px]" :class="changeClass[file.change]">{{ CHANGE_TEXT[file.change] }}</span>
            <span class="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted line-through">{{ file.path }}</span>
          </div>
          <div v-if="open === index" class="border-t border-line px-3 py-2" aria-live="polite">
            <p v-if="loading" class="text-xs text-muted">Leggo il file…</p>
            <p v-else-if="problem !== null" class="text-xs text-warn">{{ problem }}</p>
            <template v-else-if="preview !== null">
              <p class="mb-1.5 flex items-center gap-2 text-[11px] text-muted">
                <Icon name="info" :size="12" />Versione attuale del file, in sola lettura: può essere cambiato dopo il lavoro del Coder.
              </p>
              <MarkdownText class="max-h-[420px] overflow-auto" :source="codeFence(preview.text, preview.path)" />
            </template>
          </div>
        </li>
      </ul>
    </details>
  </div>
</template>
