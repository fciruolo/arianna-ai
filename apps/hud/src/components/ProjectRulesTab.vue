<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import { ApiError, loadSettings, saveSettings } from '../lib/api.ts';
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

const name = computed(() => props.container?.name ?? null);
const rules = computed(() => view.value?.values?.projectRules);
const template = computed(() => rules.value?.template ?? '');
const stored = computed(() => (name.value === null || rules.value === undefined || !Object.hasOwn(rules.value.projects, name.value) ? undefined : rules.value.projects[name.value]));
const changed = computed(() => (own.value ? stored.value !== text.value : stored.value !== undefined));
const tooLong = computed(() => own.value && text.value.length > MAX_PROJECT_RULES);

/** The form as the file has it. */
function fill(): void {
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

watch(name, () => void load(), { immediate: true });

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
      <fieldset class="flex flex-wrap gap-2">
        <legend class="sr-only">Quali regole</legend>
        <label class="inline-flex items-center gap-2 rounded-md border border-line bg-surface-2 px-2.5 py-1.5 text-[13px]">
          <input type="radio" name="rules-mode" :checked="!own" @change="own = false" />Modello comune
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

      <div class="flex items-center justify-end gap-2.5">
        <span v-if="saved && !changed" role="status" class="text-xs text-ok">Salvato</span>
        <button type="button" class="btn px-3 py-1.5 text-[13px]" :disabled="!changed || busy" @click="fill">Annulla</button>
        <button type="button" class="btn btn-primary px-3 py-1.5 text-[13px] font-semibold" :disabled="!changed || busy || tooLong" @click="save">Salva</button>
      </div>
    </template>
  </section>
</template>
