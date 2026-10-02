// The first-run wizard (task 1.18, docs/INSTALLER-PORTABILITY.md): questions in
// Italian that produce the settings of config/arianna.toml. It only decides
// values: reading the file, writing it and running the doctor are the CLI's.
// It never touches the credentials of Claude Code and Codex, nor the vault.
import {
  aliasesOf,
  CLOUD_EXECUTORS,
  modelSize,
  TELEGRAM_TOKEN_REF,
  type CatalogEntry,
  type CloudExecutor,
  type ModelCatalog,
  type ModelRole,
  type Settings,
} from '@arianna/config';

/** The terminal, or scripted answers in the tests. */
export interface Prompter {
  say(text: string): void;
  /** Returns the answer as typed, trimmed; an empty answer means the default. */
  ask(question: string): Promise<string>;
}

export interface WizardContext {
  catalog: ModelCatalog;
  /** The current settings: the defaults of every answer. */
  settings: Settings;
  /** ARIANNA_HOME and the free space on its disk, shown at step 1. */
  home: string;
  freeBytes: number;
  ramBytes: number;
  /** Which official binaries are installed; only reported. */
  installed: Record<CloudExecutor, boolean>;
}

/** Roles a model can be chosen for today; embedder and voice come with later phases. */
const WIZARD_ROLES: readonly { role: ModelRole; name: string; label: string }[] = [
  { role: 'orchestrator', name: 'orchestratore', label: 'orchestratore (local-large: pianifica e decide)' },
  { role: 'extractor', name: 'estrattore', label: 'estrattore (local-small: estrae, classifica, riassume)' },
];

const EXECUTOR_LABELS: Record<CloudExecutor, { name: string; login: string }> = {
  claude: { name: 'Claude Code', login: 'apri `claude` in un terminale e usa /login' },
  codex: { name: 'Codex', login: 'lancia `codex login` in un terminale' },
};

/** Suggested port: 8000 may be taken by another container (docs/HANDOFF.md). */
const OMLX_PORT = 8001;

function gib(bytes: number): string {
  return `${(bytes / 2 ** 30).toFixed(1)} GiB`;
}

async function confirm(io: Prompter, question: string, fallback: boolean): Promise<boolean> {
  for (;;) {
    const answer = (await io.ask(`${question} ${fallback ? '[S/n]' : '[s/N]'} `)).toLowerCase();
    if (answer === '') return fallback;
    if (['s', 'si', 'sì', 'y', 'yes'].includes(answer)) return true;
    if (['n', 'no'].includes(answer)) return false;
    io.say('Rispondi s oppure n.');
  }
}

/** Index of the chosen option, or `undefined` for "none" (0). */
async function choose(io: Prompter, question: string, options: string[], fallback: number | undefined): Promise<number | undefined> {
  options.forEach((option, index) => {
    io.say(`  ${String(index + 1)}. ${option}`);
  });
  io.say('  0. nessuno');
  const shown = fallback === undefined ? '0' : String(fallback + 1);
  for (;;) {
    const answer = await io.ask(`${question} [${shown}] `);
    if (answer === '') return fallback;
    const number = Number(answer);
    if (Number.isInteger(number) && number >= 0 && number <= options.length) return number === 0 ? undefined : number - 1;
    io.say(`Scrivi un numero fra 0 e ${String(options.length)}.`);
  }
}

async function chatIds(io: Prompter, current: number[]): Promise<number[]> {
  const shown = current.length === 0 ? '' : ` [${current.join(', ')}]`;
  for (;;) {
    const answer = await io.ask(`Id delle chat private ammesse, separati da virgola${shown}: `);
    if (answer === '' && current.length > 0) return current;
    const ids = answer.split(',').map((part) => part.trim()).filter((part) => part !== '').map(Number);
    if (ids.length > 0 && ids.every((id) => Number.isSafeInteger(id) && id > 0) && new Set(ids).size === ids.length) return ids;
    io.say('Servono uno o più numeri interi positivi diversi fra loro (l\'id lo dà @userinfobot su Telegram).');
  }
}

function describe(model: CatalogEntry): string {
  const status = model.status === 'verified' ? 'verificato' : 'sperimentale';
  return `${model.id} (${model.family}, ${model.runtime}, ${gib(modelSize(model))}, almeno ${String(model.ramMinGib)} GiB di RAM, ${status})`;
}

async function stepModels(io: Prompter, context: WizardContext, settings: Settings): Promise<void> {
  io.say('\n2. Modelli locali');
  if (context.catalog.models.length === 0) {
    io.say('Il catalogo (config/models.catalog.yaml) non ha ancora modelli: i ruoli restano come sono.');
    io.say('Le voci vere arrivano dalla configurazione di oMLX sul Mac Studio; poi rilancia pnpm arianna:init --reconfigure.');
    return;
  }
  const roles = new Map(Object.entries(settings.roles) as [ModelRole, string][]);
  for (const { role, label } of WIZARD_ROLES) {
    const candidates = context.catalog.models.filter((model) => model.roles.includes(role));
    if (candidates.length === 0) continue;
    io.say(`Modello per ${label}:`);
    const current = candidates.findIndex((model) => model.id === roles.get(role));
    const verified = candidates.findIndex((model) => model.status === 'verified');
    const fallback = current >= 0 ? current : verified >= 0 ? verified : undefined;
    const picked = await choose(io, 'Scelta', candidates.map(describe), fallback);
    const entry = picked === undefined ? undefined : candidates[picked];
    if (entry === undefined) roles.delete(role);
    else roles.set(role, entry.id);
  }
  settings.roles = Object.fromEntries(roles);
  // A server that takes its names from the roles has nothing to serve without them.
  const kept = settings.endpoints.filter((endpoint) => endpoint.models !== undefined || Object.keys(aliasesOf(settings.roles)).length > 0);
  if (kept.length < settings.endpoints.length) {
    io.say('Senza modelli assegnati tolgo i server locali che prendono i nomi dai ruoli.');
    settings.endpoints = kept;
  }

  const chosen = context.catalog.models.filter((model) => Object.values(settings.roles).includes(model.id));
  const ram = chosen.reduce((sum, model) => sum + model.ramMinGib, 0);
  const machine = context.ramBytes / 2 ** 30;
  if (ram > machine) {
    io.say(`Attenzione: i modelli scelti chiedono insieme ${String(ram)} GiB di RAM, la macchina ne ha ${machine.toFixed(0)}. oMLX potrebbe non caricarli entrambi.`);
  }
  const size = chosen.reduce((sum, model) => sum + modelSize(model), 0);
  if (size > context.freeBytes) {
    io.say(`Attenzione: da scaricare ${gib(size)}, liberi ${gib(context.freeBytes)}.`);
  }
  if (chosen.length > 0 && settings.endpoints.length === 0) {
    const add = await confirm(io, `Aggiungo oMLX come server locale su 127.0.0.1:${String(OMLX_PORT)}, con i modelli in data/models?`, true);
    if (add) {
      settings.endpoints = [
        {
          id: 'omlx',
          url: `http://127.0.0.1:${String(OMLX_PORT)}/v1`,
          command: ['omlx', 'serve', '--model-dir', 'data/models', '--host', '127.0.0.1', '--port', String(OMLX_PORT)],
        },
      ];
    }
  }
}

async function stepExecutors(io: Prompter, context: WizardContext, settings: Settings): Promise<void> {
  io.say('\n3. Esecutori cloud');
  io.say('Ricevono solo dati L0 e L1 passati dal gateway e lavorano solo sui repository di cloud.allowlist.');
  io.say('Il login lo fai tu: il wizard non legge né salva credenziali.');
  const executors: CloudExecutor[] = [];
  for (const executor of CLOUD_EXECUTORS) {
    const { name, login } = EXECUTOR_LABELS[executor];
    const found = context.installed[executor] ? 'installato' : 'non installato';
    if (await confirm(io, `Abilitare ${name} (${found})?`, settings.cloud.executors.includes(executor))) {
      executors.push(executor);
      io.say(`  Login: ${login}.`);
    }
  }
  settings.cloud = { ...settings.cloud, executors };
}

function stepAutonomy(io: Prompter): void {
  io.say('\n4. Autonomia');
  io.say('Tutti gli agenti partono da A1: agiscono solo in sandbox e chiedono approvazione per ogni azione irreversibile.');
  io.say('Un agente sale di livello solo per una tua decisione, registrata in docs/DECISIONS.md (docs/AGENT-CARDS.md).');
  io.say('I tetti di passi, tempo e costo stanno nelle schede degli agenti (agents/*.yaml).');
}

function stepSync(io: Prompter): void {
  io.say('\n5. Sincronizzazione (per esempio Synology Drive)');
  io.say('Sincronizza solo data/kb, data/archive e data/vault, e solo verso il tuo NAS.');
  io.say('Mai data/postgres dal vivo (si salvano i dump), mai data/models (si riscaricano dal catalogo).');
  io.say('Mai questa cartella sotto iCloud o altri cloud di terzi senza cifratura. Dettagli in docs/INSTALLER-PORTABILITY.md.');
}

async function stepChannels(io: Prompter, settings: Settings): Promise<void> {
  io.say('\n6. Canali');
  io.say('La chat web è sempre attiva, solo su questa macchina.');
  io.say('Telegram è un canale esterno: riceve al massimo L1, il resto arriva come rimando alla chat web.');
  if (await confirm(io, 'Attivare Telegram?', settings.telegram !== undefined)) {
    const chats = await chatIds(io, settings.telegram?.chats ?? []);
    settings.telegram = { token: settings.telegram?.token ?? TELEGRAM_TOKEN_REF, chats };
    io.say(`  Il token del bot va nel vault con pnpm vault:edit, chiave ${(settings.telegram.token).replace('vault://', '')}.`);
  } else {
    delete settings.telegram;
  }
  io.say('Voce e telefono arrivano con le fasi successive.');
}

function summary(io: Prompter, settings: Settings): void {
  io.say('\n7. Riepilogo');
  const roles = WIZARD_ROLES.map(({ role, name }) => `${name} ${settings.roles[role] ?? 'nessuno'}`);
  io.say(`  Modelli: ${roles.join(', ')}`);
  io.say(`  Server locali: ${settings.endpoints.length === 0 ? 'nessuno' : settings.endpoints.map((endpoint) => `${endpoint.id} (${endpoint.url})`).join(', ')}`);
  io.say(`  Esecutori cloud: ${settings.cloud.executors.length === 0 ? 'nessuno' : settings.cloud.executors.map((executor) => EXECUTOR_LABELS[executor].name).join(', ')}`);
  io.say(`  Telegram: ${settings.telegram === undefined ? 'spento' : `chat ${settings.telegram.chats.join(', ')}`}`);
}

/** Asks every question; returns the new settings, or `undefined` if the user does not confirm. */
export async function runWizard(io: Prompter, context: WizardContext): Promise<Settings | undefined> {
  const settings: Settings = structuredClone(context.settings);
  io.say('Configurazione di Arianna. Invio accetta il valore fra parentesi quadre.');
  io.say('\n1. Cartella dei dati');
  io.say(`I dati stanno in data/ dentro ${context.home}: ${gib(context.freeBytes)} liberi su quel disco.`);
  await stepModels(io, context, settings);
  await stepExecutors(io, context, settings);
  stepAutonomy(io);
  stepSync(io);
  await stepChannels(io, settings);
  summary(io, settings);
  return (await confirm(io, 'Scrivo config/arianna.toml?', true)) ? settings : undefined;
}
