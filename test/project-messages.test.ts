// D-228: the refusals of the project list in Italian are written twice, in
// @arianna/config (wizard and CLI) and in the chat (apps/hud, which imports no
// workspace package). Every refusal parseProjects gives must read the same in both.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { test } from 'node:test';

import { parseConfig, projectProblemText, resolveHome } from '@arianna/config';

import { projectProblemText as chatText } from '../apps/hud/src/lib/settings.ts';

const ROOT = join(resolveHome({}), 'data', 'test-tmp', `project-messages-${randomUUID()}`);
const HOME = join(ROOT, 'arianna');
const USER = join(ROOT, 'utente');
const VALID = '[paths]\ndata = "data"\n\n[database]\nhost = "127.0.0.1"\nport = 54329\nname = "arianna"\nuser = "arianna"\n';
const project = (name: string, path: string, label = 'L1'): string => `[[project]]\nname = "${name}"\npath = "${path}"\nlabel = "${label}"\n`;

function refusal(sections: string, userHome = USER): string {
  try {
    parseConfig(`${VALID}\n${sections}\n`, HOME, undefined, userHome);
  } catch (error) {
    if (error instanceof Error) return error.message;
  }
  return assert.fail(`not refused: ${sections}`);
}

test('the chat and the wizard say every refusal of a project with the same Italian text', () => {
  const messages = [
    refusal(project('casa', '~')),
    refusal(project('casa', USER)),
    refusal(project('assoluto', join(USER, 'Sites', 'negozio'))),
    refusal(project('altrove', join(ROOT, 'altrove'))),
    refusal(project('rel', 'Sites/negozio')),
    refusal(project('nascosta', '~/.ssh')),
    refusal(project('lib', '~/Library/x')),
    refusal(project('dentro', '~/arianna/repos/x'), ROOT),
    refusal(project('demo', 'repos/altro')),
    refusal(project('Maiuscole', '~/x')),
    refusal(project('privato', '~/x', 'L2')),
    refusal(`${project('a', '~/a')}\n${project('a', '~/b')}`),
    refusal(`${project('a', '~/p')}\n${project('b', '~/p/b')}`),
    refusal(project('x', '~/x'), 'relative/home'),
  ];
  for (const message of messages) {
    const text = projectProblemText(message);
    assert.ok(text !== undefined, message);
    assert.equal(chatText(message), text, message);
  }
  assert.equal(new Set(messages.map((message) => projectProblemText(message))).size, messages.length - 1, 'one Italian text per kind of refusal, the home twice');
  assert.equal(chatText('roles.orchestrator: unknown model'), undefined);
});
