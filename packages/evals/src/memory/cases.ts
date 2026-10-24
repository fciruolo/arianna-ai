import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { isAtMost, isLabel, type Label } from '@arianna/policy';

import { CaseFileError } from '../cases.ts';
import { contains } from './check.ts';
import type { Clearance, MemoryQuestion, WorldEpisode, WorldStep } from './types.ts';

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function record(line: string, where: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new CaseFileError(`${where}: not valid JSON`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new CaseFileError(`${where}: expected an object`);
  return raw as Record<string, unknown>;
}

function onlyKeys(raw: Record<string, unknown>, allowed: readonly string[], where: string): void {
  const extra = Object.keys(raw).filter((key) => !allowed.includes(key));
  if (extra.length > 0) throw new CaseFileError(`${where}: unknown key(s) ${extra.join(', ')}`);
}

function text(raw: Record<string, unknown>, key: string, where: string): string {
  const value = raw[key];
  if (typeof value !== 'string' || value.trim() === '') throw new CaseFileError(`${where}: "${key}" must be a non-empty string`);
  return value;
}

function strings(value: unknown, key: string, where: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || !value.every((item) => typeof item === 'string' && item.trim() !== '')) {
    throw new CaseFileError(`${where}: "${key}" must be a non-empty list of non-empty strings`);
  }
  return value as string[];
}

function lines(body: string, file: string): { line: string; where: string }[] {
  return body.split('\n').flatMap((line, index) => (line.trim() === '' ? [] : [{ line, where: `${file}:${String(index + 1)}` }]));
}

function unique(ids: string[], file: string): void {
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate !== undefined) throw new CaseFileError(`${file}: duplicate id ${duplicate}`);
}

/** `world.jsonl`: episodes and deletions, in time order; a deletion names a conversation seen before it. */
export function parseWorld(body: string, file = 'world.jsonl'): WorldStep[] {
  const steps: WorldStep[] = [];
  let last = -Infinity;
  for (const { line, where } of lines(body, file)) {
    const raw = record(line, where);
    const id = text(raw, 'id', where);
    const at = text(raw, 'at', where);
    const time = Date.parse(at);
    if (!ISO_TIME.test(at) || Number.isNaN(time)) throw new CaseFileError(`${where}: "at" must be an ISO time with offset`);
    if (time < last) throw new CaseFileError(`${where}: "at" goes back in time`);
    last = time;
    if ('forget' in raw) {
      onlyKeys(raw, ['id', 'at', 'forget'], where);
      const conversation = text(raw, 'forget', where);
      if (!steps.some((step) => step.kind === 'episode' && step.conversation === conversation)) {
        throw new CaseFileError(`${where}: "forget" names a conversation without earlier episodes`);
      }
      steps.push({ kind: 'forget', id, at, conversation });
      continue;
    }
    onlyKeys(raw, ['id', 'at', 'label', 'conversation', 'text', 'incognito', 'canaries'], where);
    const { label, incognito } = raw;
    if (!isLabel(label)) throw new CaseFileError(`${where}: "label" must be one of L0, L1, L2, L3`);
    if (incognito !== undefined && typeof incognito !== 'boolean') throw new CaseFileError(`${where}: "incognito" must be a boolean`);
    const body = text(raw, 'text', where);
    const canaries = strings(raw.canaries, 'canaries', where);
    if (canaries?.some((canary) => !contains(body, canary)) === true) throw new CaseFileError(`${where}: every canary must be part of "text"`);
    steps.push({
      kind: 'episode',
      id,
      at,
      label,
      conversation: text(raw, 'conversation', where),
      text: body,
      incognito: incognito === true,
      ...(canaries !== undefined && { canaries }),
    });
  }
  unique(steps.map((step) => step.id), file);
  checkCanaries(steps, file);
  return steps;
}

/** True when the episode may never reach a reading of the given clearance (or any reading). */
export function isProtected(episode: WorldEpisode, forgotten: ReadonlySet<string>, clearance: Label = 'L1'): boolean {
  return episode.incognito || episode.label === 'L3' || forgotten.has(episode.conversation) || !isAtMost(episode.label, clearance);
}

/** Every protected episode has a canary, and no canary is in the text of an episode a work reading may get. */
function checkCanaries(steps: readonly WorldStep[], file: string): void {
  const forgotten = new Set(steps.flatMap((step) => (step.kind === 'forget' ? [step.conversation] : [])));
  const episodes = steps.filter((step) => step.kind === 'episode');
  for (const episode of episodes) {
    if (isProtected(episode, forgotten) && episode.canaries === undefined) {
      throw new CaseFileError(`${file}: ${episode.id} is L2, L3, incognito or deleted and needs "canaries"`);
    }
    for (const canary of episode.canaries ?? []) {
      const open = episodes.find((other) => other !== episode && !isProtected(other, forgotten) && contains(other.text, canary));
      if (open !== undefined) throw new CaseFileError(`${file}: a canary of ${episode.id} is also in ${open.id}`);
    }
  }
}

/**
 * L1 and L2 only: L1 episodes carry no canary, so a reading at L0 would have
 * nothing guarding the work data from it.
 */
function clearance(value: unknown, where: string): Clearance {
  if (value === 'L1' || value === 'L2') return value;
  throw new CaseFileError(`${where}: "clearance" must be L1 or L2`);
}

/** `questions.jsonl`: every question expects words, an abstention or both. */
export function parseQuestions(body: string, file = 'questions.jsonl'): MemoryQuestion[] {
  const questions = lines(body, file).map(({ line, where }) => {
    const raw = record(line, where);
    onlyKeys(raw, ['id', 'asOf', 'clearance', 'question', 'reference', 'expect', 'tags'], where);
    const asOf = text(raw, 'asOf', where);
    if (!DAY.test(asOf) || Number.isNaN(Date.parse(asOf))) throw new CaseFileError(`${where}: "asOf" must be a day, YYYY-MM-DD`);
    const { expect, tags } = raw;
    if (typeof expect !== 'object' || expect === null || Array.isArray(expect)) throw new CaseFileError(`${where}: "expect" must be an object`);
    const fields = expect as Record<string, unknown>;
    onlyKeys(fields, ['any', 'all', 'none', 'abstain'], `${where} expect`);
    if (fields.abstain !== undefined && fields.abstain !== true) throw new CaseFileError(`${where}: "expect.abstain" is true or absent`);
    const any = strings(fields.any, 'expect.any', where);
    const all = strings(fields.all, 'expect.all', where);
    const none = strings(fields.none, 'expect.none', where);
    const abstain = fields.abstain === true;
    if (any === undefined && all === undefined && !abstain) throw new CaseFileError(`${where}: "expect" needs "any", "all" or "abstain"`);
    if (!Array.isArray(tags) || !tags.every((tag) => typeof tag === 'string')) throw new CaseFileError(`${where}: "tags" must be a list of strings`);
    const question: MemoryQuestion = {
      id: text(raw, 'id', where),
      asOf,
      clearance: clearance(raw.clearance, where),
      question: text(raw, 'question', where),
      reference: text(raw, 'reference', where),
      expect: { ...(any && { any }), ...(all && { all }), ...(none && { none }), ...(abstain && { abstain }) },
      tags,
    };
    return question;
  });
  unique(questions.map((question) => question.id), file);
  return questions;
}

/** The two files of `evals/memory/`. */
export function loadMemoryCases(dir: string): { world: WorldStep[]; questions: MemoryQuestion[] } {
  return {
    world: parseWorld(readFileSync(join(dir, 'world.jsonl'), 'utf8')),
    questions: parseQuestions(readFileSync(join(dir, 'questions.jsonl'), 'utf8')),
  };
}
