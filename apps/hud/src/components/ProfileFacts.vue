<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';

import { ApiError, confirmFactShare, createUserFact, loadUserFacts, prepareFactShare, removeUserFact, updateUserFact } from '../lib/api.ts';
import {
  EMPTY_FACT,
  factErrorText,
  factProblems,
  formOf,
  LEVEL_HINT,
  LEVEL_TEXT,
  MAX_FACT_TEXT,
  MAX_TOPIC,
  PROFILE_INTRO,
  PROFILE_REAL_DATA,
  saveKind,
  SHARE_CONFIRM_TEXT,
  SHARED_NOTICE,
  TOPIC_NOTICE,
  type FactForm,
  type ShareProposal,
  type UserFact,
} from '../lib/profile.ts';
import ConfirmDialog from './ConfirmDialog.vue';
import FormField from './FormField.vue';
import Icon from './Icon.vue';

/**
 * «Su di te» (D-114, tappa A): the facts of the user's profile, one at a
 * time, each «Solo in casa» (the default) or «Condivisibile». Adding,
 * editing, deleting and raising a fact back to «Solo in casa» are immediate;
 * making a fact «Condivisibile» is shown first and written only on
 * confirmation, as a privacy change of the Settings (D-071).
 */
const facts = ref<UserFact[] | null>(null);
const loadProblem = ref<string | null>(null);
/** The fact being edited: an id, 'new', or null. */
const editing = ref<string | null>(null);
const form = ref<FactForm>({ ...EMPTY_FACT });
const tried = ref(false);
const serverProblem = ref<{ field: 'topic' | 'text' | null; text: string } | null>(null);
const busy = ref(false);
const removing = ref<string | null>(null);
const proposal = ref<ShareProposal | null>(null);

const current = computed(() => (editing.value === null || editing.value === 'new' ? null : (facts.value?.find((fact) => fact.id === editing.value) ?? null)));
const problems = computed(() => {
  const found = tried.value ? factProblems(form.value) : {};
  const server = serverProblem.value;
  if (server?.field === 'topic' && found.topic === undefined) found.topic = server.text;
  if (server?.field === 'text' && found.text === undefined) found.text = server.text;
  return found;
});
const generalProblem = computed(() => (serverProblem.value !== null && serverProblem.value.field === null ? serverProblem.value.text : null));

function failure(cause: unknown): { field: 'topic' | 'text' | null; text: string } {
  return cause instanceof ApiError ? factErrorText(cause.message, cause.status) : { field: null, text: 'Il core non risponde: riprova.' };
}

async function reload(): Promise<void> {
  try {
    facts.value = await loadUserFacts();
    loadProblem.value = null;
  } catch (cause) {
    loadProblem.value = failure(cause).text;
  }
}
onMounted(reload);

function edit(fact: UserFact | null): void {
  editing.value = fact === null ? 'new' : fact.id;
  form.value = fact === null ? { ...EMPTY_FACT } : formOf(fact);
  tried.value = false;
  serverProblem.value = null;
  removing.value = null;
}

function close(): void {
  editing.value = null;
  serverProblem.value = null;
}

async function save(): Promise<void> {
  tried.value = true;
  serverProblem.value = null;
  if (Object.keys(factProblems(form.value)).length > 0) return;
  const fields = { topic: form.value.topic.trim(), text: form.value.text.trim() };
  busy.value = true;
  try {
    const fact = current.value;
    if (fact === null) {
      await createUserFact({ ...fields, label: form.value.shared ? 'L1' : 'L2' });
    } else if (saveKind(fact, form.value) === 'share') {
      // Shown first: nothing changes until «Rendi condivisibile».
      proposal.value = await prepareFactShare(fact.id, fields);
      return;
    } else {
      await updateUserFact(fact.id, { ...fields, label: form.value.shared ? 'L1' : 'L2' });
    }
    close();
    await reload();
  } catch (cause) {
    serverProblem.value = failure(cause);
  } finally {
    busy.value = false;
  }
}

async function confirmShare(): Promise<void> {
  if (proposal.value === null) return;
  busy.value = true;
  try {
    await confirmFactShare(proposal.value.id);
    proposal.value = null;
    close();
    await reload();
  } catch (cause) {
    proposal.value = null;
    serverProblem.value = failure(cause);
  } finally {
    busy.value = false;
  }
}

async function remove(fact: UserFact): Promise<void> {
  busy.value = true;
  try {
    await removeUserFact(fact.id);
    removing.value = null;
    if (editing.value === fact.id) close();
    await reload();
  } catch (cause) {
    loadProblem.value = failure(cause).text;
  } finally {
    busy.value = false;
  }
}

const input = 'field w-full min-w-0 px-2.5 py-1.5 text-[14px] text-ink';
</script>

<template>
  <div class="flex flex-col gap-3.5">
    <section class="rounded-xl border border-line bg-surface-2 p-4 text-[14px]">
      <p class="max-w-[80ch]">{{ PROFILE_INTRO }}</p>
      <p class="mt-2 flex max-w-[80ch] items-start gap-2 text-warn"><Icon name="warning" :size="14" class="mt-0.5 shrink-0" />{{ PROFILE_REAL_DATA }}</p>
      <dl class="mt-3 grid max-w-[80ch] gap-1.5 text-muted sm:grid-cols-[auto_1fr] sm:gap-x-3">
        <dt class="font-semibold text-ink">{{ LEVEL_TEXT.L2 }}</dt>
        <dd>{{ LEVEL_HINT.L2 }}</dd>
        <dt class="font-semibold text-ink">{{ LEVEL_TEXT.L1 }}</dt>
        <dd>{{ LEVEL_HINT.L1 }} Diventarlo chiede conferma.</dd>
      </dl>
    </section>

    <div class="flex flex-wrap items-center gap-2">
      <button type="button" class="btn btn-primary px-3 py-1.5 text-[14px]" :disabled="busy || editing !== null || facts === null" @click="edit(null)"><Icon name="new" :size="14" />Aggiungi</button>
      <p v-if="loadProblem !== null" class="text-[14px] text-danger" role="alert">{{ loadProblem }}</p>
    </div>

    <form v-if="editing !== null" class="grid gap-3 rounded-xl border border-accent/50 bg-surface p-4" novalidate @submit.prevent="save">
      <h2 class="text-[16px] font-semibold">{{ editing === 'new' ? 'Nuovo fatto' : 'Modifica il fatto' }}</h2>
      <FormField id="fact-topic" label="Argomento" :problem="problems.topic" :hint="TOPIC_NOTICE">
        <input id="fact-topic" v-model="form.topic" :class="input" :maxlength="MAX_TOPIC" autocomplete="off" placeholder="Per esempio: città, lavoro, figli" />
      </FormField>
      <FormField id="fact-text" label="Testo" :problem="problems.text" :hint="`${String(form.text.trim().length)} di ${String(MAX_FACT_TEXT)} caratteri.`">
        <textarea id="fact-text" v-model="form.text" rows="3" :class="input" class="resize-y" :maxlength="MAX_FACT_TEXT" placeholder="Per esempio: vivo a Borgo Finto, lavoro da casa." />
      </FormField>
      <div class="flex flex-col gap-1.5">
        <div class="inline-flex self-start overflow-hidden rounded-[9px] border border-line-strong" role="radiogroup" aria-label="Livello">
          <button
            v-for="shared in [false, true]"
            :key="String(shared)"
            type="button"
            role="radio"
            :aria-checked="form.shared === shared"
            class="inline-flex items-center gap-1.5 border-line-strong px-3 py-1.5 text-[14px] not-first:border-l touch:min-h-11"
            :class="form.shared === shared ? 'bg-surface-2 font-semibold text-ink' : 'text-muted hover:text-ink'"
            @click="form.shared = shared"
          >
            <Icon :name="shared ? 'gateway' : 'private'" :size="14" />{{ shared ? LEVEL_TEXT.L1 : LEVEL_TEXT.L2 }}
          </button>
        </div>
        <p class="text-[13px] text-muted">{{ form.shared ? LEVEL_HINT.L1 : LEVEL_HINT.L2 }}</p>
        <p v-if="form.shared" class="flex items-start gap-2 text-[13px] text-warn"><Icon name="gateway" :size="14" class="mt-0.5 shrink-0" />{{ SHARED_NOTICE }}</p>
        <p v-if="current !== null && saveKind(current, form) === 'share'" class="text-[13px] text-muted">Salvando ti mostro cosa diventa condivisibile e chiedo conferma.</p>
        <p v-if="current !== null && current.label === 'L1' && form.shared" class="text-[13px] text-muted">È già condivisibile: il testo nuovo lo è da subito, senza altra conferma.</p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <button type="submit" class="btn btn-primary px-3 py-1.5 text-[14px]" :disabled="busy">Salva</button>
        <button type="button" class="btn px-3 py-1.5 text-[14px]" :disabled="busy" @click="close">Annulla</button>
        <p v-if="generalProblem !== null" class="text-[14px] text-danger" role="alert">{{ generalProblem }}</p>
      </div>
    </form>

    <p v-if="facts !== null && facts.length === 0 && editing === null" class="max-w-xl rounded-xl border border-line bg-surface p-4 text-sm text-muted">
      Nessun fatto. Aggiungi qualcosa di stabile su di te, per esempio «lavoro: sviluppatore web» o «lingue: italiano e inglese».
    </p>

    <ul v-if="facts !== null && facts.length > 0" class="grid gap-2.5">
      <li v-for="fact in facts" :key="fact.id" class="grid gap-1.5 rounded-xl border border-line bg-surface p-3.5">
        <p class="flex flex-wrap items-start gap-2">
          <b class="min-w-0 flex-1 text-[14px] font-semibold break-words">{{ fact.topic }}</b>
          <span class="chip inline-flex items-center gap-1" :class="fact.label === 'L1' ? 'text-warn' : 'text-ok'"><Icon :name="fact.label === 'L1' ? 'gateway' : 'private'" :size="12" />{{ LEVEL_TEXT[fact.label] }}</span>
        </p>
        <p class="text-[14px] whitespace-pre-line break-words">{{ fact.text }}</p>
        <div class="mt-1 flex flex-wrap gap-1.5">
          <button type="button" class="btn px-2.5 py-1 text-xs" :disabled="busy || editing !== null" @click="edit(fact)"><Icon name="rename" :size="12" />Modifica</button>
          <button type="button" class="btn px-2.5 py-1 text-xs" :disabled="busy" @click="removing = fact.id"><Icon name="delete" :size="12" />Elimina</button>
        </div>
        <div v-if="removing === fact.id" class="mt-1 grid gap-2 rounded-lg border border-danger/50 p-2.5 text-[13.5px]" role="alertdialog" :aria-label="`Eliminare ${fact.topic}?`">
          <p>Eliminare «{{ fact.topic }}»? Arianna non lo saprà più.<template v-if="fact.label === 'L1'"> Se l’avevi reso condivisibile con una conferma, quel testo resta nel registro delle approvazioni.</template></p>
          <div class="flex gap-1.5">
            <button type="button" class="btn btn-danger px-2.5 py-1 text-xs" :disabled="busy" @click="remove(fact)">Elimina</button>
            <button type="button" class="btn px-2.5 py-1 text-xs" @click="removing = null">Annulla</button>
          </div>
        </div>
      </li>
    </ul>

    <ConfirmDialog v-if="proposal !== null" title="Rendere condivisibile?" confirm-text="Rendi condivisibile" :busy="busy" @confirm="confirmShare" @cancel="proposal = null">
      <p>{{ SHARE_CONFIRM_TEXT }}</p>
      <div class="rounded-lg border border-line bg-surface-2 p-3">
        <p class="text-[13px] text-muted">Argomento</p>
        <p class="font-semibold break-words">{{ proposal.topic }}</p>
        <p class="mt-2 text-[13px] text-muted">Testo che diventa condivisibile</p>
        <p class="whitespace-pre-line break-words">{{ proposal.text }}</p>
      </div>
      <p class="flex items-start gap-2 text-[13px] text-warn"><Icon name="gateway" :size="14" class="mt-0.5 shrink-0" />{{ SHARED_NOTICE }}</p>
    </ConfirmDialog>
  </div>
</template>
