import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { sanitizeForTerminal } from '@arianna/agents';

import { GOD_MAIN, godPartDir, originOf, subtaskBranch, TRIAL_PREFIX, type GitRunner } from './clone.ts';
import { branchRefusal, COMMIT_IDENTITY, GodError, isSensitive, parseRaw, type GodWork, type SubtaskRow } from './work.ts';

/**
 * «Prova», «Approva funzionalità» and «Non funziona» (D-179): the work of
 * GOD comes into the installation the user is using, at the user's click.
 *
 * «Prova» commits each subtask in its clone (as «Prepara il ramo» did), then
 * in the installation, on main and clean, makes the branch `prova/god-<part>`
 * with one merge commit of the subtasks plus the next version in
 * CHANGELOG.md and package.json; the pre-commit hook runs `pnpm check`. Then
 * the chat is built again and the core restarts on that branch: the user
 * tries the real Arianna. «Approva funzionalità» moves main forward to the
 * trial (fast-forward only: what was tried is what lands), tags it, deletes
 * the trial branch, builds and restarts; without a trial it does both at
 * once. «Non funziona» sends the user's words to each Coder, goes back to
 * main, deletes the branch, builds and restarts. A trial lands or goes as a
 * whole, whichever of its subtasks was clicked.
 *
 * Main moves only after the checks passed; a failure leaves the
 * installation on main as it was. What a fetched commit brings is checked as
 * «Prepara il ramo» checks the changes (the Coder may have committed in its
 * clone), and a change of the lockfile is refused (nothing reinstalls). A subtask with a migration is never tried:
 * back on main, the core would refuse a database with a migration it does not
 * know; it may land directly, only with the development passwords (the core
 * migrates by itself only with those).
 */

export const MIGRATIONS_DIR = 'apps/core/migrations/';

/** `pnpm check` runs in the hook: minutes. */
const CHECK_TIMEOUT_MS = 30 * 60_000;
const BUILD_TIMEOUT_MS = 10 * 60_000;
/** What the hook and the build may read of the core's environment: never the database passwords or the age key. */
const INHERITED = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TERM', 'PNPM_HOME'];

export type LandAction = 'trial' | 'approve' | 'reject';

export interface Landing {
  action: LandAction;
  parts: string[];
  /** What happens now, in Italian. */
  phase: string;
  startedAt: string;
}

export interface LandingOutcome {
  ok: boolean;
  text: string;
  at: string;
}

export interface InstallationState {
  /** The branch the installation is on ('' when detached). */
  branch: string;
  /** Nothing changed and nothing untracked outside what git ignores. */
  clean: boolean;
  /** The trial branch of GOD the installation is on, if any. */
  trial: string | null;
}

export interface GodLandingView {
  installation: InstallationState;
  landing: Landing | null;
  outcome: LandingOutcome | null;
}

/** Runs a command in the installation with an environment built from nothing: exit code and the tail of its output. */
export type CommandRunner = (command: string, args: readonly string[], cwd: string, timeoutMs: number) => Promise<{ code: number; output: string }>;

export interface GodLandingEnv {
  home: string;
  data: string;
  work: Pick<GodWork, 'rows' | 'planRows' | 'plan' | 'prepareBranch' | 'reopen'>;
  /** git without hooks or global configuration (clone.ts). */
  git: GitRunner;
  /** git with the installation's hooks, pnpm (commandRunner below by default). */
  run?: CommandRunner;
  /** The core migrates by itself (development passwords). */
  development: () => boolean;
  /** Restarts the core on the code now in the installation (main.ts). */
  restart: () => void;
  now?: () => Date;
  onError?: (error: unknown) => void;
}

/**
 * The environment of the hook and of the build: only the variables named,
 * never the database passwords or the age key. No dead proxy, unlike the
 * processes that receive L2 (child-env.ts): the tests check the proxy of the
 * environment themselves, and nothing here handles private data.
 */
export function landingEnv(from: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of INHERITED) {
    const value = from[key];
    if (value !== undefined && value !== '') env[key] = value;
  }
  return env;
}

export function commandRunner(): CommandRunner {
  const env = landingEnv(process.env);
  return (command, args, cwd, timeoutMs) =>
    new Promise((resolve) => {
      execFile(command, [...args], { cwd, env, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024, encoding: 'utf8', shell: false }, (error, stdout, stderr) => {
        const output = `${stdout}\n${stderr}`;
        if (error === null) resolve({ code: 0, output });
        else resolve({ code: typeof error.code === 'number' ? error.code : 1, output: error.killed ? `${output}\ntook too long` : output });
      });
    });
}

/** The last meaningful lines of a command's output, for the user: at most 300 characters. */
export function tailOf(output: string): string {
  const lines = output
    .split('\n')
    .map((line) => sanitizeForTerminal(line).trim())
    .filter((line) => line !== '');
  return lines.slice(-4).join(' · ').slice(-300);
}

/** 0.68.0 → 0.69.0: a function of GOD is a new function (minor). */
export function nextMinor(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (match === null) throw new GodError('conflict', `la versione ${version} di package.json non è X.Y.Z`);
  return `${match[1] ?? '0'}.${String(Number(match[2]) + 1)}.0`;
}

/** The version of a package.json text. */
export function versionOf(packageJson: string): string {
  const match = /"version"\s*:\s*"([^"]+)"/.exec(packageJson);
  if (match?.[1] === undefined) throw new GodError('conflict', 'package.json non ha una versione');
  return match[1];
}

/** The package.json text with the version changed, nothing else touched. */
export function withVersion(packageJson: string, version: string): string {
  return packageJson.replace(/("version"\s*:\s*")[^"]+(")/, `$1${version}$2`);
}

/**
 * The CHANGELOG with a new section for `version` right after «Non rilasciato»
 * (which keeps its entries), or before the first version when that section
 * is missing.
 */
export function withRelease(changelog: string, version: string, date: string, lines: readonly string[]): string {
  const section = `## [${version}] - ${date}\n\n### Aggiunto\n\n${lines.map((line) => `- ${line}`).join('\n')}\n\n`;
  const headings = [...changelog.matchAll(/^## \[([^\]]+)\]/gm)];
  const unreleased = headings.findIndex((heading) => heading[1] === 'Non rilasciato');
  const after = headings[unreleased === -1 ? 0 : unreleased + 1];
  if (after?.index === undefined) return `${changelog.trimEnd()}\n\n${section.trimEnd()}\n`;
  return `${changelog.slice(0, after.index)}${section}${changelog.slice(after.index)}`;
}

/** The line of a subtask in CHANGELOG.md: its title, and where it comes from. */
export function changelogLine(row: Pick<SubtaskRow, 'title' | 'part'>): string {
  const title = row.title.trim().replace(/[.\s]+$/, '');
  return `${title} (GOD ${row.part.slice(0, 4)}, D-179).`;
}

/** The trial branch of these subtasks: named after the first. */
export function trialBranch(rows: readonly Pick<SubtaskRow, 'part'>[]): string {
  const first = rows[0];
  if (first === undefined) throw new GodError('invalid', 'nessun sottocompito');
  return `${TRIAL_PREFIX}${first.part}`;
}

function localDate(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function createGodLanding(env: GodLandingEnv) {
  const { home, data, git, work } = env;
  const run = env.run ?? commandRunner();
  const now = env.now ?? (() => new Date());
  const outcomeFile = join(data, 'god', 'landing.json');
  let landing: Landing | null = null;

  function readOutcome(): LandingOutcome | null {
    try {
      const parsed = JSON.parse(readFileSync(outcomeFile, 'utf8')) as Partial<LandingOutcome>;
      return typeof parsed.ok === 'boolean' && typeof parsed.text === 'string' && typeof parsed.at === 'string' ? { ok: parsed.ok, text: parsed.text, at: parsed.at } : null;
    } catch {
      return null;
    }
  }

  function writeOutcome(ok: boolean, text: string): void {
    mkdirSync(join(data, 'god'), { recursive: true, mode: 0o700 });
    writeFileSync(outcomeFile, `${JSON.stringify({ ok, text, at: now().toISOString() })}\n`, { mode: 0o600 });
  }

  const succeeds = (args: readonly string[]): Promise<boolean> => git(args, home).then(() => true, () => false);

  async function installation(): Promise<InstallationState> {
    const branch = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], home).then(
      (out) => out.trim(),
      () => '',
    );
    const clean = (await git(['status', '--porcelain', '--untracked-files=normal'], home)).trim() === '';
    return { branch, clean, trial: branch.startsWith(TRIAL_PREFIX) ? branch : null };
  }

  async function view(): Promise<GodLandingView> {
    return { installation: await installation(), landing, outcome: readOutcome() };
  }

  /** Whether a subtask's prepared commit is already in the installation's main. */
  const inMain = (commit: string): Promise<boolean> => succeeds(['merge-base', '--is-ancestor', commit, `refs/heads/${GOD_MAIN}`]);

  /** Of these subtasks, the ones in the trial branch now checked out (their commits reach HEAD, not main). */
  async function trialRows(rows: readonly SubtaskRow[]): Promise<SubtaskRow[]> {
    const found: SubtaskRow[] = [];
    for (const row of rows) {
      if (row.commitSha === null) continue;
      if ((await succeeds(['merge-base', '--is-ancestor', row.commitSha, 'HEAD'])) && !(await inMain(row.commitSha))) found.push(row);
    }
    return found;
  }

  /** Every subtask of the trial, from the plans of the ones the user clicked: the trial lands or goes as a whole. */
  async function wholeTrial(ids: readonly string[]): Promise<SubtaskRow[]> {
    const plans = new Set((await work.rows(ids)).map((row) => row.planId));
    const rows: SubtaskRow[] = [];
    for (const plan of plans) rows.push(...(await work.planRows(plan)));
    return trialRows(rows);
  }

  /** The title of the trial, from its commit («X.Y.Z: title (GOD, D-179)»). */
  async function trialTitle(branch: string): Promise<string> {
    const subject = (await git(['log', '-1', '--format=%s', branch], home)).trim();
    return /^\d+\.\d+\.\d+: (.+) \(GOD, D-179\)$/.exec(subject)?.[1] ?? subject;
  }

  async function needMainClean(): Promise<void> {
    const state = await installation();
    if (state.trial !== null) throw new GodError('conflict', `l'installazione è già in prova su ${state.trial}: approvala o di' «Non funziona» prima`);
    if (state.branch !== GOD_MAIN) throw new GodError('conflict', `l'installazione è sul ramo ${state.branch || '(nessuno)'}, non su main: forse ci sta lavorando Claude Code`);
    if (!state.clean) throw new GodError('conflict', "nell'installazione ci sono modifiche non salvate: forse ci sta lavorando Claude Code");
  }

  function ready(rows: readonly SubtaskRow[]): void {
    if (rows.length === 0) throw new GodError('invalid', 'nessun sottocompito da provare');
    for (const row of rows) {
      if (!['reviewed', 'attention', 'stopped', 'branch'].includes(row.state)) {
        throw new GodError('conflict', `«${row.title}» non è pronto: si prova dopo la revisione, o con il lavoro fermo`);
      }
    }
  }

  interface Finished {
    ok: boolean;
    text: string;
    /** The code in the installation changed: the core restarts on it. */
    restart: boolean;
  }

  /**
   * One operation at a time: the slot is taken at once (two clicks never both
   * pass), the checks run (a refusal reaches the caller and frees the slot),
   * then the work goes on in the background.
   */
  async function exclusive(action: LandAction, checks: () => Promise<{ parts: string[]; task: (step: (text: string) => void) => Promise<Finished> }>): Promise<GodLandingView> {
    if (landing !== null) throw new GodError('conflict', `c'è già un'operazione in corso: ${landing.phase}`);
    landing = { action, parts: [], phase: 'controllo', startedAt: now().toISOString() };
    let prepared: Awaited<ReturnType<typeof checks>>;
    try {
      prepared = await checks();
    } catch (error) {
      landing = null;
      throw error;
    }
    landing = { ...landing, parts: prepared.parts, phase: 'comincio' };
    const step = (text: string): void => {
      if (landing !== null) landing = { ...landing, phase: text };
    };
    void prepared.task(step).then(
      (finished) => {
        writeOutcome(finished.ok, finished.text);
        landing = null;
        // The page reads the outcome before the core goes; the new core finds it in the file.
        if (finished.restart) {
          setTimeout(() => {
            env.restart();
          }, 1500);
        }
      },
      (error: unknown) => {
        writeOutcome(false, error instanceof GodError ? error.message : tailOf(error instanceof Error ? error.message : String(error)));
        if (!(error instanceof GodError)) env.onError?.(error);
        landing = null;
      },
    );
    return view();
  }

  /** The chat built again from the code now in the installation; the reason when it fails. */
  async function buildChat(step: (text: string) => void): Promise<string | undefined> {
    step('ricompilo la chat');
    const built = await run('pnpm', ['hud:build'], home, BUILD_TIMEOUT_MS);
    return built.code === 0 ? undefined : `la chat non si è ricompilata: ${tailOf(built.output)}`;
  }

  /** The refs fetched from the clones go with the trial: nothing of the cloud stays in the installation. */
  async function dropRefs(parts: readonly string[]): Promise<void> {
    for (const part of parts) await git(['update-ref', '-d', `refs/god/${part}`], home).catch(() => undefined);
  }

  /** Back to main as it was, the half-made trial branch gone. */
  async function undo(branch: string, parts: readonly string[]): Promise<void> {
    await git(['merge', '--abort'], home).catch(() => undefined);
    await git(['reset', '--quiet', '--hard'], home).catch(() => undefined);
    await git(['checkout', '--quiet', GOD_MAIN], home).catch(() => undefined);
    await git(['branch', '--quiet', '-D', branch], home).catch(() => undefined);
    await dropRefs(parts);
  }

  /**
   * What a fetched commit brings into the installation, checked as «Prepara
   * il ramo» checks the uncommitted changes, but on everything since main:
   * the Coder may have committed in its clone.
   */
  async function refusalOf(row: SubtaskRow, commit: string, allowMigrations: boolean): Promise<string | undefined> {
    const changes = parseRaw(await git(['diff', '--raw', '-z', '--no-renames', `${GOD_MAIN}...${commit}`], home));
    const listed = changes.map((change) => change.path);
    const ignored = new Set(
      listed.length === 0 ? [] : (await git(['check-ignore', '--no-index', '-z', '--stdin'], home, { input: `${listed.join('\0')}\0`, okCodes: [1] })).split('\0').filter((path) => path !== ''),
    );
    const refused = branchRefusal(changes, ignored);
    if (refused !== undefined) return `«${row.title}»: ${refused}`;
    if (listed.some((path) => path === 'pnpm-lock.yaml')) return `«${row.title}» cambia le dipendenze (pnpm-lock.yaml): va unito a mano, con pnpm install`;
    if (listed.some((path) => path.startsWith(MIGRATIONS_DIR))) {
      if (!allowMigrations) return `«${row.title}» aggiunge una migrazione del database: non si prova (tornando a main il core non partirebbe), si approva direttamente`;
      if (!env.development()) return `«${row.title}» aggiunge una migrazione: con le password vere va unito a mano, con pnpm db:migrate`;
    }
    return undefined;
  }

  /**
   * Commits the subtasks in their clones, brings them into a new branch of
   * the installation and commits the merge with the next version: the hook
   * runs pnpm check. Returns the branch, the version and a note when the
   * work changes what runs the check.
   */
  async function makeTrial(rows: SubtaskRow[], title: string, step: (text: string) => void, allowMigrations: boolean): Promise<{ branch: string; version: string; note: string }> {
    const commits: string[] = [];
    const parts = rows.map((row) => row.part);
    const branch = trialBranch(rows);
    let sensitive = false;
    try {
      for (const row of rows) {
        step(`preparo il commit di «${row.title}»`);
        const prepared = row.state === 'branch' && row.commitSha !== null ? row : await work.prepareBranch(row.id);
        if (prepared.state !== 'branch' || prepared.commitSha === null) throw new GodError('conflict', `«${row.title}»: ${prepared.reason ?? 'il commit non si è fatto'}`);
        step(`scarico «${row.title}» nell'installazione`);
        const ref = `refs/god/${row.part}`;
        await git(['fetch', '--quiet', '--no-tags', originOf(godPartDir(home, row.part)), `+refs/heads/${subtaskBranch(row.part)}:${ref}`], home);
        const fetched = (await git(['rev-parse', ref], home)).trim();
        if (fetched !== prepared.commitSha) throw new GodError('conflict', `il ramo di «${row.title}» è cambiato dopo il commit: riprova`);
        if (await inMain(fetched)) throw new GodError('conflict', `«${row.title}» è già in main`);
        const refused = await refusalOf(row, fetched, allowMigrations);
        if (refused !== undefined) throw new GodError('conflict', refused);
        sensitive ||= (await git(['diff', '--name-only', '-z', `${GOD_MAIN}...${fetched}`], home)).split('\0').some((path) => path !== '' && isSensitive(path));
        commits.push(fetched);
      }
    } catch (error) {
      await dropRefs(parts);
      throw error;
    }
    const version = nextMinor(versionOf(readFileSync(join(home, 'package.json'), 'utf8')));
    if (await succeeds(['rev-parse', '--quiet', '--verify', `refs/tags/v${version}`])) {
      await dropRefs(parts);
      throw new GodError('conflict', `il tag v${version} c'è già: allinea la versione di package.json prima`);
    }
    await git(['branch', '--quiet', '-D', branch], home).catch(() => undefined);
    await git(['checkout', '--quiet', '-b', branch, GOD_MAIN], home);
    try {
      step('unisco');
      await git(['merge', '--quiet', '--no-ff', '--no-commit', ...commits], home).catch((error: unknown) => {
        throw new GodError('conflict', `l'unione con main non riesce (conflitti?): ${error instanceof Error ? error.message : String(error)}`);
      });
      const packagePath = join(home, 'package.json');
      const changelogPath = join(home, 'CHANGELOG.md');
      writeFileSync(packagePath, withVersion(readFileSync(packagePath, 'utf8'), version));
      writeFileSync(changelogPath, withRelease(readFileSync(changelogPath, 'utf8'), version, localDate(now()), rows.map(changelogLine)));
      await git(['add', '--', 'package.json', 'CHANGELOG.md'], home);
      step('pnpm check in corso (qualche minuto)');
      // With the installation's own hooks: pre-commit refuses conflict markers, then runs pnpm check.
      const message = `${version}: ${title} (GOD, D-179)\n\n${rows.map((row) => `- ${row.title} (${row.part})`).join('\n')}`;
      const committed = await run('git', [...COMMIT_IDENTITY, 'commit', '--quiet', '-m', message], home, CHECK_TIMEOUT_MS);
      if (committed.code !== 0) throw new GodError('conflict', `pnpm check non passa: ${tailOf(committed.output)}`);
      // The hook that ran is the one of the merged tree: a work that changes it, or what it runs, checked itself.
      return { branch, version, note: sensitive ? ' Attenzione: il lavoro cambia file che decidono cosa esegue pnpm check (hook, package.json, script): il controllo è quello del lavoro stesso.' : '' };
    } catch (error) {
      await undo(branch, parts);
      throw error;
    }
  }

  /** Main moves forward to the trial, the tag, the trial branch and the fetched refs gone; on a refusal the installation stays where it was. */
  async function land(branch: string, title: string, parts: readonly string[], step: (text: string) => void): Promise<string> {
    step('porto la prova in main');
    const version = versionOf(await git(['show', `${branch}:package.json`], home));
    if (!(await succeeds(['merge-base', '--is-ancestor', `refs/heads/${GOD_MAIN}`, branch]))) {
      throw new GodError('conflict', "main è cambiato dopo la prova: di' «Non funziona» e rifai la prova");
    }
    if (await succeeds(['rev-parse', '--quiet', '--verify', `refs/tags/v${version}`])) throw new GodError('conflict', `il tag v${version} c'è già: main non si muove`);
    await git(['checkout', '--quiet', GOD_MAIN], home);
    await git(['merge', '--quiet', '--ff-only', branch], home);
    await git([...COMMIT_IDENTITY, 'tag', '-a', `v${version}`, '-m', `${version}: ${title}`], home);
    await git(['branch', '--quiet', '-D', branch], home);
    await dropRefs(parts);
    return version;
  }

  /** «Prova»: these subtasks, together, on a trial branch of the installation; then the core restarts there. */
  function trial(ids: readonly string[], title: string): Promise<GodLandingView> {
    return exclusive('trial', async () => {
      const rows = await work.rows(ids);
      ready(rows);
      await needMainClean();
      return {
        parts: rows.map((row) => row.part),
        task: async (step) => {
          const { branch, version, note } = await makeTrial(rows, title, step, false);
          const broken = await buildChat(step);
          if (broken !== undefined) {
            // Back on main, with the chat of main: the trial is not tried half-built.
            await undo(branch, rows.map((row) => row.part));
            await buildChat(step);
            return { ok: false, text: `Prova annullata, ${broken}`, restart: false };
          }
          step('riavvio Arianna sulla prova');
          return { ok: true, text: `In prova la ${version} con «${title}»: Arianna si riavvia su ${branch}. Provala, poi «Approva funzionalità» o «Non funziona».${note}`, restart: true };
        },
      };
    });
  }

  /** «Approva funzionalità»: the trial in progress lands in main, whole; without one, the subtasks are tried and landed at once. */
  function approve(ids: readonly string[], title: string): Promise<GodLandingView> {
    return exclusive('approve', async () => {
      const state = await installation();
      if (state.trial !== null) {
        const branch = state.trial;
        const rows = await wholeTrial(ids);
        if (rows.length === 0) throw new GodError('conflict', `l'installazione è in prova su ${branch} con un altro lavoro: approvalo o di' «Non funziona» prima`);
        if (!state.clean) throw new GodError('conflict', 'nella prova ci sono modifiche non salvate: salvale o toglile prima di approvare');
        const trialName = await trialTitle(branch);
        return {
          parts: rows.map((row) => row.part),
          task: async (step) => {
            const version = await land(branch, trialName, rows.map((row) => row.part), step);
            const broken = await buildChat(step);
            step('riavvio Arianna su main');
            return { ok: broken === undefined, text: `La ${version} è in main con «${trialName}»: Arianna si riavvia.${broken === undefined ? '' : ` Però ${broken}.`}`, restart: true };
          },
        };
      }
      const rows = (await work.rows(ids)).filter((row) => row.state !== 'discarded');
      ready(rows);
      await needMainClean();
      return {
        parts: rows.map((row) => row.part),
        task: async (step) => {
          const parts = rows.map((row) => row.part);
          const { branch, note } = await makeTrial(rows, title, step, true);
          let version: string;
          try {
            version = await land(branch, title, parts, step);
          } catch (error) {
            await undo(branch, parts);
            throw error;
          }
          const broken = await buildChat(step);
          step('riavvio Arianna su main');
          return { ok: broken === undefined, text: `La ${version} è in main con «${title}»: Arianna si riavvia.${note}${broken === undefined ? '' : ` Però ${broken}.`}`, restart: true };
        },
      };
    });
  }

  /** «Non funziona»: the user's words to each Coder of the trial, then back to main, the trial branch gone. */
  function reject(ids: readonly string[], text: string): Promise<GodLandingView> {
    return exclusive('reject', async () => {
      const words = text.trim();
      if (words === '') throw new GodError('invalid', 'scrivi cosa non va: lo leggerà il Coder');
      if (words.length > 4000) throw new GodError('invalid', 'al più 4000 caratteri');
      const state = await installation();
      if (state.trial === null) throw new GodError('conflict', "l'installazione non è in prova");
      if (!state.clean) throw new GodError('conflict', 'nella prova ci sono modifiche non salvate: salvale o toglile prima');
      const rows = await wholeTrial(ids);
      if (rows.length === 0) throw new GodError('conflict', 'questi sottocompiti non sono nella prova in corso');
      const branch = state.trial;
      return {
        parts: rows.map((row) => row.part),
        task: async (step) => {
          step('scrivo ai Coder');
          for (const row of rows) await work.reopen(row.id, words);
          step('torno a main');
          await git(['checkout', '--quiet', GOD_MAIN], home);
          await git(['branch', '--quiet', '-D', branch], home);
          await dropRefs(rows.map((row) => row.part));
          const broken = await buildChat(step);
          step('riavvio Arianna su main');
          const who = rows.length === 1 ? 'il Coder riprende' : 'i Coder riprendono';
          return { ok: broken === undefined, text: `Prova tolta, Arianna torna su main: ${who} il lavoro con le tue parole.${broken === undefined ? '' : ` Però ${broken}.`}`, restart: true };
        },
      };
    });
  }

  /**
   * At the start of the core: a trial left half-made by a core stopped in
   * the middle (a merge not committed on a trial branch) goes, back to main.
   */
  async function recover(): Promise<boolean> {
    const state = await installation();
    if (state.trial === null || !(await succeeds(['rev-parse', '--quiet', '--verify', 'MERGE_HEAD']))) return false;
    await undo(state.trial, []);
    writeOutcome(false, `Una prova lasciata a metà da un arresto del core è stata tolta: l'installazione è tornata su main.`);
    return true;
  }

  /** The live subtasks of a plan, not in main yet: what «Prova tutto» and «Approva tutto» take, with the plan's title. */
  async function planTargets(planId: string): Promise<{ ids: string[]; title: string }> {
    const plan = await work.plan(planId);
    const ids: string[] = [];
    for (const row of await work.planRows(planId)) if (row.commitSha === null || !(await inMain(row.commitSha))) ids.push(row.id);
    return { ids, title: plan.title };
  }

  return { view, trial, approve, reject, recover, planTargets };
}

export type GodLanding = ReturnType<typeof createGodLanding>;
