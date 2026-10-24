// A deterministic memory held in a Map: it tries the harness, not a memory
// design. It keeps one memory per episode, refuses what Arianna never stores,
// filters by clearance and date, picks memories by shared words and answers
// with their text, or "Non lo so." when none shares a word.
import { isAtMost, isLabel } from '@arianna/policy';

import { normalize } from './check.ts';
import type { MemoryAdapter, RecalledMemory } from './types.ts';

interface Stored extends RecalledMemory {
  conversation: string;
  day: string;
}

const STOPWORDS = new Set([
  'qual', 'quale', 'quali', 'quando', 'dove', 'come', 'quanto', 'quanta', 'cosa', 'della', 'delle', 'dello', 'degli', 'dell',
  'nella', 'sulla', 'alla', 'dalla', 'questo', 'questa', 'quest', 'anno', 'adesso', 'sono', 'fare', 'detto', 'voler', 'tutto', 'prima',
]);

function words(value: string): Set<string> {
  return new Set(normalize(value).split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 4 && !STOPWORDS.has(word)));
}

/** How many memories an answer is built from. */
const TOP = 3;

export function createFakeMemory(): MemoryAdapter {
  const store = new Map<string, Stored>();
  const recalled = ({ text, label, sources }: Stored): RecalledMemory => ({ text, label, sources: [...sources] });
  return {
    id: 'fake',
    reset: () => {
      store.clear();
      return Promise.resolve();
    },
    ingest: (episode) => {
      if (episode.incognito || !isLabel(episode.label) || episode.label === 'L3') return Promise.resolve('refused');
      store.set(episode.id, {
        text: episode.text,
        label: episode.label,
        sources: [episode.id],
        conversation: episode.conversation,
        day: episode.at.slice(0, 10),
      });
      return Promise.resolve('stored');
    },
    ask: ({ question, clearance, asOf }) => {
      const asked = words(question);
      const scored = [...store.values()]
        .filter((memory) => isAtMost(memory.label, clearance) && memory.day <= asOf)
        .map((memory) => ({ memory, score: [...words(memory.text)].filter((word) => asked.has(word)).length }))
        .filter(({ score }) => score > 0)
        .sort((a, b) => b.score - a.score || b.memory.day.localeCompare(a.memory.day))
        .slice(0, TOP)
        .map(({ memory }) => memory);
      const answer = scored.length === 0 ? 'Non lo so.' : scored.map((memory) => memory.text).join(' ');
      return Promise.resolve({ answer, memories: scored.map(recalled) });
    },
    forgetConversation: (conversation) => {
      for (const [id, memory] of store) if (memory.conversation === conversation) store.delete(id);
      return Promise.resolve();
    },
    memories: () => Promise.resolve([...store.values()].map(recalled)),
  };
}
