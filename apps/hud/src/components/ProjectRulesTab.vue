<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import { ApiError, draftProjectRules, loadSettings, previewRulesExport, saveSettings, writeRulesExport, type RulesExportStatus } from '../lib/api.ts';
import type { BrowsableContainer } from '../lib/projects.ts';
import { MAX_PROJECT_RULES, writeError, type SettingsView } from '../lib/settings.ts';
import Icon from './Icon.vue';

/**
 * The tab "Regole" of "Progetti" (I-14, tappa R1, D-174): the rules Arianna
 * puts at the head of every delegation on this project, the same for Claude
 * and for Codex. The project follows the common template of Settings, or has
 * its own text, which starts as a copy of the template. Saved in
 * `[project_rules]` of arianna.toml through the settings page of the core.
 */
const props = defineProps<{ container: BrowsableContainer | null }>();

const view = ref<SettingsView | null>(null);
const problem = ref<string | null>(null);
const own = ref(false);
const text = ref('');
const busy = ref(false);
const saved = ref(false);
/** "Proponi bozza" (D-175): the model is writing, and the draft shown is not saved yet. */
const drafting = ref(false);
const drafted = ref(false);
/** The model did not answer: the draft holds only what the files say. */
const partial = ref(false);

/** "Esporta in CLAUDE.md e AGENTS.md" (D-176): the preview the user confirms, then what was written. */
const exportPreview = ref<{ project: string; text: string; files: { path: string; status: RulesExportStatus }[] } | null>(null);
const exported = ref<{ path: string; status: 'written' | 'same' | 'foreign' }[] | null>(null);
const exporting = ref(false);

const name = computed(() => props.container?.name ?? null);
const rules = computed(() => view.value?.values?.projectRules);
const template = computed(() => rules.value?.template ?? '');
const stored = computed(() => (name.value === null || rules.value === undefined || !Object.hasOwn(rules.value.projects, name.value) ? undefined : rules.value.projects[name.value]));
const changed = computed(() => (own.value ? stored.value !== text.value : stored.value !== undefined));
const tooLong = computed(() => own.value && text.value.length > MAX_PROJECT_RULES);

/** Why a draft was not written, from the status of the core. */
function draftError(error: unknown): string {
  if (!(error instanceof ApiError)) return error instanceof Error ? error.message : 'errore';
  if (error.status === 503) return 'Il modello locale non risponde: controlla oMLX in Impostazioni → Server locali.';
  if (error.status === 504) return 'Il modello locale ci ha messo troppo: riprova fra poco.';
  if (error.status === 409) return 'Sta già scrivendo un’altra bozza: aspetta che finisca.';
  if (error.status === 403) return 'Il gateway ha fermato la bozza: i file del progetto contengono qualcosa che non può leggere.';
  return 'Il modello locale non ha scritto una bozza valida: riprova.';
}

/** The local model drafts the rules from the folder and the common template; shown in "Regole proprie", not saved. */
async function propose(): Promise<void> {
  if (name.value === null || drafting.value) return;
  // The project the draft is for: one chosen meanwhile never receives it.
  const asked = name.value;
  drafting.value = true;
  problem.value = null;
  saved.value = false;
  try {
    const draft = await draftProjectRules(asked);
    if (name.value !== asked) return;
    own.value = true;
    text.value = draft.text;
    drafted.value = true;
    partial.value = draft.partial !== undefined;
  } catch (error) {
    if (name.value === asked) problem.value = draftError(error);
  } finally {
    drafting.value = false;
  }
}

/** What the preview says of each file. */
const EXPORT_STATUS: Record<RulesExportStatus | 'written', string> = {
  new: 'nuovo',
  same: 'già uguale, non cambia',
  arianna: 'scritto da Arianna: lo aggiorno',
  foreign: 'tuo: non lo tocco',
  written: 'scritto',
};

const exportWrites = computed(() => exportPreview.value?.files.some((file) => file.status === 'new' || file.status === 'arianna') ?? false);

function exportError(error: unknown): string {
  if (!(error instanceof ApiError)) return error instanceof Error ? error.message : 'errore';
  if (error.status === 409) return error.message.includes('changed') ? 'Le regole o i file sono cambiati dopo l’anteprima: riaprila.' : 'Il progetto non ha regole da esportare.';
  return error.message;
}

async function openExport(): Promise<void> {
  if (name.value === null || exporting.value) return;
  const asked = name.value;
  exporting.value = true;
  problem.value = null;
  exported.value = null;
  try {
    const preview = await previewRulesExport(asked);
    if (name.value === asked) exportPreview.value = { project: asked, ...preview };
  } catch (error) {
    if (name.value === asked) problem.value = exportError(error);
  } finally {
    exporting.value = false;
  }
}

async function confirmExport(): Promise<void> {
  const preview = exportPreview.value;
  // Only the preview of the project on the page, with the rules saved.
  if (preview === null || preview.project !== name.value || changed.value || exporting.value) return;
  const asked = preview.project;
  exporting.value = true;
  problem.value = null;
  try {
    const result = await writeRulesExport(asked, preview);
    if (name.value !== asked) return;
    exported.value = result.files;
    exportPreview.value = null;
  } catch (error) {
    if (name.value === asked) problem.value = exportError(error);
  } finally {
    exporting.value = false;
  }
}

/** The form as the file has it. */
function fill(): void {
  drafted.value = false;
  exportPreview.value = null;
  exported.value = null;
  own.value = stored.value !== undefined;
  text.value = stored.value ?? '';
}

async function load(): Promise<void> {
  problem.value = null;
  saved.value = false;
  try {
    view.value = await loadSettings();
    if (view.value.values === null) problem.value = view.value.error ?? 'il file arianna.toml non si legge';
    else if (view.value.values.projectRules === undefined) problem.value = 'il nucleo in esecuzione non conosce ancora le regole dei progetti: riavvialo';
    fill();
  } catch (error) {
    problem.value = error instanceof Error ? error.message : 'errore';
  }
}

watch(
  name,
  () => {
    // A preview belongs to its project: gone at once, before the settings answer.
    exportPreview.value = null;
    exported.value = null;
    void load();
  },
  { immediate: true },
);

/** "Regole proprie": the first time, a copy of the template to start from. */
function chooseOwn(): void {
  if (own.value) return;
  own.value = true;
  if (text.value === '') text.value = template.value;
}

async function save(): Promise<void> {
  const fingerprint = view.value?.fingerprint;
  const current = rules.value;
  if (name.value === null || current === undefined || fingerprint === null || fingerprint === undefined) return;
  const projects = { ...current.projects };
  if (own.value) projects[name.value] = text.value;
  else delete projects[name.value];
  busy.value = true;
  problem.value = null;
  try {
    view.value = await saveSettings(fingerprint, { projectRules: { template: current.template, projects } });
    fill();
    saved.value = true;
  } catch (error) {
    if (error instanceof ApiError) {
      const { text: message, reload } = writeError(error.status, error.message);
      problem.value = message;
      if (reload) void load();
    } else problem.value = error instanceof Error ? error.message : 'errore';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="flex max-w-[860px] flex-col gap-3.5 rounded-2xl border border-line bg-surface p-4 md:p-5" aria-label="Regole del progetto">
    <p class="text-[13px] text-muted">
      Arianna mette queste regole in testa a ogni lavoro di Claude o di Codex su <span class="font-medium text-ink">{{ name }}</span>, uguali per tutti e due.
    </p>

    <p v-if="problem !== null" role="alert" class="rounded-lg border border-danger/50 bg-danger/10 px-3 py-2 text-sm text-danger">{{ problem }}</p>

    <template v-if="rules !== undefined">
      <div v-if="stored === undefined || drafted" class="flex flex-wrap items-center gap-2.5 rounded-[10px] border border-info/45 bg-info/9 px-3 py-2 text-[13px]">
        <Icon name="info" :size="16" class="shrink-0 text-info" />
        <span v-if="drafted" class="min-w-0 flex-1">
          Bozza non ancora salvata: il modello comune, le regole ricavate dai file del progetto<template v-if="!partial"> e le convenzioni dei framework proposte dal modello locale</template>. Rileggila, correggila e premi Salva.
          <template v-if="partial"> Il modello locale non ha risposto: mancano le convenzioni dei framework.</template>
        </span>
        <span v-else class="min-w-0 flex-1">Questo progetto usa il modello comune. Arianna può proporti regole adatte, guardando linguaggi, gestore di pacchetti e file di stile della cartella.</span>
        <button type="button" class="btn px-2.5 py-1 text-xs" :disabled="drafting" @click="propose">{{ drafting ? 'Scrivo la bozza…' : drafted ? 'Riproponi' : 'Proponi bozza' }}</button>
      </div>
      <fieldset class="flex flex-wrap gap-2">
        <legend class="sr-only">Quali regole</legend>
        <label class="inline-flex items-center gap-2 rounded-md border border-line bg-surface-2 px-2.5 py-1.5 text-[13px]">
          <input type="radio" name="rules-mode" :checked="!own" @change="own = false; drafted = false" />Modello comune
        </label>
        <label class="inline-flex items-center gap-2 rounded-md border border-line bg-surface-2 px-2.5 py-1.5 text-[13px]">
          <input type="radio" name="rules-mode" :checked="own" @change="chooseOwn" />Regole proprie
        </label>
      </fieldset>

      <template v-if="!own">
        <pre v-if="template.trim() !== ''" class="max-h-[340px] overflow-auto rounded-[10px] border border-line bg-surface-2 px-3 py-2.5 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap">{{ template }}</pre>
        <p v-else class="text-[13px] text-muted">Il modello comune è vuoto: il progetto non ha regole.</p>
        <p class="text-xs text-muted">Il modello comune si scrive in Impostazioni → Regole dei progetti.</p>
      </template>
      <label v-else class="flex flex-col gap-1 text-xs text-muted">
        Regole di questo progetto (partono dal modello comune; vuote = nessuna regola)
        <textarea v-model="text" rows="12" :maxlength="MAX_PROJECT_RULES" class="field px-2.5 py-2 font-mono text-[12.5px] leading-relaxed text-ink" />
        <span v-if="tooLong" class="text-danger">Al massimo {{ MAX_PROJECT_RULES }} caratteri.</span>
      </label>

      <p class="text-xs text-muted">Una chat diretta con il Coder già aperta continua con le regole di quando è iniziata: le nuove valgono dalla prossima conversazione.</p>
      <p class="flex items-start gap-1.5 text-xs text-muted">
        <Icon name="gateway" :size="14" class="mt-px shrink-0 text-warn" />
        <span>Il testo va al cloud come Interno, dal gateway: niente dati personali, nomi di clienti, importi o password (il nucleo rifiuta il salvataggio se ne trova).</span>
      </p>
      <p class="flex items-start gap-1.5 text-xs text-muted">
        <Icon name="private" :size="14" class="mt-px shrink-0" />
        <span>Gli agenti non fanno mai commit: la cartella <code class="font-mono">.git</code> è in sola lettura per loro, le modifiche restano da rivedere e il commit lo fai tu.</span>
      </p>

      <div v-if="exportPreview !== null" class="flex flex-col gap-2 rounded-[10px] border border-line bg-surface-2 px-3 py-2.5 text-[13px]" aria-label="Anteprima dell’esportazione">
        <p>Scrivo queste regole, uguali, in CLAUDE.md (per Claude Code) e in AGENTS.md (per Codex), così le vedono anche quando li lanci tu nella cartella. I file restano da committare a te.</p>
        <pre class="max-h-[240px] overflow-auto rounded-md border border-line bg-surface px-2.5 py-2 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap">{{ exportPreview.text }}</pre>
        <ul class="flex flex-col gap-0.5 text-xs">
          <li v-for="file in exportPreview.files" :key="file.path" class="flex gap-2">
            <code class="font-mono">{{ file.path }}</code><span :class="file.status === 'foreign' ? 'text-warn' : 'text-muted'">{{ EXPORT_STATUS[file.status] }}</span>
          </li>
          <li v-if="exportPreview.files.length === 0" class="text-muted">Nessuna parte del progetto è una cartella con git: non c’è dove scrivere.</li>
        </ul>
        <div class="flex items-center justify-end gap-2.5">
          <button type="button" class="btn px-3 py-1.5 text-[13px]" :disabled="exporting" @click="exportPreview = null">Annulla</button>
          <button type="button" class="btn btn-primary px-3 py-1.5 text-[13px] font-semibold" :disabled="exporting || changed || !exportWrites" @click="confirmExport">Conferma ed esporta</button>
        </div>
      </div>
      <div v-if="exported !== null" role="status" class="flex flex-col gap-0.5 rounded-[10px] border border-ok/45 bg-ok/9 px-3 py-2 text-xs">
        <span class="text-[13px]">Esportazione fatta: ricordati di committare i file nel progetto.</span>
        <span v-for="file in exported" :key="file.path"><code class="font-mono">{{ file.path }}</code> — {{ EXPORT_STATUS[file.status] }}</span>
      </div>

      <div class="flex flex-wrap items-center justify-end gap-2.5">
        <button
          type="button"
          class="btn mr-auto px-3 py-1.5 text-[13px]"
          :disabled="changed || exporting || exportPreview !== null"
          :title="changed ? 'Salva prima le regole' : 'Scrive le regole salvate in CLAUDE.md e AGENTS.md del progetto, dopo un’anteprima'"
          @click="openExport"
        >
          Esporta in CLAUDE.md e AGENTS.md
        </button>
        <span v-if="saved && !changed" role="status" class="text-xs text-ok">Salvato</span>
        <button type="button" class="btn px-3 py-1.5 text-[13px]" :disabled="!changed || busy" @click="fill">Annulla</button>
        <button type="button" class="btn btn-primary px-3 py-1.5 text-[13px] font-semibold" :disabled="!changed || busy || tooLong" @click="save">Salva</button>
      </div>
    </template>
  </section>
</template>
