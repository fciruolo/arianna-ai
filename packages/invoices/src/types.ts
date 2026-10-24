// The invoice read from a FatturaPA file (D-310). Everything here is private
// (L2): it is the user's, and it never leaves this machine.

/** A day, `YYYY-MM-DD`. */
export type Day = string;

/** Seller (CedentePrestatore) or buyer (CessionarioCommittente). */
export interface InvoiceParty {
  /** Denominazione, or Nome and Cognome; one line, at most 200 characters. */
  name: string;
  /** IdFiscaleIVA as country and code, e.g. `IT01234567890`; null when the party has none. */
  vat: string | null;
  /** CodiceFiscale; null when absent. */
  taxCode: string | null;
}

/** One line of DettaglioLinee. */
export interface InvoiceLine {
  /** NumeroLinea. */
  number: number;
  description: string;
  /** Quantita as written (a decimal), null when absent. */
  quantity: string | null;
  /** PrezzoUnitario as written (a decimal, up to 8 places). */
  unitPrice: string;
  /** PrezzoTotale in integer cents. */
  totalCents: number;
  /** AliquotaIVA as written, e.g. `22.00`. */
  vatRate: string;
  /** Natura (N1-N7 and their subcodes) when the rate is zero; else null. */
  nature: string | null;
}

/** One row of DatiRiepilogo: the taxable amount and the VAT of a rate. */
export interface VatSummary {
  vatRate: string;
  nature: string | null;
  taxableCents: number;
  vatCents: number;
}

/** One instalment of DettaglioPagamento: what the deadlines list shows. */
export interface InvoicePayment {
  /** ModalitaPagamento, MP01-MP23 (MP05 is a bank transfer). */
  method: string;
  /** DataScadenzaPagamento; null when the invoice gives none. */
  dueOn: Day | null;
  amountCents: number;
}

export interface Invoice {
  /** The `versione` of the root: FPR12 (between private parties) or FPA12 (to a public administration). */
  format: 'FPR12' | 'FPA12';
  supplier: InvoiceParty;
  customer: InvoiceParty;
  /** TipoDocumento, TD01-TD29 (TD04 is a credit note). */
  documentType: string;
  /** Divisa, ISO 4217. */
  currency: string;
  issuedOn: Day;
  number: string;
  /** ImportoTotaleDocumento in cents; null when the invoice does not state it. */
  totalCents: number | null;
  /** Sums of DatiRiepilogo. */
  taxableCents: number;
  vatCents: number;
  lines: InvoiceLine[];
  vatSummary: VatSummary[];
  payments: InvoicePayment[];
  /** sha256 of supplier, document type, number and day: the same invoice read twice, as XML or signed, is the same. */
  fingerprint: string;
}
