/**
 * «Cosa è cambiato» (D-233, idea 11 of OpenWork): the changes the core
 * observed in this installation (GET /api/changes), as rows of a list by day,
 * with an icon and a link to where that thing is changed. Pure: the page
 * shows what these functions decide.
 */
import type { IconName } from '../icons.ts';
import { LABEL_TEXT } from './labels.ts';
import { SETTINGS_PATH } from './route.ts';
import { ROLE_TEXT, type ModelRole } from './settings.ts';
import type { Label } from './types.ts';

export type ChangeArea =
  | 'arianna'
  | 'role'
  | 'model'
  | 'executor'
  | 'cloud-model'
  | 'cloud-name'
  | 'binary'
  | 'skills'
  | 'design'
  | 'agents-catalog'
  | 'agent'
  | 'project'
  | 'theme'
  | 'character';

export interface Change {
  area: ChangeArea;
  id: string;
  from: string | null;
  to: string | null;
}

export interface ChangesEntry {
  id: string;
  at: string;
  changes: Change[];
  more: number;
}

export interface ChangesReport {
  since: string | null;
  entries: ChangesEntry[];
  truncated: boolean;
}

/** The kinds of the filter, each with its icon and the section where it changes. */
export type ChangeGroup = 'models' | 'cloud' | 'skills' | 'agents' | 'projects' | 'appearance' | 'arianna';

export interface GroupInfo {
  id: ChangeGroup;
  title: string;
  icon: IconName;
  /** The section of the settings where it is changed. */
  slug: string;
  /** The words of the link. */
  link: string;
}

export const CHANGE_GROUPS: readonly GroupInfo[] = [
  { id: 'models', title: 'Modelli', icon: 'chip', slug: 'modelli', link: 'Apri Modelli' },
  { id: 'cloud', title: 'Claude e Codex', icon: 'coder', slug: 'claude-e-codex', link: 'Apri Claude e Codex' },
  { id: 'skills', title: 'Skill e stili', icon: 'puzzle', slug: 'skill-e-stili', link: 'Apri Skill e stili' },
  { id: 'agents', title: 'Agenti', icon: 'bot', slug: 'agenti', link: 'Apri Agenti' },
  { id: 'projects', title: 'Progetti', icon: 'project', slug: 'progetti', link: 'Apri Progetti' },
  { id: 'appearance', title: 'Aspetto', icon: 'studio', slug: 'aspetto-e-installazione', link: 'Apri Aspetto e installazione' },
  { id: 'arianna', title: 'Versione di Arianna', icon: 'package', slug: 'novita', link: 'Apri Novità' },
];

const AREA_GROUP: Record<ChangeArea, ChangeGroup> = {
  arianna: 'arianna',
  role: 'models',
  model: 'models',
  'cloud-model': 'models',
  'cloud-name': 'models',
  executor: 'cloud',
  binary: 'cloud',
  skills: 'skills',
  design: 'skills',
  'agents-catalog': 'agents',
  agent: 'agents',
  character: 'agents',
  project: 'projects',
  theme: 'appearance',
};

/** The section of a few areas is not the one of their group. */
const AREA_SECTION: Partial<Record<ChangeArea, { slug: string; link: string }>> = { 'agents-catalog': { slug: 'catalogo-agenti', link: 'Apri Catalogo agenti' } };

/** The themes by the name the user sees, not their id in the code (D-103, D-211: `corsia` is Scrubs, `ufficio` is The Office). */
const THEME_NAME: Readonly<Record<string, string>> = { base: 'Base', corsia: 'Scrubs', ufficio: 'The Office', springfield: 'I Simpson', quahog: 'I Griffin', langley: 'American Dad', 'fox-river': 'Prison Break', 'planet-express': 'Futurama', pasadena: 'The Big Bang Theory' };

export function themeName(id: string): string {
  return THEME_NAME[id] ?? id;
}

export function groupOf(area: ChangeArea): GroupInfo {
  const id = AREA_GROUP[area];
  const found = CHANGE_GROUPS.find((group) => group.id === id);
  if (found === undefined) throw new Error(`no group ${id}`);
  return found;
}

/** Where an area is changed: the slug of its section, its address and the words of the link. */
export function sectionOfArea(area: ChangeArea): { slug: string; href: string; link: string } {
  const { slug, link } = AREA_SECTION[area] ?? groupOf(area);
  return { slug, href: `${SETTINGS_PATH}/${slug}`, link };
}

const EXECUTOR_NAME: Record<string, string> = { claude: 'Claude Code', codex: 'Codex' };
const CLOUD_ALIAS: Record<string, string> = { opus: 'Claude Opus', sonnet: 'Claude Sonnet', haiku: 'Claude Haiku', fable: 'Claude Fable', codex: 'Codex' };

function roleName(id: string): string {
  return Object.hasOwn(ROLE_TEXT, id) ? `«${ROLE_TEXT[id as ModelRole].task}»` : `il ruolo ${id}`;
}

function labelName(value: string | null): string {
  return value !== null && Object.hasOwn(LABEL_TEXT, value) ? LABEL_TEXT[value as Label] : (value ?? '');
}

function commitText(value: string | null): string {
  return value === null || value === '-' ? 'nessuna versione in uso' : `versione ${value}`;
}

/** One change in plain Italian: what happened, then the detail (before → after). */
export function changeText(change: Change): { title: string; detail: string | null } {
  const { area, id, from, to } = change;
  const added = from === null;
  const removed = to === null;
  switch (area) {
    case 'arianna':
      return { title: removed ? 'Versione di Arianna non letta' : `Arianna aggiornata alla ${to}`, detail: from === null ? null : `prima ${from}` };
    case 'role':
      if (removed) return { title: `Nessun modello per ${roleName(id)}`, detail: `prima ${from ?? ''}` };
      return { title: `Nuovo modello per ${roleName(id)}`, detail: added ? to : `${from} → ${to}` };
    case 'model':
      if (removed) return { title: `Modello tolto dal catalogo: ${id}`, detail: null };
      if (to === 'on-disk') return { title: `Modello sul Mac: ${id}`, detail: added ? 'nuovo nel catalogo, file presenti' : 'file scaricati' };
      return { title: added ? `Modello nuovo nel catalogo: ${id}` : `File del modello tolti dal Mac: ${id}`, detail: added ? 'da scaricare' : 'resta nel catalogo' };
    case 'executor':
      return { title: `${EXECUTOR_NAME[id] ?? id} ${removed ? 'spento' : 'acceso'}`, detail: removed ? 'non riceve più lavori' : 'può ricevere lavori fino a Interno' };
    case 'cloud-model': {
      const name = CLOUD_ALIAS[id] ?? id;
      if (removed) return { title: `${name} tolto dai modelli cloud`, detail: null };
      return { title: `${name} ${to === 'on' ? 'acceso' : 'spento'} fra i modelli cloud`, detail: added ? 'nuovo' : null };
    }
    case 'cloud-name': {
      const name = CLOUD_ALIAS[id] ?? id;
      if (removed) return { title: `${name}: torna al modello più recente`, detail: `prima ${from ?? ''}` };
      return { title: `${name}: modello esatto ${to}`, detail: added ? null : `prima ${from}` };
    }
    case 'binary':
      return { title: `${EXECUTOR_NAME[id] ?? id} aggiornato alla ${to ?? '?'}`, detail: from === null ? 'prima versione vista' : `prima ${from}` };
    case 'skills':
      if (added) return { title: `Skill seguite da ${id}`, detail: commitText(to) };
      if (removed) return { title: `Skill di ${id} non più seguite`, detail: null };
      if (to === '-') return { title: `Skill di ${id}: versione scartata`, detail: `prima ${commitText(from)}` };
      return { title: `Skill di ${id}: nuova versione in uso`, detail: `${commitText(to)}, prima ${commitText(from)}` };
    case 'design':
      if (removed || to === '-') return { title: 'Stili di Open Design: nessuna versione in uso', detail: from === null || from === '-' ? null : `prima ${commitText(from)}` };
      return { title: 'Stili di Open Design: nuova versione in uso', detail: from === null || from === '-' ? commitText(to) : `${commitText(to)}, prima ${commitText(from)}` };
    case 'agents-catalog':
      if (added) return { title: `Catalogo agenti: segui ${id}`, detail: commitText(to) };
      if (removed) return { title: `Catalogo agenti: ${id} non più seguito`, detail: null };
      return { title: `Catalogo agenti: ${id} ${to === '-' ? 'senza versione in uso' : 'in una nuova versione'}`, detail: `${commitText(to)}, prima ${commitText(from)}` };
    case 'agent':
      if (added) return { title: `Agente nuovo: ${id}`, detail: to === 'active' ? 'acceso' : 'spento, da accendere' };
      if (removed) return { title: `Agente tolto: ${id}`, detail: null };
      return { title: `Agente ${id} ${to === 'active' ? 'acceso' : 'spento'}`, detail: null };
    case 'project':
      if (added) return { title: `Progetto aggiunto: ${id}`, detail: labelName(to) };
      if (removed) return { title: `Progetto tolto: ${id}`, detail: null };
      return { title: `Progetto ${id}: etichetta cambiata`, detail: `${labelName(from)} → ${labelName(to)}` };
    case 'theme':
      return { title: `Tema cambiato: ${themeName(to ?? 'base')}`, detail: from === null ? null : `prima ${themeName(from)}` };
    case 'character':
      if (removed) return { title: `${id}: torna all’aspetto predefinito`, detail: `prima ${from ?? ''}` };
      return { title: `${id} indossa ${to}`, detail: added ? null : `prima ${from}` };
  }
}

export interface ChangeRow {
  key: string;
  at: string;
  area: ChangeArea;
  group: GroupInfo;
  title: string;
  detail: string | null;
  slug: string;
  href: string;
  link: string;
}

export interface ChangeDay {
  /** AAAA-MM-GG, local. */
  day: string;
  title: string;
  rows: ChangeRow[];
  /** Changes of these events left out by the core beyond its limit. */
  more: number;
}

function dayKey(date: Date): string {
  return `${String(date.getFullYear())}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

const WEEKDAYS = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];
const MONTHS = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];

/** «Oggi», «Ieri», else «giovedì 14 ottobre» (with the year when it is not this one). */
export function dayTitle(date: Date, now: Date): string {
  const key = dayKey(date);
  if (key === dayKey(now)) return 'Oggi';
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (key === dayKey(yesterday)) return 'Ieri';
  const year = date.getFullYear() === now.getFullYear() ? '' : ` ${String(date.getFullYear())}`;
  return `${WEEKDAYS[date.getDay()] ?? ''} ${String(date.getDate())} ${MONTHS[date.getMonth()] ?? ''}${year}`;
}

export function timeText(at: string): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** The rows of the kinds chosen (null: every kind), by local day, most recent first as the core gives them. */
export function changeDays(report: ChangesReport, chosen: ChangeGroup | null, now: Date): ChangeDay[] {
  const days: ChangeDay[] = [];
  for (const entry of report.entries) {
    const date = new Date(entry.at);
    if (Number.isNaN(date.getTime())) continue;
    const rows = entry.changes.flatMap((change, index): ChangeRow[] => {
      const group = groupOf(change.area);
      if (chosen !== null && group.id !== chosen) return [];
      return [{ key: `${entry.id}-${String(index)}`, at: entry.at, area: change.area, group, ...changeText(change), ...sectionOfArea(change.area) }];
    });
    const more = chosen === null ? entry.more : 0;
    if (rows.length === 0 && more === 0) continue;
    const key = dayKey(date);
    let day = days.at(-1);
    if (day?.day !== key) {
      day = { day: key, title: dayTitle(date, now), rows: [], more: 0 };
      days.push(day);
    }
    day.rows.push(...rows);
    day.more += more;
  }
  return days;
}

/** How many changes of each kind the report holds, for the filter. */
export function groupCounts(report: ChangesReport): Record<ChangeGroup, number> {
  const counts = Object.fromEntries(CHANGE_GROUPS.map((group) => [group.id, 0])) as Record<ChangeGroup, number>;
  for (const entry of report.entries) for (const change of entry.changes) counts[groupOf(change.area).id] += 1;
  return counts;
}

/** «Osservo da …»: when the core took its first picture. */
export function sinceText(report: ChangesReport, now: Date): string {
  if (report.since === null) return 'Arianna non ha ancora fotografato l’installazione: torna fra un minuto.';
  const date = new Date(report.since);
  const day = dayTitle(date, now);
  return `Osservo i cambiamenti da ${day === 'Oggi' || day === 'Ieri' ? day.toLowerCase() : day}, alle ${timeText(report.since)}.`;
}
