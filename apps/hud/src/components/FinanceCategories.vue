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
  readFinanceSummary,
  renameFinanceCategory,
  setFinanceBudget,
} from '../lib/api.ts';
import { budgetDraft, budgetRows } from '../lib/finance-dashboard.ts';
import { centsInput, dayOf, financeErrorText, formatCents, formatMonth, monthOfDay, nameLookup, nameProblem, parseEuroInput, type Budget, type Category, type CategoryTotal, type Rule } from '../lib/finance.ts';
import Icon from './Icon.vue';

/**
 * "Categorie e budget" of the finances (I-18, D-183): the categories (new,
 * renamed, removed after a confirmation in the page), the rules that give a
 * category to a description, and the monthly budget of the expense categories.
 * On two columns (D-189): the budgets with what was spent this month and one
 * "Salva" for all of them; the categories as pills, then the rules.
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

const outCategories = computed(() => props.categories.filter((category) => category.kind === 'out'));
const rules = ref<Rule[] | null>(null);
const budgets = ref<Budget[]>([]);
const listsProblem = ref<string | null>(null);
const budgetText = reactive<Record<string, string>>({});

async function loadLists(): Promise<void> {
  try {
    const [ruleList, budgetList] = await Promise.all([listFinanceRules(), listFinanceBudgets()]);
    rules.value = ruleList;
    budgets.value = budgetList;
    for (const category of outCategories.value) budgetText[category.id] = '';
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


/** What each category spent this month, beside its budget. */
const thisMonth = monthOfDay(dayOf(new Date()));
const spent = ref<CategoryTotal[]>([]);
async function loadSpent(): Promise<void> {
  try {
    spent.value = (await readFinanceSummary({ from: `${thisMonth}-01`, to: dayOf(new Date()) })).categories;
  } catch {
    spent.value = [];
  }
}
void loadSpent();
const usage = computed(() => budgetRows(budgets.value, spent.value));
function usageOf(category: string) {
  return usage.value.find((row) => row.category === category);
}
function spentOf(category: string): number {
  return spent.value.find((total) => total.category === category)?.expenses ?? 0;
}

/** One "Salva" for every budget: what changed is set, an emptied field removes the budget. */
const draft = computed(() => budgetDraft(budgets.value, budgetText, parseEuroInput));
const pending = computed(() => draft.value.changes.length + draft.value.invalid.length);

function undoBudgets(): void {
  for (const category of outCategories.value) budgetText[category.id] = '';
  for (const budget of budgets.value) budgetText[budget.category] = centsInput(budget.monthly);
}

async function saveBudgets(): Promise<void> {
  const wrong = draft.value.invalid.map((id) => names.value.category(id));
  if (wrong.length > 0) {
    problem.value = `Il budget è una cifra in euro maggiore di zero, per esempio 250 o 250,50: controlla ${wrong.join(', ')}.`;
    return;
  }
  const changes = draft.value.changes;
  if (
    await act(async () => {
      for (const change of changes) {
        if (change.monthly === null) await deleteFinanceBudget(change.category);
        else await setFinanceBudget(change.category, change.monthly);
      }
    })
  ) {
    await loadLists();
  } else {
    // Some may be saved before the error: read them again, keeping what is still to save.
    const kept = { ...budgetText };
    await loadLists();
    Object.assign(budgetText, kept);
  }
}

/** The category whose pill is open: rename or remove. */
const selected = ref<string | null>(null);
function select(category: Category): void {
  selected.value = selected.value === category.id ? null : category.id;
  editing.value = null;
  removing.value = null;
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <p v-if="problem" class="text-sm text-danger" role="alert">{{ problem }}</p>
    <p v-if="listsProblem" class="text-sm text-danger" role="alert">{{ listsProblem }}</p>

    <div class="grid items-start gap-4 lg:grid-cols-2">
      <!-- BUDGETS -->
      <section class="hud-card flex min-w-0 flex-col gap-2 p-4" aria-label="Budget">
        <header class="flex items-baseline justify-between gap-2">
          <h3 class="hud-title">Budget mensili</h3>
          <span class="text-xs text-muted">spese di {{ formatMonth(thisMonth, true) }}</span>
        </header>
        <p class="text-xs text-muted">Un limite al mese per le categorie di uscita: l’avviso arriva all’80% e quando lo superi. Lascia vuoto per nessun budget.</p>
        <p v-if="outCategories.length === 0" class="text-sm text-muted">Nessuna categoria di uscita.</p>
        <form v-else class="flex flex-col" @submit.prevent="saveBudgets">
          <div class="grid grid-cols-[minmax(0,1fr)_110px_minmax(0,1.2fr)] gap-3 border-b border-line pb-1 text-xs text-muted">
            <span>Categoria</span><span class="text-right">al mese</span><span>speso finora</span>
          </div>
          <div v-for="category in outCategories" :key="category.id" class="grid grid-cols-[minmax(0,1fr)_110px_minmax(0,1.2fr)] items-center gap-3 border-b border-line py-1.5 last:border-b-0">
            <span class="truncate text-[14px]">{{ category.name }}</span>
            <input
              v-model="budgetText[category.id]"
              type="text"
              inputmode="decimal"
              class="field w-full px-2 py-1 text-right text-[14px]"
              :class="draft.invalid.includes(category.id) ? 'border-danger' : draft.changes.some((change) => change.category === category.id) ? 'border-accent' : ''"
              placeholder="—"
              :aria-label="`Budget mensile di ${category.name}, in euro`"
            />
            <span class="flex min-w-0 flex-col gap-1">
              <template v-if="usageOf(category.id)">
                <svg viewBox="0 0 100 6" preserveAspectRatio="none" class="h-1.5 w-full" aria-hidden="true">
                  <rect x="0" y="0" width="100" height="6" rx="3" fill="var(--bg)" />
                  <rect x="0" y="0" :width="Math.max(1, usageOf(category.id)?.percent ?? 0)" height="6" rx="3" :fill="usageOf(category.id)?.over ? 'var(--danger)' : 'var(--graph-1)'" />
                </svg>
                <span class="text-xs tabular-nums" :class="usageOf(category.id)?.over ? 'text-danger' : 'text-muted'">
                  {{ formatCents(usageOf(category.id)?.spent ?? 0) }} su {{ formatCents(usageOf(category.id)?.limit ?? 0) }}{{ usageOf(category.id)?.over ? ', superato' : '' }}
                </span>
              </template>
              <span v-else class="text-xs text-muted tabular-nums">{{ spentOf(category.id) > 0 ? `${formatCents(spentOf(category.id))}, nessun budget` : 'nessun budget' }}</span>
            </span>
          </div>
          <!-- Only when something changed: one save for all the budgets. -->
          <div v-if="pending > 0" class="sticky bottom-0 mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-accent bg-surface-2 px-3 py-2 text-[14px]" role="status">
            <span class="flex-1">{{ pending === 1 ? '1 budget cambiato' : `${String(pending)} budget cambiati` }}</span>
            <button type="button" class="btn px-3 py-1 text-[14px]" :disabled="busy" @click="undoBudgets">Annulla</button>
            <button type="submit" class="btn btn-primary px-3 py-1 text-[14px]" :disabled="busy">Salva</button>
          </div>
        </form>
      </section>

      <div class="flex min-w-0 flex-col gap-4">
        <!-- CATEGORIES -->
        <section class="hud-card flex flex-col gap-2 p-4" aria-label="Categorie">
          <header class="flex items-baseline justify-between gap-2">
            <h3 class="hud-title">Categorie</h3>
            <span class="text-xs text-muted">{{ outCategories.length }} di uscita · {{ categories.length - outCategories.length }} di entrata</span>
          </header>
          <form class="flex flex-wrap items-end gap-2" @submit.prevent="create">
            <input v-model="newName" type="text" maxlength="80" class="field min-w-[160px] flex-1 px-2.5 py-1.5 text-[14px]" placeholder="Nuova categoria" aria-label="Nome della nuova categoria" />
            <select v-model="newKind" class="field px-2 py-1.5 text-[14px]" aria-label="Tipo della categoria">
              <option value="out">Uscite</option>
              <option value="in">Entrate</option>
            </select>
            <button type="submit" class="btn btn-primary px-3 py-1.5 text-[14px]" :disabled="busy"><Icon name="new" :size="14" />Aggiungi</button>
          </form>
          <p v-if="categories.length === 0" class="text-sm text-muted">Nessuna categoria.</p>
          <template v-else>
            <ul class="flex flex-wrap gap-1.5">
              <li v-for="category in categories" :key="category.id">
                <button
                  type="button"
                  class="rounded-full border px-3 py-0.5 text-[13.5px] hover:border-accent"
                  :class="[selected === category.id ? 'border-accent bg-surface-2 text-accent' : category.kind === 'in' ? 'border-ok/60 bg-surface' : 'border-line-strong bg-surface']"
                  :aria-pressed="selected === category.id"
                  :title="category.kind === 'in' ? 'Categoria di entrata' : 'Categoria di uscita'"
                  @click="select(category)"
                >{{ category.name }}</button>
              </li>
            </ul>
            <p class="text-xs text-muted">Clic su una categoria per rinominarla o toglierla; quelle di entrata hanno il bordo verde.</p>
            <template v-for="category in categories" :key="`edit-${category.id}`">
              <div v-if="selected === category.id" class="flex flex-col gap-2 rounded-lg border border-line bg-surface px-3 py-2">
                <form v-if="editing === category.id" class="flex min-w-0 items-center gap-1.5" @submit.prevent="rename(category)">
                  <input v-model="editName" type="text" maxlength="80" class="field min-w-0 flex-1 px-2 py-1 text-[14px]" aria-label="Nuovo nome della categoria" />
                  <button type="submit" class="btn btn-primary px-2 py-1 text-xs" :disabled="busy">Salva</button>
                  <button type="button" class="rounded-md px-1.5 py-1 text-xs text-muted hover:text-ink" @click="editing = null">Annulla</button>
                </form>
                <div v-else-if="removing === category.id" class="flex flex-col gap-1.5 text-xs" role="group" aria-label="Conferma">
                  <p>Tolgo «{{ category.name }}»? I suoi movimenti restano senza categoria; le sue regole e il suo budget spariscono.</p>
                  <div class="flex gap-2">
                    <button type="button" class="btn btn-danger px-2 py-0.5 text-xs" :disabled="busy" @click="remove(category)">Togli</button>
                    <button type="button" class="rounded-md px-2 py-0.5 text-xs text-muted hover:text-ink" @click="removing = null">Annulla</button>
                  </div>
                </div>
                <div v-else class="flex flex-wrap items-center gap-2 text-[14px]">
                  <b class="flex-1 font-medium">{{ category.name }}</b>
                  <span class="chip" :class="category.kind === 'in' ? 'text-ok' : 'text-muted'">{{ category.kind === 'in' ? 'Entrate' : 'Uscite' }}</span>
                  <button type="button" class="btn px-2 py-0.5 text-xs" @click="editing = category.id; editName = category.name"><Icon name="rename" :size="13" />Rinomina</button>
                  <button type="button" class="btn px-2 py-0.5 text-xs hover:text-danger" @click="removing = category.id"><Icon name="delete" :size="13" />Togli</button>
                </div>
              </div>
            </template>
          </template>
        </section>

        <!-- RULES -->
        <section class="hud-card flex flex-col gap-2 p-4" aria-label="Regole">
          <header class="flex items-baseline justify-between gap-2">
            <h3 class="hud-title">Regole</h3>
            <span v-if="rules !== null" class="text-xs text-muted">{{ rules.length }}</span>
          </header>
          <p class="text-xs text-muted">Una descrizione che contiene queste parole, senza badare a maiuscole e accenti, va nella categoria. Vince la regola più lunga; le scelte fatte a mano non cambiano. Le regole nascono anche da Movimenti, dal menu della categoria.</p>
          <form class="flex flex-wrap items-end gap-2" @submit.prevent="addRule">
            <input v-model="ruleMatch" type="text" maxlength="200" class="field min-w-[160px] flex-1 px-2.5 py-1.5 text-[14px]" placeholder="Per esempio: supermercato" aria-label="Parole da cercare nella descrizione" />
            <select v-model="ruleCategory" class="field px-2 py-1.5 text-[14px]" aria-label="Categoria della regola">
              <option value="" disabled>Categoria…</option>
              <option v-for="category in categories" :key="category.id" :value="category.id">{{ category.name }}</option>
            </select>
            <button type="submit" class="btn btn-primary px-3 py-1.5 text-[14px]" :disabled="busy"><Icon name="new" :size="14" />Aggiungi</button>
          </form>
          <p v-if="rules === null && listsProblem === null" class="text-sm text-muted">Carico le regole…</p>
          <p v-else-if="rules !== null && rules.length === 0" class="text-sm text-muted">Nessuna regola.</p>
          <ul v-else-if="rules !== null" class="flex flex-col">
            <li v-for="rule in rules" :key="rule.id" class="flex items-center gap-2 border-t border-line py-1 text-[14px] first:border-t-0">
              <span class="min-w-0 flex-1 truncate">«{{ rule.match }}» → <b class="font-medium">{{ names.category(rule.category) }}</b></span>
              <button type="button" class="grid size-7 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-danger" :aria-label="`Togli la regola ${rule.match}`" title="Togli la regola" :disabled="busy" @click="removeRule(rule)"><Icon name="delete" :size="14" /></button>
            </li>
          </ul>
        </section>
      </div>
    </div>
  </div>
</template>
