/**
 * The checks of a client (I-16, D-168) as the web chat makes them before
 * saving: the same rules as the core (apps/core/src/clients-format.ts),
 * repeated because the page does not import the core. A file without
 * imports: the core's test reads it too, so the two cannot drift apart
 * unseen. The messages in Italian are in clients.ts.
 */

export type ClientKind = 'company' | 'individual' | 'freelancer' | 'public_administration';
export type ClientStatus = 'active' | 'prospect' | 'archived';
export type PaymentMethod = 'bank_transfer' | 'riba' | 'card' | 'paypal' | 'cash' | 'other';
export type ClientArea = 'IT' | 'EU' | 'extra-EU';

export interface Address {
  street: string | null;
  number: string | null;
  postalCode: string | null;
  city: string | null;
  province: string | null;
  country: string;
}

/** What the user writes on a client: the same fields as the core's ClientFields. */
export interface ClientForm {
  kind: ClientKind;
  status: 'active' | 'prospect';
  displayName: string;
  legalName: string | null;
  firstName: string | null;
  lastName: string | null;
  sector: string | null;
  website: string | null;
  notes: string | null;
  tags: string[];
  country: string;
  vatNumber: string | null;
  taxCode: string | null;
  euVatNumber: string | null;
  foreignTaxId: string | null;
  vatRate: number | null;
  vatNature: string | null;
  splitPayment: boolean;
  withholdingAgent: boolean;
  sdiCode: string | null;
  pec: string | null;
  ipaCode: string | null;
  cig: string | null;
  cup: string | null;
  registeredAddress: Address | null;
  billingAddress: Address | null;
  shippingAddress: Address | null;
  billingEmail: string | null;
  paymentMethod: PaymentMethod | null;
  paymentDays: number | null;
  paymentEndOfMonth: boolean;
  currency: string;
  invoiceLanguage: string;
  purchaseOrder: string | null;
  iban: string | null;
  email: string | null;
  phone: string | null;
  mobile: string | null;
}

export type IssueCode = 'required' | 'type' | 'too-long' | 'format' | 'checksum' | 'not-allowed' | 'unknown';
export interface Issue {
  field: string;
  code: IssueCode;
}

const EU_VAT_PREFIX: Readonly<Record<string, string>> = {
  AT: 'AT', BE: 'BE', BG: 'BG', CY: 'CY', CZ: 'CZ', DE: 'DE', DK: 'DK', EE: 'EE', ES: 'ES', FI: 'FI', FR: 'FR', GR: 'EL', HR: 'HR', HU: 'HU',
  IE: 'IE', IT: 'IT', LT: 'LT', LU: 'LU', LV: 'LV', MT: 'MT', NL: 'NL', PL: 'PL', PT: 'PT', RO: 'RO', SE: 'SE', SI: 'SI', SK: 'SK',
};

const EU_VAT_FORM: Readonly<Record<string, RegExp>> = {
  AT: /^ATU\d{8}$/, BE: /^BE[01]\d{9}$/, BG: /^BG\d{9,10}$/, CY: /^CY\d{8}[A-Z]$/, CZ: /^CZ\d{8,10}$/, DE: /^DE\d{9}$/, DK: /^DK\d{8}$/,
  EE: /^EE\d{9}$/, ES: /^ES[A-Z0-9]\d{7}[A-Z0-9]$/, FI: /^FI\d{8}$/, FR: /^FR[A-HJ-NP-Z0-9]{2}\d{9}$/, GR: /^EL\d{9}$/, HR: /^HR\d{11}$/,
  HU: /^HU\d{8}$/, IE: /^IE\d[A-Z0-9+*]\d{5}[A-Z]{1,2}$/, IT: /^IT\d{11}$/, LT: /^LT(\d{9}|\d{12})$/, LU: /^LU\d{8}$/, LV: /^LV\d{11}$/,
  MT: /^MT\d{8}$/, NL: /^NL\d{9}B\d{2}$/, PL: /^PL\d{10}$/, PT: /^PT\d{9}$/, RO: /^RO\d{2,10}$/, SE: /^SE\d{12}$/, SI: /^SI\d{8}$/, SK: /^SK\d{10}$/,
};

export const VAT_NATURES = ['N1', 'N2.1', 'N2.2', 'N3.1', 'N3.2', 'N3.3', 'N3.4', 'N3.5', 'N3.6', 'N4', 'N5', 'N6.1', 'N6.2', 'N6.3', 'N6.4', 'N6.5', 'N6.6', 'N6.7', 'N6.8', 'N6.9', 'N7'] as const;

export function areaOf(country: string): ClientArea {
  if (country === 'IT') return 'IT';
  return Object.hasOwn(EU_VAT_PREFIX, country) ? 'EU' : 'extra-EU';
}

/** The prefix of the VAT numbers of a member state (EL for Greece), or undefined outside the EU. */
export function euVatPrefix(country: string): string | undefined {
  return EU_VAT_PREFIX[country];
}

function luhnItalian(digits: string): number {
  let sum = 0;
  for (let index = 0; index < 10; index += 1) {
    let digit = Number(digits[index]);
    if (index % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return (10 - (sum % 10)) % 10;
}

export function isPartitaIva(value: string): boolean {
  if (!/^\d{11}$/.test(value) || /^0{11}$/.test(value)) return false;
  return luhnItalian(value) === Number(value[10]);
}

const CF_ODD = '0100050709131517192102041820110306081214161022252423';
const CF_PERSON = /^[A-Z]{6}[0-9LMNPQRSTUV]{2}[ABCDEHLMPRST][0-9LMNPQRSTUV]{2}[A-Z][0-9LMNPQRSTUV]{3}[A-Z]$/;

/** The value of a character in an odd place (1st, 3rd…) of a codice fiscale: digits as A-J, then K-Z. */
function cfOdd(char: string): number {
  const index = /\d/.test(char) ? Number(char) : char.charCodeAt(0) - 65;
  return Number(CF_ODD.slice(index * 2, index * 2 + 2));
}

export function isCodiceFiscale(value: string): boolean {
  if (/^\d{11}$/.test(value)) return isPartitaIva(value);
  if (!CF_PERSON.test(value)) return false;
  let sum = 0;
  for (let index = 0; index < 15; index += 1) {
    const char = value[index] ?? '';
    sum += index % 2 === 0 ? cfOdd(char) : /\d/.test(char) ? Number(char) : char.charCodeAt(0) - 65;
  }
  return String.fromCharCode(65 + (sum % 26)) === value[15];
}

export function isIban(value: string): boolean {
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(value)) return false;
  if (value.startsWith('IT') && value.length !== 27) return false;
  const moved = value.slice(4) + value.slice(0, 4);
  let rest = 0;
  for (const char of moved) {
    const code = /\d/.test(char) ? char : String(char.charCodeAt(0) - 55);
    for (const digit of code) rest = (rest * 10 + Number(digit)) % 97;
  }
  return rest === 1;
}

export function isEuVatNumber(value: string, country: string): boolean {
  return EU_VAT_FORM[country]?.test(value) === true;
}

export const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
export const PHONE = /^\+?[0-9][0-9 ()./-]{3,28}$/;
const FOREIGN_POSTAL = /^[A-Za-z0-9][A-Za-z0-9 -]{1,11}$/;
const FOREIGN_TAX_ID = /^[A-Za-z0-9][A-Za-z0-9 ./-]{0,29}$/;

export const clean = (value: string | null | undefined): string => (value ?? '').replace(/\s+/g, ' ').trim();
const codeOf = (value: string | null | undefined, strip = /[\s.]/g): string => clean(value).replace(strip, '').toUpperCase();
export const tooLong = (value: string | null | undefined, max: number): boolean => Array.from(clean(value)).length > max;

/** The fields each kind and country of client has (the others are hidden and sent empty). */
export interface Shown {
  person: boolean;
  vatNumber: boolean;
  taxCode: boolean;
  euVatNumber: boolean;
  foreignTaxId: boolean;
  withholdingAgent: boolean;
  pec: boolean;
  sdiCode: boolean;
  ipaCode: boolean;
  cig: boolean;
  splitPayment: boolean;
}

export function shownFields(kind: ClientKind, country: string): Shown {
  const italian = country === 'IT';
  const area = areaOf(country);
  const pa = kind === 'public_administration' && italian;
  return {
    person: kind === 'individual' || kind === 'freelancer',
    vatNumber: italian,
    taxCode: italian,
    euVatNumber: area === 'EU',
    foreignTaxId: area === 'extra-EU',
    withholdingAgent: italian,
    pec: italian,
    // A foreign client always has XXXXXXX, a public body its IPA code: no field to write.
    sdiCode: italian && !pa,
    ipaCode: pa,
    cig: pa,
    splitPayment: italian && (kind === 'public_administration' || kind === 'company'),
  };
}

/** The form as it goes to the core: the hidden fields empty, so that a change of country or kind passes. */
export function formForSave(form: ClientForm): ClientForm {
  const shown = shownFields(form.kind, form.country);
  const out: ClientForm = { ...form, tags: [...form.tags] };
  if (!shown.person) {
    out.firstName = null;
    out.lastName = null;
  }
  if (!shown.vatNumber) out.vatNumber = null;
  if (!shown.taxCode) out.taxCode = null;
  if (!shown.euVatNumber) out.euVatNumber = null;
  if (!shown.foreignTaxId) out.foreignTaxId = null;
  if (!shown.withholdingAgent) out.withholdingAgent = false;
  if (!shown.pec) out.pec = null;
  if (!shown.sdiCode) out.sdiCode = null;
  if (!shown.ipaCode) out.ipaCode = null;
  if (!shown.cig) {
    out.cig = null;
    out.cup = null;
  }
  if (!shown.splitPayment) out.splitPayment = false;
  // The registered office is in the client's country.
  if (out.registeredAddress !== null) out.registeredAddress = { ...out.registeredAddress, country: out.country };
  for (const key of ['registeredAddress', 'billingAddress', 'shippingAddress'] as const) {
    const address = out[key];
    if (address !== null && [address.street, address.number, address.postalCode, address.city, address.province].every((part) => clean(part) === '')) out[key] = null;
  }
  return out;
}

function addressIssues(address: Address | null, field: string, add: (field: string, code: IssueCode) => void): void {
  if (address === null) return;
  const country = codeOf(address.country) || 'IT';
  if (!/^[A-Z]{2}$/.test(country)) add(`${field}.country`, 'format');
  const limits: [keyof Address, number][] = [['street', 200], ['number', 20], ['postalCode', 12], ['city', 100], ['province', 60]];
  for (const [part, max] of limits) if (tooLong(address[part], max)) add(`${field}.${part}`, 'too-long');
  const postal = clean(address.postalCode);
  const province = clean(address.province).toUpperCase();
  if (country === 'IT') {
    if (postal !== '' && !/^\d{5}$/.test(postal)) add(`${field}.postalCode`, 'format');
    if (province !== '' && !/^[A-Z]{2}$/.test(province)) add(`${field}.province`, 'format');
  } else if (postal !== '' && !FOREIGN_POSTAL.test(postal)) {
    add(`${field}.postalCode`, 'format');
  }
}

/** What the core would refuse in the form, by field: the same rules, so a message shows before saving. */
export function clientIssues(form: ClientForm): Issue[] {
  const issues: Issue[] = [];
  const add = (field: string, code: IssueCode): void => {
    if (!issues.some((issue) => issue.field === field)) issues.push({ field, code });
  };
  const country = codeOf(form.country) || 'IT';
  if (!/^[A-Z]{2}$/.test(country)) add('country', 'format');
  const shown = shownFields(form.kind, country);
  const pa = form.kind === 'public_administration';
  const italian = country === 'IT';

  const name = clean(form.displayName) || clean(form.legalName) || [clean(form.firstName), clean(form.lastName)].filter((part) => part !== '').join(' ');
  if (name === '') add('displayName', 'required');
  else if (Array.from(name).length > 200) add('displayName', 'too-long');
  if (tooLong(form.legalName, 300)) add('legalName', 'too-long');
  if (tooLong(form.firstName, 100)) add('firstName', 'too-long');
  if (tooLong(form.lastName, 100)) add('lastName', 'too-long');
  if (tooLong(form.sector, 100)) add('sector', 'too-long');
  if (Array.from((form.notes ?? '').trim()).length > 10_000) add('notes', 'too-long');
  if (form.tags.length > 20 || form.tags.some((tag) => tooLong(tag, 40))) add('tags', 'too-long');

  const website = clean(form.website);
  if (website !== '') {
    const full = /^[a-z][a-z0-9+.-]*:/i.test(website) ? website : `https://${website}`;
    try {
      const url = new URL(full);
      if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname.includes('.') || url.username !== '' || url.password !== '') add('website', 'format');
    } catch {
      add('website', 'format');
    }
    if (tooLong(website, 300)) add('website', 'too-long');
  }

  const vat = codeOf(form.vatNumber, /[\s.-]/g).replace(/^IT/, '');
  if (vat !== '') {
    if (!/^\d{11}$/.test(vat)) add('vatNumber', 'format');
    else if (!isPartitaIva(vat)) add('vatNumber', 'checksum');
  }
  const taxCode = codeOf(form.taxCode, /[\s.-]/g);
  if (taxCode !== '') {
    if (!/^\d{11}$/.test(taxCode) && !CF_PERSON.test(taxCode)) add('taxCode', 'format');
    else if (!isCodiceFiscale(taxCode)) add('taxCode', 'checksum');
  }
  const euVat = codeOf(form.euVatNumber, /[\s.-]/g);
  if (euVat !== '' && areaOf(country) === 'EU' && !isEuVatNumber(euVat, country)) add('euVatNumber', 'format');
  const foreignTaxId = clean(form.foreignTaxId);
  if (foreignTaxId !== '' && (tooLong(foreignTaxId, 30) || !FOREIGN_TAX_ID.test(foreignTaxId))) add('foreignTaxId', 'format');

  if (form.vatRate !== null) {
    if (typeof form.vatRate !== 'number' || !Number.isFinite(form.vatRate)) add('vatRate', 'type');
    else if (form.vatRate < 0 || form.vatRate > 100 || Math.round(form.vatRate * 100) !== form.vatRate * 100) add('vatRate', 'format');
  }
  const nature = codeOf(form.vatNature, /\s/g);
  if (nature !== '' && !(VAT_NATURES as readonly string[]).includes(nature)) add('vatNature', 'format');

  const sdi = codeOf(form.sdiCode);
  if (sdi !== '' && !/^[A-Z0-9]{7}$/.test(sdi)) add('sdiCode', 'format');
  const ipa = codeOf(form.ipaCode);
  if (ipa !== '' && !/^[A-Z0-9]{6}$/.test(ipa)) add('ipaCode', 'format');
  const cig = codeOf(form.cig);
  if (cig !== '' && !/^[A-Z0-9]{10}$/.test(cig)) add('cig', 'format');
  const cup = codeOf(form.cup);
  if (cup !== '' && !/^[A-Z0-9]{15}$/.test(cup)) add('cup', 'format');

  if (form.paymentDays !== null) {
    if (typeof form.paymentDays !== 'number' || !Number.isInteger(form.paymentDays)) add('paymentDays', 'type');
    else if (form.paymentDays < 0 || form.paymentDays > 365) add('paymentDays', 'format');
  }
  if (!/^[A-Z]{3}$/.test(codeOf(form.currency) || 'EUR')) add('currency', 'format');
  const language = clean(form.invoiceLanguage).toLowerCase() || 'it';
  if (language.length > 2) add('invoiceLanguage', 'too-long');
  else if (!/^[a-z]{2}$/.test(language)) add('invoiceLanguage', 'format');
  if (tooLong(form.purchaseOrder, 500)) add('purchaseOrder', 'too-long');
  const iban = codeOf(form.iban, /[\s.-]/g);
  if (iban !== '') {
    if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) add('iban', 'format');
    else if (!isIban(iban)) add('iban', 'checksum');
  }

  for (const key of ['pec', 'billingEmail', 'email'] as const) {
    const value = clean(form[key]);
    if (value !== '' && (tooLong(value, 254) || !EMAIL.test(value))) add(key, 'format');
  }
  for (const key of ['phone', 'mobile'] as const) {
    const value = clean(form[key]);
    if (value !== '' && (tooLong(value, 30) || !PHONE.test(value))) add(key, 'format');
  }

  addressIssues(form.registeredAddress, 'registeredAddress', add);
  addressIssues(form.billingAddress, 'billingAddress', add);
  addressIssues(form.shippingAddress, 'shippingAddress', add);

  // The fields of another kind or country, as the core refuses them.
  if (/^[A-Z]{2}$/.test(country)) {
    const refuse = (field: string, value: unknown, allowed: boolean): void => {
      if (!allowed && value !== null && value !== false && value !== '') add(field, 'not-allowed');
    };
    refuse('vatNumber', vat, shown.vatNumber);
    refuse('taxCode', taxCode, shown.taxCode);
    refuse('withholdingAgent', form.withholdingAgent, shown.withholdingAgent);
    refuse('pec', clean(form.pec), shown.pec);
    refuse('euVatNumber', euVat, shown.euVatNumber);
    refuse('foreignTaxId', foreignTaxId, shown.foreignTaxId);
    refuse('ipaCode', ipa, shown.ipaCode);
    refuse('cig', cig, shown.cig);
    refuse('cup', cup, shown.cig);
    refuse('splitPayment', form.splitPayment, shown.splitPayment);
    refuse('firstName', clean(form.firstName), shown.person);
    refuse('lastName', clean(form.lastName), shown.person);
    if (sdi !== '') {
      if (pa && italian) add('sdiCode', 'not-allowed');
      else if (!italian && sdi !== 'XXXXXXX') add('sdiCode', 'not-allowed');
      else if (italian && sdi === 'XXXXXXX') add('sdiCode', 'not-allowed');
    }
    if (nature !== '' && form.vatRate !== null && form.vatRate > 0) add('vatNature', 'not-allowed');
  }
  return issues;
}

