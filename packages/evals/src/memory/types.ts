// The comparison of agent memories (D-204, D-307): what a candidate receives,
// what it answers, and how a judge rules on answers the expected words miss.
import type { Label } from '@arianna/policy';

/** One thing the user said, in the conversation it came from (a line of `world.jsonl`). */
export interface MemoryEpisode {
  kind: 'episode';
  /** The id of the source message: every memory cites the episodes it comes from. */
  id: string;
  /** When the user said it, ISO 8601 with offset. */
  at: string;
  /** The label of the conversation; a memory inherits the highest label of its sources. */
  label: Label;
  conversation: string;
  text: string;
  /** An incognito conversation never enters the memory. */
  incognito: boolean;
}

/** The user deletes a conversation: every memory born from it must go (a line of `world.jsonl`). */
export interface ForgetStep {
  kind: 'forget';
  id: string;
  at: string;
  conversation: string;
}

/**
 * An episode as the case file has it. `canaries` are unique strings of its text,
 * required when the episode is L2, L3, incognito or later deleted: they must
 * never reach a reading below its label, nor any reading once excluded or
 * deleted. The adapter never sees them.
 */
export interface WorldEpisode extends MemoryEpisode {
  canaries?: string[];
}

export type WorldStep = WorldEpisode | ForgetStep;

/** A label a conversation can read with (L3 is read by no model). */
export type Clearance = Exclude<Label, 'L3'>;

/** A line of `questions.jsonl`. */
export interface MemoryQuestion {
  id: string;
  /** The day the question is asked, YYYY-MM-DD: the memory answers with what it knew then. */
  asOf: string;
  clearance: Clearance;
  question: string;
  /** The right answer in words, for a judge (never compared as a string). */
  reference: string;
  expect: {
    /** At least one of these must be in the answer. */
    any?: string[];
    /** All of these must be in the answer. */
    all?: string[];
    /** None of these may be in the answer nor in the memories returned: a privacy check. */
    none?: string[];
    /** The right answer is "I don't know". */
    abstain?: boolean;
  };
  tags: string[];
}

/** A memory as a candidate returns it: its text, its label and the episodes it comes from. */
export interface RecalledMemory {
  text: string;
  label: Label;
  sources: string[];
}

export interface MemoryAsk {
  question: string;
  clearance: Clearance;
  asOf: string;
}

export interface MemoryAnswer {
  answer: string;
  /** What the memory handed over before the model wrote the answer. */
  memories: RecalledMemory[];
}

/**
 * The adapter in front of a candidate memory (docs/MEMORIA-CONFRONTO.md §3).
 * The adapter, not the candidate, is where Arianna's rules live: it refuses
 * incognito and L3 episodes, labels what it stores and filters by clearance
 * before anything reaches a model.
 */
export interface MemoryAdapter {
  readonly id: string;
  /** Empties the memory before a run. */
  reset(): Promise<void>;
  ingest(episode: MemoryEpisode): Promise<'stored' | 'refused'>;
  ask(query: MemoryAsk): Promise<MemoryAnswer>;
  /** Removes every memory born from the conversation (`purge_conversation`). */
  forgetConversation(conversation: string): Promise<void>;
  /** Every stored memory, for the audit of labels and sources. */
  memories(): Promise<RecalledMemory[]>;
  close?(): Promise<void>;
}

export type Verdict = 'correct' | 'wrong' | 'doubtful';

export interface JudgeInput {
  question: string;
  reference: string;
  answer: string;
}

/** Rules on an answer the expected words did not confirm; for the trial only, Claude through the gateway comes with step (c) (D-307). */
export interface MemoryJudge {
  readonly id: string;
  judge(input: JudgeInput): Promise<Verdict>;
}
