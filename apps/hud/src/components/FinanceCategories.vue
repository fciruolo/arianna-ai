<script setup lang="ts">
import { computed, reactive, ref } from 'vue';

import {
  createFinanceCategory,
  createFinanceRule,
  deleteFinanceBudget,
  deleteFinanceCategory,
  deleteFinanceRule,
  listFinanceBudgets,
  listFinanceRules,
  renameFinanceCategory,
  setFinanceBudget,
} from '../lib/api.ts';
import { centsInput, financeErrorText, formatCents, nameLookup, nameProblem, parseEuroInput, type Budget, type Category, type Rule } from '../lib/finance.ts';
import Icon from './Icon.vue';

/**
 * "Categorie e budget" of the finances (I-18, D-183): the categories (new,
 * renamed, removed after a confirmation in the page), the rules that give a
 * category to a description, and the monthly budget of the expense categories.
 */
const props = defineProps<{ categories: Category[] }>();
const emit = defineEmits<{ changed: [] }>();

const names = computed(() => nameLookup([], props.categories));
const problem = ref<string | null>(null);
const busy = ref(false);

async function act(work: () => Promise<void>): Promise<boolean> {
  busy.value = true;
  try {
    await work();
    problem.value = null;
    return true;
  } catch (cause) {
    problem.value = financeErrorText(cause);
    return false;
  } finally {
    busy.value = false;
  }
}

// --- Categories ---------------------------------------------------------------

const newName = ref('');
const newKind = ref<Category['kind']>('out');
const editing = ref<string | null>(null);
const editName = ref('');
const removing = ref<string | null>(null);

async function create(): Promise<void> {
  const issue = nameProblem(newName.value);
  if (issue !== null) {
    problem.value = issue;
    return;
  }
  if (await act(async () => void (await createFinanceCategory(newName.value.trim(), newKind.value)))) {
    newName.value = '';
    emit('changed');
  }
}

async function rename(category: Category): Promise<void> {
  const issue = nameProblem(editName.value);
  if (issue !== null) {
    problem.value = issue;
    return;
  }
  if (await act(() => renameFinanceCategory(category.id, editName.value.trim()))) {
    editing.value = null;
    emit('changed');
  }
}

async function remove(category: Category): Promise<void> {
  if (await act(() => deleteFinanceCategory(category.id))) {
    removing.value = null;
    emit('changed');
    await loadLists();
  }
}

// --- Rules and budgets ----------------------------------------------------------

const rules = ref<Rule[] | null>(null);
const budgets = ref<Budget[]>([]);
const listsProblem = ref<string | null>(null);
const budgetText = reactive<Record<string, string>>({});

async function loadLists(): Promise<void> {
  try {
    const [ruleList, budgetList] = await Promise.all([listFinanceRules(), listFinanceBudgets()]);
    rules.value = ruleList;
    budgets.value = budgetList;
    for (const budget of budgetList) budgetText[budget.category] = centsInput(budget.monthly);
    listsProblem.value = null;
  } catch (cause) {
    listsProblem.value = financeErrorText(cause);
  }
}
void loadLists();

const ruleMatch = ref('');
const ruleCategory = ref('');

async function addRule(): Promise<void> {
  const match = ruleMatch.value.trim();
  if (match === '' || ruleCategory.value === '') {
    problem.value = 'Scrivi le parole da cercare e scegli la categoria.';
    return;
  }
  if (await act(async () => void (await createFinanceRule(match, ruleCategory.value)))) {
    ruleMatch.value = '';
    await loadLists();
  }
}

async function removeRule(rule: Rule): Promise<void> {
  if (await act(() => deleteFinanceRule(rule.id))) await loadLists();
}

const outCategories = computed(() => props.categories.filter((category) => category.kind === 'out'));

function budgetOf(category: string): Budget | undefined {
  return budgets.value.find((budget) => budget.category === category);
}

async function saveBudget(category: Category): Promise<void> {
  const cents = parseEuroInput(budgetText[category.id] ?? '');
  if (cents === null || cents <= 0) {
    problem.value = `Il budget di ${category.name} è una cifra in euro maggiore di zero, per esempio 250 o 250,50.`;
    return;
  }
  if (await act(async () => void (await setFinanceBudget(category.id, cents)))) await loadLists();
}

async function removeBudget(category: Category): Promise<void> {
  if (await act(() => deleteFinanceBudget(category.id))) {
    budgetText[category.id] = '';
    await loadLists();
  }
}
</script>

<template>
  <div class="flex max-w-4xl flex-col gap-5">
    <p v-if="problem" class="text-sm text-danger" role="alert">{{ problem }}</p>

    <!-- CATEGORIES -->
    <section class="flex flex-col gap-2" aria-label="Categorie">
      <h3 class="hud-title">Categorie</h3>
      <form class="flex flex-wrap items-end gap-2" @submit.prevent="create">
        <input v-model="newName" type="text" maxlength="80" class="field min-w-[200px] flex-1 px-2.5 py-1.5 text-[14px] sm:max-w-xs" placeholder="Nuova categoria" aria-label="Nome della nuova categoria" />
        <select v-model="newKind" class="field px-2 py-1.5 text-[14px]" aria-label="Tipo della categoria">
          <option value="out">Uscite</option>
          <option value="in">Entrate</option>
        </select>
        <button type="submit" class="btn btn-primary px-3 py-1.5 text-[14px]" :disabled="busy"><Icon name="new" :size="14" />Aggiungi</button>
      </form>
      <p v-if="categories.length === 0" class="text-sm text-muted">Nessuna categoria.</p>
      <ul v-else class="grid gap-1.5 sm:grid-cols-2">
        <li v-for="category in categories" :key="category.id" class="flex flex-col gap-2 rounded-lg border border-line bg-surface px-3 py-1.5">
          <div class="flex items-center gap-2">
            <form v-if="editing === category.id" class="flex min-w-0 flex-1 items-center gap-1.5" @submit.prevent="rename(category)">
              <input v-model="editName" type="text" maxlength="80" class="field min-w-0 flex-1 px-2 py-1 text-[14px]" aria-label="Nuovo nome della categoria" />
              <button type="submit" class="btn btn-primary px-2 py-1 text-xs" :disabled="busy">Salva</button>
              <button type="button" class="rounded-md px-1.5 py-1 text-xs text-muted hover:text-ink" @click="editing = null">Annulla</button>
            </form>
            <template v-else>
              <span class="min-w-0 flex-1 truncate text-[14px]">{{ category.name }}</span>
              <span class="chip" :class="category.kind === 'in' ? 'text-ok' : 'text-muted'">{{ category.kind === 'in' ? 'Entrate' : 'Uscite' }}</span>
              <button type="button" class="grid size-7 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-ink" :aria-label="`Rinomina ${category.name}`" title="Rinomina" @click="editing = category.id; editName = category.name"><Icon name="rename" :size="14" /></button>
              <button type="button" class="grid size-7 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-danger" :aria-label="`Togli ${category.name}`" title="Togli" @click="removing = category.id"><Icon name="delete" :size="14" /></button>
            </template>
          </div>
          <div v-if="removing === category.id" class="flex flex-col gap-1.5 rounded-md border border-danger/50 bg-danger/10 px-2 py-1.5 text-xs" role="group" aria-label="Conferma">
            <p>Tolgo «{{ category.name }}»? I suoi movimenti restano senza categoria; le sue regole e il suo budget spariscono.</p>
            <div class="flex gap-2">
              <button type="button" class="btn btn-danger px-2 py-0.5 text-xs" :disabled="busy" @click="remove(category)">Togli</button>
              <button type="button" class="rounded-md px-2 py-0.5 text-xs text-muted hover:text-ink" @click="removing = null">Annulla</button>
            </div>
          </div>
        </li>
      </ul>
    </section>

    <p v-if="listsProblem" class="text-sm text-danger" role="alert">{{ listsProblem }}</p>

    <!-- RULES -->
    <section class="flex flex-col gap-2" aria-label="Regole">
      <h3 class="hud-title">Regole</h3>
      <p class="text-xs text-muted">Una descrizione che contiene queste parole, senza badare a maiuscole e accenti, va nella categoria. Vince la regola più lunga; le scelte fatte a mano non cambiano.</p>
      <form class="flex flex-wrap items-end gap-2" @submit.prevent="addRule">
        <input v-model="ruleMatch" type="text" maxlength="200" class="field min-w-[200px] flex-1 px-2.5 py-1.5 text-[14px] sm:max-w-xs" placeholder="Per esempio: supermercato" aria-label="Parole da cercare nella descrizione" />
        <select v-model="ruleCategory" class="field px-2 py-1.5 text-[14px]" aria-label="Categoria della regola">
          <option value="" disabled>Categoria…</option>
          <option v-for="category in categories" :key="category.id" :value="category.id">{{ category.name }}</option>
        </select>
        <button type="submit" class="btn btn-primary px-3 py-1.5 text-[14px]" :disabled="busy"><Icon name="new" :size="14" />Aggiungi</button>
      </form>
      <p v-if="rules === null && listsProblem === null" class="text-sm text-muted">Carico le regole…</p>
      <p v-else-if="rules !== null && rules.length === 0" class="text-sm text-muted">Nessuna regola. Si creano anche dai movimenti, con «crea una regola».</p>
      <ul v-else-if="rules !== null" class="grid gap-1">
        <li v-for="rule in rules" :key="rule.id" class="flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-1.5 text-[14px]">
          <span class="min-w-0 flex-1 truncate">«{{ rule.match }}» → <b class="font-medium">{{ names.category(rule.category) }}</b></span>
          <button type="button" class="grid size-7 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-danger" :aria-label="`Togli la regola ${rule.match}`" title="Togli la regola" :disabled="busy" @click="removeRule(rule)"><Icon name="delete" :size="14" /></button>
        </li>
      </ul>
    </section>

    <!-- BUDGETS -->
    <section class="flex flex-col gap-2" aria-label="Budget">
      <h3 class="hud-title">Budget mensili</h3>
      <p class="text-xs text-muted">Un limite al mese per le categorie di uscita: l’avviso arriva all’80% e quando lo superi.</p>
      <ul class="grid gap-1.5 sm:grid-cols-2">
        <li v-for="category in outCategories" :key="category.id" class="flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-1.5">
          <span class="min-w-0 flex-1 truncate text-[14px]">{{ category.name }}</span>
          <span v-if="budgetOf(category.id)" class="text-xs text-muted">{{ formatCents(budgetOf(category.id)?.monthly ?? 0) }}</span>
          <form class="flex items-center gap-1" @submit.prevent="saveBudget(category)">
            <input v-model="budgetText[category.id]" type="text" inputmode="decimal" class="field w-24 px-2 py-1 text-right text-[14px]" placeholder="€ al mese" :aria-label="`Budget mensile di ${category.name}`" />
            <button type="submit" class="btn px-2 py-1 text-xs" :disabled="busy">Salva</button>
          </form>
          <button v-if="budgetOf(category.id)" type="button" class="grid size-7 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-danger" :aria-label="`Togli il budget di ${category.name}`" title="Togli il budget" :disabled="busy" @click="removeBudget(category)"><Icon name="close" :size="14" /></button>
        </li>
      </ul>
    </section>
  </div>
</template>
