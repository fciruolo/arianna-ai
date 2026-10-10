/**
 * The fields of a client (I-16, D-168, tappa C1), checked without the
 * database: what an Italian or a foreign invoice needs, the forms of the
 * Italian codes with their check characters (partita IVA, codice fiscale),
 * the codes of the electronic invoice (SDI, IPA), the addresses and the
 * terms of payment. Pure functions: the core writes only what passes here.
 * The web chat repeats the same rules for its inline messages
 * (apps/hud/src/lib/client-codes.ts); a test keeps the two in step.
 * No check goes on the network: a VAT number of the EU is checked for its
 * form only, never asked to VIES (that would be data leaving the machine).
 */

export const CLIENT_KINDS = ['company', 'individual', 'freelancer', 'public_administration'] as const;
export type ClientKind = (typeof CLIENT_KINDS)[number];

/** `archived` is reached only with "Archivia" (archiveClient), never written as a field. */
export const CLIENT_STATUSES = ['active', 'prospect', 'archived'] as const;
export type ClientStatus = (typeof CLIENT_STATUSES)[number];

export const PAYMENT_METHODS = ['bank_transfer', 'riba', 'card', 'paypal', 'cash', 'other'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** The natures of a line without VAT in FatturaPA (tracciato 1.2.x): N1-N7 with their sub-codes. */
export const VAT_NATURES = [
  'N1',
  'N2.1',
  'N2.2',
  'N3.1',
  'N3.2',
  'N3.3',
  'N3.4',
  'N3.5',
  'N3.6',
  'N4',
  'N5',
  'N6.1',
  'N6.2',
  'N6.3',
  'N6.4',
  'N6.5',
  'N6.6',
  'N6.7',
  'N6.8',
  'N6.9',
  'N7',
] as const;

/** The member states of the EU and the prefix of their VAT numbers (Greece writes EL). */
export const EU_VAT_PREFIX: Readonly<Record<string, string>> = {
  AT: 'AT',
  BE: 'BE',
  BG: 'BG',
  CY: 'CY',
  CZ: 'CZ',
  DE: 'DE',
  DK: 'DK',
  EE: 'EE',
  ES: 'ES',
  FI: 'FI',
  FR: 'FR',
  GR: 'EL',
  HR: 'HR',
  HU: 'HU',
  IE: 'IE',
  IT: 'IT',
  LT: 'LT',
  LU: 'LU',
  LV: 'LV',
  MT: 'MT',
  NL: 'NL',
  PL: 'PL',
  PT: 'PT',
  RO: 'RO',
  SE: 'SE',
  SI: 'SI',
  SK: 'SK',
};

/** The form of a VAT number of each member state, prefix included (format only). */
const EU_VAT_FORM: Readonly<Record<string, RegExp>> = {
  AT: /^ATU\d{8}$/,
  BE: /^BE[01]\d{9}$/,
  BG: /^BG\d{9,10}$/,
  CY: /^CY\d{8}[A-Z]$/,
  CZ: /^CZ\d{8,10}$/,
  DE: /^DE\d{9}$/,
  DK: /^DK\d{8}$/,
  EE: /^EE\d{9}$/,
  ES: /^ES[A-Z0-9]\d{7}[A-Z0-9]$/,
  FI: /^FI\d{8}$/,
  FR: /^FR[A-HJ-NP-Z0-9]{2}\d{9}$/,
  GR: /^EL\d{9}$/,
  HR: /^HR\d{11}$/,
  HU: /^HU\d{8}$/,
  IE: /^IE\d[A-Z0-9+*]\d{5}[A-Z]{1,2}$/,
  IT: /^IT\d{11}$/,
  LT: /^LT(\d{9}|\d{12})$/,
  LU: /^LU\d{8}$/,
  LV: /^LV\d{11}$/,
  MT: /^MT\d{8}$/,
  NL: /^NL\d{9}B\d{2}$/,
  PL: /^PL\d{10}$/,
  PT: /^PT\d{9}$/,
  RO: /^RO\d{2,10}$/,
  SE: /^SE\d{12}$/,
  SI: /^SI\d{8}$/,
  SK: /^SK\d{10}$/,
};

export type ClientArea = 'IT' | 'EU' | 'extra-EU';

/** Italia, another member state of the EU, or outside it (San Marino and the Vatican are outside). */
export function areaOf(country: string): ClientArea {
  if (country === 'IT') return 'IT';
  return Object.hasOwn(EU_VAT_PREFIX, country) ? 'EU' : 'extra-EU';
}

export interface Address {
  street: string | null;
  number: string | null;
  postalCode: string | null;
  city: string | null;
  /** Two letters for Italy (MI, RM…); free for other countries. */
  province: string | null;
  country: string;
}

/** Everything the user writes on a client, as the core keeps it. */
export interface ClientFields {
  kind: ClientKind;
  status: Exclude<ClientStatus, 'archived'>;
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

/** A new client before the user writes anything: Italian, a company, active. */
export const EMPTY_CLIENT: Readonly<ClientFields> = {
  kind: 'company',
  status: 'active',
  displayName: '',
  legalName: null,
  firstName: null,
  lastName: null,
  sector: null,
  website: null,
  notes: null,
  tags: [],
  country: 'IT',
  vatNumber: null,
  taxCode: null,
  euVatNumber: null,
  foreignTaxId: null,
  vatRate: null,
  vatNature: null,
  splitPayment: false,
  withholdingAgent: false,
  sdiCode: null,
  pec: null,
  ipaCode: null,
  cig: null,
  cup: null,
  registeredAddress: null,
  billingAddress: null,
  shippingAddress: null,
  billingEmail: null,
  paymentMethod: null,
  paymentDays: null,
  paymentEndOfMonth: false,
  currency: 'EUR',
  invoiceLanguage: 'it',
  purchaseOrder: null,
  iban: null,
  email: null,
  phone: null,
  mobile: null,
};

/** The fields the chat may send for a client, new or changed. */
export const CLIENT_FIELDS = Object.keys(EMPTY_CLIENT) as (keyof ClientFields)[];

export interface ContactFields {
  name: string;
  role: string | null;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  notes: string | null;
  primary: boolean;
}

export const EMPTY_CONTACT: Readonly<ContactFields> = { name: '', role: null, email: null, phone: null, mobile: null, notes: null, primary: false };
export const CONTACT_FIELDS = Object.keys(EMPTY_CONTACT) as (keyof ContactFields)[];

/**
 * What is wrong with a field: `required` missing, `type` not the right kind
 * of value, `too-long`, `format` not in its form, `checksum` the check
 * character does not match, `not-allowed` not for this kind or country of
 * client, `unknown` a field that does not exist.
 */
export type IssueCode = 'required' | 'type' | 'too-long' | 'format' | 'checksum' | 'not-allowed' | 'unknown';

export interface Issue {
  /** The field, `registeredAddress.postalCode` for a part of an address. */
  field: string;
  code: IssueCode;
}

export type Checked<T> = { ok: true; value: T } | { ok: false; issues: Issue[] };

export const MAX_TAGS = 20;
export const MAX_TAG = 40;
export const MAX_NOTES = 10_000;
export const MAX_CONTACT_NOTES = 2_000;

// ---------------------------------------------------------------------------
// Codes with a check character
// ---------------------------------------------------------------------------

/** The check digit of 10 digits, as the partita IVA and the numeric codice fiscale compute it. */
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

/** A partita IVA italiana: 11 digits, the last the check digit, not all zeros. */
export function isPartitaIva(value: string): boolean {
  if (!/^\d{11}$/.test(value) || /^0{11}$/.test(value)) return false;
  return luhnItalian(value) === Number(value[10]);
}

const CF_ODD: Readonly<Record<string, number>> = {
  '0': 1, '1': 0, '2': 5, '3': 7, '4': 9, '5': 13, '6': 15, '7': 17, '8': 19, '9': 21,
  A: 1, B: 0, C: 5, D: 7, E: 9, F: 13, G: 15, H: 17, I: 19, J: 21, K: 2, L: 4, M: 18,
  N: 20, O: 11, P: 3, Q: 6, R: 8, S: 12, T: 14, U: 16, V: 10, W: 22, X: 25, Y: 24, Z: 23,
};

/** A person's codice fiscale (16 characters, with the letters of omocodia): its form and check letter. */
const CF_PERSON = /^[A-Z]{6}[0-9LMNPQRSTUV]{2}[ABCDEHLMPRST][0-9LMNPQRSTUV]{2}[A-Z][0-9LMNPQRSTUV]{3}[A-Z]$/;

/** A codice fiscale: a person's 16 characters, or the 11 digits of a company or a body. */
export function isCodiceFiscale(value: string): boolean {
  if (/^\d{11}$/.test(value)) return isPartitaIva(value);
  if (!CF_PERSON.test(value)) return false;
  let sum = 0;
  for (let index = 0; index < 15; index += 1) {
    const char = value[index] ?? '';
    sum += index % 2 === 0 ? (CF_ODD[char] ?? 0) : /\d/.test(char) ? Number(char) : char.charCodeAt(0) - 65;
  }
  return String.fromCharCode(65 + (sum % 26)) === value[15];
}

/** An IBAN: its form and the check of ISO 13616 (mod 97). */
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

/** A VAT number of a member state, with the prefix of that state (format only, never asked to VIES). */
export function isEuVatNumber(value: string, country: string): boolean {
  return EU_VAT_FORM[country]?.test(value) === true;
}

// ---------------------------------------------------------------------------
// Simple forms
// ---------------------------------------------------------------------------

/** An e-mail or PEC address: one @, a dot in the domain, no space. */
export const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
export const PHONE = /^\+?[0-9][0-9 ()./-]{3,28}$/;
export const COUNTRY = /^[A-Z]{2}$/;
export const CURRENCY = /^[A-Z]{3}$/;
export const LANGUAGE = /^[a-z]{2}$/;
export const SDI_CODE = /^[A-Z0-9]{7}$/;
export const IPA_CODE = /^[A-Z0-9]{6}$/;
export const CIG = /^[A-Z0-9]{10}$/;
export const CUP = /^[A-Z0-9]{15}$/;
export const CAP = /^\d{5}$/;
export const PROVINCE = /^[A-Z]{2}$/;
const FOREIGN_POSTAL = /^[A-Za-z0-9][A-Za-z0-9 -]{1,11}$/;
const FOREIGN_TAX_ID = /^[A-Za-z0-9][A-Za-z0-9 ./-]{0,29}$/;

/** The SDI code of a client without one (it receives in its fiscal drawer or at its PEC). */
export const SDI_NONE = '0000000';
/** The SDI code of every foreign client. */
export const SDI_FOREIGN = 'XXXXXXX';

/** The code an invoice carries as CodiceDestinatario: the IPA code for a public body, XXXXXXX abroad, 0000000 without one. */
export function effectiveSdi(fields: Pick<ClientFields, 'kind' | 'country' | 'sdiCode' | 'ipaCode'>): string {
  if (fields.country !== 'IT') return SDI_FOREIGN;
  if (fields.kind === 'public_administration') return fields.ipaCode ?? '';
  return fields.sdiCode ?? SDI_NONE;
}

// ---------------------------------------------------------------------------
// The checks of a client
// ---------------------------------------------------------------------------

class Collector {
  readonly issues: Issue[] = [];

  add(field: string, code: IssueCode): void {
    if (!this.issues.some((issue) => issue.field === field)) this.issues.push({ field, code });
  }

  has(field: string): boolean {
    return this.issues.some((issue) => issue.field === field || issue.field.startsWith(`${field}.`));
  }
}

/** One line of text, trimmed; empty is null. Undefined when the value is not text. */
function line(value: unknown, max: number, field: string, out: Collector): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    out.add(field, 'type');
    return null;
  }
  const text = value.replace(/\s+/g, ' ').trim();
  if (text === '') return null;
  if (Array.from(text).length > max) out.add(field, 'too-long');
  return text;
}

/** Text over more lines (notes): line ends kept, trimmed; empty is null. */
function block(value: unknown, max: number, field: string, out: Collector): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    out.add(field, 'type');
    return null;
  }
  const text = value.replace(/\r\n?/g, '\n').trim();
  if (text === '') return null;
  if (Array.from(text).length > max) out.add(field, 'too-long');
  return text;
}

/** A code: spaces and dots out, upper case; empty is null. */
function code(value: unknown, field: string, out: Collector, strip = /[\s.]/g): string | null {
  const text = line(value, 60, field, out);
  return text === null ? null : text.replace(strip, '').toUpperCase();
}

function flag(value: unknown, field: string, out: Collector): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value !== 'boolean') {
    out.add(field, 'type');
    return false;
  }
  return value;
}

function email(value: unknown, field: string, out: Collector): string | null {
  const text = line(value, 254, field, out);
  if (text === null) return null;
  if (!EMAIL.test(text)) out.add(field, 'format');
  return text.toLowerCase();
}

function phone(value: unknown, field: string, out: Collector): string | null {
  const text = line(value, 30, field, out);
  if (text !== null && !PHONE.test(text)) out.add(field, 'format');
  return text;
}

/** A site: http or https, the scheme added when missing. */
function website(value: unknown, field: string, out: Collector): string | null {
  const text = line(value, 300, field, out);
  if (text === null) return null;
  const full = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
  try {
    const url = new URL(full);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname.includes('.') || url.username !== '' || url.password !== '') out.add(field, 'format');
  } catch {
    out.add(field, 'format');
  }
  return full;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string, out: Collector): T | null {
  if (value === null || value === undefined || value === '') return null;
  const found = allowed.find((item) => item === value);
  if (found === undefined) out.add(field, typeof value === 'string' ? 'format' : 'type');
  return found ?? null;
}

function tags(value: unknown, out: Collector): string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) {
    out.add('tags', 'type');
    return [];
  }
  const found: string[] = [];
  for (const item of value as unknown[]) {
    if (typeof item !== 'string') {
      out.add('tags', 'type');
      continue;
    }
    const tag = item.replace(/\s+/g, ' ').trim();
    if (tag === '') continue;
    if (Array.from(tag).length > MAX_TAG) out.add('tags', 'too-long');
    if (!found.some((other) => other.toLowerCase() === tag.toLowerCase())) found.push(tag);
  }
  if (found.length > MAX_TAGS) out.add('tags', 'too-long');
  return found;
}

const ADDRESS_FIELDS = ['street', 'number', 'postalCode', 'city', 'province', 'country'] as const;

/** An address: its parts checked by its country (CAP and province for Italy); all empty is null. */
function address(value: unknown, field: string, fallbackCountry: string, out: Collector): Address | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    out.add(field, 'type');
    return null;
  }
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) if (!(ADDRESS_FIELDS as readonly string[]).includes(key)) out.add(`${field}.${key}`, 'unknown');
  const country = code(input.country, `${field}.country`, out) ?? fallbackCountry;
  if (!COUNTRY.test(country)) out.add(`${field}.country`, 'format');
  const found: Address = {
    street: line(input.street, 200, `${field}.street`, out),
    number: line(input.number, 20, `${field}.number`, out),
    postalCode: line(input.postalCode, 12, `${field}.postalCode`, out),
    city: line(input.city, 100, `${field}.city`, out),
    province: line(input.province, 60, `${field}.province`, out),
    country,
  };
  if (country === 'IT') {
    if (found.province !== null) found.province = found.province.toUpperCase();
    if (found.postalCode !== null && !CAP.test(found.postalCode)) out.add(`${field}.postalCode`, 'format');
    if (found.province !== null && !PROVINCE.test(found.province)) out.add(`${field}.province`, 'format');
  } else if (found.postalCode !== null && !FOREIGN_POSTAL.test(found.postalCode)) {
    out.add(`${field}.postalCode`, 'format');
  }
  if (found.street === null && found.number === null && found.postalCode === null && found.city === null && found.province === null) return null;
  return found;
}

/** Fields that only some clients have: written on another, they are refused. */
function allowedHere(fields: ClientFields, out: Collector): void {
  const italian = fields.country === 'IT';
  const area = areaOf(fields.country);
  const pa = fields.kind === 'public_administration';
  const person = fields.kind === 'individual' || fields.kind === 'freelancer';
  const refuse = (field: keyof ClientFields, when: boolean): void => {
    const value = fields[field];
    if (when && value !== null && value !== false) out.add(field, 'not-allowed');
  };
  refuse('vatNumber', !italian);
  refuse('taxCode', !italian);
  refuse('withholdingAgent', !italian);
  refuse('pec', !italian);
  refuse('euVatNumber', area !== 'EU');
  refuse('foreignTaxId', area !== 'extra-EU');
  refuse('ipaCode', !pa || !italian);
  refuse('cig', !pa || !italian);
  refuse('cup', !pa || !italian);
  refuse('splitPayment', !italian || (fields.kind !== 'public_administration' && fields.kind !== 'company'));
  refuse('firstName', !person);
  refuse('lastName', !person);
  // The SDI code: a public body receives at its IPA code, a foreign client at XXXXXXX.
  if (fields.sdiCode !== null) {
    if (pa && italian) out.add('sdiCode', 'not-allowed');
    else if (!italian && fields.sdiCode !== SDI_FOREIGN) out.add('sdiCode', 'not-allowed');
    else if (italian && fields.sdiCode === SDI_FOREIGN) out.add('sdiCode', 'not-allowed');
  }
  // A line without VAT has its nature, and no rate above zero.
  if (fields.vatNature !== null && fields.vatRate !== null && fields.vatRate > 0) out.add('vatNature', 'not-allowed');
}

/**
 * A client as the chat sends it, merged over `base` (the client as it is,
 * for a change; the empty client for a new one) and checked as a whole: a
 * change of country or kind rechecks every field. Unknown fields are
 * refused. `displayName`, when empty, comes from the legal name or the
 * person's name.
 */
export function checkClient(input: Record<string, unknown>, base: Readonly<ClientFields> = EMPTY_CLIENT): Checked<ClientFields> {
  const out = new Collector();
  for (const key of Object.keys(input)) if (!(CLIENT_FIELDS as string[]).includes(key)) out.add(key, 'unknown');
  const raw = (key: keyof ClientFields): unknown => (Object.hasOwn(input, key) ? input[key] : base[key]);

  const kind = oneOf(raw('kind'), CLIENT_KINDS, 'kind', out) ?? 'company';
  const statusValue = raw('status');
  const status = statusValue === 'active' || statusValue === 'prospect' ? statusValue : 'active';
  if (statusValue !== 'active' && statusValue !== 'prospect' && statusValue !== null && statusValue !== undefined) out.add('status', statusValue === 'archived' ? 'not-allowed' : 'format');
  const country = code(raw('country'), 'country', out) ?? 'IT';
  if (!COUNTRY.test(country)) out.add('country', 'format');

  const legalName = line(raw('legalName'), 300, 'legalName', out);
  const firstName = line(raw('firstName'), 100, 'firstName', out);
  const lastName = line(raw('lastName'), 100, 'lastName', out);
  const personName = [firstName, lastName].filter((part) => part !== null).join(' ');
  const displayName = line(raw('displayName'), 200, 'displayName', out) ?? legalName ?? (personName === '' ? null : personName);
  if (displayName === null) out.add('displayName', 'required');
  else if (Array.from(displayName).length > 200) out.add('displayName', 'too-long');

  const vatNumber = code(raw('vatNumber'), 'vatNumber', out, /[\s.-]/g);
  if (vatNumber !== null) {
    const digits = vatNumber.startsWith('IT') ? vatNumber.slice(2) : vatNumber;
    if (!/^\d{11}$/.test(digits)) out.add('vatNumber', 'format');
    else if (!isPartitaIva(digits)) out.add('vatNumber', 'checksum');
  }
  const taxCode = code(raw('taxCode'), 'taxCode', out, /[\s.-]/g);
  if (taxCode !== null) {
    if (!/^\d{11}$/.test(taxCode) && !CF_PERSON.test(taxCode)) out.add('taxCode', 'format');
    else if (!isCodiceFiscale(taxCode)) out.add('taxCode', 'checksum');
  }
  const euVatNumber = code(raw('euVatNumber'), 'euVatNumber', out, /[\s.-]/g);
  if (euVatNumber !== null && areaOf(country) === 'EU' && !isEuVatNumber(euVatNumber, country)) out.add('euVatNumber', 'format');
  const foreignTaxId = line(raw('foreignTaxId'), 30, 'foreignTaxId', out);
  if (foreignTaxId !== null && !FOREIGN_TAX_ID.test(foreignTaxId)) out.add('foreignTaxId', 'format');

  let vatRate: number | null = null;
  const rateValue = raw('vatRate');
  if (rateValue !== null && rateValue !== undefined && rateValue !== '') {
    if (typeof rateValue !== 'number' || !Number.isFinite(rateValue)) out.add('vatRate', 'type');
    else if (rateValue < 0 || rateValue > 100 || Math.abs(Math.round(rateValue * 100) - rateValue * 100) > 1e-6) out.add('vatRate', 'format');
    else vatRate = rateValue;
  }
  const vatNature = oneOf(code(raw('vatNature'), 'vatNature', out, /\s/g), VAT_NATURES, 'vatNature', out);

  const sdiCode = code(raw('sdiCode'), 'sdiCode', out);
  if (sdiCode !== null && !SDI_CODE.test(sdiCode)) out.add('sdiCode', 'format');
  const ipaCode = code(raw('ipaCode'), 'ipaCode', out);
  if (ipaCode !== null && !IPA_CODE.test(ipaCode)) out.add('ipaCode', 'format');
  const cig = code(raw('cig'), 'cig', out);
  if (cig !== null && !CIG.test(cig)) out.add('cig', 'format');
  const cup = code(raw('cup'), 'cup', out);
  if (cup !== null && !CUP.test(cup)) out.add('cup', 'format');

  let paymentDays: number | null = null;
  const daysValue = raw('paymentDays');
  if (daysValue !== null && daysValue !== undefined && daysValue !== '') {
    if (typeof daysValue !== 'number' || !Number.isInteger(daysValue)) out.add('paymentDays', 'type');
    else if (daysValue < 0 || daysValue > 365) out.add('paymentDays', 'format');
    else paymentDays = daysValue;
  }
  const currency = code(raw('currency'), 'currency', out) ?? 'EUR';
  if (!CURRENCY.test(currency)) out.add('currency', 'format');
  const languageText = line(raw('invoiceLanguage'), 2, 'invoiceLanguage', out);
  const invoiceLanguage = languageText === null ? 'it' : languageText.toLowerCase();
  if (!LANGUAGE.test(invoiceLanguage)) out.add('invoiceLanguage', 'format');
  const iban = code(raw('iban'), 'iban', out, /[\s.-]/g);
  if (iban !== null) {
    if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) out.add('iban', 'format');
    else if (!isIban(iban)) out.add('iban', 'checksum');
  }

  const fields: ClientFields = {
    kind,
    status,
    displayName: displayName ?? '',
    legalName,
    firstName,
    lastName,
    sector: line(raw('sector'), 100, 'sector', out),
    website: website(raw('website'), 'website', out),
    notes: block(raw('notes'), MAX_NOTES, 'notes', out),
    tags: tags(raw('tags'), out),
    country,
    vatNumber: vatNumber?.startsWith('IT') === true ? vatNumber.slice(2) : vatNumber,
    taxCode,
    euVatNumber,
    foreignTaxId,
    vatRate,
    vatNature,
    splitPayment: flag(raw('splitPayment'), 'splitPayment', out),
    withholdingAgent: flag(raw('withholdingAgent'), 'withholdingAgent', out),
    sdiCode,
    pec: email(raw('pec'), 'pec', out),
    ipaCode,
    cig,
    cup,
    registeredAddress: address(raw('registeredAddress'), 'registeredAddress', country, out),
    billingAddress: address(raw('billingAddress'), 'billingAddress', country, out),
    shippingAddress: address(raw('shippingAddress'), 'shippingAddress', country, out),
    billingEmail: email(raw('billingEmail'), 'billingEmail', out),
    paymentMethod: oneOf(raw('paymentMethod'), PAYMENT_METHODS, 'paymentMethod', out),
    paymentDays,
    paymentEndOfMonth: flag(raw('paymentEndOfMonth'), 'paymentEndOfMonth', out),
    currency,
    invoiceLanguage,
    purchaseOrder: line(raw('purchaseOrder'), 500, 'purchaseOrder', out),
    iban,
    email: email(raw('email'), 'email', out),
    phone: phone(raw('phone'), 'phone', out),
    mobile: phone(raw('mobile'), 'mobile', out),
  };
  if (!out.has('country') && !out.has('kind')) allowedHere(fields, out);
  return out.issues.length === 0 ? { ok: true, value: fields } : { ok: false, issues: out.issues };
}

/** A contact as the chat sends it, merged over `base` (the contact as it is, for a change). */
export function checkContact(input: Record<string, unknown>, base: Readonly<ContactFields> = EMPTY_CONTACT): Checked<ContactFields> {
  const out = new Collector();
  for (const key of Object.keys(input)) if (!(CONTACT_FIELDS as string[]).includes(key)) out.add(key, 'unknown');
  const raw = (key: keyof ContactFields): unknown => (Object.hasOwn(input, key) ? input[key] : base[key]);
  const name = line(raw('name'), 200, 'name', out);
  if (name === null) out.add('name', 'required');
  const value: ContactFields = {
    name: name ?? '',
    role: line(raw('role'), 100, 'role', out),
    email: email(raw('email'), 'email', out),
    phone: phone(raw('phone'), 'phone', out),
    mobile: phone(raw('mobile'), 'mobile', out),
    notes: block(raw('notes'), MAX_CONTACT_NOTES, 'notes', out),
    primary: flag(raw('primary'), 'primary', out),
  };
  return out.issues.length === 0 ? { ok: true, value } : { ok: false, issues: out.issues };
}

/** The fields that changed between two versions of a client: names only, what the event carries. */
export function changedFields(before: Readonly<ClientFields>, after: Readonly<ClientFields>): (keyof ClientFields)[] {
  return CLIENT_FIELDS.filter((key) => stable(before[key]) !== stable(after[key]));
}

/** A value as text with the keys of its objects in order: an address read back from jsonb has them sorted. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  }
  return value === undefined ? 'undefined' : JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// The logo
// ---------------------------------------------------------------------------

export const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type LogoType = (typeof LOGO_TYPES)[number];
/** Largest logo: 1 MB. */
export const MAX_LOGO_BYTES = 1024 * 1024;

export const LOGO_EXTENSION: Readonly<Record<LogoType, string>> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

/** The type of an image by its first bytes: PNG, JPEG or WebP; anything else (SVG included) is undefined. */
export function logoTypeOf(bytes: Uint8Array): LogoType | undefined {
  const starts = (prefix: readonly number[], at = 0): boolean => prefix.every((byte, index) => bytes[at + index] === byte);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (bytes.length >= 12 && starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  return undefined;
}
