<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import { listMockups } from '../lib/api.ts';
import { allotThumbs, overviewOf, overviewText, THUMBS_MAX, type ProjectOverview } from '../lib/studio-overview.ts';
import type { ProjectInfo } from '../lib/types.ts';
import Icon from './Icon.vue';
import PageHeader from './PageHeader.vue';
import StudioThumb from './StudioThumb.vue';

/**
 * The Studio without a project (D-194): the common header with the list of
 * the projects on the right, then one card per project with up to three
 * thumbnails of its mockups, how many there are and the latest one. A click
 * opens the project in the Studio, as the list does.
 */
const props = defineProps<{ projects: ProjectInfo[] }>();
const emit = defineEmits<{ choose: [project: string] }>();

/** Per project: its overview, null while reading, or the reason it could not be read. */
const overviews = ref<Record<string, ProjectOverview | null | string>>({});

let token = 0;
watch(
  // The same names read again (every refresh of the projects) keep the cards as they are.
  () => props.projects.map((project) => project.name).join('\n'),
  (joined) => {
    const names = joined === '' ? [] : joined.split('\n');
    const mine = ++token;
    overviews.value = Object.fromEntries(names.map((name) => [name, null]));
    for (const name of names) {
      listMockups(name).then(
        (list) => {
          if (mine === token) overviews.value = { ...overviews.value, [name]: overviewOf(list.files) };
        },
        () => {
          if (mine === token) overviews.value = { ...overviews.value, [name]: 'Non riesco a leggere i mockup' };
        },
      );
    }
  },
  { immediate: true },
);

/** What each card shows: the thumbnails, the empty boxes that complete the row, the line under the name. */
const cards = computed(() => {
  const read = props.projects.map((project) => {
    const overview = overviews.value[project.name];
    return typeof overview === 'object' && overview !== null ? overview : undefined;
  });
  const allotted = allotThumbs(read.map((overview) => overview?.thumbs.length ?? 0));
  return props.projects.map((project, index) => {
    const overview = overviews.value[project.name];
    const mine = read[index];
    const thumbs = mine?.thumbs.slice(0, allotted[index] ?? 0) ?? [];
    const text = mine !== undefined ? overviewText(mine) : typeof overview === 'string' ? overview : 'Leggo i mockup…';
    return { name: project.name, thumbs, empty: THUMBS_MAX - thumbs.length, text };
  });
});
</script>

<template>
  <div class="min-h-0 flex-1 overflow-y-auto">
    <div class="mx-auto flex max-w-[1440px] flex-col gap-4 px-4 pt-5 pb-10 md:px-6">
      <PageHeader title="Studio di design">
        Scegli un progetto: a sinistra parli col Designer, a destra vedi i suoi mockup, lasci commenti sugli elementi e li esporti.
        <template #actions>
          <label class="flex items-center gap-2 text-[13.5px] text-muted">
            <Icon name="project" :size="14" />
            <span class="sr-only">Progetto</span>
            <select class="field px-2 py-1 text-[14px] text-ink" value="" @change="emit('choose', ($event.target as HTMLSelectElement).value)">
              <option value="">Scegli un progetto…</option>
              <option v-for="entry in projects" :key="entry.name" :value="entry.name">{{ entry.name }}</option>
            </select>
          </label>
        </template>
      </PageHeader>

      <p v-if="projects.length === 0" class="rounded-xl border border-line bg-surface-2 p-4 text-[14.5px] text-muted">
        Nessun progetto ancora: aggiungine uno in Impostazioni → Progetti, poi chiedi al Designer una pagina.
      </p>
      <ul v-else class="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
        <li v-for="card in cards" :key="card.name" class="relative overflow-hidden rounded-xl border border-line bg-surface-2 hover:border-accent has-[:focus-visible]:border-accent">
          <div class="grid grid-cols-3 gap-1 border-b border-line bg-surface p-2">
            <StudioThumb v-for="file in card.thumbs" :key="file.path" :project="card.name" :file="file" />
            <span v-for="index in card.empty" :key="`empty-${String(index)}`" class="aspect-[4/3] rounded border border-line bg-surface-2 opacity-50" aria-hidden="true" />
          </div>
          <button type="button" class="block w-full px-3 py-2.5 text-left after:absolute after:inset-0 after:content-['']" @click="emit('choose', card.name)">
            <span class="block text-[14.5px] font-semibold break-words">{{ card.name }}</span>
            <span class="block text-[13px] text-muted">{{ card.text }}</span>
          </button>
        </li>
      </ul>
      <p class="flex items-center gap-1.5 text-[13px] text-muted" role="note">
        <Icon name="private" :size="13" />I mockup si vedono in una cornice isolata: niente rete, niente accesso alla chat.
      </p>
    </div>
  </div>
</template>
