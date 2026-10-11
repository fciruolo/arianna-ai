// The expense tracker (D-183): import of bank statements and analysis, pure.
export type { Budget, CategorizedTransaction, Category, CategoryRule, Day, Transaction } from './types.ts';

export { DEFAULT_LIMITS, FinanceImportError, cellText, isBlank, isDateCell } from './table.ts';
export type { Cell, DateCell, ImportErrorCode, ReadLimits, SheetRow } from './table.ts';
export { decodeText, guessSeparator, readCsv } from './csv.ts';
export type { CsvEncoding, CsvReadOptions, CsvSeparator, CsvTable } from './csv.ts';
export { excelSerialToDay, isDateFormatCode, isOleFile, isZipFile, readXlsx } from './xlsx.ts';
export type { XlsxReadOptions, XlsxTable } from './xlsx.ts';
export { DATE_FORMATS, columnOf, findHeader, guessProfile, normalizeHeader, parseAmount, parseDate } from './profiles.ts';
export type { AmountColumns, BankProfile, DateFormat, DecimalMark } from './profiles.ts';
// The fingerprint's own normalization, apart from the analysis's normalizeDescription.
export { OccurrenceCounter, fingerprint, normalizeDescription as fingerprintDescription } from './fingerprint.ts';
export { detectKind, isNewestFirst, previewImport } from './import.ts';
export type { FileKind, ImportPreview, PreviewOptions, PreviewRow, RejectReason } from './import.ts';

export * from './analysis/index.ts';
