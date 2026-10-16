// The refusals of `parseProjects` (D-058) in plain Italian, with what to do
// (D-228): the wizard and the CLI print them, the chat has the same table in
// apps/hud/src/lib/settings.ts (a test keeps the two equal). The messages of
// the code stay in English; only what the user reads is translated.

const RULES: [RegExp, (match: RegExpExecArray) => string][] = [
  [/^your whole home cannot be a project/, () => 'La tua cartella utente intera non può essere un progetto: scegli una cartella dentro, per esempio ~/Sites/negozio.'],
  [/^an absolute path is not accepted, write (\S.*)$/, (match) => `Scrivi la cartella come ${match[1] ?? ''}: con ~/ vale anche su un altro Mac, dove la tua cartella utente ha un altro nome.`],
  [
    /^a project must be under your home/,
    () => 'Un progetto deve stare nella tua cartella utente (~/…) o dentro Arianna (repos/<nome>): una cartella altrove sul disco non si può aggiungere. Spostala nella tua cartella utente e riprova.',
  ],
  [/^write ~\/<folder> for a folder under your home/, () => 'Scrivi la cartella come ~/… se sta nella tua cartella utente (per esempio ~/Sites/negozio), oppure repos/<nome> se sta dentro Arianna.'],
  [/^every folder of the path must be a plain name/, () => 'Ogni cartella del percorso deve avere un nome semplice: niente cartelle nascoste (col punto davanti), niente . o .., niente barre doppie.'],
  [/^Library holds the settings/, () => 'Library contiene le impostazioni e i dati di tutte le app: non può essere un progetto.'],
  [/^must not be ARIANNA_HOME/, () => 'La cartella non può essere quella di Arianna, né stare dentro o contenerla: per una cartella dentro Arianna scrivi repos/<nome>.'],
  [/^a folder inside Arianna must be (\S+)$/, (match) => `Una cartella dentro Arianna si scrive repos/ seguito dal nome del progetto: qui ${match[1] ?? ''}.`],
  [/^lowercase letters, digits and dashes/, () => 'Il nome del progetto usa solo lettere minuscole, cifre e trattini, e comincia con una lettera o una cifra (per esempio negozio-finto).'],
  [/^a project goes to the cloud, so it is L0 or L1/, () => 'Un progetto va a Claude o Codex: la riservatezza è Pubblico o Interno. Le cartelle private restano fuori dalla lista.'],
  [/^(\S+) is listed twice$/, (match) => `Il progetto ${match[1] ?? ''} compare due volte.`],
  [/^(\S+) and (\S+) are the same folder or one inside the other$/, (match) => `I progetti ${match[1] ?? ''} e ${match[2] ?? ''} sono la stessa cartella, o uno sta dentro l’altro.`],
  [/^the home folder \(HOME\) must be/, () => 'La cartella utente di questo computer (HOME) non è valida: dev’essere un percorso completo diverso da /.'],
];

/**
 * A refusal of the project list in Italian, or `undefined` when the message
 * is not one of them. The `project[0].path: ` part is left out: the user
 * reads which project from where they typed it.
 */
export function projectProblemText(message: string): string | undefined {
  const where = /^project(?:\[\d+\](?:\.[a-z]+)?)?: (.*)$/s.exec(message);
  if (where?.[1] === undefined) return undefined;
  for (const [pattern, text] of RULES) {
    const match = pattern.exec(where[1]);
    if (match !== null) return text(match);
  }
  return undefined;
}
