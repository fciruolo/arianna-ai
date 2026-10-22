<script setup lang="ts">
/**
 * «Seguiti» (D-272): in one place what Arianna follows on GitHub for ideas.
 * At the top the one field «Segui» (a repository or an account) and a search
 * that filters, on the page, the cards and their news; then a grid of large
 * cards — projects (D-202), accounts (D-271), oMLX (D-265) and Open Design
 * (D-186) — each with its last release, the last check and the first news; a
 * click opens the detail, made of the components that were elsewhere
 * (FollowedProjects, OmlxRelease, OdNews). Under the grid the sources of the
 * catalogs of skills and agents, with a link to where they are managed.
 * Everything here is read from the core: no new request to GitHub.
 */
import { computed, onMounted, ref } from 'vue';

import { loadAgentsCatalog, loadFollowedProjects, loadOdNews, loadOmlxRelease, loadSkillsCatalog } from '../lib/api.ts';
import type { AgentsStatus } from '../lib/agents-catalog.ts';
import { dateText } from '../lib/design-catalog.ts';
import type { NewsPair } from '../lib/design-news.ts';
import {
  CATALOG_PLACES,
  catalogRows,
  FOLLOWED_INTRO,
  FOLLOWED_TITLE,
  followedCards,
  highlight,
  noResultText,
  OPEN_DESIGN_PLACE,
  ROW_KIND_TEXT,
  searchFollowed,
  type FollowedCard,
} from '../lib/followed-page.ts';
import type { FollowedAccount, FollowedProject } from '../lib/followed-projects.ts';
import { errorText } from '../lib/italian.ts';
import type { OmlxReleaseView } from '../lib/omlx-release.ts';
import { openInside as open } from '../lib/route.ts';
import type { SkillsStatus } from '../lib/skills-catalog.ts';
import FollowAddress from './FollowAddress.vue';
import FollowedProjects from './FollowedProjects.vue';
import Icon from './Icon.vue';
import OdNews from './OdNews.vue';
import OmlxRelease from './OmlxRelease.vue';
import PageHeader from './PageHeader.vue';
import SettingsCard from './SettingsCard.vue';

/** `omlx`: the card of oMLX read its state; the dot on «Seguiti» follows it (D-265). */
const emit = defineEmits<{ omlx: [view: OmlxReleaseView] }>();

const projects = ref<FollowedProject[]>([]);
const accounts = ref<FollowedAccount[]>([]);
const max = ref(0);
const maxAccounts = ref(0);
const omlx = ref<OmlxReleaseView | null>(null);
const openDesign = ref<NewsPair | null>(null);
const followedError = ref<string | null>(null);
const loadedFollowed = ref(false);

const skills = ref<SkillsStatus | null>(null);
const agents = ref<AgentsStatus | null>(null);
const catalogError = ref<string | null>(null);
const loaded = ref(false);
const reading = ref(false);
const rows = computed(() => catalogRows(skills.value, agents.value));

const query = ref('');
/** The card opened: its key, or null for the grid. */
const opened = ref<string | null>(null);

const cards = computed(() => followedCards({ projects: projects.value, accounts: accounts.value, omlx: omlx.value, openDesign: openDesign.value }));
const search = computed(() => searchFollowed(cards.value, query.value));
const searching = computed(() => query.value.trim() !== '');
const others = computed(() => projects.value.filter((project) => !project.catalog).length);
const openedCard = computed(() => cards.value.find((card) => card.key === opened.value) ?? null);

/** The projects, accounts, oMLX and Open Design: four reads of what the core keeps; one that fails leaves its card out. */
async function loadFollowed(): Promise<void> {
  const [list, omlxView, news] = await Promise.allSettled([loadFollowedProjects(), loadOmlxRelease(), loadOdNews()]);
  if (list.status === 'fulfilled') {
    projects.value = list.value.projects;
    accounts.value = list.value.accounts;
    max.value = list.value.max;
    maxAccounts.value = list.value.maxAccounts;
    followedError.value = null;
  } else {
    followedError.value = `Non riesco a leggere i progetti seguiti. ${errorText(list.reason)}`;
  }
  if (omlxView.status === 'fulfilled') {
    omlx.value = omlxView.value;
    emit('omlx', omlxView.value);
  }
  openDesign.value = news.status === 'fulfilled' ? news.value : null;
  loadedFollowed.value = true;
}

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

onMounted(() => {
  void loadFollowed();
  void loadCatalogs();
});

/** A card or a result of the search opens the detail, from its top. */
function openKey(key: string): void {
  opened.value = key;
  window.scrollTo({ top: 0 });
}

function openCard(card: FollowedCard): void {
  openKey(card.key);
}

function back(): void {
  opened.value = null;
  void loadFollowed();
}

function omlxChanged(view: OmlxReleaseView): void {
  omlx.value = view;
  emit('omlx', view);
}

function checkedText(card: FollowedCard): string {
  return card.checkedAt === null ? 'Mai controllato' : `Controllato il ${dateText(card.checkedAt)}`;
}

function countText(card: FollowedCard): string {
  if (card.kind === 'account') return card.count === 1 ? '1 repository nuovo' : `${String(card.count)} repository nuovi`;
  return card.count === 1 ? '1 novità' : `${String(card.count)} novità`;
}
</script>

<template>
  <div class="relative flex min-h-0 flex-1 overflow-hidden">
    <div class="min-w-0 flex-1 overflow-y-auto">
      <div class="mx-auto flex max-w-[1180px] flex-col gap-4 px-4 pt-5 pb-10 md:px-6">
        <PageHeader :title="FOLLOWED_TITLE" title-id="followed-title">{{ FOLLOWED_INTRO }}</PageHeader>

        <!-- The detail of one card -->
        <template v-if="opened !== null">
          <div class="flex flex-wrap items-center gap-2.5">
            <button type="button" class="btn flex items-center gap-1.5 px-2.5 py-1 text-[13.5px]" @click="back"><Icon name="back" :size="14" />Tutti i seguiti</button>
            <a v-if="openedCard !== null" :href="openedCard.page" target="_blank" rel="noopener noreferrer" class="text-[15px] font-semibold hover:text-accent hover:underline">{{ openedCard.title }}</a>
          </div>
          <OmlxRelease v-if="opened === 'omlx'" @changed="omlxChanged" />
          <div v-else-if="opened === 'open-design'" class="flex flex-col gap-1.5">
            <OdNews />
            <p class="px-1 text-[13px] text-muted">
              Il catalogo degli stili e delle skill di Open Design si scarica e si sceglie in Impostazioni:
              <a :href="OPEN_DESIGN_PLACE.path" class="font-medium text-accent hover:underline" @click="open($event, OPEN_DESIGN_PLACE.path)">{{ OPEN_DESIGN_PLACE.label }}</a>.
            </p>
          </div>
          <FollowedProjects v-else :only="opened" @changed="loadFollowed" @removed="back" />
        </template>

        <template v-else>
          <!-- The one field «Segui» and the search -->
          <FollowAddress :projects="others" :max-projects="max" :accounts="accounts.length" :max-accounts="maxAccounts" @added="loadFollowed" />
          <label class="flex items-center gap-2 rounded-[10px] border border-line-strong bg-surface px-3 py-1.5 text-[14px]">
            <Icon name="search" :size="15" class="text-muted" />
            <span class="sr-only">Cerca nelle novità</span>
            <input v-model="query" type="search" class="min-w-0 flex-1 bg-transparent outline-none" placeholder="Cerca nelle novità: release, funzioni, commit, repository nuovi" />
          </label>

          <p v-if="followedError !== null" role="alert" class="text-[13px] text-danger">
            {{ followedError }} <button type="button" class="underline" @click="loadFollowed">Riprova</button>
          </p>
          <p v-if="!loadedFollowed" class="text-[14px] text-muted">Leggo i seguiti…</p>

          <!-- The cards -->
          <ul v-if="search.cards.length > 0" class="m-0 grid list-none grid-cols-1 gap-3 p-0 md:grid-cols-2 xl:grid-cols-3">
            <li v-for="card in search.cards" :key="card.key">
              <button
                type="button"
                class="flex h-full w-full flex-col gap-2 rounded-xl border border-line bg-surface px-4 py-3.5 text-left transition-colors hover:border-line-strong hover:bg-surface-2 touch:min-h-11"
                :aria-label="`Apri ${card.title}`"
                @click="openCard(card)"
              >
                <span class="flex w-full items-start gap-2">
                  <span class="min-w-0 flex-1 text-[15.5px] leading-snug font-semibold break-words">
                    <template v-for="(part, index) in highlight(card.title, query)" :key="index"><mark v-if="part.hit" class="rounded-sm bg-accent/25 text-ink">{{ part.text }}</mark><template v-else>{{ part.text }}</template></template>
                  </span>
                  <span v-if="card.tag !== null" class="pill shrink-0 text-[12px]" :class="{ 'text-accent': card.tag === 'Aggiornamento' }">{{ card.tag }}</span>
                </span>
                <span v-if="card.description !== ''" class="line-clamp-2 text-[13.5px] text-muted">
                  <template v-for="(part, index) in highlight(card.description, query)" :key="index"><mark v-if="part.hit" class="rounded-sm bg-accent/25 text-ink">{{ part.text }}</mark><template v-else>{{ part.text }}</template></template>
                </span>
                <span class="text-[12.5px] text-muted">
                  <template v-if="card.release !== null">Ultima release {{ card.release }} · </template>{{ checkedText(card) }}
                </span>
                <span class="text-[13px] font-medium" :class="card.count > 0 ? 'text-ink' : 'text-muted'">{{ countText(card) }}</span>
                <ul v-if="card.top.length > 0" class="m-0 flex list-none flex-col gap-0.5 p-0 text-[13px]">
                  <li v-for="(title, index) in card.top" :key="index" class="truncate">· {{ title }}</li>
                </ul>
              </button>
            </li>
          </ul>
          <p v-else-if="loadedFollowed && !searching" class="text-[14px] text-muted">Niente da mostrare: segui un progetto o un account con la casella qui sopra.</p>

          <!-- The rows found by the search -->
          <section v-if="searching" class="flex flex-col gap-2" aria-labelledby="followed-results">
            <h2 id="followed-results" class="text-[15px] font-semibold">Novità trovate</h2>
            <p v-if="search.results.length === 0" role="status" class="text-[14px] text-muted">{{ noResultText(query) }}</p>
            <ul v-else class="m-0 flex list-none flex-col overflow-hidden rounded-xl border border-line bg-surface p-0">
              <li v-for="(result, index) in search.results" :key="index" class="border-b border-line last:border-b-0">
                <button type="button" class="flex w-full flex-col gap-0.5 px-3.5 py-2 text-left hover:bg-surface-2 touch:min-h-11" @click="openKey(result.cardKey)">
                  <span class="text-[12.5px] text-muted">{{ result.source }} · {{ ROW_KIND_TEXT[result.kind] }}</span>
                  <span class="text-[14px] break-words">
                    <template v-for="(part, part_index) in highlight(result.text, query)" :key="part_index"><mark v-if="part.hit" class="rounded-sm bg-accent/25 text-ink">{{ part.text }}</mark><template v-else>{{ part.text }}</template></template>
                  </span>
                  <span v-if="result.context !== ''" class="text-[13px] break-words text-muted">
                    <template v-for="(part, part_index) in highlight(result.context, query)" :key="part_index"><mark v-if="part.hit" class="rounded-sm bg-accent/25 text-ink">{{ part.text }}</mark><template v-else>{{ part.text }}</template></template>
                  </span>
                </button>
              </li>
            </ul>
          </section>

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
                <div class="min-w-0 flex-1 phone:min-w-[12rem]">
                  <a :href="row.page" target="_blank" rel="noopener noreferrer" class="font-semibold break-words hover:text-accent hover:underline">{{ row.id }}</a>
                  <div class="text-[13px] text-muted">
                    {{ row.inUse }}<template v-if="row.pending !== null"> · <span class="text-info">{{ row.pending }}</span></template><template v-if="row.job !== null"> · {{ row.job }}</template>
                  </div>
                </div>
                <a :href="CATALOG_PLACES[row.kind].path" class="text-[13px] font-medium text-accent hover:underline touch:inline-flex touch:min-h-11 touch:items-center" @click="open($event, CATALOG_PLACES[row.kind].path)">{{ CATALOG_PLACES[row.kind].label }}</a>
              </li>
            </ul>
          </SettingsCard>
        </template>
      </div>
    </div>
  </div>
</template>
