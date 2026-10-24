import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { InvoiceReadError, decodeEntities, readInvoiceXml, toCents, vatRate } from '../src/index.ts';

// The fake invoices of the development knowledge base (D-310): every name, VAT number and amount is invented.
const FOLDER = join(import.meta.dirname, '..', '..', '..', 'kb', 'private', 'finanze', 'fatture');
const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(join(FOLDER, name)));
const xml = (text: string): Uint8Array => new TextEncoder().encode(text);

function rejects(bytes: Uint8Array, code: string): void {
  assert.throws(() => readInvoiceXml(bytes), (error: unknown) => error instanceof InvoiceReadError && error.code === code);
}

/** A minimal FatturaPA with `body` as its only body, or the bodies given. */
function minimal(options: { body?: string; bodies?: number; version?: string; root?: string; supplier?: string } = {}): string {
  const root = options.root ?? 'FatturaElettronica';
  const body = options.body ?? `
    <DatiGenerali><DatiGeneraliDocumento><TipoDocumento>TD01</TipoDocumento><Divisa>EUR</Divisa><Data>2026-01-31</Data><Numero>1</Numero></DatiGeneraliDocumento></DatiGenerali>
    <DatiBeniServizi><DatiRiepilogo><AliquotaIVA>22.00</AliquotaIVA><ImponibileImporto>10.00</ImponibileImporto><Imposta>2.20</Imposta></DatiRiepilogo></DatiBeniServizi>`;
  const supplier = options.supplier ?? '<IdFiscaleIVA><IdPaese>IT</IdPaese><IdCodice>00011122233</IdCodice></IdFiscaleIVA><Anagrafica><Denominazione>Ditta Finta</Denominazione></Anagrafica>';
  return `<?xml version="1.0"?>
<x:${root} xmlns:x="urn:finto" versione="${options.version ?? 'FPR12'}">
  <FatturaElettronicaHeader>
    <CedentePrestatore><DatiAnagrafici>${supplier}</DatiAnagrafici></CedentePrestatore>
    <CessionarioCommittente><DatiAnagrafici><CodiceFiscale>FNTMRA80A01H501U</CodiceFiscale><Anagrafica><Nome>Mario</Nome><Cognome>Finto</Cognome></Anagrafica></DatiAnagrafici></CessionarioCommittente>
  </FatturaElettronicaHeader>
  ${Array.from({ length: options.bodies ?? 1 }, () => `<FatturaElettronicaBody>${body}</FatturaElettronicaBody>`).join('\n')}
</x:${root}>`;
}

describe('readInvoiceXml: the fake invoices of kb/', () => {
  it('reads an invoice with two lines and one deadline', () => {
    const [invoice, ...rest] = readInvoiceXml(fixture('IT12345678901_00001.xml'));
    assert.equal(rest.length, 0);
    assert.ok(invoice);
    assert.equal(invoice.format, 'FPR12');
    assert.deepEqual(invoice.supplier, { name: 'Elettroforniture Finte S.r.l.', vat: 'IT12345678901', taxCode: null });
    assert.deepEqual(invoice.customer, { name: 'Mario Finto', vat: null, taxCode: 'FNTMRA80A01H501U' });
    assert.equal(invoice.documentType, 'TD01');
    assert.equal(invoice.number, '2026/0042');
    assert.equal(invoice.issuedOn, '2026-10-15');
    assert.equal(invoice.currency, 'EUR');
    assert.equal(invoice.totalCents, 18300);
    assert.equal(invoice.taxableCents, 15000);
    assert.equal(invoice.vatCents, 3300);
    assert.equal(invoice.lines.length, 2);
    assert.deepEqual(invoice.lines[0], { number: 1, description: 'Lampadine LED finte, confezione da 4', quantity: '2.00', unitPrice: '25.00', totalCents: 5000, vatRate: '22.00', nature: null });
    assert.deepEqual(invoice.payments, [{ method: 'MP05', dueOn: '2026-11-30', amountCents: 18300 }]);
    assert.match(invoice.fingerprint, /^[0-9a-f]{64}$/);
  });

  it('reads entities, CDATA, a zero rate with its nature and two instalments', () => {
    const [invoice] = readInvoiceXml(fixture('IT98765432109_0A1B2.xml'));
    assert.ok(invoice);
    assert.equal(invoice.supplier.name, 'Studio Bianchi & Verdi Associati (finto)');
    assert.equal(invoice.supplier.taxCode, 'BNCLRA75B41F205Z');
    assert.equal(invoice.lines[0]?.description, 'Consulenza "finta" sul contratto d\'affitto <via Roma>');
    assert.equal(invoice.lines[1]?.nature, 'N1');
    assert.equal(invoice.lines[1].vatRate, '0.00');
    assert.equal(invoice.vatSummary.length, 2);
    assert.equal(invoice.taxableCents, 100200);
    assert.equal(invoice.vatCents, 22000);
    assert.deepEqual(invoice.payments.map((payment) => payment.dueOn), ['2026-11-15', '2026-12-15']);
  });

  it('reads a credit note written in ISO-8859-1, without deadlines', () => {
    const [invoice] = readInvoiceXml(fixture('IT12345678901_00003.xml'));
    assert.ok(invoice);
    assert.equal(invoice.documentType, 'TD04');
    assert.equal(invoice.lines[0]?.description, 'Reso: una confezione di lampadine è arrivata rotta (città finta)');
    assert.deepEqual(invoice.payments, []);
  });

  it('gives the same fingerprint to the same invoice and a different one to another', () => {
    const [first] = readInvoiceXml(fixture('IT12345678901_00001.xml'));
    const [again] = readInvoiceXml(fixture('IT12345678901_00001.xml'));
    const [other] = readInvoiceXml(fixture('IT12345678901_00003.xml'));
    assert.equal(first?.fingerprint, again?.fingerprint);
    assert.notEqual(first?.fingerprint, other?.fingerprint);
  });
});

describe('readInvoiceXml: what it accepts', () => {
  it('reads every body of a batch, with the header of the file', () => {
    const invoices = readInvoiceXml(xml(minimal({ bodies: 3 })));
    assert.equal(invoices.length, 3);
    assert.ok(invoices.every((invoice) => invoice.supplier.vat === 'IT00011122233'));
  });

  it('keeps the leading zeros of a VAT number (values stay strings)', () => {
    const [invoice] = readInvoiceXml(xml(minimal()));
    assert.equal(invoice?.supplier.vat, 'IT00011122233');
    assert.equal(invoice.totalCents, null);
  });

  it('accepts a public administration invoice (FPA12) and a byte order mark', () => {
    const bytes = xml(`${String.fromCharCode(0xfeff)}${minimal({ version: 'FPA12' })}`);
    assert.equal(readInvoiceXml(bytes)[0]?.format, 'FPA12');
  });

  it('does not parse the attachments', () => {
    const body = minimal().replace('</DatiBeniServizi>', '</DatiBeniServizi><Allegati><NomeAttachment>a.pdf</NomeAttachment><Attachment>JVBERi0=</Attachment></Allegati>');
    assert.equal(readInvoiceXml(xml(body)).length, 1);
  });
});

describe('readInvoiceXml: what it refuses', () => {
  it('refuses a DOCTYPE before parsing (no entity is ever expanded)', () => {
    const bomb = `<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;">]>${minimal().replace(/^<\?xml[^>]*>/, '')}`;
    rejects(xml(bomb), 'doctype');
    const external = `<?xml version="1.0"?><!DOCTYPE x SYSTEM "file:///etc/passwd">${minimal().replace(/^<\?xml[^>]*>/, '')}`;
    rejects(xml(external), 'doctype');
  });

  it('refuses an unknown entity and a bare ampersand', () => {
    rejects(xml(minimal().replace('Ditta Finta', 'Ditta &nbsp; Finta')), 'bad-xml');
    rejects(xml(minimal().replace('Ditta Finta', 'Ditta & Finta')), 'bad-xml');
  });

  it('refuses XML that is not well formed, and what is not XML', () => {
    rejects(xml(minimal().replace('</Numero>', '')), 'bad-xml');
    rejects(xml('Data,Importo\n2026-01-01,10'), 'not-xml');
    rejects(new Uint8Array([0x3c, 0x61, 0x3e, 0xff, 0xfe, 0x3c, 0x2f, 0x61, 0x3e]), 'not-xml');
  });

  it('refuses another root, the simplified invoice and an unknown version', () => {
    rejects(xml('<Fattura versione="FPR12"/>'), 'not-fatturapa');
    rejects(xml(minimal({ root: 'FatturaElettronicaSemplificata', version: 'FSM10' })), 'unsupported');
    rejects(xml(minimal({ version: 'FPR11' })), 'unsupported');
  });

  it('refuses missing or wrong fields, naming the field and never its value', () => {
    const noDate = minimal().replace('<Data>2026-01-31</Data>', '<Data>2026-02-30</Data>');
    assert.throws(() => readInvoiceXml(xml(noDate)), (error: unknown) => error instanceof InvoiceReadError && error.code === 'bad-field' && error.message === 'Data is missing or not valid');
    rejects(xml(minimal().replace('<TipoDocumento>TD01</TipoDocumento>', '<TipoDocumento>XX</TipoDocumento>')), 'bad-field');
    rejects(xml(minimal().replace('<ImponibileImporto>10.00</ImponibileImporto>', '<ImponibileImporto>10,00</ImponibileImporto>')), 'bad-field');
    rejects(xml(minimal({ supplier: '<Anagrafica><Denominazione>Senza partita IVA</Denominazione></Anagrafica>' })), 'bad-field');
    rejects(xml(minimal().replace(/<DatiBeniServizi>.*<\/DatiBeniServizi>/s, '<DatiBeniServizi/>')), 'bad-field');
  });

  it('refuses a file with too many bodies, lines or instalments', () => {
    rejects(xml(minimal({ bodies: 201 })), 'too-many');
    const line = '<DettaglioLinee><NumeroLinea>1</NumeroLinea><Descrizione>Riga finta</Descrizione><PrezzoUnitario>1.00</PrezzoUnitario><PrezzoTotale>1.00</PrezzoTotale><AliquotaIVA>22.00</AliquotaIVA></DettaglioLinee>';
    rejects(xml(minimal().replace('<DatiBeniServizi>', `<DatiBeniServizi>${line.repeat(5001)}`)), 'too-many');
    const instalment = '<DettaglioPagamento><ModalitaPagamento>MP05</ModalitaPagamento><ImportoPagamento>1.00</ImportoPagamento></DettaglioPagamento>';
    rejects(xml(minimal().replace('</DatiBeniServizi>', `</DatiBeniServizi><DatiPagamento><CondizioniPagamento>TP01</CondizioniPagamento>${instalment.repeat(101)}</DatiPagamento>`)), 'too-many');
    const fewer = readInvoiceXml(xml(minimal().replace('</DatiBeniServizi>', `</DatiBeniServizi><DatiPagamento>${instalment.repeat(100)}</DatiPagamento>`)));
    assert.equal(fewer[0]?.payments.length, 100);
  });

  it('refuses nesting deeper than the limit', () => {
    const deep = `${'<a>'.repeat(70)}x${'</a>'.repeat(70)}`;
    rejects(xml(minimal().replace('</DatiBeniServizi>', `</DatiBeniServizi><Altro>${deep}</Altro>`)), 'bad-xml');
  });

  it('refuses UTF-16 and an unknown encoding, and reads ISO-8859-15 with its euro sign', () => {
    rejects(new Uint8Array([0xff, 0xfe, 0x3c, 0x00]), 'not-xml');
    rejects(xml(minimal().replace('<?xml version="1.0"?>', '<?xml version="1.0" encoding="EBCDIC-IT"?>')), 'not-xml');
    const text = minimal().replace('<?xml version="1.0"?>', '<?xml version="1.0" encoding="ISO-8859-15"?>').replace('Ditta Finta', 'Ditta Finta X');
    const bytes = new Uint8Array(Buffer.from(text, 'latin1'));
    bytes[bytes.indexOf(0x58, text.indexOf('Ditta Finta X'))] = 0xa4;
    assert.equal(readInvoiceXml(bytes)[0]?.supplier.name, 'Ditta Finta €');
  });
});

describe('amounts and rates', () => {
  it('turns FatturaPA amounts into cents, rounding half away from zero', () => {
    assert.equal(toCents('183.00', 'x'), 18300);
    assert.equal(toCents('0.5', 'x'), 50);
    assert.equal(toCents('12.345', 'x'), 1235);
    assert.equal(toCents('12.34499999', 'x'), 1234);
    assert.equal(toCents('-3.005', 'x'), -301);
    assert.equal(toCents('-0.001', 'x'), 0);
    assert.throws(() => toCents('1,50', 'x'), InvoiceReadError);
    assert.throws(() => toCents('1e3', 'x'), InvoiceReadError);
    assert.throws(() => toCents('', 'x'), InvoiceReadError);
  });

  it('writes rates with two places, from 0 to 100', () => {
    assert.equal(vatRate('22', 'x'), '22.00');
    assert.equal(vatRate('4.0', 'x'), '4.00');
    assert.throws(() => vatRate('101.00', 'x'), InvoiceReadError);
    assert.throws(() => vatRate('-1', 'x'), InvoiceReadError);
  });

  it('decodes only the XML entities and character references', () => {
    assert.equal(decodeEntities('a &amp; b &lt;c&gt; &#233; &#xE8;'), 'a & b <c> é è');
    assert.throws(() => decodeEntities('&copy;'), InvoiceReadError);
    assert.throws(() => decodeEntities('&#0;'), InvoiceReadError);
  });
});
