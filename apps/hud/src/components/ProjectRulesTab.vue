<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';

import { ApiError, draftProjectRules, loadSettings, previewRulesExport, saveSettings, writeRulesExport, type RulesExportStatus } from '../lib/api.ts';
import { changesText, codeParts, ruleChanges, ruleRows } from '../lib/projects-page.ts';
import type { BrowsableContainer } from '../lib/projects.ts';
import { MAX_PROJECT_RULES, writeError, type SettingsView } from '../lib/settings.ts';
import { AUDIENCE_TEXT, ruleItems, withAudience, type RuleAudience } from '../lib/rule-audience.ts';
import Icon from './Icon.vue';

/**
 * The tab "Regole" of "Progetti" (I-14, tappa R1, D-174), revised in D-191:
 * the rules Arianna puts at the head of every delegation on this project, as
 * a list in the normal font, each with who reads it (D-181) on a pill
 * selector; "Modifica come testo" opens the raw text. The project follows the
 * common template of Settings or has its own text, which starts as a copy of
 * the template. Saved in `[project_rules]` of arianna.toml through the
 * settings page of the core; the save bar shows only with changes.
 */
const props = defineProps<{ container: BrowsableContainer | null }>();
/** `exported`: the files of the project changed, the tab File reads its tree again; `settings`: open a section of the settings. */
const emit = defineEmits<{ exported: []; settings: [slug: string] }>();

const view = ref<SettingsView | null>(null);
/** What went wrong, and what "Riprova" does again. */
const problem = ref<{ text: string; retry: 'load' | 'draft' | 'save' | 'export' | null; localDown?: boolean } | null>(null);
const own = ref(false);
const text = ref('');
const asText = ref(false);
const busy = ref(false);
const saved = ref(false);
/** "Proponi bozza" (D-175): the model is writing, and the draft shown is not saved yet. */
const drafting = ref(false);
const drafted = ref(false);
/** The model did not answer: the draft holds only what the files say. */
const partial = ref(false);

/** "Esporta in CLAUDE.md e AGENTS.md" (D-176): the preview the user confirms, then what was written. */
const exportPreview = ref<{ project: string; text: string; files: { path: string; status: RulesExportStatus }[]; contents?: Record<'CLAUDE.md' | 'AGENTS.md', string> } | null>(null);
const exported = ref<{ path: string; status: 'written' | 'same' | 'foreign' | 'removed' }[] | null>(null);
const exporting = ref(false);
const exportCancel = ref<HTMLButtonElement | null>(null);
watch(
  () => exportPreview.value !== null,
  async (open) => {
    if (!open) return;
    await nextTick();
    exportCancel.value?.focus();
  },
);

const name = computed(() => props.container?.name ?? null);
const rules = computed(() => view.value?.values?.projectRules);
const template = computed(() => rules.value?.template ?? '');
const stored = computed(() => (name.value === null || rules.value === undefined || !Object.hasOwn(rules.value.projects, name.value) ? undefined : rules.value.projects[name.value]));
const changed = computed(() => (own.value ? stored.value !== text.value : stored.value !== undefined));
const tooLong = computed(() => own.value && text.value.length > MAX_PROJECT_RULES);

/** The rules shown, with the headings between them: the own text being written, or the template. */
const rows = computed(() => ruleRows(own.value ? text.value : template.value));
const hasRules = computed(() => rows.value.some((row) => row.kind === 'rule'));
/** Who read each rule before the changes: a rule changed here gets the colour of a change. */
const before = computed(() => new Map(ruleItems(stored.value ?? template.value).map((item) => [item.line, item])));
const audienceChanged = (line: number, textNow: string, audience: RuleAudience): boolean => {
  const old = before.value.get(line);
  return own.value && old !== undefined && old.text === textNow && old.audience !== audience;
};
const saveText = computed(() => {
  const list = ruleChanges({ own: stored.value !== undefined, text: stored.value ?? '' }, { own: own.value, text: text.value });
  return changesText(list.length === 0 ? ['testo delle regole cambiato'] : list, ['modifica non salvata', 'modifiche non salvate']);
});
const AUDIENCES: readonly RuleAudience[] = ['both', 'claude', 'codex'];
const EXPORT_NAMES = ['CLAUDE.md', 'AGENTS.md'] as const;

function chooseAudience(line: number, audience: RuleAudience): void {
  saved.value = false;
  text.value = withAudience(text.value, line, audience);
}

/** The two files of the preview hold different texts when some rule is for one executor only. */
const exportSplit = computed(() => {
  const contents = exportPreview.value?.contents;
  return contents !== undefined && contents['CLAUDE.md'] !== contents['AGENTS.md'];
});

/** Why a draft was not written, from the status of the core. */
function draftError(error: unknown): { text: string; localDown?: boolean } {
  if (!(error instanceof ApiError)) return { text: error instanceof Error ? error.message : 'errore' };
  if (error.status === 503) return { text: 'Il modello locale non risponde: controlla oMLX.', localDown: true };
  if (error.status === 504) return { text: 'Il modello locale ci ha messo troppo: riprova fra poco.' };
  if (error.status === 409) return { text: 'Sta già scrivendo un’altra bozza: aspetta che finisca.' };
  if (error.status === 403) return { text: 'Il gateway ha fermato la bozza: i file del progetto contengono qualcosa che non può leggere.' };
  return { text: 'Il modello locale non ha scritto una bozza valida: riprova.' };
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
    if (name.value === asked) problem.value = { ...draftError(error), retry: 'draft' };
  } finally {
    drafting.value = false;
  }
}

/** What the preview says of each file. */
const EXPORT_STATUS: Record<RulesExportStatus | 'written' | 'removed', string> = {
  new: 'nuovo',
  same: 'già uguale, non cambia',
  arianna: 'scritto da Arianna: lo aggiorno',
  foreign: 'tuo: non lo tocco',
  stale: 'scritto da Arianna, ora senza regole per lui: lo tolgo',
  written: 'scritto',
  removed: 'tolto',
};

const exportWrites = computed(() => exportPreview.value?.files.some((file) => file.status === 'new' || file.status === 'arianna' || file.status === 'stale') ?? false);

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
    if (name.value === asked) problem.value = { text: exportError(error), retry: 'export' };
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
    emit('exported');
  } catch (error) {
    if (name.value === asked) {
      exportPreview.value = null;
      problem.value = { text: exportError(error), retry: 'export' };
    }
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
    if (view.value.values === null) problem.value = { text: `Non leggo le regole: ${view.value.error ?? 'il file arianna.toml non si legge'}.`, retry: 'load' };
    else if (view.value.values.projectRules === undefined) problem.value = { text: 'Il nucleo in esecuzione non conosce ancora le regole dei progetti: riavvialo.', retry: 'load' };
    fill();
  } catch (error) {
    problem.value = { text: `Non leggo le regole: ${error instanceof Error ? error.message : 'errore'}.`, retry: 'load' };
  }
}

watch(
  name,
  () => {
    // A preview belongs to its project: gone at once, before the settings answer.
    exportPreview.value = null;
    exported.value = null;
    asText.value = false;
    void load();
  },
  { immediate: true },
);

/** "Modello comune" or "Regole proprie"; the first time, the own rules start as a copy of the template. */
function chooseMode(mine: boolean): void {
  saved.value = false;
  if (!mine) {
    own.value = false;
    drafted.value = false;
    asText.value = false;
    return;
  }
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
      problem.value = { text: message, retry: reload ? null : 'save' };
      if (reload) void load();
    } else problem.value = { text: error instanceof Error ? error.message : 'errore', retry: 'save' };
  } finally {
    busy.value = false;
  }
}

function retry(): void {
  const kind = problem.value?.retry;
  if (kind === 'load') void load();
  else if (kind === 'draft') void propose();
  else if (kind === 'save') void save();
  else if (kind === 'export') void openExport();
}
</script>

<template>
  <div class="flex flex-col gap-3" aria-label="Regole del progetto">
    <!-- Wide rules on the left, a sticky column of settings on the right; below 1100 px the column goes under (D-193) -->
    <div class="grid grid-cols-1 items-start gap-4 min-[1100px]:grid-cols-[minmax(0,1fr)_340px]">
      <section class="flex min-w-0 flex-col gap-3 rounded-2xl border border-line bg-surface-2 p-4 md:p-5">
        <div class="flex flex-wrap items-center gap-2">
          <h2 class="mr-auto text-[16px] font-semibold">Regole per Claude Code e Codex</h2>
          <button v-if="rules !== undefined && own" type="button" class="btn px-2.5 py-1 text-xs" :aria-pressed="asText" @click="asText = !asText">
            <Icon :name="asText ? 'view-list' : 'rename'" :size="13" />{{ asText ? 'Torna all’elenco' : 'Modifica come testo' }}
          </button>
        </div>
        <p class="text-[14.5px]">
          Arianna le mette in testa a ogni lavoro del Coder su <b class="font-semibold">{{ name }}</b>. Ogni regola va a tutti e due o solo a uno: lo scegli accanto alla regola. Esempio: «Usa pnpm, mai npm» evita che Codex crei un <span class="font-mono text-[13px]">package-lock.json</span>.
        </p>

        <div v-if="problem !== null" role="alert" class="flex flex-wrap items-center gap-2.5 rounded-xl border border-danger/50 bg-danger/10 px-3 py-2 text-[14px]">
          <span class="text-danger"><Icon name="warning" :size="15" /></span>
          <span class="min-w-0 flex-1">{{ problem.text }}</span>
          <button v-if="problem.retry !== null" type="button" class="btn px-2.5 py-1 text-xs" :disabled="busy || drafting || exporting" @click="retry"><Icon name="retry" :size="13" />Riprova</button>
          <button v-if="problem.localDown" type="button" class="btn px-2.5 py-1 text-xs" @click="emit('settings', 'server-locali')"><Icon name="server" :size="13" />Server locali</button>
        </div>

        <template v-if="rules !== undefined">
          <div v-if="drafted" class="flex flex-wrap items-center gap-2.5 rounded-xl border border-info/45 bg-info/9 px-3 py-2 text-[14px]">
            <span class="text-info"><Icon name="info" :size="15" /></span>
            <span class="min-w-0 flex-1">
              Bozza non ancora salvata: il modello comune, le regole ricavate dai file del progetto<template v-if="!partial"> e le convenzioni dei framework proposte dal modello locale</template>. Rileggila, correggila e salva.
              <template v-if="partial"> Il modello locale non ha risposto: mancano le convenzioni dei framework.</template>
            </span>
          </div>

          <label v-if="own && asText" class="flex flex-col gap-1 text-[13px] text-muted">
            Il testo delle regole: ogni riga al margine è una regola; «[solo Claude Code]» o «[solo Codex]» all’inizio la dà a uno solo; i titoli con «#» restano per tutti e due.
            <textarea v-model="text" rows="14" :maxlength="MAX_PROJECT_RULES" class="field px-2.5 py-2 font-mono text-[13.5px] leading-relaxed text-ink" @input="saved = false" />
          </label>
          <template v-else>
            <p v-if="!hasRules" class="text-[14px] text-muted">
              <template v-if="own">Nessuna regola: il Coder lavora senza regole di progetto. Scrivile con «Modifica come testo».</template>
              <template v-else>Il modello comune è vuoto: il progetto non ha regole.</template>
            </p>
            <div v-else class="flex flex-col" :aria-label="own ? 'Le regole del progetto e a chi vanno' : 'Le regole del modello comune'">
              <template v-for="row in rows" :key="row.kind === 'head' ? `h${String(row.line)}` : `r${String(row.item.line)}`">
                <p v-if="row.kind === 'head'" class="border-b border-line pt-3.5 pb-1.5 text-[13px] font-semibold text-muted">{{ row.text }}</p>
                <div v-else class="grid grid-cols-1 items-center gap-x-3 gap-y-1.5 border-b border-line py-2 text-[14.5px] last:border-b-0 sm:grid-cols-[minmax(0,1fr)_auto]" :class="audienceChanged(row.item.line, row.item.text, row.item.audience) ? 'bg-accent/5' : ''">
                  <span class="min-w-0 break-words"><template v-for="(part, at) in codeParts(row.item.text)" :key="at"><code v-if="part.code" class="font-mono text-[13px]">{{ part.text }}</code><template v-else>{{ part.text }}</template></template></span>
                  <span v-if="own" class="inline-flex justify-self-start overflow-hidden rounded-full border border-line-strong text-[13px] sm:justify-self-end" role="group" :aria-label="`A chi va la regola: ${row.item.text}`">
                    <button
                      v-for="(audience, at) in AUDIENCES"
                      :key="audience"
                      type="button"
                      class="px-2.5 py-0.5"
                      :class="[at > 0 ? 'border-l border-line-strong' : '', row.item.audience === audience ? 'bg-accent/14 font-semibold text-ink' : 'text-muted hover:text-ink']"
                      :aria-pressed="row.item.audience === audience"
                      @click="chooseAudience(row.item.line, audience)"
                    >
                      {{ AUDIENCE_TEXT[audience] }}
                    </button>
                  </span>
                  <span v-else class="justify-self-start rounded-full border border-line-strong px-2.5 py-0.5 text-[13px] text-muted sm:justify-self-end">{{ AUDIENCE_TEXT[row.item.audience] }}</span>
                </div>
              </template>
            </div>
            <p v-if="!own" class="text-[13px] text-muted">
              Il modello comune si scrive in
              <button type="button" class="text-accent hover:underline" @click="emit('settings', 'regole-dei-progetti')">Impostazioni → Regole dei progetti</button>. Per sceglierle solo per questo progetto passa a «Regole proprie».
            </p>
          </template>
          <p v-if="tooLong" class="text-[13px] text-danger">Al massimo {{ MAX_PROJECT_RULES }} caratteri.</p>

          <div v-if="exported !== null" role="status" class="flex flex-col gap-0.5 rounded-xl border border-ok/45 bg-ok/9 px-3 py-2 text-[13px]">
            <span class="text-[14px]">Esportazione fatta: ricordati di committare i file nel progetto.</span>
            <span v-for="file in exported" :key="file.path"><code class="font-mono">{{ file.path }}</code> — {{ EXPORT_STATUS[file.status] }}</span>
          </div>
          <p v-if="saved && !changed" role="status" class="flex items-center gap-1.5 text-[13px] text-ok"><Icon name="saved" :size="14" />Regole salvate.</p>
        </template>
      </section>

      <aside v-if="rules !== undefined" class="flex min-w-0 flex-col gap-3 min-[1100px]:sticky min-[1100px]:top-3" aria-label="Impostazioni delle regole">
        <section class="rounded-2xl border border-line bg-surface-2 px-5 py-4">
          <h3 class="mb-1.5 font-hud text-[12px] font-semibold tracking-[0.14em] text-muted uppercase">Quali regole</h3>
          <span class="flex w-full overflow-hidden rounded-[9px] border border-line-strong" role="group" aria-label="Quali regole">
            <button type="button" class="flex-1 px-2 py-1.5 text-[14px]" :class="!own ? 'bg-accent/14 font-semibold text-ink' : 'bg-surface-2 text-muted hover:text-ink'" :aria-pressed="!own" @click="chooseMode(false)">Modello comune</button>
            <button type="button" class="flex-1 border-l border-line-strong px-2 py-1.5 text-[14px]" :class="own ? 'bg-accent/14 font-semibold text-ink' : 'bg-surface-2 text-muted hover:text-ink'" :aria-pressed="own" @click="chooseMode(true)">Regole proprie</button>
          </span>
          <p class="mt-2 text-[13px] text-muted">{{ own ? 'Partono da una copia del modello comune; vuote = nessuna regola.' : 'Le stesse di ogni progetto senza regole proprie.' }}</p>
        </section>

        <section v-if="stored === undefined || drafted" class="rounded-2xl border border-line bg-surface-2 px-5 py-4">
          <h3 class="mb-1.5 font-hud text-[12px] font-semibold tracking-[0.14em] text-muted uppercase">Bozza</h3>
          <p class="mb-2 text-[13.5px]">Arianna può proporre regole adatte guardando linguaggi, gestore di pacchetti e file di stile delle parti.</p>
          <button type="button" class="btn px-2.5 py-1 text-xs" :disabled="drafting" @click="propose">{{ drafting ? 'Scrivo la bozza…' : drafted ? 'Riproponi' : 'Proponi bozza' }}</button>
        </section>

        <section class="rounded-2xl border border-line bg-surface-2 px-5 py-4">
          <h3 class="mb-1.5 font-hud text-[12px] font-semibold tracking-[0.14em] text-muted uppercase">Esporta</h3>
          <p class="mb-2 text-[13.5px]">Scrive le regole salvate in <code class="font-mono text-[13px]">CLAUDE.md</code> e <code class="font-mono text-[13px]">AGENTS.md</code> delle parti, dopo un’anteprima. Il commit lo fai tu.</p>
          <button
            type="button"
            class="btn px-2.5 py-1 text-xs"
            :disabled="changed || exporting || exportPreview !== null"
            :title="changed ? 'Salva prima le regole' : 'Scrive le regole salvate in CLAUDE.md e AGENTS.md del progetto, dopo un’anteprima'"
            @click="openExport"
          >
            {{ exporting && exportPreview === null ? 'Preparo l’anteprima…' : 'Esporta in CLAUDE.md e AGENTS.md…' }}
          </button>
        </section>

        <ul class="grid list-disc gap-1 pl-5 text-[13px] text-muted">
          <li>Il testo va al cloud come <b class="font-semibold">Interno</b>, dal gateway: niente nomi di clienti, importi o password (il salvataggio li rifiuta).</li>
          <li>Valgono dalla prossima conversazione con il Coder; gli agenti non fanno mai commit, il commit lo fai tu.</li>
        </ul>
      </aside>
    </div>

    <!-- The save bar: only with changes, sticky at the bottom (D-191) -->
    <div v-if="rules !== undefined && changed" class="sticky bottom-3 z-10 flex flex-wrap items-center gap-2.5 rounded-xl border border-line-strong bg-surface-2 px-4 py-2.5 text-[14px] shadow-[0_8px_24px_#0003]">
      <span class="min-w-0 flex-1">{{ saveText }}</span>
      <button type="button" class="btn px-3 py-1 text-[14px]" :disabled="busy" @click="fill">Annulla</button>
      <button type="button" class="btn btn-primary px-3 py-1 text-[14px] font-semibold" :disabled="busy || tooLong" @click="save">Salva</button>
    </div>

    <!-- The preview of the export, in a window -->
    <div v-if="exportPreview !== null" class="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="rules-export-title" @keydown.esc="!exporting && (exportPreview = null)">
      <div class="flex max-h-[90vh] w-full max-w-[640px] flex-col overflow-hidden rounded-2xl border border-line-strong bg-surface shadow-[0_24px_70px_#0008]">
        <div class="flex flex-col gap-2 overflow-auto px-5 pt-5 pb-3 text-[14px]">
          <h2 id="rules-export-title" class="text-[16px] font-semibold">Esportare le regole?</h2>
          <p>
            Scrivo le regole in CLAUDE.md (per Claude Code) e in AGENTS.md (per Codex), così le vedono anche quando li lanci tu nella cartella<template v-if="exportSplit">: ognuno riceve solo le regole per lui</template>. I file restano da committare a te.
          </p>
          <template v-if="exportSplit && exportPreview.contents">
            <template v-for="file in EXPORT_NAMES" :key="file">
              <p class="font-mono text-[13px] text-muted">{{ file }}</p>
              <pre v-if="exportPreview.contents[file] !== ''" class="max-h-[200px] overflow-auto rounded-md border border-line bg-surface-2 px-2.5 py-2 font-mono text-[13px] leading-relaxed whitespace-pre-wrap">{{ exportPreview.contents[file] }}</pre>
              <p v-else class="text-[13px] text-muted">Nessuna regola per lui: il file non si scrive (se l’aveva scritto Arianna, si toglie).</p>
            </template>
          </template>
          <pre v-else class="max-h-[260px] overflow-auto rounded-md border border-line bg-surface-2 px-2.5 py-2 font-mono text-[13px] leading-relaxed whitespace-pre-wrap">{{ exportPreview.text }}</pre>
          <ul class="flex flex-col gap-0.5 text-[13px]">
            <li v-for="file in exportPreview.files" :key="file.path" class="flex gap-2">
              <code class="font-mono">{{ file.path }}</code><span :class="file.status === 'foreign' || file.status === 'stale' ? 'text-warn' : 'text-muted'">{{ EXPORT_STATUS[file.status] }}</span>
            </li>
            <li v-if="exportPreview.files.length === 0" class="text-muted">Nessuna parte del progetto è una cartella con git: non c’è dove scrivere.</li>
          </ul>
        </div>
        <div class="flex justify-end gap-2 border-t border-line px-5 py-3">
          <button ref="exportCancel" type="button" class="btn px-3 py-1 text-[14px]" :disabled="exporting" @click="exportPreview = null">Annulla</button>
          <button type="button" class="btn btn-primary px-3 py-1 text-[14px] font-semibold" :disabled="exporting || changed || !exportWrites" @click="confirmExport">Conferma ed esporta</button>
        </div>
      </div>
    </div>
  </div>
</template>
