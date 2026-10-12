<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';

import { archiveClient, linkClientProject, listClients, readClient, readClientDashboard, removeClientLogo, unlinkClientProject, uploadClientLogo } from '../lib/api.ts';
import { CARD_ORDER_TEXT, cardMoney, sortCards, type CardMoney, type CardOrder } from '../lib/client-cards.ts';
import { roundMoneyText, summarize } from '../lib/client-dashboard.ts';
import {
  AREA_TEXT,
  billingGaps,
  clientErrorText,
  countryName,
  filterClients,
  formOf,
  freeProjects,
  gapFields,
  initialsOf,
  KIND_TEXT,
  logoFileProblem,
  logoUrl,
  paymentText,
  STATUS_FILTER_TEXT,
  STATUS_TEXT,
  type Client,
  type ClientArea,
  type ClientStatus,
  type ClientSummary,
  type StatusFilter,
} from '../lib/clients.ts';
import ClientContacts from './ClientContacts.vue';
import ClientDashboard from './ClientDashboard.vue';
import ClientDocuments from './ClientDocuments.vue';
import ClientRegistry from './ClientRegistry.vue';
import Icon from './Icon.vue';

/**
 * "Clienti" (I-16, D-168, tappa C1): the list as cards (D-190) with logo,
 * name, contact, projects and three numbers of the year; a client in full
 * with "Dashboard" first (tappa C3, D-170), "Anagrafica", "Contatti",
 * "Progetti" and "Documenti" (tappa C2, D-171). Everything is private (L2): it
 * stays between this page and the core of this Mac.
 * `client` comes from the address (`/clienti/<id>`); "new" writes a new one.
 */
const props = defineProps<{ client: string | null }>();
const emit = defineEmits<{ open: [id: string | null]; project: [name: string] }>();

const clients = ref<ClientSummary[] | null>(null);
const approved = ref<string[]>([]);
const listProblem = ref<string | null>(null);
const status = ref<StatusFilter>('current');
const query = ref('');
const creating = ref(false);

/** The order of the cards, remembered in this browser only. */
const ORDER_KEY = 'arianna.clients-order';
function readOrder(): CardOrder {
  try {
    const value = localStorage.getItem(ORDER_KEY);
    return value !== null && value in CARD_ORDER_TEXT ? (value as CardOrder) : 'due';
  } catch {
    return 'due';
  }
}
const order = ref<CardOrder>(readOrder());
watch(order, (value) => {
  try {
    localStorage.setItem(ORDER_KEY, value);
  } catch {
    // Without storage the order lasts until the page reloads.
  }
});
const orders = Object.entries(CARD_ORDER_TEXT) as [CardOrder, string][];

/** The three numbers of each card, read from its dashboard after the list; missing while not read. */
const money = ref(new Map<string, CardMoney>());
const thisYear = new Date().getFullYear();
let moneyRead = 0;
async function loadMoney(list: readonly ClientSummary[]): Promise<void> {
  const request = ++moneyRead;
  const found = await Promise.all(
    list
      .filter((item) => item.status !== 'archived' || status.value !== 'current')
      .map(async (item) => {
        try {
          const dashboard = await readClientDashboard(item.id);
          return [item.id, cardMoney(summarize(dashboard, { year: thisYear, project: 'all', basis: 'accrual' }), dashboard.currency)] as const;
        } catch {
          return null;
        }
      }),
  );
  if (request === moneyRead) money.value = new Map(found.filter((entry) => entry !== null));
}

const shown = computed(() => sortCards(filterClients(clients.value ?? [], status.value, query.value), order.value, money.value));

function euros(cents: number, currency: string): string {
  return roundMoneyText(cents, currency);
}

async function loadList(): Promise<void> {
  try {
    const found = await listClients();
    clients.value = found.clients;
    approved.value = found.projects;
    listProblem.value = null;
    void loadMoney(found.clients);
  } catch (cause) {
    listProblem.value = clientErrorText(cause);
  }
}

// One client
const detail = ref<Client | null>(null);
const detailProblem = ref<string | null>(null);
// The dashboard first (D-190): the money of a client is what one opens it for most often.
const tab = ref<'registry' | 'contacts' | 'projects' | 'documents' | 'dashboard'>('dashboard');
const actionProblem = ref<string | null>(null);
const busy = ref(false);

async function loadDetail(id: string): Promise<void> {
  try {
    const found = await readClient(id);
    if (props.client === id) {
      detail.value = found;
      detailProblem.value = null;
    }
  } catch (cause) {
    if (props.client === id) detailProblem.value = clientErrorText(cause);
  }
}

watch(
  () => props.client,
  (id) => {
    detail.value = null;
    detailProblem.value = null;
    actionProblem.value = null;
    if (id !== null) {
      creating.value = false;
      tab.value = 'dashboard';
      void loadDetail(id);
    } else void loadList();
  },
);

onMounted(() => {
  void loadList();
  if (props.client !== null) void loadDetail(props.client);
});

async function refresh(): Promise<void> {
  if (props.client !== null) await loadDetail(props.client);
  void loadList();
}

function saved(id: string): void {
  creating.value = false;
  if (props.client === id) void refresh();
  else emit('open', id);
}

async function setArchived(archived: boolean): Promise<void> {
  if (detail.value === null) return;
  busy.value = true;
  actionProblem.value = null;
  try {
    await archiveClient(detail.value.id, archived);
    await refresh();
  } catch (cause) {
    actionProblem.value = clientErrorText(cause);
  } finally {
    busy.value = false;
  }
}

// The logo: chosen, checked here, sent as base64; the core checks the bytes again.
const logoInput = ref<HTMLInputElement | null>(null);
async function chooseLogo(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (file === undefined || detail.value === null) return;
  const wrong = logoFileProblem(file);
  if (wrong !== null) {
    actionProblem.value = wrong;
    return;
  }
  busy.value = true;
  actionProblem.value = null;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
    await uploadClientLogo(detail.value.id, btoa(binary));
    await refresh();
  } catch (cause) {
    actionProblem.value = clientErrorText(cause);
  } finally {
    busy.value = false;
  }
}

async function dropLogo(): Promise<void> {
  if (detail.value === null) return;
  busy.value = true;
  actionProblem.value = null;
  try {
    await removeClientLogo(detail.value.id);
    await refresh();
  } catch (cause) {
    actionProblem.value = clientErrorText(cause);
  } finally {
    busy.value = false;
  }
}

// Projects
const toLink = ref('');
const linkable = computed(() => (detail.value === null ? [] : freeProjects(approved.value, clients.value ?? [], detail.value.id)));
async function link(): Promise<void> {
  if (detail.value === null || toLink.value === '') return;
  busy.value = true;
  actionProblem.value = null;
  try {
    await linkClientProject(detail.value.id, toLink.value);
    toLink.value = '';
    await refresh();
  } catch (cause) {
    actionProblem.value = clientErrorText(cause);
  } finally {
    busy.value = false;
  }
}
async function unlink(linkId: string): Promise<void> {
  if (detail.value === null) return;
  busy.value = true;
  actionProblem.value = null;
  try {
    await unlinkClientProject(detail.value.id, linkId);
    await refresh();
  } catch (cause) {
    actionProblem.value = clientErrorText(cause);
  } finally {
    busy.value = false;
  }
}

const gaps = computed(() => (detail.value === null ? [] : billingGaps(formOf(detail.value))));
const primary = computed(() => detail.value?.contacts.find((contact) => contact.primary) ?? detail.value?.contacts[0] ?? null);
const payment = computed(() => (detail.value === null ? null : paymentText(detail.value.paymentMethod, detail.value.paymentDays, detail.value.paymentEndOfMonth)));
const tabs = computed(() => [
  { id: 'dashboard', text: 'Dashboard' },
  { id: 'registry', text: 'Anagrafica' },
  { id: 'contacts', text: `Contatti${detail.value !== null && detail.value.contacts.length > 0 ? ` · ${String(detail.value.contacts.length)}` : ''}` },
  { id: 'projects', text: `Progetti${detail.value !== null && detail.value.projects.length > 0 ? ` · ${String(detail.value.projects.length)}` : ''}` },
  { id: 'documents', text: 'Documenti' },
] as const);

/** "Completa": the registry, on the first field the electronic invoice still needs. */
async function complete(): Promise<void> {
  if (detail.value === null) return;
  const first = gapFields(formOf(detail.value))[0];
  tab.value = 'registry';
  await nextTick();
  if (first === undefined) return;
  const field = document.getElementById(`cl-${first}`);
  field?.scrollIntoView({ block: 'center' });
  field?.focus({ preventScroll: true });
}

const areaClass: Record<ClientArea, string> = { IT: 'text-ok', EU: 'text-info', 'extra-EU': 'text-warn' };
const statusClass: Record<ClientStatus, string> = { active: 'text-ok', prospect: 'text-info', archived: 'text-muted' };
const filters = Object.entries(STATUS_FILTER_TEXT) as [StatusFilter, string][];
</script>

<template>
  <!-- One width with the finances (D-189, D-190). -->
  <section class="flex min-h-0 flex-1 flex-col overflow-auto px-4 py-4 md:px-6" aria-label="Clienti">
    <div class="mx-auto flex w-full max-w-[1440px] flex-1 flex-col gap-4">
    <!-- A NEW CLIENT -->
    <template v-if="creating && client === null">
      <header class="flex flex-wrap items-center gap-3">
        <button type="button" class="btn px-2.5 py-1 text-xs" @click="creating = false"><Icon name="expand" :size="13" class="rotate-180" />Clienti</button>
        <h2 class="font-hud text-[21px] font-semibold tracking-[0.02em]">Nuovo cliente</h2>
      </header>
      <ClientRegistry :client="null" @saved="saved" @cancel="creating = false" />
    </template>

    <!-- THE LIST -->
    <template v-else-if="client === null">
      <div class="flex flex-wrap items-center gap-2">
        <button type="button" class="btn btn-primary px-3 py-1.5 text-[14px]" @click="creating = true"><Icon name="new" :size="14" />Cliente</button>
        <label class="flex h-[34px] min-w-[200px] flex-1 items-center gap-2 rounded-lg border border-line-strong bg-surface-2 px-2.5 text-muted sm:max-w-sm">
          <Icon name="search" :size="14" />
          <input v-model="query" type="search" class="w-full bg-transparent text-[14px] text-ink outline-none" placeholder="Cerca per nome, partita IVA, contatto, progetto" aria-label="Cerca un cliente" />
        </label>
        <select v-model="status" class="field px-2 py-1.5 text-[14px]" aria-label="Quali clienti">
          <option v-for="[value, text] in filters" :key="value" :value="value">{{ text }}</option>
        </select>
        <select v-model="order" class="field px-2 py-1.5 text-[14px]" aria-label="Ordine dei clienti">
          <option v-for="[value, text] in orders" :key="value" :value="value">Ordina: {{ text.toLowerCase() }}</option>
        </select>
        <span v-if="clients" class="ml-auto text-xs text-muted">{{ shown.length === 1 ? '1 cliente' : `${String(shown.length)} clienti` }} · numeri del {{ thisYear }}</span>
      </div>
      <p v-if="listProblem" class="text-sm text-danger" role="alert">{{ listProblem }}</p>
      <p v-else-if="clients === null" class="text-sm text-muted">Carico i clienti…</p>
      <div v-else-if="clients.length === 0" class="max-w-xl rounded-xl border border-line bg-surface p-4 text-sm">
        Nessun cliente. Con <b>+ Cliente</b> scrivi l’anagrafica, poi aggiungi contatti e progetti. Tutto resta privato su questo computer.
      </div>
      <p v-else-if="shown.length === 0" class="text-sm text-muted">Nessun cliente con questi filtri.</p>
      <!-- Each client a card (D-190), as many per row as the width holds. -->
      <ul v-else class="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3.5">
        <li v-for="item in shown" :key="item.id" class="flex">
          <button
            type="button"
            class="flex w-full flex-col gap-3 rounded-2xl border border-line bg-surface-2 p-4 text-left transition-colors hover:border-accent"
            :class="(money.get(item.id)?.overdue ?? 0) > 0 ? 'shadow-[inset_3px_0_0_var(--danger)]' : ''"
            @click="emit('open', item.id)"
          >
            <span class="flex items-center gap-3">
              <img v-if="item.logo" :src="logoUrl(item.id, item.logo) ?? ''" alt="" class="size-[52px] shrink-0 rounded-xl border border-line bg-white object-contain p-0.5" />
              <span v-else class="grid size-[52px] shrink-0 place-items-center rounded-xl border border-accent/40 bg-accent/15 font-hud text-[17px] font-semibold text-accent" aria-hidden="true">{{ initialsOf(item.displayName) }}</span>
              <span class="min-w-0">
                <b class="block truncate text-[16px] leading-snug font-semibold">{{ item.displayName }}</b>
                <span class="mt-0.5 flex flex-wrap items-center gap-1.5 text-[13px] text-muted">
                  <span class="lab" :class="statusClass[item.status]">{{ STATUS_TEXT[item.status] }}</span>
                  {{ KIND_TEXT[item.kind] }} · <span :title="AREA_TEXT[item.area]">{{ countryName(item.country) }}</span>
                </span>
              </span>
            </span>
            <span class="flex min-h-[42px] flex-col text-[14px]">
              <template v-if="item.primaryContact">
                <b class="truncate font-medium">{{ item.primaryContact.name }}</b>
                <span class="truncate text-[13px] text-muted">{{ [item.primaryContact.email, item.primaryContact.phone].filter((part) => part).join(' · ') || 'nessun recapito' }}</span>
              </template>
              <template v-else-if="item.email">
                <b class="font-medium text-muted">Nessun contatto</b>
                <span class="truncate text-[13px] text-muted">{{ item.email }}</span>
              </template>
              <span v-else class="text-muted">Nessun contatto</span>
            </span>
            <span class="flex min-h-[24px] flex-wrap gap-1.5">
              <span v-for="name in item.projects.slice(0, 4)" :key="name" class="chip inline-flex items-center gap-1"><Icon name="project" :size="11" />{{ name }}</span>
              <span v-if="item.projects.length > 4" class="chip">+{{ item.projects.length - 4 }}</span>
              <span v-if="item.projects.length === 0" class="text-[13px] text-muted">Nessun progetto</span>
            </span>
            <span class="mt-auto border-t border-line pt-3">
              <span v-if="money.get(item.id) === undefined" class="text-[13px] text-muted">Numeri del {{ thisYear }} non ancora letti.</span>
              <span v-else-if="money.get(item.id)!.closed === 0 && money.get(item.id)!.awaiting === 0 && money.get(item.id)!.toInvoice === 0" class="text-[13px] text-muted">Nessun IM chiuso nel {{ thisYear }}: i numeri compaiono con il primo lavoro chiuso.</span>
              <span v-else class="grid grid-cols-3 gap-2">
                <span class="flex flex-col"><span class="text-xs text-muted">Guadagno {{ thisYear }}</span><b class="text-[18px] tabular-nums">{{ euros(money.get(item.id)!.earned, money.get(item.id)!.currency) }}</b></span>
                <span class="flex flex-col"><span class="text-xs text-muted">Da fatturare</span><b class="text-[18px] tabular-nums">{{ euros(money.get(item.id)!.toInvoice, money.get(item.id)!.currency) }}</b></span>
                <span class="flex flex-col">
                  <span class="text-xs text-muted">In attesa</span>
                  <b class="text-[18px] tabular-nums" :class="money.get(item.id)!.overdue > 0 ? 'text-danger' : ''">{{ euros(money.get(item.id)!.awaiting, money.get(item.id)!.currency) }}</b>
                  <span v-if="money.get(item.id)!.overdue > 0" class="text-xs text-danger">{{ money.get(item.id)!.overdue === 1 ? '1 scaduta' : `${String(money.get(item.id)!.overdue)} scadute` }}</span>
                </span>
              </span>
            </span>
          </button>
        </li>
        <li class="flex">
          <button type="button" class="grid min-h-[220px] w-full place-items-center rounded-2xl border border-dashed border-line-strong text-[15px] font-semibold text-muted hover:border-accent hover:text-accent" @click="creating = true">
            <span class="flex items-center gap-2"><Icon name="new" :size="16" />Nuovo cliente</span>
          </button>
        </li>
      </ul>
      <p class="mt-auto inline-flex items-center gap-1.5 text-xs text-muted"><Icon name="private" :size="13" />Privato: i clienti restano su questo computer. Claude, Codex e Telegram non li vedono.</p>
    </template>

    <!-- ONE CLIENT -->
    <template v-else>
      <p v-if="detailProblem" class="text-sm text-danger" role="alert">{{ detailProblem }} <button type="button" class="btn ml-2 px-2.5 py-1 text-xs" @click="emit('open', null)">Torna ai clienti</button></p>
      <p v-else-if="detail === null" class="text-sm text-muted">Carico il cliente…</p>
      <template v-else>
        <header class="flex flex-wrap items-center gap-x-4 gap-y-3">
          <button type="button" class="btn px-2.5 py-1 text-xs" title="Torna alla lista dei clienti" @click="emit('open', null)"><span class="rotate-180"><Icon name="expand" :size="13" /></span>Clienti</button>
          <div class="group relative">
            <img v-if="detail.logo" :src="logoUrl(detail.id, detail.logo) ?? ''" alt="Logo del cliente" class="size-14 rounded-xl border border-line bg-white object-contain p-1" />
            <span v-else class="grid size-14 place-items-center rounded-xl border border-accent/40 bg-accent/15 font-hud text-[19px] font-semibold text-accent" aria-hidden="true">{{ initialsOf(detail.displayName) }}</span>
          </div>
          <div class="min-w-0 flex-1">
            <h2 class="truncate font-hud text-[21px] leading-tight font-semibold tracking-[0.02em]">{{ detail.displayName }}</h2>
            <p class="mt-1 flex flex-wrap items-center gap-1.5 text-[13.5px] text-muted">
              <span>{{ KIND_TEXT[detail.kind] }}</span>
              <span class="lab" :class="areaClass[detail.area]">{{ AREA_TEXT[detail.area] }} · {{ countryName(detail.country) }}</span>
              <span class="lab" :class="statusClass[detail.status]">{{ STATUS_TEXT[detail.status] }}</span>
              <span v-if="detail.vatNumber" class="font-mono">P.IVA {{ detail.vatNumber }}</span>
              <span v-else-if="detail.euVatNumber" class="font-mono">{{ detail.euVatNumber }}</span>
              <span v-if="payment">· {{ payment }}</span>
              <span class="lab text-warn" title="Privato: resta su questo computer">L2</span>
            </p>
            <!-- The primary contact, at hand on every tab (D-190). -->
            <p v-if="primary" class="mt-1 truncate text-[13.5px]">
              <b class="font-medium">{{ primary.name }}</b><span class="text-muted">{{ [primary.role, primary.email, primary.phone ?? primary.mobile].filter((part) => part).map((part) => ` · ${part}`).join('') }}</span>
            </p>
          </div>
          <div class="flex flex-wrap items-center gap-1.5">
            <template v-if="detail.status !== 'archived'">
              <input ref="logoInput" type="file" accept="image/png,image/jpeg,image/webp" class="hidden" @change="chooseLogo" />
              <button type="button" class="btn px-2.5 py-1 text-xs" :disabled="busy" @click="logoInput?.click()"><Icon name="image-up" :size="13" />{{ detail.logo ? 'Cambia logo' : 'Logo' }}</button>
              <button v-if="detail.logo" type="button" class="btn px-2.5 py-1 text-xs" :disabled="busy" @click="dropLogo">Togli logo</button>
              <button type="button" class="btn px-2.5 py-1 text-xs" :disabled="busy" title="Esce dalla lista dei clienti attivi; si ripristina quando vuoi" @click="setArchived(true)"><Icon name="archive" :size="13" />Archivia</button>
            </template>
            <button v-else type="button" class="btn px-2.5 py-1 text-xs" :disabled="busy" @click="setArchived(false)"><Icon name="restore" :size="13" />Ripristina</button>
          </div>
        </header>
        <p v-if="actionProblem" class="text-sm text-danger" role="alert">{{ actionProblem }}</p>
        <p v-if="gaps.length > 0 && detail.status !== 'archived'" class="flex flex-wrap items-center gap-2 rounded-lg border border-warn/50 bg-warn/10 px-3 py-2 text-[13.5px]">
          <span class="text-warn"><Icon name="warning" :size="14" /></span>
          <span class="flex-1">Per la fattura elettronica mancano: {{ gaps.join(', ') }}.</span>
          <button type="button" class="btn px-2.5 py-1 text-xs" title="Apre l’Anagrafica sul primo campo da riempire; i campi mancanti hanno il bordo ambra" @click="complete">Completa</button>
        </p>

        <nav class="flex shrink-0 items-end gap-1 overflow-x-auto border-b border-line" aria-label="Schede del cliente">
          <button
            v-for="item in tabs"
            :key="item.id"
            type="button"
            :aria-current="tab === item.id ? 'true' : undefined"
            class="-mb-px flex items-center gap-1.5 border-b-2 px-3 pt-2 pb-2.5 text-[14.5px] font-medium whitespace-nowrap"
            :class="tab === item.id ? 'border-accent text-ink' : 'border-transparent text-muted hover:text-ink'"
            @click="tab = item.id"
          >
            {{ item.text }}
          </button>
        </nav>

        <ClientDashboard v-if="tab === 'dashboard'" :client-id="detail.id" @project="emit('project', $event)" />
        <ClientRegistry v-else-if="tab === 'registry'" :client="detail" @saved="saved" />
        <ClientContacts v-else-if="tab === 'contacts'" :client="detail" @changed="refresh" />

        <div v-else-if="tab === 'projects'" class="grid max-w-3xl gap-3">
          <p class="text-[14px] text-muted">I progetti di questo cliente, fra quelli approvati in Impostazioni → Progetti. Un progetto appartiene a un solo cliente.</p>
          <ul v-if="detail.projects.length > 0" class="grid gap-2">
            <li v-for="item in detail.projects" :key="item.id" class="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2.5">
              <Icon name="project" :size="15" />
              <b class="font-mono text-[14px] font-medium">{{ item.project }}</b>
              <span v-if="!item.approved" class="chip text-warn">non più approvato</span>
              <span class="ml-auto flex gap-1.5">
                <button v-if="item.approved" type="button" class="btn px-2.5 py-1 text-xs" @click="emit('project', item.project)"><Icon name="external" :size="12" />Apri il progetto</button>
                <button type="button" class="btn px-2.5 py-1 text-xs" :disabled="busy" :title="detail.status === 'archived' ? 'Libera il progetto per un altro cliente' : undefined" @click="unlink(item.id)">Scollega</button>
              </span>
            </li>
          </ul>
          <p v-else class="rounded-xl border border-line bg-surface p-4 text-sm text-muted">Nessun progetto collegato.</p>
          <form v-if="detail.status !== 'archived'" class="flex flex-wrap items-center gap-2" @submit.prevent="link">
            <select v-model="toLink" class="field min-w-[220px] px-2 py-1.5 text-[14px]" aria-label="Progetto da collegare" :disabled="linkable.length === 0">
              <option value="">{{ linkable.length === 0 ? 'Nessun progetto libero' : 'Scegli un progetto…' }}</option>
              <option v-for="name in linkable" :key="name" :value="name">{{ name }}</option>
            </select>
            <button type="submit" class="btn btn-primary px-3 py-1.5 text-[14px]" :disabled="busy || toLink === ''"><Icon name="link" :size="13" />Collega</button>
          </form>
        </div>

        <ClientDocuments v-else :client="detail" />
      </template>
    </template>
    </div>
  </section>
</template>
