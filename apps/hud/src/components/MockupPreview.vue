<script setup lang="ts">
import { computed, ref } from 'vue';

import { loadDelegationFile } from '../lib/api.ts';
import { previewErrorText } from '../lib/italian.ts';
import { studioPathFor } from '../lib/studio.ts';
import Icon from './Icon.vue';
import StudioFrame from './StudioFrame.vue';

/**
 * The preview of a mockup a delegation wrote (I-19, D-184, tappa O1): the
 * file read from the route the chat already uses for the files of a
 * delegation, shown in the isolated frame of the Studio, loaded only when
 * opened; "Apri nello Studio" goes to the page with that project and file.
 */
const props = defineProps<{ delegationId: string; index: number; path: string; project: string | null }>();

const text = ref<string | null>(null);
const loading = ref(false);
const problem = ref<string | null>(null);
const name = computed(() => props.path.split('/').at(-1) ?? props.path);
const studioHref = computed(() => (props.project === null ? undefined : studioPathFor({ project: props.project, file: props.path })));

async function load(event: Event): Promise<void> {
  if (!(event.target instanceof HTMLDetailsElement) || !event.target.open || text.value !== null || loading.value) return;
  loading.value = true;
  problem.value = null;
  try {
    text.value = (await loadDelegationFile(props.delegationId, props.index)).text;
  } catch (cause) {
    problem.value = previewErrorText(cause);
  } finally {
    loading.value = false;
  }
}

/** Inside the page: the address changes and the app follows it, as with "back". */
function openStudio(event: MouseEvent): void {
  const href = studioHref.value;
  if (href === undefined || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
  event.preventDefault();
  window.history.pushState(null, '', href);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
</script>

<template>
  <details class="rounded-lg border border-line bg-surface-2 text-[12.5px]" @toggle="load">
    <summary class="flex cursor-pointer items-center gap-2 px-3 py-2 font-medium select-none">
      <Icon name="studio" :size="14" />Anteprima di <span class="truncate font-mono text-[11.5px]">{{ name }}</span>
      <a
        v-if="studioHref !== undefined"
        class="ml-auto shrink-0 font-mono text-[10.5px] font-normal text-accent hover:underline"
        :href="studioHref"
        @click.stop="openStudio"
      >Apri nello Studio</a>
    </summary>
    <div class="border-t border-line p-2">
      <p v-if="loading" class="text-xs text-muted">Leggo il file…</p>
      <p v-else-if="problem !== null" class="text-xs text-warn">{{ problem }}</p>
      <template v-else-if="text !== null">
        <p class="mb-1.5 flex items-center gap-2 text-[11px] text-muted">
          <Icon name="private" :size="12" />Anteprima isolata: la pagina non raggiunge la rete né la chat.
        </p>
        <div class="h-[420px] overflow-hidden rounded border border-line">
          <StudioFrame :source="text" :title="`Anteprima di ${name}`" />
        </div>
      </template>
    </div>
  </details>
</template>
