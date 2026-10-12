<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import { createClient, updateClient } from '../lib/api.ts';
import {
  AREA_TEXT,
  areaOf,
  clientErrorText,
  clientIssues,
  COUNTRIES,
  countryName,
  emptyAddress,
  euVatPrefix,
  formForSave,
  formOf,
  issueText,
  KIND_TEXT,
  numberField,
  parseTags,
  PAYMENT_TEXT,
  problemsFromError,
  shownFields,
  VAT_NATURE_TEXT,
  VAT_NATURES,
  type Address,
  type Client,
  type ClientForm,
  type ClientKind,
  type PaymentMethod,
} from '../lib/clients.ts';
import FormField from './FormField.vue';
import Icon from './Icon.vue';

/**
 * "Anagrafica" of a client (I-16, D-168): identity, tax, electronic invoice,
 * addresses, payment and notes. The fields follow the kind and the country
 * (no SDI or PEC abroad, the IPA code and split payment for a public body);
 * the checks are the core's, repeated here so that a message shows under the
 * field before saving. With `client` null it writes a new client.
 */
const props = defineProps<{ client: Client | null }>();
const emit = defineEmits<{ saved: [id: string]; cancel: [] }>();

const form = ref<ClientForm>(formOf(props.client));
const office = ref<Address>(emptyAddress('IT'));
const billing = ref<Address>(emptyAddress('IT'));
const shipping = ref<Address>(emptyAddress('IT'));
const billingOn = ref(false);
const shippingOn = ref(false);
const vatRateText = ref('');
const daysText = ref('');
const tagsText = ref('');

function load(client: Client | null): void {
  form.value = formOf(client);
  const country = form.value.country;
  office.value = form.value.registeredAddress === null ? emptyAddress(country) : { ...form.value.registeredAddress };
  billingOn.value = form.value.billingAddress !== null;
  billing.value = form.value.billingAddress === null ? emptyAddress(country) : { ...form.value.billingAddress };
  shippingOn.value = form.value.shippingAddress !== null;
  shipping.value = form.value.shippingAddress === null ? emptyAddress(country) : { ...form.value.shippingAddress };
  vatRateText.value = form.value.vatRate === null ? '' : String(form.value.vatRate).replace('.', ',');
  daysText.value = form.value.paymentDays === null ? '' : String(form.value.paymentDays);
  tagsText.value = form.value.tags.join(', ');
  touched.value = new Set();
  tried.value = false;
  serverProblems.value = {};
  problem.value = null;
}

const touched = ref<Set<string>>(new Set());
const tried = ref(false);
const serverProblems = ref<Record<string, string>>({});
const problem = ref<string | null>(null);
const saving = ref(false);
load(props.client);
watch(
  () => props.client,
  (client) => {
    load(client);
  },
);

/** The form as it would be saved: the hidden fields empty. */
const current = computed<ClientForm>(() =>
  formForSave({
    ...form.value,
    vatRate: numberField(vatRateText.value),
    paymentDays: numberField(daysText.value),
    tags: parseTags(tagsText.value),
    registeredAddress: office.value,
    billingAddress: billingOn.value ? billing.value : null,
    shippingAddress: shippingOn.value ? shipping.value : null,
  }),
);
const issues = computed(() => clientIssues(current.value));
const shown = computed(() => shownFields(form.value.kind, form.value.country));
const area = computed(() => areaOf(form.value.country));
const italian = computed(() => form.value.country === 'IT');
const pa = computed(() => form.value.kind === 'public_administration');
const person = computed(() => form.value.kind === 'individual' || form.value.kind === 'freelancer');
const readOnly = computed(() => props.client?.status === 'archived');
const countryMissing = computed(() => !COUNTRIES.some((country) => country.code === form.value.country));

/** The message under a field: after the user left it or tried to save; the core's answer first. */
function problemOf(field: string): string | undefined {
  const fromServer = serverProblems.value[field];
  if (fromServer !== undefined) return fromServer;
  if (!tried.value && !touched.value.has(field)) return undefined;
  const issue = issues.value.find((item) => item.field === field);
  return issue === undefined ? undefined : issueText(issue);
}

function leave(event: FocusEvent): void {
  const id = (event.target as HTMLElement | null)?.id ?? '';
  if (id.startsWith('cl-')) touched.value = new Set([...touched.value, id.slice(3)]);
}

// A change clears what the core said about the fields.
watch(current, () => {
  serverProblems.value = {};
});

/** The SDI code the invoice will carry, as the core computes it. */
const sdiShown = computed(() => {
  if (!italian.value) return 'XXXXXXX';
  if (pa.value) return current.value.ipaCode ?? 'il codice IPA';
  return current.value.sdiCode === null || current.value.sdiCode.trim() === '' ? '0000000' : current.value.sdiCode.toUpperCase();
});

const displayPlaceholder = computed(() => {
  const name = person.value ? [form.value.firstName, form.value.lastName].filter((part) => part !== null && part.trim() !== '').join(' ') : (form.value.legalName ?? '');
  return name.trim() === '' ? (person.value ? 'Laura Bianchi' : 'Rossi') : name;
});

function chooseCountry(event: Event): void {
  const country = (event.target as HTMLSelectElement).value;
  form.value.country = country;
  // The other addresses follow while the user has not chosen a country for them.
  if (!billingOn.value) billing.value.country = country;
  if (!shippingOn.value) shipping.value.country = country;
}

async function save(): Promise<void> {
  tried.value = true;
  problem.value = null;
  if (issues.value.length > 0) {
    problem.value = 'Alcuni campi non vanno: guarda i messaggi in rosso.';
    return;
  }
  saving.value = true;
  try {
    const body = current.value;
    if (props.client === null) emit('saved', await createClient(body));
    else {
      await updateClient(props.client.id, body);
      emit('saved', props.client.id);
    }
  } catch (cause) {
    serverProblems.value = problemsFromError(cause);
    problem.value = clientErrorText(cause);
  } finally {
    saving.value = false;
  }
}

const kinds = Object.entries(KIND_TEXT) as [ClientKind, string][];
const payments = Object.entries(PAYMENT_TEXT) as [PaymentMethod, string][];
const input = 'field w-full px-2.5 py-1.5 text-[14px] text-ink disabled:opacity-60';
const sectionClass = 'grid gap-3 rounded-xl border border-line bg-surface p-4 sm:grid-cols-2';
</script>

<template>
  <form class="grid gap-4" novalidate @submit.prevent="save" @focusout="leave">
    <fieldset :disabled="readOnly || saving" class="grid gap-4">
      <!-- IDENTITÀ -->
      <section :class="sectionClass" aria-labelledby="cl-identity">
        <h3 id="cl-identity" class="hud-title sm:col-span-2">Identità</h3>
        <FormField id="cl-kind" label="Tipo">
          <select id="cl-kind" v-model="form.kind" :class="input">
            <option v-for="[value, text] in kinds" :key="value" :value="value">{{ text }}</option>
          </select>
        </FormField>
        <FormField id="cl-status" label="Stato" hint="Potenziale: un cliente con cui non lavori ancora.">
          <select id="cl-status" v-model="form.status" :class="input">
            <option value="active">Attivo</option>
            <option value="prospect">Potenziale</option>
          </select>
        </FormField>
        <template v-if="person">
          <FormField id="cl-firstName" label="Nome" :problem="problemOf('firstName')">
            <input id="cl-firstName" v-model="form.firstName" :class="input" maxlength="100" autocomplete="off" />
          </FormField>
          <FormField id="cl-lastName" label="Cognome" :problem="problemOf('lastName')">
            <input id="cl-lastName" v-model="form.lastName" :class="input" maxlength="100" autocomplete="off" />
          </FormField>
        </template>
        <FormField v-else id="cl-legalName" label="Ragione sociale" :problem="problemOf('legalName')" hint="Come va scritta in fattura." wide>
          <input id="cl-legalName" v-model="form.legalName" :class="input" maxlength="300" autocomplete="off" :placeholder="pa ? 'Comune di …' : 'Rossi Srl'" />
        </FormField>
        <FormField id="cl-displayName" label="Nome nella lista" :problem="problemOf('displayName')" hint="Vuoto: si usa la ragione sociale o nome e cognome.">
          <input id="cl-displayName" v-model="form.displayName" :class="input" maxlength="200" autocomplete="off" :placeholder="displayPlaceholder" />
        </FormField>
        <FormField id="cl-sector" label="Settore" :problem="problemOf('sector')">
          <input id="cl-sector" v-model="form.sector" :class="input" maxlength="100" placeholder="Ristorazione, e-commerce…" />
        </FormField>
        <FormField id="cl-website" label="Sito" :problem="problemOf('website')">
          <input id="cl-website" v-model="form.website" :class="input" maxlength="300" inputmode="url" placeholder="rossi.example" />
        </FormField>
        <FormField id="cl-email" label="Email" :problem="problemOf('email')">
          <input id="cl-email" v-model="form.email" type="email" :class="input" maxlength="254" />
        </FormField>
        <FormField id="cl-phone" label="Telefono" :problem="problemOf('phone')">
          <input id="cl-phone" v-model="form.phone" type="tel" :class="input" maxlength="30" />
        </FormField>
        <FormField id="cl-mobile" label="Cellulare" :problem="problemOf('mobile')">
          <input id="cl-mobile" v-model="form.mobile" type="tel" :class="input" maxlength="30" />
        </FormField>
        <FormField id="cl-tags" label="Etichette" :problem="problemOf('tags')" hint="Separate da virgole: web, grafica.">
          <input id="cl-tags" v-model="tagsText" :class="input" />
        </FormField>
      </section>

      <!-- FISCALE -->
      <section :class="sectionClass" aria-labelledby="cl-tax">
        <h3 id="cl-tax" class="hud-title flex items-center gap-2 sm:col-span-2">Fiscale <span class="chip normal-case">{{ AREA_TEXT[area] }}</span></h3>
        <FormField id="cl-country" label="Paese" :problem="problemOf('country')">
          <select id="cl-country" :value="form.country" :class="input" @change="chooseCountry">
            <option v-if="countryMissing" :value="form.country">{{ form.country }}</option>
            <option v-for="country in COUNTRIES" :key="country.code" :value="country.code">{{ country.name }}</option>
          </select>
        </FormField>
        <FormField v-if="shown.vatNumber" id="cl-vatNumber" label="Partita IVA" :problem="problemOf('vatNumber')" hint="11 cifre, senza IT davanti.">
          <input id="cl-vatNumber" v-model="form.vatNumber" :class="input" maxlength="20" inputmode="numeric" autocomplete="off" />
        </FormField>
        <FormField v-if="shown.taxCode" id="cl-taxCode" label="Codice fiscale" :problem="problemOf('taxCode')" :hint="person ? '16 caratteri.' : 'Di solito uguale alla partita IVA.'">
          <input id="cl-taxCode" v-model="form.taxCode" :class="input" maxlength="20" autocomplete="off" class="uppercase" />
        </FormField>
        <FormField v-if="shown.euVatNumber" id="cl-euVatNumber" label="Partita IVA UE (VIES)" :problem="problemOf('euVatNumber')" :hint="`Con il prefisso ${euVatPrefix(form.country) ?? ''}. Non viene verificata in rete.`">
          <input id="cl-euVatNumber" v-model="form.euVatNumber" :class="input" maxlength="20" autocomplete="off" class="uppercase" :placeholder="`${euVatPrefix(form.country) ?? ''}…`" />
        </FormField>
        <FormField v-if="shown.foreignTaxId" id="cl-foreignTaxId" label="Identificativo fiscale estero" :problem="problemOf('foreignTaxId')" :hint="`Il numero fiscale del cliente in ${countryName(form.country)}.`">
          <input id="cl-foreignTaxId" v-model="form.foreignTaxId" :class="input" maxlength="30" autocomplete="off" />
        </FormField>
        <FormField id="cl-vatRate" label="Aliquota IVA (%)" :problem="problemOf('vatRate')" hint="Vuoto: quella ordinaria (22).">
          <input id="cl-vatRate" v-model="vatRateText" :class="input" inputmode="decimal" placeholder="22" />
        </FormField>
        <FormField id="cl-vatNature" label="Natura IVA (operazioni senza IVA)" :problem="problemOf('vatNature')" hint="Per esempio N2.2 per un forfettario, N6.x per il reverse charge.">
          <select id="cl-vatNature" v-model="form.vatNature" :class="input">
            <option :value="null">Nessuna</option>
            <option v-for="nature in VAT_NATURES" :key="nature" :value="nature">{{ nature }} · {{ VAT_NATURE_TEXT[nature] }}</option>
          </select>
        </FormField>
        <label v-if="shown.splitPayment" class="flex items-center gap-2.5 text-[14px]">
          <input id="cl-splitPayment" v-model="form.splitPayment" type="checkbox" class="switch" />
          Split payment (scissione dei pagamenti)
        </label>
        <label v-if="shown.withholdingAgent" class="flex items-center gap-2.5 text-[14px]">
          <input id="cl-withholdingAgent" v-model="form.withholdingAgent" type="checkbox" class="switch" />
          Applica la ritenuta d’acconto (sostituto d’imposta)
        </label>
      </section>

      <!-- FATTURAZIONE ELETTRONICA -->
      <section :class="sectionClass" aria-labelledby="cl-einvoice">
        <h3 id="cl-einvoice" class="hud-title sm:col-span-2">Fatturazione elettronica</h3>
        <p class="text-[13.5px] text-muted sm:col-span-2">
          Codice destinatario in fattura: <b class="font-mono text-ink">{{ sdiShown }}</b>
          <template v-if="!italian"> · per un cliente estero la fattura va allo SDI come transfrontaliera.</template>
          <template v-else-if="pa"> · per una pubblica amministrazione è il codice univoco ufficio (IPA).</template>
        </p>
        <FormField v-if="shown.sdiCode" id="cl-sdiCode" label="Codice SDI" :problem="problemOf('sdiCode')" hint="7 caratteri; vuoto vale 0000000 (riceve nel cassetto fiscale o alla PEC).">
          <input id="cl-sdiCode" v-model="form.sdiCode" :class="input" maxlength="7" autocomplete="off" class="uppercase" placeholder="0000000" />
        </FormField>
        <FormField v-if="shown.ipaCode" id="cl-ipaCode" label="Codice univoco ufficio (IPA)" :problem="problemOf('ipaCode')" hint="6 caratteri, dall’indice IPA.">
          <input id="cl-ipaCode" v-model="form.ipaCode" :class="input" maxlength="6" autocomplete="off" class="uppercase" />
        </FormField>
        <FormField v-if="shown.pec" id="cl-pec" label="PEC" :problem="problemOf('pec')">
          <input id="cl-pec" v-model="form.pec" type="email" :class="input" maxlength="254" />
        </FormField>
        <template v-if="shown.cig">
          <FormField id="cl-cig" label="CIG" :problem="problemOf('cig')" hint="Facoltativo: 10 caratteri.">
            <input id="cl-cig" v-model="form.cig" :class="input" maxlength="10" autocomplete="off" class="uppercase" />
          </FormField>
          <FormField id="cl-cup" label="CUP" :problem="problemOf('cup')" hint="Facoltativo: 15 caratteri.">
            <input id="cl-cup" v-model="form.cup" :class="input" maxlength="15" autocomplete="off" class="uppercase" />
          </FormField>
        </template>
      </section>

      <!-- INDIRIZZI -->
      <section :class="sectionClass" aria-labelledby="cl-addresses">
        <h3 id="cl-addresses" class="hud-title sm:col-span-2">Indirizzi</h3>
        <p class="text-[14px] font-medium sm:col-span-2">Sede legale</p>
        <FormField id="cl-registeredAddress.street" label="Via" :problem="problemOf('registeredAddress.street')">
          <input id="cl-registeredAddress.street" v-model="office.street" :class="input" maxlength="200" />
        </FormField>
        <FormField id="cl-registeredAddress.number" label="Civico" :problem="problemOf('registeredAddress.number')">
          <input id="cl-registeredAddress.number" v-model="office.number" :class="input" maxlength="20" />
        </FormField>
        <FormField id="cl-registeredAddress.postalCode" :label="italian ? 'CAP' : 'Codice postale'" :problem="problemOf('registeredAddress.postalCode')">
          <input id="cl-registeredAddress.postalCode" v-model="office.postalCode" :class="input" maxlength="12" :inputmode="italian ? 'numeric' : 'text'" />
        </FormField>
        <FormField id="cl-registeredAddress.city" label="Città" :problem="problemOf('registeredAddress.city')">
          <input id="cl-registeredAddress.city" v-model="office.city" :class="input" maxlength="100" />
        </FormField>
        <FormField id="cl-registeredAddress.province" :label="italian ? 'Provincia (sigla)' : 'Regione o stato'" :problem="problemOf('registeredAddress.province')">
          <input id="cl-registeredAddress.province" v-model="office.province" :class="[input, italian ? 'uppercase' : '']" :maxlength="italian ? 2 : 60" />
        </FormField>

        <template v-for="other in [{ key: 'billingAddress', text: 'Indirizzo di fatturazione diverso', on: billingOn, address: billing }, { key: 'shippingAddress', text: 'Indirizzo operativo o di spedizione', on: shippingOn, address: shipping }]" :key="other.key">
          <label class="mt-1 flex items-center gap-2.5 text-[14px] sm:col-span-2">
            <input
              type="checkbox"
              class="switch"
              :checked="other.on"
              @change="other.key === 'billingAddress' ? (billingOn = !billingOn) : (shippingOn = !shippingOn)"
            />
            {{ other.text }}
          </label>
          <template v-if="other.on">
            <FormField :id="`cl-${other.key}.street`" label="Via" :problem="problemOf(`${other.key}.street`)">
              <input :id="`cl-${other.key}.street`" v-model="other.address.street" :class="input" maxlength="200" />
            </FormField>
            <FormField :id="`cl-${other.key}.number`" label="Civico" :problem="problemOf(`${other.key}.number`)">
              <input :id="`cl-${other.key}.number`" v-model="other.address.number" :class="input" maxlength="20" />
            </FormField>
            <FormField :id="`cl-${other.key}.postalCode`" :label="other.address.country === 'IT' ? 'CAP' : 'Codice postale'" :problem="problemOf(`${other.key}.postalCode`)">
              <input :id="`cl-${other.key}.postalCode`" v-model="other.address.postalCode" :class="input" maxlength="12" />
            </FormField>
            <FormField :id="`cl-${other.key}.city`" label="Città" :problem="problemOf(`${other.key}.city`)">
              <input :id="`cl-${other.key}.city`" v-model="other.address.city" :class="input" maxlength="100" />
            </FormField>
            <FormField :id="`cl-${other.key}.province`" :label="other.address.country === 'IT' ? 'Provincia (sigla)' : 'Regione o stato'" :problem="problemOf(`${other.key}.province`)">
              <input :id="`cl-${other.key}.province`" v-model="other.address.province" :class="input" maxlength="60" />
            </FormField>
            <FormField :id="`cl-${other.key}.country`" label="Paese" :problem="problemOf(`${other.key}.country`)">
              <select :id="`cl-${other.key}.country`" v-model="other.address.country" :class="input">
                <option v-for="country in COUNTRIES" :key="country.code" :value="country.code">{{ country.name }}</option>
              </select>
            </FormField>
          </template>
        </template>
      </section>

      <!-- PAGAMENTI -->
      <section :class="sectionClass" aria-labelledby="cl-payment">
        <h3 id="cl-payment" class="hud-title sm:col-span-2">Pagamenti</h3>
        <FormField id="cl-paymentMethod" label="Metodo" :problem="problemOf('paymentMethod')">
          <select id="cl-paymentMethod" v-model="form.paymentMethod" :class="input">
            <option :value="null">Non detto</option>
            <option v-for="[value, text] in payments" :key="value" :value="value">{{ text }}</option>
          </select>
        </FormField>
        <FormField id="cl-paymentDays" label="Giorni" :problem="problemOf('paymentDays')" hint="0 = a vista; di solito 30, 60 o 90.">
          <div class="flex items-center gap-3">
            <input id="cl-paymentDays" v-model="daysText" :class="input" inputmode="numeric" placeholder="30" />
            <label class="flex shrink-0 items-center gap-2 text-[14px]"><input v-model="form.paymentEndOfMonth" type="checkbox" class="switch" />Fine mese</label>
          </div>
        </FormField>
        <FormField id="cl-currency" label="Valuta" :problem="problemOf('currency')">
          <input id="cl-currency" v-model="form.currency" :class="input" maxlength="3" class="uppercase" placeholder="EUR" />
        </FormField>
        <FormField id="cl-invoiceLanguage" label="Lingua delle fatture" :problem="problemOf('invoiceLanguage')" hint="Due lettere: it, en, de…">
          <input id="cl-invoiceLanguage" v-model="form.invoiceLanguage" :class="input" maxlength="2" placeholder="it" />
        </FormField>
        <FormField id="cl-billingEmail" label="Email per le fatture" :problem="problemOf('billingEmail')">
          <input id="cl-billingEmail" v-model="form.billingEmail" type="email" :class="input" maxlength="254" />
        </FormField>
        <FormField id="cl-purchaseOrder" label="Ordine o riferimento" :problem="problemOf('purchaseOrder')" hint="Da riportare in fattura, se il cliente lo chiede.">
          <input id="cl-purchaseOrder" v-model="form.purchaseOrder" :class="input" maxlength="500" />
        </FormField>
        <FormField id="cl-iban" label="IBAN del cliente" :problem="problemOf('iban')" hint="Facoltativo: serve per la RiBa o un addebito. Resta privato su questo computer." wide>
          <input id="cl-iban" v-model="form.iban" :class="input" maxlength="42" autocomplete="off" class="font-mono uppercase" />
        </FormField>
      </section>

      <!-- NOTE -->
      <section class="grid gap-2 rounded-xl border border-line bg-surface p-4" aria-labelledby="cl-notes-title">
        <h3 id="cl-notes-title" class="hud-title">Note</h3>
        <FormField id="cl-notes" label="Note libere" :problem="problemOf('notes')">
          <textarea id="cl-notes" v-model="form.notes" rows="5" :class="input" class="resize-y" maxlength="10000" />
        </FormField>
      </section>
    </fieldset>

    <div class="sticky bottom-0 flex flex-wrap items-center gap-2 border-t border-line bg-bg/90 py-3 backdrop-blur-sm">
      <p v-if="readOnly" class="text-[14px] text-muted">Il cliente è archiviato: ripristinalo per cambiarlo.</p>
      <template v-else>
        <button type="submit" class="btn btn-primary px-3.5 py-1.5 text-[14px]" :disabled="saving"><Icon name="saved" :size="14" />{{ client === null ? 'Crea il cliente' : 'Salva' }}</button>
        <button type="button" class="btn px-3 py-1.5 text-[14px]" :disabled="saving" @click="client === null ? emit('cancel') : load(client)">{{ client === null ? 'Annulla' : 'Annulla le modifiche' }}</button>
        <p v-if="problem" class="text-[14px] text-danger" role="alert">{{ problem }}</p>
      </template>
      <span class="ml-auto inline-flex items-center gap-1.5 text-xs text-muted"><Icon name="private" :size="13" />Privato: resta su questo computer, Claude e Codex non lo vedono</span>
    </div>
  </form>
</template>
