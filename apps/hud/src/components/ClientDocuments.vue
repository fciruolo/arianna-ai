<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';

import { addClientDocument, archiveClientDocument, listClientDocuments, openClientDocument, updateClientDocument } from '../lib/api.ts';
import {
  DOCUMENT_EXTENSIONS,
  DOCUMENT_KINDS,
  documentErrorText,
  documentFileProblem,
  documentFileUrl,
  expiryText,
  filterDocuments,
  KIND_TEXT,
  kindChips,
  sizeText,
  typeText,
  type ClientDocument,
  type DocumentForm,
  type KindFilter,
} from '../lib/client-documents.ts';
import type { Client } from '../lib/clients.ts';
import { dayText, todayInput } from '../lib/im-billing.ts';
import Icon from './Icon.vue';
import LabelBadge from './LabelBadge.vue';

/**
 * "Documenti" of a client (I-16 tappa C2, D-171): contracts, signed quotes,
 * NDA, orders and other files, in the private folder of the client on this
 * computer. A file is dropped or chosen, described (type, project, dates)
 * and sent as base64; the list filters by type and searches; PDF and images
 * are shown here, "Apri" and "Mostra nel Finder" ask the core to run `open`
 * on the Mac. Never to the Coder, Claude, Codex or Telegram.
 */
const props = defineProps<{ client: Client }>();

const documents = ref<ClientDocument[] | null>(null);
const problem = ref<string | null>(null);
const notice = ref<string | null>(null);
const busy = ref(false);
const kind = ref<KindFilter>('all');
const query = ref('');
const archived = ref(false);
const selected = ref<string | null>(null);
const today = todayInput();

const projects = computed(() => props.client.projects.map((item) => item.project));
const shown = computed(() => filterDocuments(documents.value ?? [], kind.value, query.value, archived.value));
const chips = computed(() => kindChips(documents.value ?? []));
const current = computed(() => (documents.value ?? []).find((document) => document.id === selected.value) ?? null);
const archivedCount = computed(() => (documents.value ?? []).filter((document) => document.archivedAt !== null).length);

async function load(): Promise<void> {
  const id = props.client.id;
  try {
    const found = await listClientDocuments(id);
    if (props.client.id !== id) return;
    documents.value = found;
    problem.value = null;
    if (selected.value === null || !found.some((document) => document.id === selected.value)) selected.value = filterDocuments(found, 'all', '', false)[0]?.id ?? null;
  } catch (cause) {
    if (props.client.id === id) problem.value = documentErrorText(cause);
  }
}

async function run(action: () => Promise<unknown>, done: string): Promise<boolean> {
  busy.value = true;
  notice.value = null;
  try {
    await action();
    notice.value = done;
    return true;
  } catch (cause) {
    notice.value = documentErrorText(cause);
    return false;
  } finally {
    await load();
    busy.value = false;
  }
}

// --- A new document: the file, then what it is
const emptyForm = (): DocumentForm => ({ name: '', kind: 'contract', otherType: null, project: null, documentOn: null, expiresOn: null });
const pending = ref<{ file: File; form: DocumentForm } | null>(null);
const dragging = ref(false);
const picker = ref<HTMLInputElement | null>(null);

/** The document chosen from the list; on a phone the preview is under the list, so it comes into view (D-293). */
const previewBox = ref<HTMLElement | null>(null);
function choose(id: string): void {
  selected.value = id;
  if (!window.matchMedia('(width < 48rem)').matches) return;
  void nextTick(() => previewBox.value?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
}
const accept = DOCUMENT_EXTENSIONS.map((extension) => `.${extension}`).join(',');

function take(file: File | undefined): void {
  if (file === undefined) return;
  const wrong = documentFileProblem(file);
  if (wrong !== null) {
    notice.value = wrong;
    return;
  }
  notice.value = null;
  pending.value = { file, form: { ...emptyForm(), name: file.name.replace(/\.[A-Za-z0-9]{1,5}$/, ''), project: projects.value.length === 1 ? (projects.value[0] ?? null) : null } };
}

function dropped(event: DragEvent): void {
  dragging.value = false;
  if (busy.value || props.client.status === 'archived') return;
  take(event.dataTransfer?.files[0]);
}

function chosen(event: Event): void {
  const input = event.target as HTMLInputElement;
  take(input.files?.[0]);
  input.value = '';
}

const pendingValid = computed(() => pending.value !== null && pending.value.form.name.trim() !== '' && (pending.value.form.kind !== 'other' || (pending.value.form.otherType ?? '').trim() !== ''));

async function upload(): Promise<void> {
  const item = pending.value;
  if (item === null || !pendingValid.value || busy.value) return;
  // Busy from the reading of the file on: a second click does not send it twice.
  busy.value = true;
  const bytes = new Uint8Array(await item.file.arrayBuffer());
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  const form = { ...item.form, otherType: item.form.kind === 'other' ? (item.form.otherType ?? '').trim() : null };
  let added: ClientDocument | undefined;
  const ok = await run(async () => {
    added = await addClientDocument(props.client.id, { ...form, fileName: item.file.name, data: btoa(binary) });
  }, `Documento «${form.name}» aggiunto alla cartella del cliente.`);
  if (ok) {
    pending.value = null;
    if (added !== undefined) {
      archived.value = false;
      selected.value = added.id;
    }
  }
}

// --- One document: change, archive, open
const editing = ref<DocumentForm | null>(null);

function startEditing(document: ClientDocument): void {
  editing.value = { name: document.name, kind: document.kind, otherType: document.otherType, project: document.project, documentOn: document.documentOn, expiresOn: document.expiresOn };
}

async function saveEditing(document: ClientDocument): Promise<void> {
  const form = editing.value;
  if (form === null) return;
  const change = { ...form, otherType: form.kind === 'other' ? (form.otherType ?? '').trim() : null };
  if (await run(() => updateClientDocument(props.client.id, document.id, change), 'Documento aggiornato.')) editing.value = null;
}

function setArchived(document: ClientDocument, value: boolean): void {
  void run(() => archiveClientDocument(props.client.id, document.id, value), value ? `«${document.name}» archiviato: non è cancellato, lo trovi fra gli archiviati.` : `«${document.name}» ripristinato.`).then((ok) => {
    if (!ok) return;
    if (value) selected.value = null;
    else {
      // Back among the documents in use, with the one restored chosen.
      archived.value = false;
      selected.value = document.id;
    }
  });
}

function open(document: ClientDocument, reveal: boolean): void {
  void run(() => openClientDocument(props.client.id, document.id, reveal), reveal ? 'Mostrato nel Finder.' : 'Aperto con l’app del Mac.');
}

// The name shown may have lost its extension: the download gets it back.
const downloadName = (document: ClientDocument): string => (document.name.toLowerCase().endsWith(`.${document.extension}`) ? document.name : `${document.name}.${document.extension}`);
const fileUrl = (document: ClientDocument): string => documentFileUrl(props.client.id, document.id);
const isImage = (document: ClientDocument): boolean => document.preview && document.mediaType.startsWith('image/');

watch(
  () => props.client.id,
  () => {
    documents.value = null;
    pending.value = null;
    editing.value = null;
    selected.value = null;
    kind.value = 'all';
    query.value = '';
    archived.value = false;
    void load();
  },
  { immediate: true },
);
watch(selected, () => {
  editing.value = null;
});
</script>

<template>
  <div class="flex flex-col gap-3.5">
    <p v-if="problem" class="rounded-xl border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger" role="alert">{{ problem }}</p>

    <!-- The file: dropped or chosen -->
    <div
      class="flex flex-wrap items-center gap-3 rounded-xl border border-dashed p-3.5 text-[14px] text-muted transition-colors"
      :class="dragging ? 'border-accent bg-accent/10' : 'border-line-strong bg-surface'"
      @dragover.prevent="dragging = true"
      @dragleave="dragging = false"
      @drop.prevent="dropped"
    >
      <Icon name="attach" :size="18" />
      <div class="min-w-[220px] flex-1">
        <p class="text-ink">Trascina qui un file o scegli dal computer · PDF, immagini, documenti di Office o di testo, al più 25 MB</p>
        <p class="text-xs">data/clients/&lt;cliente&gt;/documenti/ · cartella Privata su questo computer</p>
      </div>
      <input ref="picker" type="file" class="sr-only" :accept="accept" @change="chosen" />
      <button type="button" class="btn px-3 py-1 text-[14px]" :disabled="busy || client.status === 'archived'" @click="picker?.click()">Scegli file…</button>
    </div>

    <form v-if="pending" class="flex flex-col gap-3 rounded-xl border border-line bg-surface-2 px-4 py-3.5" @submit.prevent="upload">
      <p class="text-[14px]">Aggiungi <b>{{ pending.file.name }}</b> ({{ sizeText(pending.file.size) }}) ai documenti di {{ client.displayName }}.</p>
      <div class="flex flex-wrap gap-1.5" role="group" aria-label="Tipo di documento">
        <button v-for="item in DOCUMENT_KINDS" :key="item" type="button" class="chip" :class="{ on: pending.form.kind === item }" :aria-pressed="pending.form.kind === item" @click="pending.form.kind = item">{{ KIND_TEXT[item] }}</button>
      </div>
      <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_150px_150px]">
        <label class="flex flex-col gap-1 text-xs text-muted">Nome
          <input v-model="pending.form.name" maxlength="200" class="field touch:min-h-11 px-2 py-1.5 text-[14px] text-ink" />
        </label>
        <label v-if="pending.form.kind === 'other'" class="flex flex-col gap-1 text-xs text-muted">Tipo
          <input v-model="pending.form.otherType" maxlength="60" class="field touch:min-h-11 px-2 py-1.5 text-[14px] text-ink" placeholder="brochure, materiali…" />
        </label>
        <label v-else class="flex flex-col gap-1 text-xs text-muted">Progetto (facoltativo)
          <select v-model="pending.form.project" class="field touch:min-h-11 px-2 py-1.5 text-[14px] text-ink">
            <option :value="null">—</option>
            <option v-for="item in projects" :key="item" :value="item">{{ item }}</option>
          </select>
        </label>
        <label class="flex flex-col gap-1 text-xs text-muted">Data del documento
          <input v-model="pending.form.documentOn" type="date" class="field touch:min-h-11 px-2 py-1.5 text-[14px] text-ink" />
        </label>
        <label class="flex flex-col gap-1 text-xs text-muted">Scadenza (facoltativa)
          <input v-model="pending.form.expiresOn" type="date" class="field touch:min-h-11 px-2 py-1.5 text-[14px] text-ink" />
        </label>
        <label v-if="pending.form.kind === 'other'" class="flex flex-col gap-1 text-xs text-muted">Progetto (facoltativo)
          <select v-model="pending.form.project" class="field touch:min-h-11 px-2 py-1.5 text-[14px] text-ink">
            <option :value="null">—</option>
            <option v-for="item in projects" :key="item" :value="item">{{ item }}</option>
          </select>
        </label>
      </div>
      <p class="text-xs text-muted">Con una scadenza, 30 giorni prima il messaggio del mattino della segretaria la ricorda, con il solo nome del cliente e il tipo.</p>
      <div class="flex justify-end gap-2">
        <button type="button" class="btn px-3 py-1 text-[14px]" :disabled="busy" @click="pending = null">Annulla</button>
        <button type="submit" class="btn btn-primary px-3 py-1 text-[14px] font-semibold" :disabled="busy || !pendingValid">Aggiungi</button>
      </div>
    </form>

    <p v-if="notice" class="text-sm text-muted" role="status">{{ notice }}</p>

    <div class="grid gap-3.5 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
      <!-- The list -->
      <section class="flex min-w-0 flex-col gap-2.5 rounded-2xl border border-line bg-surface p-3.5" aria-label="Documenti del cliente">
        <div class="flex flex-wrap items-center gap-2">
          <div class="flex flex-wrap gap-1.5" role="group" aria-label="Filtra per tipo">
            <button v-for="chip in chips" :key="chip.id" type="button" class="chip" :class="{ on: kind === chip.id }" :aria-pressed="kind === chip.id" @click="kind = chip.id">{{ chip.text }} · {{ chip.count }}</button>
          </div>
          <span class="flex-1" />
          <label class="flex min-w-[180px] items-center gap-2 rounded-lg border border-line-strong bg-surface-2 px-2.5 py-1 max-md:flex-1 touch:min-h-11">
            <Icon name="search" :size="13" class="text-muted" />
            <input v-model="query" class="w-full bg-transparent text-[14px]" placeholder="Cerca" aria-label="Cerca fra i documenti" />
          </label>
          <button v-if="archivedCount > 0 || archived" type="button" class="chip" :class="{ on: archived }" :aria-pressed="archived" @click="archived = !archived">Archiviati · {{ archivedCount }}</button>
        </div>
        <p v-if="documents === null && problem === null" class="text-sm text-muted">Carico i documenti…</p>
        <p v-else-if="shown.length === 0" class="py-3 text-sm text-muted">{{ (documents ?? []).length === 0 ? 'Nessun documento ancora: trascina qui sopra un contratto o un preventivo firmato.' : 'Nessun documento con questi filtri.' }}</p>
        <!-- On a phone each document is a card (D-293): name and size, then type, project and date. -->
        <div v-else class="overflow-x-auto">
          <table class="w-full text-[14px] max-md:block">
            <thead class="max-md:hidden">
              <tr class="border-b border-line text-left text-xs text-muted">
                <th class="px-2 py-1.5 font-normal">Nome</th>
                <th class="px-2 py-1.5 font-normal">Tipo</th>
                <th class="px-2 py-1.5 font-normal">Progetto</th>
                <th class="px-2 py-1.5 font-normal">Data</th>
                <th class="px-2 py-1.5 text-right font-normal">Dim.</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-line max-md:block">
              <tr v-for="document in shown" :key="document.id" class="cursor-pointer max-md:grid max-md:grid-cols-[minmax(0,1fr)_auto] max-md:gap-x-3 max-md:gap-y-0.5 max-md:py-2" :class="selected === document.id ? 'bg-accent/10' : 'hover:bg-surface-2'" @click="choose(document.id)">
                <td class="px-2 py-2 max-md:min-w-0 max-md:py-0">
                  <button type="button" class="flex items-center gap-2 text-left max-md:w-full touch:min-h-11" :aria-pressed="selected === document.id">
                    <span class="inline-grid h-[22px] w-[34px] shrink-0 place-items-center rounded border border-line-strong font-mono text-[12px] font-semibold text-muted uppercase">{{ document.extension }}</span>
                    <span class="min-w-0">
                      <span class="block truncate">{{ document.name }}</span>
                      <span v-if="expiryText(document.expiresOn, today)" class="block text-xs" :class="expiryText(document.expiresOn, today)?.past ? 'text-danger' : expiryText(document.expiresOn, today)?.soon ? 'text-warn' : 'text-muted'">{{ expiryText(document.expiresOn, today)?.text }}</span>
                    </span>
                  </button>
                </td>
                <td class="px-2 py-2 whitespace-nowrap max-md:order-3 max-md:col-span-2 max-md:py-0 max-md:pl-[3.25rem] max-md:text-[13px] max-md:whitespace-normal max-md:text-muted">{{ typeText(document) }}<span class="md:hidden"> · {{ document.project ?? 'nessun progetto' }} · {{ document.documentOn ? dayText(document.documentOn) : dayText(document.createdAt.slice(0, 10)) }}</span></td>
                <td class="px-2 py-2 text-muted max-md:hidden">{{ document.project ?? '—' }}</td>
                <td class="px-2 py-2 whitespace-nowrap text-muted max-md:hidden">{{ document.documentOn ? dayText(document.documentOn) : dayText(document.createdAt.slice(0, 10)) }}</td>
                <td class="px-2 py-2 text-right font-mono text-xs whitespace-nowrap text-muted max-md:order-2 max-md:self-center max-md:py-0">{{ sizeText(document.sizeBytes) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- The document chosen -->
      <section v-if="current" ref="previewBox" class="flex min-w-0 scroll-mt-3 flex-col gap-3 rounded-2xl border border-line bg-surface p-3.5" aria-labelledby="doc-preview-title">
        <header class="flex items-center gap-2">
          <h2 id="doc-preview-title" class="hud-title flex-1">Anteprima</h2>
          <LabelBadge label="L2" class="text-xs" />
        </header>
        <img v-if="isImage(current)" :src="fileUrl(current)" :alt="current.name" class="max-h-[360px] w-full rounded-lg border border-line bg-surface-2 object-contain" />
        <iframe v-else-if="current.preview" :src="fileUrl(current)" :title="`Anteprima di ${current.name}`" class="h-[360px] w-full rounded-lg border border-line bg-surface-2" />
        <div v-else class="grid h-[140px] place-items-center rounded-lg border border-dashed border-line-strong bg-surface-2 text-center text-xs text-muted">
          <p>Nessuna anteprima per un file {{ current.extension.toUpperCase() }}:<br />aprilo con l’app del Mac.</p>
        </div>

        <form v-if="editing" class="grid gap-2.5" @submit.prevent="saveEditing(current)">
          <div class="flex flex-wrap gap-1.5" role="group" aria-label="Tipo di documento">
            <button v-for="item in DOCUMENT_KINDS" :key="item" type="button" class="chip" :class="{ on: editing.kind === item }" :aria-pressed="editing.kind === item" @click="editing.kind = item">{{ KIND_TEXT[item] }}</button>
          </div>
          <label class="flex flex-col gap-1 text-xs text-muted">Nome<input v-model="editing.name" maxlength="200" class="field touch:min-h-11 px-2 py-1.5 text-[14px] text-ink" /></label>
          <label v-if="editing.kind === 'other'" class="flex flex-col gap-1 text-xs text-muted">Tipo<input v-model="editing.otherType" maxlength="60" class="field touch:min-h-11 px-2 py-1.5 text-[14px] text-ink" /></label>
          <label class="flex flex-col gap-1 text-xs text-muted">Progetto
            <select v-model="editing.project" class="field touch:min-h-11 px-2 py-1.5 text-[14px] text-ink">
              <option :value="null">—</option>
              <option v-for="item in projects" :key="item" :value="item">{{ item }}</option>
            </select>
          </label>
          <div class="grid grid-cols-2 gap-2.5">
            <label class="flex flex-col gap-1 text-xs text-muted">Data<input v-model="editing.documentOn" type="date" class="field touch:min-h-11 px-2 py-1.5 text-[14px] text-ink" /></label>
            <label class="flex flex-col gap-1 text-xs text-muted">Scadenza<input v-model="editing.expiresOn" type="date" class="field touch:min-h-11 px-2 py-1.5 text-[14px] text-ink" /></label>
          </div>
          <div class="flex justify-end gap-2">
            <button type="button" class="btn px-3 py-1 text-[14px]" :disabled="busy" @click="editing = null">Annulla</button>
            <button type="submit" class="btn btn-primary px-3 py-1 text-[14px] font-semibold" :disabled="busy || editing.name.trim() === '' || (editing.kind === 'other' && (editing.otherType ?? '').trim() === '')">Salva</button>
          </div>
        </form>
        <dl v-else class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13.5px]">
          <dt class="text-muted">Nome</dt><dd class="min-w-0 break-words">{{ current.name }}</dd>
          <dt class="text-muted">Tipo</dt>
          <dd>{{ typeText(current) }}<span v-if="expiryText(current.expiresOn, today)" :class="expiryText(current.expiresOn, today)?.past ? 'text-danger' : 'text-muted'"> · {{ expiryText(current.expiresOn, today)?.text }}</span></dd>
          <dt class="text-muted">Progetto</dt><dd>{{ current.project ?? '—' }}</dd>
          <dt class="text-muted">Aggiunto</dt><dd>{{ dayText(current.createdAt.slice(0, 10)) }} · {{ sizeText(current.sizeBytes) }}</dd>
        </dl>

        <div v-if="!editing" class="flex flex-wrap gap-1.5">
          <button type="button" class="btn px-2.5 py-1 text-xs" :disabled="busy" @click="open(current, false)"><Icon name="external" :size="12" />Apri</button>
          <button type="button" class="btn px-2.5 py-1 text-xs" :disabled="busy" @click="open(current, true)"><Icon name="project" :size="12" />Mostra nel Finder</button>
          <a class="btn px-2.5 py-1 text-xs" :href="fileUrl(current)" :download="downloadName(current)">Scarica</a>
          <template v-if="current.archivedAt === null">
            <button type="button" class="btn px-2.5 py-1 text-xs" :disabled="busy || client.status === 'archived'" @click="startEditing(current)">Cambia tipo o progetto</button>
            <button type="button" class="btn px-2.5 py-1 text-xs" :disabled="busy || client.status === 'archived'" @click="setArchived(current, true)"><Icon name="archive" :size="12" />Archivia</button>
          </template>
          <button v-else type="button" class="btn px-2.5 py-1 text-xs" :disabled="busy || client.status === 'archived'" @click="setArchived(current, false)"><Icon name="restore" :size="12" />Ripristina</button>
        </div>
        <p class="text-xs text-muted">L’anteprima si fa qui, sul Mac; “Apri” usa l’app predefinita del sistema. Archiviare toglie il documento dalla lista senza cancellarlo.</p>
      </section>
    </div>

    <p class="flex items-center gap-2 text-xs text-muted">
      <LabelBadge label="L2" class="text-xs" />
      I documenti del cliente restano nella sua cartella: non vanno mai al Coder, a Claude, a Codex né a Telegram, e non entrano nella conoscenza indicizzata del progetto.
    </p>
  </div>
</template>

<style scoped>
.chip {
  color: var(--muted);
  font-size: 11.5px;
  padding: 3px 9px;
  border-radius: 999px;
}
.chip.on {
  border-color: var(--accent);
  background: var(--glow);
  color: var(--ink);
}
/* A finger (D-293): the chips of the filters and of the type reach the 44 px of a tap. */
@media (pointer: coarse) {
  button.chip {
    min-height: 44px;
    padding: 3px 12px;
  }
}
</style>
