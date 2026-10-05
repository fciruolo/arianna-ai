import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { TurnMessage } from '@arianna/agents';
import type { Label, Labeled } from '@arianna/policy';

import { joinSameRole, SYSTEM_MESSAGE_MARK } from '../src/orchestrator/orchestrator.ts';

const part = (role: TurnMessage['role'], content: string, label: Label = 'L1', source = content): Labeled<TurnMessage> => ({
  value: { role, content },
  label,
  source,
});

test('alternating roles are left as they are', () => {
  const parts = [part('user', 'a'), part('assistant', 'b'), part('tool', 'c'), part('assistant', 'd'), part('tool', 'e')];
  assert.deepEqual(joinSameRole(parts), parts);
});

test('consecutive user messages become one, in order, separated by a blank line', () => {
  const parts = [part('user', 'summary', 'L1', 'summary:1-4'), part('user', `${SYSTEM_MESSAGE_MARK}\nerror`, 'L1', 'message:5'), part('user', 'question', 'L1', 'message:6')];
  assert.deepEqual(joinSameRole(parts), [
    { value: { role: 'user', content: `summary\n\n${SYSTEM_MESSAGE_MARK}\nerror\n\nquestion` }, label: 'L1', source: 'summary:1-4+message:5+message:6' },
  ]);
});

test('consecutive assistant messages become one', () => {
  const joined = joinSameRole([part('user', 'q'), part('assistant', 'x'), part('assistant', 'y')]);
  assert.deepEqual(
    joined.map((entry) => [entry.value.role, entry.value.content]),
    [
      ['user', 'q'],
      ['assistant', 'x\n\ny'],
    ],
  );
});

test('the joined entry carries the highest label of its parts; parts of different roles keep their own', () => {
  assert.equal(joinSameRole([part('user', 'a', 'L0'), part('user', 'b', 'L2'), part('user', 'c', 'L1')])[0]?.label, 'L2');
  assert.deepEqual(
    joinSameRole([part('user', 'a', 'L0'), part('assistant', 'b', 'L2')]).map((entry) => entry.label),
    ['L0', 'L2'],
  );
});

test('tool results are never joined', () => {
  const parts = [part('assistant', 'call'), part('tool', 'r1'), part('tool', 'r2')];
  assert.deepEqual(joinSameRole(parts), parts);
});

test('the input is not changed', () => {
  const parts = [part('user', 'a'), part('user', 'b')];
  const copy = structuredClone(parts);
  joinSameRole(parts);
  assert.deepEqual(parts, copy);
});

test('stable prefix: the same parts give the same bytes, a part added at the end extends only the last entry', () => {
  const parts = [part('user', 'a'), part('assistant', 'b'), part('user', 'c')];
  const before = joinSameRole(parts);
  assert.deepEqual(joinSameRole(parts), before);
  // A different role at the end: everything before is unchanged.
  const other = joinSameRole([...parts, part('assistant', 'd')]);
  assert.deepEqual(other.slice(0, before.length), before);
  // The same role: only the last entry changes, by appending.
  const same = joinSameRole([...parts, part('user', 'e')]);
  assert.deepEqual(same.slice(0, -1), before.slice(0, -1));
  assert.equal(same.at(-1)?.value.content, 'c\n\ne');
});

test('empty parts add no blank separator, but their label still counts', () => {
  const joined = joinSameRole([part('user', '', 'L2', 'm1'), part('user', 'a'), part('user', ''), part('user', 'b')]);
  assert.deepEqual(joined, [{ value: { role: 'user', content: 'a\n\nb' }, label: 'L2', source: 'm1+a++b' }]);
});

test('a tool result followed by a user message is not joined here (chatMessages sends both as user)', () => {
  const parts = [part('assistant', 'call'), part('tool', 'r'), part('user', 'q')];
  assert.deepEqual(joinSameRole(parts), parts);
});
