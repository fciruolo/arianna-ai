<script setup lang="ts">
/**
 * «Seguiti» (D-272): in one place what Arianna follows on GitHub for ideas.
 * The parts are the components that were elsewhere, moved here as they are:
 * the projects and accounts with the one field «Segui» (FollowedProjects,
 * D-202, D-271), the releases of oMLX (OmlxRelease, D-265), the news of Open
 * Design (OdNews, D-186; its catalog is still updated in Skill e stili), and
 * the sources of the catalogs of skills and agents, listed with a link to
 * where they are managed. Reading the catalogs asks the core only for what it
 * keeps: no new request to GitHub.
 */
import { computed, onMounted, ref } from 'vue';

import { loadAgentsCatalog, loadSkillsCatalog } from '../lib/api.ts';
import type { AgentsStatus } from '../lib/agents-catalog.ts';
import { CATALOG_PLACES, catalogRows, FOLLOWED_INTRO, FOLLOWED_TITLE, OPEN_DESIGN_PLACE } from '../lib/followed-page.ts';
import { errorText } from '../lib/italian.ts';
import type { OmlxReleaseView } from '../lib/omlx-release.ts';
import { openInside as open } from '../lib/route.ts';
import type { SkillsStatus } from '../lib/skills-catalog.ts';
import FollowedProjects from './FollowedProjects.vue';
import OdNews from './OdNews.vue';
import OmlxRelease from './OmlxRelease.vue';
import PageHeader from './PageHeader.vue';
import SettingsCard from './SettingsCard.vue';

/** `omlx`: the card of oMLX read its state; the dot on «Seguiti» follows it (D-265). */
const emit = defineEmits<{ omlx: [view: OmlxReleaseView] }>();

const skills = ref<SkillsStatus | null>(null);
const agents = ref<AgentsStatus | null>(null);
const catalogError = ref<string | null>(null);
const loaded = ref(false);
const reading = ref(false);
const rows = computed(() => catalogRows(skills.value, agents.value));

async function loadCatalogs(): Promise<void> {
  if (reading.value) return;
  reading.value = true;
  const [skillsResult, agentsResult] = await Promise.allSettled([loadSkillsCatalog(), loadAgentsCatalog()]);
  skills.value = skillsResult.status === 'fulfilled' ? skillsResult.value : null;
  agents.value = agentsResult.status === 'fulfilled' ? agentsResult.value : null;
  const failed = [skillsResult, agentsResult].find((result) => result.status === 'rejected');
  catalogError.value = failed === undefined ? null : `Non riesco a leggere tutti i cataloghi. ${errorText(failed.reason)}`;
  loaded.value = true;
  reading.value = false;
}
onMounted(loadCatalogs);
</script>

<template>
  <div class="relative flex min-h-0 flex-1 overflow-hidden">
    <div class="min-w-0 flex-1 overflow-y-auto">
      <div class="mx-auto flex max-w-[1040px] flex-col gap-4 px-4 pt-5 pb-10 md:px-6">
        <PageHeader :title="FOLLOWED_TITLE" title-id="followed-title">{{ FOLLOWED_INTRO }}</PageHeader>

        <!-- Projects and accounts, with the one field «Segui» (D-202, D-271) -->
        <FollowedProjects />

        <!-- The server of the models (D-265) -->
        <OmlxRelease @changed="emit('omlx', $event)" />

        <!-- Open Design (D-186): its news here, its catalog in Skill e stili -->
        <div class="flex flex-col gap-1.5">
          <OdNews />
          <p class="px-1 text-[13px] text-muted">
            Il catalogo degli stili e delle skill di Open Design si scarica e si sceglie in Impostazioni:
            <a :href="OPEN_DESIGN_PLACE.path" class="font-medium text-accent hover:underline" @click="open($event, OPEN_DESIGN_PLACE.path)">{{ OPEN_DESIGN_PLACE.label }}</a>.
          </p>
        </div>

        <!-- The catalogs of skills (D-161) and agents (D-079): listed here, managed in the settings -->
        <SettingsCard id="followed-catalogs" title="Cataloghi" description="Le raccolte di skill e di ruoli seguite su GitHub. Qui solo l’elenco con la versione in uso e quella in attesa: si scaricano, si scelgono e si tolgono nelle Impostazioni.">
          <template #header>
            <button type="button" class="btn px-2.5 py-1 text-[13px]" :disabled="reading" @click="loadCatalogs">Aggiorna</button>
          </template>
          <p v-if="catalogError !== null" role="alert" class="text-[13px] text-danger">{{ catalogError }}</p>
          <p v-if="!loaded" class="text-[14px] text-muted">Leggo i cataloghi…</p>
          <p v-else-if="rows.length === 0 && catalogError === null" class="text-[14px] text-muted">Nessuna raccolta seguita.</p>
          <ul v-if="rows.length > 0" class="m-0 flex list-none flex-col p-0">
            <li v-for="row in rows" :key="`${row.kind}:${row.id}`" class="flex flex-wrap items-center gap-2.5 border-t border-line py-2.5 text-[14px] first:border-t-0 first:pt-0">
              <span class="pill text-[12.5px]">{{ CATALOG_PLACES[row.kind].kind }}</span>
              <div class="min-w-0 flex-1">
                <a :href="row.page" target="_blank" rel="noopener noreferrer" class="font-semibold break-words hover:text-accent hover:underline">{{ row.id }}</a>
                <div class="text-[13px] text-muted">
                  {{ row.inUse }}<template v-if="row.pending !== null"> · <span class="text-info">{{ row.pending }}</span></template><template v-if="row.job !== null"> · {{ row.job }}</template>
                </div>
              </div>
              <a :href="CATALOG_PLACES[row.kind].path" class="text-[13px] font-medium text-accent hover:underline" @click="open($event, CATALOG_PLACES[row.kind].path)">{{ CATALOG_PLACES[row.kind].label }}</a>
            </li>
          </ul>
        </SettingsCard>
      </div>
    </div>
  </div>
</template>
