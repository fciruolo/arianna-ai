// Descriptions of bank movements made comparable (D-183, F2). Italian bank
// statements wrap the merchant in boilerplate that changes at every row:
// "PAGAMENTO POS SUPERMERCATO ALFA MILANO CARTA ****1234 DEL 03/10 ORE 18:42".
// `normalizeDescription` keeps the words and drops what changes (dates, times,
// masked cards, references, amounts); `merchantKey` also drops the boilerplate
// words, so the same shop gives the same key in different months.

/** Masked card numbers: `****1234`, `XXXX1234`, `5300********1234`. */
const MASKED_CARD = /\b\d{0,6}[*x]{3,}\d{2,4}\b|[*x]{3,}\d{2,4}\b/g;
/** Dates: `03/10`, `03/10/2025`, `3.10.25`, `03-10-2025`, `2025-10-03`. */
const DATE = /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[/.-]\d{1,2}(?:[/.-]\d{2,4})?\b/g;
/** Times: `18:42`, `18.42.10`, with an optional `h`. */
const TIME = /\b\d{1,2}[:.]\d{2}(?:[:.]\d{2})?h?\b/g;
/** Amounts written in the description: `12,50`, `1.234,50`. */
const AMOUNT = /\b\d{1,3}(?:\.\d{3})*,\d{2}\b/g;
/** Any token carrying three or more digits: references, card numbers, CRO, TRN, mandates. */
const DIGIT_HEAVY = /^(?:.*\d){3,}.*$/;

/**
 * The description for comparison: lower case, without accents, without dates,
 * times, masked cards, amounts and tokens with three or more digits, with only
 * letters, digits and single spaces.
 */
export function normalizeDescription(description: string): string {
  const text = description
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(MASKED_CARD, ' ')
    .replace(AMOUNT, ' ')
    .replace(DATE, ' ')
    .replace(TIME, ' ');
  return text
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((token) => token !== '' && !DIGIT_HEAVY.test(token))
    .join(' ');
}

/**
 * Words of Italian bank statements that describe the operation, not the
 * counterpart: they never identify a merchant.
 */
const BOILERPLATE = new Set([
  // operation
  'pagamento', 'pagam', 'pag', 'pos', 'acquisto', 'acq', 'addebito', 'addeb', 'accredito', 'sdd', 'sepa', 'direct', 'debit', 'core', 'b2b',
  'bonifico', 'bonif', 'bon', 'istantaneo', 'sct', 'disposizione', 'disp', 'ordinante', 'beneficiario', 'favore', 'operazione', 'op',
  'domiciliazione', 'utenza', 'rata', 'commissione', 'commissioni', 'canone',
  // card and channel
  'carta', 'card', 'debito', 'credito', 'prepagata', 'bancomat', 'pagobancomat', 'visa', 'mastercard', 'maestro', 'vpay', 'amex',
  'contactless', 'nfc', 'apple', 'google', 'pay', 'online', 'internet', 'ecommerce', 'web',
  // references and time
  'del', 'ore', 'data', 'rif', 'ref', 'cro', 'trn', 'id', 'mandato', 'mand', 'debitore', 'creditore', 'causale', 'num', 'nr', 'n',
  'presso', 'c', 'o', 'eur', 'euro', 'importo',
  // short Italian words
  'a', 'ad', 'al', 'alla', 'da', 'dal', 'di', 'della', 'dello', 'dei', 'e', 'in', 'per', 'il', 'lo', 'la', 'le', 'su',
]);

/**
 * A stable key for the counterpart of a movement: the normalized description
 * without boilerplate words and without numbers. Two rows of the same shop in
 * different months have the same key. Falls back to the normalized
 * description when nothing is left (a row made only of boilerplate).
 */
export function merchantKey(description: string): string {
  const normalized = normalizeDescription(description);
  const key = normalized
    .split(' ')
    .filter((token) => token !== '' && !BOILERPLATE.has(token) && !/^\d+$/.test(token))
    .join(' ');
  return key === '' ? normalized : key;
}
