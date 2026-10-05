// The first-run wizard (task 1.18, docs/INSTALLER-PORTABILITY.md): questions in
// Italian that produce the settings of config/arianna.toml. It only decides
// values: reading the file, writing it and running the doctor are the CLI's.
// It never touches the credentials of Claude Code and Codex, nor the vault.
import {
  aliasesOf,
  CLOUD_EXECUTORS,
  ConfigError,
  modelSize,
  parseProjects,
  PROJECT_NAME,
  PROJECTS_DIR,
  TELEGRAM_TOKEN_REF,
  type CatalogEntry,
  type CloudExecutor,
  type ModelCatalog,
  type ModelRole,
  type ProjectSettings,
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
  /** Where the `~/` of a project path points. */
  userHome: string;
  /** What is wrong with a project folder on disk (`folderProblem`), or `undefined`. */
  checkFolder: (absolute: string, name: string) => string | undefined;
  /**
   * Whether step 7 asks about Telegram. Off by default: the channel is off by
   * the user's choice (D-110, question 12; the phone is task 1.19), and the
   * wizard keeps the section as it is. The code stays, ready to turn back on.
   */
  telegram?: boolean;
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
const OMLX_PORT = 7001;
/** oMLX's prefix cache: in data/, at most 10 GB (D-075). */
const OMLX_CACHE = ['--paged-ssd-cache-dir', 'data/omlx-cache', '--paged-ssd-cache-max-size', '10GB'];

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
          // The prefix cache in data/, bounded (D-075): without the flag oMLX uses its own settings, outside ARIANNA_HOME.
          command: ['omlx', 'serve', '--model-dir', 'data/models', '--host', '127.0.0.1', '--port', String(OMLX_PORT), ...OMLX_CACHE],
        },
      ];
    }
  }
}

async function stepExecutors(io: Prompter, context: WizardContext, settings: Settings): Promise<void> {
  io.say('\n3. Esecutori cloud');
  io.say('Ricevono solo dati L0 e L1 passati dal gateway e lavorano solo nelle cartelle dei progetti approvati (passo 4).');
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

/** A name for the link from the last folder of the path: lowercase, dashes, nothing else. */
function suggestName(path: string): string {
  const last = path.split('/').filter((part) => part !== '' && part !== '~').at(-1) ?? '';
  const name = last
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
  return PROJECT_NAME.test(name) ? name : '';
}

/** Validates the list as the configuration will; the error in plain words, or `undefined`. */
function listProblem(context: WizardContext, projects: ProjectSettings[]): string | undefined {
  try {
    parseProjects(projects, context.home, context.userHome);
    return undefined;
  } catch (error) {
    if (error instanceof ConfigError) return error.message;
    throw error;
  }
}

async function addProject(io: Prompter, context: WizardContext, projects: ProjectSettings[]): Promise<ProjectSettings | undefined> {
  const path = await io.ask(`Cartella (~/... sotto la tua home, oppure ${PROJECTS_DIR}/<nome> dentro Arianna): `);
  if (path === '') return undefined;
  const suggested = path.startsWith(`${PROJECTS_DIR}/`) ? path.slice(PROJECTS_DIR.length + 1) : suggestName(path);
  const name = (await io.ask(`Nome (minuscole, cifre, trattini)${suggested === '' ? '' : ` [${suggested}]`}: `)) || suggested;
  let label: 'L0' | 'L1' | undefined;
  while (label === undefined) {
    const answer = (await io.ask('Etichetta: L1 lavoro, L0 pubblico [L1]: ')).toUpperCase();
    if (answer === '' || answer === 'L1') label = 'L1';
    else if (answer === 'L0') label = 'L0';
    else io.say('Scrivi L0 oppure L1: una cartella privata (L2) non va fra i progetti.');
  }
  const project: ProjectSettings = { name, path, label };
  const problem = listProblem(context, [...projects, project]);
  if (problem !== undefined) {
    io.say(`Non lo aggiungo: ${problem}`);
    return undefined;
  }
  const [resolved] = parseProjects([project], context.home, context.userHome);
  const folder = resolved === undefined ? 'cartella non valida' : context.checkFolder(resolved.absolute, resolved.name);
  if (folder !== undefined) {
    io.say(`Non lo aggiungo: ${folder}.`);
    return undefined;
  }
  if (!path.startsWith(`${PROJECTS_DIR}/`)) io.say(`  Dopo la scrittura creo il link ${PROJECTS_DIR}/${name} verso la cartella.`);
  return project;
}

async function stepProjects(io: Prompter, context: WizardContext, settings: Settings): Promise<void> {
  io.say('\n4. Progetti');
  io.say('Il Coder (Claude Code) lavora solo nelle cartelle che approvi qui, come faresti tu con la CLI: legge e modifica');
  io.say('tutta la cartella e niente fuori. Ciò che contiene va al cloud con l\'etichetta che scegli (L0 o L1).');
  io.say('Mai la home intera, cartelle nascoste, Library o cartelle con dati privati. Deve essere un repository git.');
  const projects: ProjectSettings[] = [];
  for (const project of settings.projects) {
    if (await confirm(io, `Tenere ${project.name} (${project.path}, ${project.label})?`, true)) projects.push(project);
  }
  while (await confirm(io, 'Aggiungere un progetto?', false)) {
    const added = await addProject(io, context, projects);
    if (added !== undefined) projects.push(added);
  }
  settings.projects = projects;
}

function stepAutonomy(io: Prompter): void {
  io.say('\n5. Autonomia');
  io.say('Tutti gli agenti partono da A1: agiscono solo in sandbox e chiedono approvazione per ogni azione irreversibile.');
  io.say('Un agente sale di livello solo per una tua decisione, registrata in docs/DECISIONS.md (docs/AGENT-CARDS.md).');
  io.say('I tetti di passi, tempo e costo stanno nelle schede degli agenti (agents/*.yaml).');
}

function stepSync(io: Prompter): void {
  io.say('\n6. Sincronizzazione (per esempio Synology Drive)');
  io.say('Sincronizza solo data/kb, data/archive e data/vault, e solo verso il tuo NAS.');
  io.say('Mai data/postgres dal vivo (si salvano i dump), mai data/models (si riscaricano dal catalogo).');
  io.say('Mai questa cartella sotto iCloud o altri cloud di terzi senza cifratura. Dettagli in docs/INSTALLER-PORTABILITY.md.');
}

async function stepChannels(io: Prompter, settings: Settings, telegram: boolean): Promise<void> {
  io.say('\n7. Canali');
  io.say('La chat web è sempre attiva, solo su questa macchina.');
  if (!telegram) {
    io.say('Voce e telefono arrivano con le fasi successive.');
    return;
  }
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

function summary(io: Prompter, settings: Settings, telegram: boolean): void {
  io.say('\n8. Riepilogo');
  const roles = WIZARD_ROLES.map(({ role, name }) => `${name} ${settings.roles[role] ?? 'nessuno'}`);
  io.say(`  Modelli: ${roles.join(', ')}`);
  io.say(`  Server locali: ${settings.endpoints.length === 0 ? 'nessuno' : settings.endpoints.map((endpoint) => `${endpoint.id} (${endpoint.url})`).join(', ')}`);
  io.say(`  Esecutori cloud: ${settings.cloud.executors.length === 0 ? 'nessuno' : settings.cloud.executors.map((executor) => EXECUTOR_LABELS[executor].name).join(', ')}`);
  io.say(`  Progetti: ${settings.projects.length === 0 ? 'nessuno' : settings.projects.map((project) => `${project.name} (${project.path}, ${project.label})`).join(', ')}`);
  if (telegram) io.say(`  Telegram: ${settings.telegram === undefined ? 'spento' : `chat ${settings.telegram.chats.join(', ')}`}`);
}

/** Asks every question; returns the new settings, or `undefined` if the user does not confirm. */
export async function runWizard(io: Prompter, context: WizardContext): Promise<Settings | undefined> {
  const settings: Settings = structuredClone(context.settings);
  io.say('Configurazione di Arianna. Invio accetta il valore fra parentesi quadre.');
  io.say('\n1. Cartella dei dati');
  io.say(`I dati stanno in data/ dentro ${context.home}: ${gib(context.freeBytes)} liberi su quel disco.`);
  await stepModels(io, context, settings);
  await stepExecutors(io, context, settings);
  await stepProjects(io, context, settings);
  stepAutonomy(io);
  stepSync(io);
  await stepChannels(io, settings, context.telegram === true);
  summary(io, settings, context.telegram === true);
  return (await confirm(io, 'Scrivo config/arianna.toml?', true)) ? settings : undefined;
}
