// A tiny zip and .xlsx writer for the tests: fake workbooks are built in the
// test itself instead of committing binary files.
import { deflateRawSync } from 'node:zlib';

import { crc32 } from '../../src/zip.ts';

export interface ZipInput {
  name: string;
  data: Uint8Array | string;
  /** 8 (deflate, default) or 0 (stored). */
  method?: 0 | 8;
  /** Extra general purpose flags, e.g. 0x1 for "encrypted". */
  flags?: number;
  /** Lie about the uncompressed size in the headers. */
  declaredSize?: number;
}

export function zip(entries: readonly ZipInput[]): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const data = typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf8') : Buffer.from(entry.data);
    const method = entry.method ?? 8;
    const body = method === 8 ? deflateRawSync(data) : data;
    const name = Buffer.from(entry.name, 'utf8');
    const crc = crc32(data);
    const size = entry.declaredSize ?? data.length;
    const flags = (entry.flags ?? 0) | 0x800;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, end]));
}

/** A string cell, a number cell, or an Excel serial day shown with a date style. */
export type FakeCell = string | number | { serial: number } | null;

export interface FakeWorkbook {
  sheets: { name: string; rows: FakeCell[][] }[];
  date1904?: boolean;
  /** Write strings inline (`t="inlineStr"`) instead of in the shared strings. */
  inline?: boolean;
  /** Style dates with a custom `dd/mm/yyyy` format (id 164) instead of built-in 14. */
  customDateFormat?: boolean;
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function columnName(index: number): string {
  let name = '';
  let n = index + 1;
  while (n > 0) {
    const rest = (n - 1) % 26;
    name = String.fromCharCode(65 + rest) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

/** The parts of a minimal workbook, to be zipped as they are or altered first. */
export function xlsxParts(workbook: FakeWorkbook): ZipInput[] {
  const shared: string[] = [];
  const sharedIndex = new Map<string, number>();
  const sheetParts: ZipInput[] = workbook.sheets.map((sheet, sheetIndex) => {
    const rows = sheet.rows
      .map((row, rowIndex) => {
        const cells = row
          .map((cell, columnIndex) => {
            const ref = `${columnName(columnIndex)}${String(rowIndex + 1)}`;
            if (cell === null) return '';
            if (typeof cell === 'number') return `<c r="${ref}"><v>${String(cell)}</v></c>`;
            if (typeof cell === 'object') return `<c r="${ref}" s="1"><v>${String(cell.serial)}</v></c>`;
            if (workbook.inline === true) return `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(cell)}</t></is></c>`;
            let index = sharedIndex.get(cell);
            if (index === undefined) {
              index = shared.length;
              shared.push(cell);
              sharedIndex.set(cell, index);
            }
            return `<c r="${ref}" t="s"><v>${String(index)}</v></c>`;
          })
          .join('');
        return `<row r="${String(rowIndex + 1)}">${cells}</row>`;
      })
      .join('');
    return {
      name: `xl/worksheets/sheet${String(sheetIndex + 1)}.xml`,
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`,
    };
  });
  const sheetsXml = workbook.sheets
    .map((sheet, index) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${String(index + 1)}" r:id="rId${String(index + 1)}"/>`)
    .join('');
  const relsXml = workbook.sheets
    .map((_sheet, index) => `<Relationship Id="rId${String(index + 1)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${String(index + 1)}.xml"/>`)
    .join('');
  const dateFormat = workbook.customDateFormat === true ? 164 : 14;
  const numFmts = workbook.customDateFormat === true ? '<numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy;@"/></numFmts>' : '';
  return [
    { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' },
    {
      name: 'xl/workbook.xml',
      data: `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr${workbook.date1904 === true ? ' date1904="1"' : ''}/><sheets>${sheetsXml}</sheets></workbook>`,
    },
    { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relsXml}</Relationships>` },
    {
      name: 'xl/styles.xml',
      data: `<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${numFmts}<cellStyleXfs count="1"><xf numFmtId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="${String(dateFormat)}" applyNumberFormat="1"/></cellXfs></styleSheet>`,
    },
    {
      name: 'xl/sharedStrings.xml',
      data: `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${shared.map((text) => `<si><t xml:space="preserve">${escapeXml(text)}</t></si>`).join('')}</sst>`,
    },
    ...sheetParts,
  ];
}

export function xlsx(workbook: FakeWorkbook): Uint8Array {
  return zip(xlsxParts(workbook));
}
