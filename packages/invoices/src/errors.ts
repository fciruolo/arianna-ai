export type InvoiceErrorCode =
  /** Larger than MAX_INVOICE_BYTES. */
  | 'too-large'
  /** Not text in a known encoding, or not XML at all. */
  | 'not-xml'
  /** A DOCTYPE or an entity declaration: never in a FatturaPA file, refused before parsing. */
  | 'doctype'
  /** XML that is not well formed. */
  | 'bad-xml'
  /** Well formed, but not a FatturaElettronica. */
  | 'not-fatturapa'
  /** A FatturaPA the reader does not handle: the simplified invoice (FSM10) or an unknown version. */
  | 'unsupported'
  /** A required field is missing or wrong (the message names it, never its value). */
  | 'bad-field'
  /** More bodies, lines or instalments than the limits. */
  | 'too-many'
  /** A signed file (.p7m) whose content could not be taken out. */
  | 'bad-signature';

/** Why a file could not be read. The message names fields, never their values. */
export class InvoiceReadError extends Error {
  override name = 'InvoiceReadError';
  readonly code: InvoiceErrorCode;

  constructor(code: InvoiceErrorCode, message: string = code) {
    super(message);
    this.code = code;
  }
}
