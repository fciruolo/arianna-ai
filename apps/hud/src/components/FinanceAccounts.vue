<script setup lang="ts">
import { computed, ref } from 'vue';

import { createFinanceAccount, updateFinanceAccount } from '../lib/api.ts';
import { financeErrorText, formatDay, nameProblem, type Account } from '../lib/finance.ts';
import Icon from './Icon.vue';

/** "Conti" of the finances (I-18, D-183): the list, a new account, rename, archive. */
const props = defineProps<{ accounts: Account[] }>();
const emit = defineEmits<{ changed: [] }>();

const showArchived = ref(false);
const shown = computed(() => props.accounts.filter((account) => showArchived.value || !account.archived));
const archivedCount = computed(() => props.accounts.filter((account) => account.archived).length);

const newName = ref('');
const newCurrency = ref('EUR');
const problem = ref<string | null>(null);
const busy = ref(false);

async function create(): Promise<void> {
  const issue = nameProblem(newName.value);
  const currency = newCurrency.value.trim().toUpperCase();
  if (issue !== null) {
    problem.value = issue;
    return;
  }
  if (!/^[A-Z]{3}$/.test(currency)) {
    problem.value = 'La valuta è un codice di tre lettere, per esempio EUR.';
    return;
  }
  busy.value = true;
  try {
    await createFinanceAccount(newName.value.trim(), currency === 'EUR' ? undefined : currency);
    newName.value = '';
    newCurrency.value = 'EUR';
    problem.value = null;
    emit('changed');
  } catch (cause) {
    problem.value = financeErrorText(cause);
  } finally {
    busy.value = false;
  }
}

const editing = ref<string | null>(null);
const editName = ref('');

function startRename(account: Account): void {
  editing.value = account.id;
  editName.value = account.name;
  problem.value = null;
}

async function rename(account: Account): Promise<void> {
  const issue = nameProblem(editName.value);
  if (issue !== null) {
    problem.value = issue;
    return;
  }
  busy.value = true;
  try {
    await updateFinanceAccount(account.id, { name: editName.value.trim() });
    editing.value = null;
    problem.value = null;
    emit('changed');
  } catch (cause) {
    problem.value = financeErrorText(cause);
  } finally {
    busy.value = false;
  }
}

async function archive(account: Account, archived: boolean): Promise<void> {
  busy.value = true;
  try {
    await updateFinanceAccount(account.id, { archived });
    problem.value = null;
    emit('changed');
  } catch (cause) {
    problem.value = financeErrorText(cause);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <form class="hud-card flex flex-wrap items-end gap-2 p-3" @submit.prevent="create">
      <label class="flex min-w-[200px] flex-1 flex-col gap-1 text-xs text-muted">
        Nuovo conto
        <input v-model="newName" type="text" maxlength="80" class="field px-2.5 py-1.5 text-[14px]" placeholder="Per esempio: Conto corrente, Carta prepagata" />
      </label>
      <label class="flex w-24 flex-col gap-1 text-xs text-muted">
        Valuta
        <input v-model="newCurrency" type="text" maxlength="3" class="field px-2.5 py-1.5 text-[14px] uppercase" aria-label="Valuta del conto" />
      </label>
      <button type="submit" class="btn btn-primary px-3 py-1.5 text-[14px]" :disabled="busy"><Icon name="new" :size="14" />Crea</button>
    </form>

    <p v-if="problem" class="text-sm text-danger" role="alert">{{ problem }}</p>

    <div v-if="accounts.length === 0" class="rounded-xl border border-line bg-surface p-4 text-sm">
      Nessun conto. Crea il primo conto, poi importa un estratto conto CSV o Excel dalla sezione <b>Importa</b>.
    </div>
    <ul v-else class="grid gap-2">
      <li v-for="account in shown" :key="account.id" class="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface px-3 py-2.5" :class="account.archived ? 'opacity-60' : ''">
        <form v-if="editing === account.id" class="flex min-w-0 flex-1 items-center gap-2" @submit.prevent="rename(account)">
          <input v-model="editName" type="text" maxlength="80" class="field min-w-0 flex-1 px-2.5 py-1 text-[14px]" aria-label="Nuovo nome del conto" />
          <button type="submit" class="btn btn-primary px-2.5 py-1 text-xs" :disabled="busy">Salva</button>
          <button type="button" class="rounded-md px-2 py-1 text-xs text-muted hover:text-ink" @click="editing = null">Annulla</button>
        </form>
        <span v-else class="min-w-0 flex-1">
          <b class="block truncate text-[14px] font-semibold">{{ account.name }}</b>
          <span class="block text-[13px] text-muted">
            {{ account.currency }} · {{ account.transactions === 1 ? '1 movimento' : `${account.transactions.toLocaleString('it-IT')} movimenti` }}
            <template v-if="account.lastBooked"> · ultimo il {{ formatDay(account.lastBooked) }}</template>
            <template v-if="account.profile"> · profilo della banca ricordato</template>
          </span>
        </span>
        <span v-if="account.archived" class="chip text-muted">Archiviato</span>
        <span v-if="editing !== account.id" class="flex gap-1">
          <button type="button" class="btn px-2.5 py-1 text-xs" :disabled="busy" @click="startRename(account)"><Icon name="rename" :size="13" />Rinomina</button>
          <button v-if="!account.archived" type="button" class="btn px-2.5 py-1 text-xs" :disabled="busy" @click="archive(account, true)"><Icon name="archive" :size="13" />Archivia</button>
          <button v-else type="button" class="btn px-2.5 py-1 text-xs" :disabled="busy" @click="archive(account, false)"><Icon name="restore" :size="13" />Ripristina</button>
        </span>
      </li>
    </ul>
    <label v-if="archivedCount > 0" class="flex items-center gap-2 text-xs text-muted">
      <input v-model="showArchived" type="checkbox" />
      Mostra i conti archiviati ({{ archivedCount }})
    </label>
  </div>
</template>
