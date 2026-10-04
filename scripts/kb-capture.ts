// Capture into kb/inbox from a terminal (D-080), without the core:
//   pnpm kb:capture "testo"                     a thought
//   pnpm kb:capture --kind link --url https://... "testo"
//   echo "testo" | pnpm kb:capture              the text from stdin
// The note is L2, like every capture; only its path and label are printed.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { loadLabelRules, resolveHome } from '@arianna/config';

import { CaptureError, captureNote, isCaptureKind, MAX_CAPTURE_BYTES, type CaptureErrorCode } from '../apps/core/src/capture.ts';

/** The refusals of captureNote, in Italian like the rest of what the user reads. */
const ITALIAN: Record<string, string> = {
  'text is empty': 'il testo è vuoto',
  'text holds a NUL character': 'il testo contiene un carattere non valido',
  'url must be http or https': 'il link deve essere un indirizzo http o https',
  'url must be a single http(s) address': 'il link deve essere un indirizzo http o https',
  'a link needs an url': 'un link richiede --url',
  'title must be one line of at most 200 characters': 'il titolo deve stare su una riga di al massimo 200 caratteri',
  'there is no kb/ folder': 'manca la cartella kb/',
  'kb/inbox is not a folder': 'kb/inbox non è una cartella vera',
};
const CODES: Record<CaptureErrorCode, string> = {
  invalid: 'dati non validi',
  'too-large': `il testo supera ${String(MAX_CAPTURE_BYTES / 1024)} KiB`,
  'not-allowed': 'kb/inbox ha un’etichetta sopra L2 in config/labels.toml',
  unavailable: 'non riesco a creare la nota in kb/inbox',
};

const USAGE = 'Usage: pnpm kb:capture [--kind thought|link|note] [--url https://...] [--title "..."] ["testo" | < file]';

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: { kind: { type: 'string' }, url: { type: 'string' }, title: { type: 'string' }, help: { type: 'boolean' } },
  });
} catch (error) {
  console.error(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
  process.exit(2);
}
const { values, positionals } = parsed;
if (values.help === true) {
  console.log(USAGE);
  process.exit(0);
}
const kind = values.kind ?? (values.url === undefined ? 'thought' : 'link');
if (!isCaptureKind(kind)) {
  console.error(`--kind must be thought, link or note\n${USAGE}`);
  process.exit(2);
}

let text = positionals.join(' ');
if (text === '' && !process.stdin.isTTY) {
  // One byte past the limit is enough for captureNote to refuse it.
  text = readFileSync(0, 'utf8').slice(0, MAX_CAPTURE_BYTES + 1);
}
if (text.trim() === '' && values.url !== undefined) text = values.url;
if (text.trim() === '') {
  console.error(`no text\n${USAGE}`);
  process.exit(2);
}

try {
  const note = captureNote({
    home: resolveHome(),
    rules: loadLabelRules(),
    text,
    kind,
    source: { channel: 'cli', id: randomUUID() },
    ...(values.url === undefined ? {} : { url: values.url }),
    ...(values.title === undefined ? {} : { title: values.title }),
  });
  console.log(`Nota salvata in ${note.path} (${note.label})`);
} catch (error) {
  if (!(error instanceof CaptureError)) throw error;
  console.error(`Nota non salvata: ${ITALIAN[error.message] ?? CODES[error.code]}`);
  process.exitCode = 1;
}
