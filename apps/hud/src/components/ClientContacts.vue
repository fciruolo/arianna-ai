<script setup lang="ts">
import { computed, ref } from 'vue';

import { addClientContact, removeClientContact, updateClientContact } from '../lib/api.ts';
import { clientErrorText, contactProblems, EMPTY_CONTACT, problemsFromError, type Client, type ClientContact, type ContactForm } from '../lib/clients.ts';
import FormField from './FormField.vue';
import Icon from './Icon.vue';

/**
 * "Contatti" of a client (D-168): the people to talk to, one of them the
 * primary (shown in the list of clients). Removed, a contact leaves the page,
 * never the database.
 */
const props = defineProps<{ client: Client }>();
const emit = defineEmits<{ changed: [] }>();

/** The contact being edited: an id, 'new', or null. */
const editing = ref<string | null>(null);
const form = ref<ContactForm>({ ...EMPTY_CONTACT });
const tried = ref(false);
const serverProblems = ref<Record<string, string>>({});
const problem = ref<string | null>(null);
const busy = ref(false);
const removing = ref<ClientContact | null>(null);
const locked = computed(() => props.client.status === 'archived');

const problems = computed(() => ({ ...(tried.value ? contactProblems(form.value) : {}), ...serverProblems.value }));

function edit(contact: ClientContact | null): void {
  editing.value = contact === null ? 'new' : contact.id;
  form.value = contact === null ? { ...EMPTY_CONTACT, primary: props.client.contacts.length === 0 } : { name: contact.name, role: contact.role, email: contact.email, phone: contact.phone, mobile: contact.mobile, notes: contact.notes, primary: contact.primary };
  tried.value = false;
  serverProblems.value = {};
  problem.value = null;
}

async function save(): Promise<void> {
  tried.value = true;
  if (Object.keys(contactProblems(form.value)).length > 0) return;
  busy.value = true;
  problem.value = null;
  try {
    if (editing.value === 'new') await addClientContact(props.client.id, form.value);
    else if (editing.value !== null) await updateClientContact(props.client.id, editing.value, form.value);
    editing.value = null;
    emit('changed');
  } catch (cause) {
    serverProblems.value = problemsFromError(cause);
    problem.value = clientErrorText(cause);
  } finally {
    busy.value = false;
  }
}

async function remove(): Promise<void> {
  if (removing.value === null) return;
  const contact = removing.value;
  busy.value = true;
  try {
    await removeClientContact(props.client.id, contact.id);
    removing.value = null;
    emit('changed');
  } catch (cause) {
    problem.value = clientErrorText(cause);
  } finally {
    busy.value = false;
  }
}

async function makePrimary(contact: ClientContact): Promise<void> {
  busy.value = true;
  try {
    await updateClientContact(props.client.id, contact.id, { primary: true });
    emit('changed');
  } catch (cause) {
    problem.value = clientErrorText(cause);
  } finally {
    busy.value = false;
  }
}

const input = 'field touch:min-h-11 w-full px-2.5 py-1.5 text-[14px] text-ink';
</script>

<template>
  <div class="grid gap-3">
    <div class="flex flex-wrap items-center gap-2">
      <button v-if="!locked" type="button" class="btn btn-primary px-3 py-1.5 text-[14px]" :disabled="busy || editing !== null" @click="edit(null)"><Icon name="new" :size="14" />Contatto</button>
      <p v-if="problem && editing === null" class="text-[14px] text-danger" role="alert">{{ problem }}</p>
    </div>

    <p v-if="client.contacts.length === 0 && editing === null" class="max-w-xl rounded-xl border border-line bg-surface p-4 text-sm text-muted">
      Nessun contatto. Aggiungi le persone con cui parli: amministrazione, referente tecnico, chi approva i preventivi.
    </p>

    <form v-if="editing !== null" class="grid gap-3 rounded-xl border border-accent/50 bg-surface p-4 sm:grid-cols-2" novalidate @submit.prevent="save">
      <h3 class="hud-title sm:col-span-2">{{ editing === 'new' ? 'Nuovo contatto' : 'Modifica il contatto' }}</h3>
      <FormField id="ct-name" label="Nome e cognome" :problem="problems.name">
        <input id="ct-name" v-model="form.name" :class="input" maxlength="200" autocomplete="off" />
      </FormField>
      <FormField id="ct-role" label="Ruolo" :problem="problems.role">
        <input id="ct-role" v-model="form.role" :class="input" maxlength="100" placeholder="Amministrazione, referente…" />
      </FormField>
      <FormField id="ct-email" label="Email" :problem="problems.email">
        <input id="ct-email" v-model="form.email" type="email" :class="input" maxlength="254" />
      </FormField>
      <FormField id="ct-phone" label="Telefono" :problem="problems.phone">
        <input id="ct-phone" v-model="form.phone" type="tel" :class="input" maxlength="30" />
      </FormField>
      <FormField id="ct-mobile" label="Cellulare" :problem="problems.mobile">
        <input id="ct-mobile" v-model="form.mobile" type="tel" :class="input" maxlength="30" />
      </FormField>
      <label class="flex items-center gap-2.5 self-end pb-2 text-[14px]"><input v-model="form.primary" type="checkbox" class="switch" />Contatto principale</label>
      <FormField id="ct-notes" label="Note" :problem="problems.notes" wide>
        <textarea id="ct-notes" v-model="form.notes" rows="3" :class="input" class="resize-y" maxlength="2000" />
      </FormField>
      <div class="flex flex-wrap items-center gap-2 sm:col-span-2">
        <button type="submit" class="btn btn-primary px-3 py-1.5 text-[14px]" :disabled="busy">Salva</button>
        <button type="button" class="btn px-3 py-1.5 text-[14px]" :disabled="busy" @click="editing = null">Annulla</button>
        <p v-if="problem" class="text-[14px] text-danger" role="alert">{{ problem }}</p>
      </div>
    </form>

    <ul class="grid gap-2.5 sm:grid-cols-[repeat(auto-fill,minmax(280px,1fr))]">
      <li v-for="contact in client.contacts" :key="contact.id" class="grid content-start gap-1.5 rounded-xl border bg-surface p-3.5" :class="contact.primary ? 'border-accent/60' : 'border-line'">
        <p class="flex items-start gap-2">
          <span class="min-w-0 flex-1">
            <b class="block truncate text-[14px] font-semibold">{{ contact.name }}</b>
            <span v-if="contact.role" class="block truncate text-[13.5px] text-muted">{{ contact.role }}</span>
          </span>
          <span v-if="contact.primary" class="chip text-accent">principale</span>
        </p>
        <a v-if="contact.email" :href="`mailto:${contact.email}`" class="inline-flex items-center gap-1.5 truncate text-[14px] hover:text-accent touch:min-h-11"><Icon name="mail" :size="13" />{{ contact.email }}</a>
        <a v-if="contact.phone" :href="`tel:${contact.phone.replace(/\s+/g, '')}`" class="inline-flex items-center gap-1.5 text-[14px] hover:text-accent touch:min-h-11"><Icon name="phone" :size="13" />{{ contact.phone }}</a>
        <a v-if="contact.mobile" :href="`tel:${contact.mobile.replace(/\s+/g, '')}`" class="inline-flex items-center gap-1.5 text-[14px] hover:text-accent touch:min-h-11"><Icon name="phone" :size="13" />{{ contact.mobile }} <span class="text-muted">cell.</span></a>
        <p v-if="contact.notes" class="text-[13.5px] whitespace-pre-line text-muted">{{ contact.notes }}</p>
        <div v-if="!locked" class="mt-1 flex flex-wrap gap-1.5">
          <button type="button" class="btn px-2.5 py-1 text-xs" :disabled="busy || editing !== null" @click="edit(contact)"><Icon name="rename" :size="12" />Modifica</button>
          <button v-if="!contact.primary" type="button" class="btn px-2.5 py-1 text-xs" :disabled="busy" @click="makePrimary(contact)">Rendi principale</button>
          <button type="button" class="btn px-2.5 py-1 text-xs" :disabled="busy" @click="removing = contact"><Icon name="delete" :size="12" />Togli</button>
        </div>
        <div v-if="removing?.id === contact.id" class="mt-1 grid gap-2 rounded-lg border border-danger/50 p-2.5 text-[13.5px]" role="alertdialog" aria-label="Togliere il contatto?">
          <p>Togliere {{ contact.name }} dai contatti? Resta nello storico, non compare più qui.</p>
          <div class="flex gap-1.5">
            <button type="button" class="btn btn-danger px-2.5 py-1 text-xs" :disabled="busy" @click="remove">Togli</button>
            <button type="button" class="btn px-2.5 py-1 text-xs" @click="removing = null">Annulla</button>
          </div>
        </div>
      </li>
    </ul>
  </div>
</template>
