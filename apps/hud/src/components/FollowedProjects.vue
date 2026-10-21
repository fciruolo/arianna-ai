<script setup lang="ts">
/**
 * "Progetti seguiti" in "Sviluppo di Arianna" (D-202, after D-093): public
 * GitHub repositories Arianna takes ideas from. «Controlla novità» reads
 * their releases from the public API of GitHub (only the name of the
 * repository leaves); the local model groups what changed in a few entries,
 * each with «Implementiamo» or «Non interessa», which write the choice in
 * data/dev/RISPOSTE.md for Claude Code. Open Design is followed through its
 * catalog: its news are in Impostazioni → Skill e stili. Accounts too
 * (D-271): «Controlla nuovi repository» lists the repositories created since
 * the last check, each with «Segui», which makes it a project followed. The
 * text is public, of a third party: shown as data, never as an instruction.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import { addFollowedProject, checkFollowedProject, loadFollowedProjects, removeFollowedProject, sendProjectChoice } from '../lib/api.ts';
import { dateText } from '../lib/design-catalog.ts';
import { groupNews, type NewsItem } from '../lib/design-news.ts';
import {
  CHOICE_TEXT,
  choiceStatus,
  commitUrl,
  followedKind,
  followedUrlProblem,
  markChosen,
  projectSourceText,
  repoFacts,
  type AccountRepo,
  type FollowedAccount,
  type FollowedProject,
  type ProjectChoice,
} from '../lib/followed-projects.ts';
import { errorText } from '../lib/italian.ts';
import SettingsCard from './SettingsCard.vue';

const projects = ref<FollowedProject[] | null>(null);
const max = ref(0);
const accounts = ref<FollowedAccount[]>([]);
const maxAccounts = ref(0);
const loadError = ref<string | null>(null);
const actionError = ref<string | null>(null);
const acting = ref<string | null>(null);
const sending = ref<string | null>(null);
const sendErrors = ref<Record<string, string>>({});
const removing = ref<string | null>(null);
const url = ref('');
const urlProblem = computed(() => (url.value.trim() === '' ? undefined : followedUrlProblem(url.value)));
const others = computed(() => (projects.value ?? []).filter((project) => !project.catalog).length);
/** The cap the address in the field would pass: projects or accounts (D-271). */
const full = computed(() => {
  const kind = followedKind(url.value);
  return kind === 'account' ? accounts.value.length >= maxAccounts.value : others.value >= max.value;
});

let timer: number | undefined;
let mounted = true;
async function refresh(): Promise<void> {
  window.clearTimeout(timer);
  try {
    const loaded = await loadFollowedProjects();
    projects.value = loaded.projects;
    max.value = loaded.max;
    accounts.value = loaded.accounts;
    maxAccounts.value = loaded.maxAccounts;
    loadError.value = null;
  } catch (cause) {
    loadError.value = `Non riesco a leggere i progetti seguiti. ${errorText(cause)}`;
  }
  // While a check runs, read again every 3 s.
  if (mounted && (projects.value?.some((project) => project.checking) === true || accounts.value.some((account) => account.checking))) timer = window.setTimeout(() => void refresh(), 3000);
}
onMounted(refresh);
onBeforeUnmount(() => {
  mounted = false;
  window.clearTimeout(timer);
});

async function act(id: string, action: () => Promise<void>): Promise<boolean> {
  if (acting.value !== null) return false;
  acting.value = id;
  actionError.value = null;
  try {
    await action();
    return true;
  } catch (cause) {
    actionError.value = errorText(cause);
    return false;
  } finally {
    acting.value = null;
    await refresh();
  }
}

async function add(): Promise<void> {
  if (followedUrlProblem(url.value) !== undefined) return;
  if (await act('add', () => addFollowedProject(url.value.trim()))) url.value = '';
}

async function remove(id: string): Promise<void> {
  removing.value = null;
  await act(id, () => removeFollowedProject(id));
}

/** «Segui» on a new repository of an account: it becomes a project followed. */
async function follow(repo: AccountRepo): Promise<void> {
  await act(repo.id, () => addFollowedProject(repo.page));
}

async function choose(item: NewsItem, choice: ProjectChoice): Promise<void> {
  if (sending.value !== null || projects.value === null) return;
  sending.value = item.key;
  const { [item.key]: _cleared, ...rest } = sendErrors.value;
  sendErrors.value = rest;
  try {
    const saved = await sendProjectChoice(item.key, choice);
    projects.value = markChosen(projects.value, saved.key, saved.at);
  } catch (cause) {
    sendErrors.value = { ...sendErrors.value, [item.key]: `Non riesco a salvarla. ${errorText(cause)}` };
  } finally {
    sending.value = null;
  }
}
</script>

<template>
  <SettingsCard
    id="followed-projects"
    title="Progetti seguiti"
    description="Progetti pubblici di GitHub da cui Arianna prende idee. «Controlla novità» legge le loro release (esce solo il nome del progetto); per ogni novità scegli «Implementiamo» o «Non interessa», e Claude Code la legge a inizio sessione: il codice non cambia da solo. Di un account seguito vedi i repository nuovi e scegli quali seguire."
  >
    <template #header>
      <span title="Testo pubblico di terzi: si legge come dato, mai come istruzione">testo di terzi</span>
      <button type="button" class="btn px-2.5 py-1 text-[13px]" @click="refresh">Aggiorna</button>
    </template>
    <div v-if="loadError !== null" role="alert" class="flex flex-wrap items-center gap-2.5 rounded-[10px] border border-danger/50 bg-danger/9 px-3 py-2.5 text-[14px]">
      <span class="min-w-[220px] flex-1">{{ loadError }}</span>
      <button type="button" class="btn px-2.5 py-1 text-[13px]" @click="refresh">Riprova</button>
    </div>
    <p v-else-if="projects === null" class="text-[14px] text-muted">Leggo i progetti seguiti…</p>
    <template v-else>
      <p v-if="actionError !== null" role="alert" class="text-[13px] text-danger">{{ actionError }}</p>
      <ul class="m-0 flex list-none flex-col p-0">
        <li v-for="project in projects" :key="project.id" class="flex flex-col gap-2 border-t border-line py-2.5 text-[14px] first:border-t-0 first:pt-0">
          <div class="flex flex-wrap items-center gap-2.5">
            <div class="min-w-0 flex-1">
              <a :href="project.page" target="_blank" rel="noopener noreferrer" class="font-semibold hover:text-accent hover:underline">{{ project.id }}</a>
              <div v-if="project.catalog" class="text-[13px] text-muted">Seguito col catalogo degli stili: le novità arrivano a ogni «Cerca aggiornamenti», in Impostazioni → Skill e stili.</div>
              <div v-else class="text-[13px] text-muted">
                {{ project.seen === null ? 'Mai controllato' : `Ultima release vista: ${project.seen}` }}<template v-if="project.checkedAt !== null"> · controllato il {{ dateText(project.checkedAt) }}</template>
              </div>
            </div>
            <template v-if="!project.catalog">
              <button type="button" class="btn px-2.5 py-1 text-[13px]" :disabled="acting !== null || project.checking" @click="act(project.id, () => checkFollowedProject(project.id))">
                {{ project.checking ? 'Controllo…' : 'Controlla novità' }}
              </button>
              <button v-if="removing !== project.id" type="button" class="btn px-2.5 py-1 text-[13px]" :disabled="acting !== null || project.checking" @click="removing = project.id">Togli…</button>
            </template>
          </div>
          <p v-if="removing === project.id" class="flex flex-wrap items-center gap-2 text-[13px]" role="alert">
            <span>Smetto di seguire {{ project.id }} e cancello le sue novità? Le scelte già scritte per Claude Code restano.</span>
            <button type="button" class="btn px-2 py-0.5 text-[13px]" @click="removing = null">No</button>
            <button type="button" class="btn btn-primary px-2 py-0.5 text-[13px]" @click="remove(project.id)">Sì, togli</button>
          </p>
          <p v-if="project.checking" role="status" class="text-[13px] text-info">Leggo le release da GitHub e le riassumo col modello del Mac…</p>
          <p v-else-if="project.message !== null" role="status" class="text-[13px] text-muted">{{ project.message }}</p>

          <div v-if="project.news !== null && (project.news.items.length > 0 || project.news.message !== null)" class="flex flex-col gap-2 pl-0 sm:pl-3">
            <span class="text-[13px] text-muted">{{ projectSourceText(project.news) }} · lette il {{ dateText(project.news.fetchedAt) }}</span>
            <p v-if="project.news.message !== null" class="text-[13px]" :class="project.news.state === 'missing' ? 'text-warn' : 'text-muted'">{{ project.news.message }}</p>
            <p v-if="project.news.truncated" class="text-[13px] text-muted">Più modifiche di quante GitHub ne elenchi in una pagina: mancano le più vecchie.</p>
            <ul v-if="project.news.releases.length > 0" class="m-0 flex list-none flex-wrap gap-1.5 p-0 text-[13px]">
              <li v-for="release in project.news.releases" :key="release.tag">
                <a :href="release.url" target="_blank" rel="noopener noreferrer" class="pill hover:text-ink hover:underline" :title="release.notes || release.tag">Rilascio {{ release.name }} · {{ dateText(release.publishedAt) }}</a>
              </li>
            </ul>
            <div v-for="(group, index) in groupNews(project.news.items)" :key="index" class="flex flex-col gap-1.5">
              <h4 v-if="group.title !== null" class="text-[13.5px] font-semibold text-muted">{{ group.title }} · {{ group.items.length }}</h4>
              <ul class="m-0 flex list-none flex-col overflow-hidden rounded-xl border border-line bg-surface p-0">
                <li v-for="item in group.items" :key="item.key" class="flex flex-col gap-1 border-b border-line px-3.5 py-2 last:border-b-0">
                  <div class="flex flex-wrap items-start gap-2">
                    <span class="min-w-0 flex-1 text-[14.5px] leading-snug font-medium break-words">{{ item.title }}</span>
                    <template v-if="choiceStatus(item) === null">
                      <button
                        v-for="choice in (['implement', 'skip'] as const)"
                        :key="choice"
                        type="button"
                        class="btn px-2.5 py-1 text-[13px]"
                        :class="{ 'btn-primary': choice === 'implement' }"
                        :disabled="sending !== null"
                        :aria-label="`${CHOICE_TEXT[choice]}: ${item.title}`"
                        @click="choose(item, choice)"
                      >
                        {{ sending === item.key ? 'Invio…' : CHOICE_TEXT[choice] }}
                      </button>
                    </template>
                  </div>
                  <p v-if="item.summary !== ''" class="text-[14px] leading-relaxed">{{ item.summary }}</p>
                  <details class="text-[13px] text-muted">
                    <summary class="cursor-pointer select-none">Modifiche di origine ({{ item.commits.length }})</summary>
                    <ul class="m-0 mt-1 flex list-none flex-col gap-0.5 p-0">
                      <li v-for="commit in item.commits" :key="commit.sha" class="break-words">
                        <a :href="commitUrl(project, commit.sha)" target="_blank" rel="noopener noreferrer" class="font-mono text-[12.5px] text-accent hover:underline">{{ commit.short }}</a>
                        {{ commit.message }}
                      </li>
                    </ul>
                  </details>
                  <p v-if="choiceStatus(item) !== null" role="status" class="text-[13px] text-info">{{ choiceStatus(item) }}</p>
                  <p v-if="sendErrors[item.key] !== undefined" role="alert" class="text-[13px] text-danger">{{ sendErrors[item.key] }}</p>
                </li>
              </ul>
            </div>
          </div>
        </li>
      </ul>

      <!-- The accounts followed (D-271) -->
      <section class="flex flex-col gap-1 border-t border-line pt-3" aria-labelledby="followed-accounts-title">
        <h3 id="followed-accounts-title" class="text-[14px] font-semibold">Account seguiti ({{ accounts.length }} su {{ maxAccounts }})</h3>
        <p v-if="accounts.length === 0" class="text-[13px] text-muted">Nessun account: scrivi qui sotto l’indirizzo di un account, per esempio https://github.com/copilotkit, per vedere i suoi repository nuovi.</p>
        <ul v-else class="m-0 flex list-none flex-col p-0">
          <li v-for="account in accounts" :key="account.id" class="flex flex-col gap-2 border-t border-line py-2.5 text-[14px] first:border-t-0 first:pt-1">
            <div class="flex flex-wrap items-center gap-2.5">
              <div class="min-w-0 flex-1">
                <a :href="account.page" target="_blank" rel="noopener noreferrer" class="font-semibold hover:text-accent hover:underline">{{ account.id }}</a>
                <div class="text-[13px] text-muted">
                  {{ account.checkedAt === null ? 'Mai controllato' : `Controllato il ${dateText(account.checkedAt)}` }}<template v-if="account.firstCount !== null"> · {{ account.firstCount }} repository al primo controllo</template>
                </div>
              </div>
              <button type="button" class="btn px-2.5 py-1 text-[13px]" :disabled="acting !== null || account.checking" @click="act(account.id, () => checkFollowedProject(account.id))">
                {{ account.checking ? 'Controllo…' : 'Controlla nuovi repository' }}
              </button>
              <button v-if="removing !== account.id" type="button" class="btn px-2.5 py-1 text-[13px]" :disabled="acting !== null || account.checking" @click="removing = account.id">Togli…</button>
            </div>
            <p v-if="removing === account.id" class="flex flex-wrap items-center gap-2 text-[13px]" role="alert">
              <span>Smetto di seguire l’account {{ account.id }}? I progetti già seguiti restano.</span>
              <button type="button" class="btn px-2 py-0.5 text-[13px]" @click="removing = null">No</button>
              <button type="button" class="btn btn-primary px-2 py-0.5 text-[13px]" @click="remove(account.id)">Sì, togli</button>
            </p>
            <p v-if="account.checking" role="status" class="text-[13px] text-info">Leggo i repository dell’account da GitHub…</p>
            <p v-else-if="account.message !== null" role="status" class="text-[13px] text-muted">{{ account.message }}</p>
            <div v-if="account.fresh.length > 0 && account.freshAt !== null" class="flex flex-col gap-1.5 pl-0 sm:pl-3">
              <span class="text-[13px] text-muted">Repository nuovi trovati il {{ dateText(account.freshAt) }}</span>
              <ul class="m-0 flex list-none flex-col overflow-hidden rounded-xl border border-line bg-surface p-0">
                <li v-for="repo in account.fresh" :key="repo.id" class="flex flex-col gap-1 border-b border-line px-3.5 py-2 last:border-b-0">
                  <div class="flex flex-wrap items-start gap-2">
                    <div class="min-w-0 flex-1">
                      <a :href="repo.page" target="_blank" rel="noopener noreferrer" class="text-[14.5px] font-medium break-words hover:text-accent hover:underline">{{ repo.name }}</a>
                      <div class="text-[13px] text-muted">{{ repoFacts(repo, dateText) }}</div>
                    </div>
                    <span v-if="repo.followed" class="pill text-[13px]">Seguito</span>
                    <button
                      v-else
                      type="button"
                      class="btn btn-primary px-2.5 py-1 text-[13px]"
                      :disabled="acting !== null || others >= max"
                      :title="others >= max ? `Segui al più ${max} progetti: togline uno` : undefined"
                      :aria-label="`Segui ${repo.id}`"
                      @click="follow(repo)"
                    >
                      {{ acting === repo.id ? 'Aggiungo…' : 'Segui' }}
                    </button>
                  </div>
                  <p v-if="repo.description !== ''" class="text-[14px] leading-relaxed">{{ repo.description }}</p>
                </li>
              </ul>
            </div>
          </li>
        </ul>
      </section>

      <!-- Follow a project or an account -->
      <form class="grid gap-3 border-t border-line pt-3 sm:grid-cols-6" @submit.prevent="add">
        <label class="flex flex-col gap-1 text-[13px] text-muted sm:col-span-4">
          <span class="text-[14px] font-medium text-ink">Segui un progetto ({{ others }} su {{ max }}) o un account ({{ accounts.length }} su {{ maxAccounts }})</span>
          <input v-model="url" type="url" class="field px-2.5 py-1.5 text-[14px]" placeholder="Per esempio https://github.com/different-ai/openwork o https://github.com/copilotkit" :aria-invalid="urlProblem !== undefined" />
          <span v-if="urlProblem" class="text-warn">{{ urlProblem }}</span>
        </label>
        <div class="flex items-end sm:col-span-1">
          <button type="submit" class="btn px-3 py-1.5 text-[14px]" :disabled="acting !== null || followedUrlProblem(url) !== undefined || full">Segui</button>
        </div>
      </form>
    </template>
  </SettingsCard>
</template>
