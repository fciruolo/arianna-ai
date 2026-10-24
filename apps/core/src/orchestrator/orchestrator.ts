import {
  answerText,
  isBrowserTool,
  isMacTool,
  chatMessages,
  offerable,
  promptLabelOf,
  readAnswer,
  RESPONSE_SCHEMA_NAME,
  responseSchema,
  seriesSource,
  type Answer,
  type DelegateTarget,
  type LoadedAgent,
  type Planner,
  type ReadAnswer,
  type ToolId,
  type TurnMessage,
} from '@arianna/agents';
import { enabledCloudModels, ORCHESTRATOR_AGENT, SKILLS_DELIVERY_BYTES, workParts, type AriannaConfig } from '@arianna/config';
import { JsonFieldStream, LocalModelError, type ChatRequest, type ClaudeExecutor, type CodexExecutor, type LocalModel } from '@arianna/executors';
import { clearanceFor, createContext, isAtMost, maxLabel, type Context, type Label, type Labeled, type LabelRules } from '@arianna/policy';

import { contextOf } from '../finance-mark.ts';
import { answersWithoutDelegation, CHAT_AGENT, characterOn, CLOUD_CHAT_AGENTS, loadConversation } from '../conversations.ts';
import type { Queryable, Sql } from '../db/client.ts';
import type { RunSpec, StepContext, StepExecutor, StepOutcome } from '../engine.ts';
import { appendEvent } from '../events.ts';
import { passGateway } from '../gateway.ts';
import { clockPart, joinTrailer } from '../clock-part.ts';
import { linesPart, minLabel, profilePart, promptTail, tailParts } from '../prompt-tail.ts';
import { listUserFacts } from '../user-facts.ts';
import { enterOnDelegation, isParticipant, nameLabelOf, participantsAt, participantsNote } from '../participants.ts';
import { openReply, postActivity, postCardActivity, type ActivityKind, type ChatReply } from '../reply.ts';
import { recordRouteDecision } from '../router-log.ts';
import type { Task } from '../tasks.ts';
import { canAnswerDirectly, directTargetOf, runDirect, type DirectTarget } from './claude-direct.ts';
import {
  briefCeiling,
  delegateTargets,
  delegationRoute,
  isCloudRoute,
  directChatOf,
  NO_PROJECT,
  noProjectCase,
  noProjectError,
  noProjectReply,
  planDelegation,
  repoFor,
  runDelegation,
  runLocalDelegation,
  skillsPart,
  type AgentSkills,
  type CardDesign,
  type CloudExecutor,
  type DelegateEnv,
  type DelegationPlan,
} from './delegate.ts';
import type { Advise } from './advisor.ts';
import { updateOffered, UPDATED } from './cards.ts';
import { createDelegation, loadDelegations, openDelegation, updateDelegation, type Delegation } from './delegations.ts';
import { gatewayRefusalOf, gatewayRefusalReply } from './gateway-refusal.ts';
import { writeFreeReply, type DraftReason } from './free-reply.ts';
import type { Kb } from './kb.ts';
import { conversationView, summaryMessage, writeMissingSummaries, type ConversationView, type SummarizeOutcome } from './summaries.ts';
import { attachmentHistory, attachmentsOf, readPendingImages, withinBudget } from './attachment-reading.ts';
import { imDecisionAnswer, imReplay, requestIm, WAITING_IM } from './im-step.ts';
import {
  bindSharedFacts,
  PROFILE_PROPOSE,
  PROFILE_SHARE,
  proposeDecisionAnswer,
  proposeReplay,
  requestPropose,
  requestShare,
  shareReplay,
  shareResults,
  WAITING_PROPOSE,
  WAITING_SHARE,
} from './profile-share.ts';
import type { ImToolEnv } from './im-tool.ts';
import { routineDecisionAnswer, routineReplay } from './routine-tool.ts';
import { milestoneDecisionAnswer, milestoneReplay } from './milestone-tool.ts';
import { MILESTONE_PROPOSE, WAITING_MILESTONE, writeMilestoneProposal } from '../milestone-proposals.ts';
import { ROUTINE_PROPOSE, routineProposalAllowed, WAITING_ROUTINE, writeRoutineProposal } from '../routine-proposals.ts';
import { isLocalTool, runTool, SKIPPED_NOTE, type LocalTool } from './tools.ts';
import { WEB_FETCH, webFetchOffered, type WebPage, type WebToolEnv } from './web-tool.ts';
import { approvedPrivateSteps, REFUSED_SAVED, refusedSaved, requestSavedPrivate, WAITING_PRIVATE } from './saved-ask.ts';
import { approvedRedo, BROWSER_ACTION_EVENT, PAGE_CHANGED, browserChatSite, browserOffered, browserReplay, browserResults, browserTool, promisesClose, requestBrowserOpen, requestBrowserSend, WAITING_BROWSER, WAITING_SEND, type BrowserToolEnv } from './browser-tool.ts';
import { INCOGNITO_OFF_TOOLS, isIncognitoConversation } from '../incognito.ts';
import type { MacEnv } from '../mac-files.ts';
import { MAC_READ_ONLY_ERROR, MAC_READ_ONLY_REPLY, MAC_RESULT_LABEL, macConversation, macFilesInPlay, macRedo, macReplay, macResults, macTool, requestMacRead, WAITING_MAC } from './mac-tool.ts';
import { runTrialChat, trialModelOf } from './trial-chat.ts';
import { decisionAnswer, isSecretaryTool, runSecretaryTool, secretaryReplay } from './secretary.ts';
import { PLAN_TOOL, planDecisionAnswer, planReplay, runPlanTool } from './plans.ts';
import { plannerFor, plannerModelOf, writePlan } from './claude-plan.ts';
import { planCardStep, planRequestStep } from './plan-job.ts';
import { planningOf } from '../card-plans.ts';
import { budgetOf } from './routing.ts';
import {
  cardBrief,
  loadCardReturns,
  returnNoteText,
  cardEnd,
  cardLabel,
  cardRepo,
  choiceOf,
  choosesWay,
  chosenExecutor,
  cloudOf,
  defaultWay,
  executorOptions,
  isAgentCard,
  localCardRequest,
  noWayReason,
  approvedRepo,
  delegationExecutorApproval,
  notStartedText,
  outOfQuotaOf,
  pendingExecutorApproval,
  preferredWay,
  requestDelegationExecutor,
  requestExecutor,
  waysFor,
} from './card-run.ts';
import { isSecretaryConversation } from '../commitments.ts';
import { sideContext } from '../side-threads.ts';
import { loadTurns, recordTurn, type NewTurn, type Turn } from './turns.ts';
import { ADDRESSED_REASON, addressedBrief, addressedTask, MAX_INTERVENTIONS, MAX_PER_AGENT, type AddressedTask } from '../addressed.ts';

/**
 * The local orchestrator (task 1.10, D-053): one model call per engine step.
 * The model reads the conversation up to the message that started the task,
 * then the task's own turns, and answers with one action of the response
 * schema shared with the acceptance test (D-036, D-051, D-052). A tool call
 * or a plan continues the task; a reply, a question or a refusal is written
 * in the chat and ends it.
 *
 * The context is per task (docs/PRIVACY-POLICY-SPEC.md): a task reads its
 * conversation, never another task's turns. What the model reads passes the
 * gateway towards the local executor and is logged in gateway_log; the model
 * gets `decision.texts`. Every turn carries the highest label it read, and
 * the database raises the task's label to it.
 *
 * A `task.delegate` call opens a delegation (D-055): the next step of the
 * task runs on Claude Code (delegate.ts), and the step after reads its
 * report as the result of the call.
 *
 * In a work system chat where the user chose Claude (D-064, second part),
 * the whole step runs on Claude instead, without tools (claude-direct.ts).
 */
export const ORCHESTRATOR_EXECUTOR = 'local';
/** The model alias of the orchestrator role (docs/ROUTER-SPEC.md, planning and judgement). */
export const ORCHESTRATOR_MODEL = 'local-large';

/** Tools that end the step with a message in the chat instead of running. */
const CHAT_TOOLS: readonly ToolId[] = ['user.ask'];
const DELEGATE: ToolId = 'task.delegate';
const UPDATE: ToolId = 'task.update';
const PLAN: ToolId = PLAN_TOOL;
/** Longest message, tool result or turn shown to the model. */
const MAX_TEXT = 8_000;

export interface OrchestratorOptions {
  sql: Sql;
  agents: ReadonlyMap<string, LoadedAgent>;
  kb: Kb;
  /**
   * The local model of the current configuration, asked at every call: a
   * model changed for a role in arianna.toml applies at the next step (1.18).
   */
  model: () => LocalModel;
  /** The current configuration: cloud executors and projects for delegation. */
  settings: () => AriannaConfig;
  rules: LabelRules;
  /** The `claude -p` adapter, when `claude` is enabled and runs on this machine. */
  claude?: ClaudeExecutor;
  /** The `codex exec` adapter (D-140), when it runs on this machine; enabled or not is read at each step. */
  codex?: CodexExecutor;
  /** What Claude reads first when it answers a system chat directly (claude-direct.ts); for tests. */
  directPrompt?: string;
  /** What Claude reads first in the plain chat with the user (claude-direct.ts, D-111 tappa B); for tests. */
  chatPrompt?: string;
  /** What ChatGPT reads first in its plain chat with the user (claude-direct.ts, D-212); for tests. */
  codexChatPrompt?: string;
  /** What Claude reads first in a chat with a person of the series (character-chat.ts, D-225); for tests. */
  characterChatPrompt?: string;
  /** What Claude reads first when it writes the cards of a plan (claude-plan.ts); for tests. */
  plannerPrompt?: string;
  /** Room for the thought and the answer. Default 2048 (D-052). */
  maxTokens?: number;
  /** The local model serving one catalog model, for its trial chat (D-142); without it a trial chat waits for the user. */
  trialModel?: (modelId: string) => LocalModel;
  /** The skills block of an agent's delivery (D-161), with the style and skills of a Designer card (D-163); absent, no agent reads skills. */
  skills?: (agent: string, maxBytes: number, card?: CardDesign, ceiling?: Label) => AgentSkills;
  /** Claude's opinion on the difficulty of an unsure step (D-207); absent, the rules alone decide. */
  advise?: Advise;
  /** Arianna's MCP server for the Coder's runs on claude (D-261, DelegateEnv.mcp); absent, no run gets it. */
  mcp?: DelegateEnv['mcp'];
  /** The IM files of the approved projects for `im.add` (D-167, P4b); absent, the tool answers with an error. */
  ims?: ImToolEnv;
  /**
   * A chat reply of a character switched on is written once more at LIVELY_TEMPERATURE (D-225, tappa A). Off by
   * default: main.ts turns it on; a test with a scripted model has one answer per step.
   */
  livelyReplies?: boolean;
  /**
   * A chat reply is written once more as free text in Markdown, without the schema (D-251): the JSON decides, the
   * second call writes what the user reads. Off by default: main.ts turns it on; a test with a scripted model has one
   * answer per step.
   */
  freeReplies?: boolean;
  /** data/attachments (D-247): the images attached in a private chat, read by the `vision` model; without it they stay unread. */
  attachmentsDir?: string;
  /** Tests: the downloader of `web.fetch` (D-262), with fake pages; without it the network of link-fetch.ts. */
  fetchLink?: WebToolEnv['fetchLink'];
  /** The browser of Arianna (D-264, passo 3) and whether its image is built; absent, the browser tools are never offered. */
  browser?: { agent: BrowserToolEnv['browser']; installed: () => boolean };
  /** The folders of the Mac (D-314, I-22, tappa M1): the home and what is never read; absent, the mac tools are never offered. */
  mac?: MacEnv;
  /** The clock of the line of now at the end of each request to the local model (D-311); tests fix it. Default: the time of this Mac. */
  now?: () => Date;
  /** The time zone of that line; default the one of this Mac (systemTimeZone). */
  timeZone?: string;
}

/**
 * The tools of a card the orchestrator can offer now: `task.delegate` only
 * when a cloud executor can take the step, `task.update` only when the
 * conversation had an open card to update when the task started (cards.ts,
 * fixed for the whole task). Without one the tool has no valid target, and a
 * local model would reach for it to move its own task instead of asking.
 * In an incognito conversation (D-136) none of INCOGNITO_OFF_TOOLS: what
 * they write would outlive the closing. `task.plan` (D-159) everywhere but
 * the secretary's conversation: the plan is approved in the chat.
 * `profile.read` (D-114, tappa B) only when `profile`: the tail of the prompt
 * shows the topics alone, so that the model has a text to read with it; the
 * prompt of a user without such a profile stays the same byte for byte.
 * `profile.share` (D-114, tappa C) only with `shares` (the profile holds a
 * fact) and where `task.delegate` is offered: it gives a fact to a delegation.
 * `routine.propose` (D-256) only with `routines`: a conversation of Arianna,
 * never incognito nor the secretary's; the tool itself writes a routine only
 * in a private one (routineProposalAllowed).
 * `milestone.propose` (D-313, seguito 2) only with `milestones`: a
 * conversation of Arianna, never incognito nor the secretary's.
 * `web.fetch` (D-262) only with `web`: a step whose context is at most
 * Internal, without finance data, not incognito (webFetchOffered).
 * The browser tools (D-264, passo 3) only with `browser`: the same steps as
 * `web.fetch`, once the browser image is built (browserOffered).
 * The tools of the folders of the Mac (D-314) only with `mac`: a private
 * conversation of the user with Arianna (macConversation); in incognito they
 * are offered and answer that they read nothing there.
 */
export function orchestratorTools(
  agent: LoadedAgent,
  delegation = false,
  cards = false,
  incognito = false,
  secretary = false,
  profile = false,
  shares = false,
  routines = false,
  web = false,
  browser = false,
  mac = false,
  milestones = false,
): ToolId[] {
  return offerable(agent.card.tools).filter(
    (tool) =>
      !(incognito && (INCOGNITO_OFF_TOOLS as readonly string[]).includes(tool)) &&
      ((isLocalTool(tool) &&
        (tool !== UPDATE || cards) &&
        (tool !== PROFILE_READ || profile) &&
        (tool !== PROFILE_SHARE || (delegation && !secretary && shares)) &&
        (tool !== ROUTINE_PROPOSE || (routines && !incognito && !secretary)) &&
        (tool !== MILESTONE_PROPOSE || (milestones && !incognito && !secretary)) &&
        (tool !== WEB_FETCH || (web && !incognito))) ||
        (browser && !incognito && isBrowserTool(tool)) ||
        (mac && isMacTool(tool)) ||
        CHAT_TOOLS.includes(tool) ||
        // The secretary's conversation (D-144) hands no step to another agent: a commitment never leaves in a brief.
        (delegation && !secretary && tool === DELEGATE) ||
        (!secretary && tool === PLAN) ||
        // The commitments only there, never in an incognito conversation (what they note outlives it).
        (secretary && !incognito && isSecretaryTool(tool))),
  );
}

/**
 * The tools of the Private chat of an access (D-281), while it holds the
 * browser of that access: the browser tools and user.ask, as the card lists
 * them; nothing that reads other data or hands the step to another agent.
 */
export function browserChatTools(agent: LoadedAgent): ToolId[] {
  return offerable(agent.card.tools).filter((tool) => isBrowserTool(tool) || CHAT_TOOLS.includes(tool));
}

const PROFILE_READ = 'profile.read' satisfies ToolId;
const PROFILE_TOOLS: readonly string[] = [PROFILE_READ, PROFILE_SHARE, PROFILE_PROPOSE];

/** How a message of the system starts when the model reads it. */
export const SYSTEM_MESSAGE_MARK = '[Messaggio del sistema, non dell’utente]';

function clip(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n[cut at ${String(MAX_TEXT)} characters]` : text;
}

/** How the model reads the outcome of a delegation at the step after it. */
function delegationResult(delegation: Delegation | undefined): { text: string; label: Label } {
  if (delegation === undefined) return { text: `error: ${DELEGATE}: the delegation was not recorded`, label: 'L0' };
  switch (delegation.status) {
    case 'ok':
      return { text: `${delegation.agent} (${delegation.executor ?? ''}/${delegation.model ?? ''}) reported:\n${clip(delegation.result ?? '')}`, label: delegation.resultLabel ?? delegation.label };
    case 'failed':
    case 'refused':
      return { text: delegation.result ?? `error: ${DELEGATE}: failed`, label: delegation.resultLabel ?? delegation.label };
    case 'pending':
    case 'running':
      return { text: `delegation to ${delegation.agent} in progress`, label: 'L0' };
  }
}

/** What the model reads, each part with its label: the conversation, then the task's turns. */
async function historyOf(
  sql: Sql,
  agents: ReadonlyMap<string, LoadedAgent>,
  task: Task,
  turns: readonly Turn[],
  delegations: readonly Delegation[],
  computed?: ConversationView,
): Promise<Labeled<TurnMessage>[]> {
  const history: Labeled<TurnMessage>[] = [];
  if (task.conversationId === null) {
    // A task without a conversation: its title and goal are the request.
    // A card of an agent that writes files elsewhere reads that here it does not (D-159).
    const content = isAgentCard(task) ? localCardRequest(task, agents.get(task.assignee)?.card) : [task.title, task.goal].filter((part) => part !== null && part !== '').join('\n\n');
    history.push({ value: { role: 'user', content }, label: task.label, source: `task:${task.id}` });
  } else {
    // Up to the message that started this task: later ones belong to other tasks.
    // The summary of what the anchor left behind first, then the messages from
    // the anchor (D-077). Reports of delegated steps are read from their
    // delegation, not as messages. Messages of the system (a system chat,
    // D-064) reach the model as the user's, marked: chat templates take one
    // system prompt, at the start.
    const view = computed ?? (await conversationView(sql, task.conversationId, task.id, MAX_TEXT));
    // A side thread (D-232) reads the answer it is about, and the messages of its mother before it, first.
    const side = view.messages.length === 0 ? undefined : await sideContext(sql, task.conversationId);
    if (side !== undefined) history.push(side);
    const summary = summaryMessage(view.pieces);
    if (summary !== undefined) history.push(summary);
    // The images and files of the user's messages (D-247): after each message, each part L2.
    const userIds = view.messages.filter((row) => row.role === 'user').map((row) => row.id);
    const attached = withinBudget(await attachmentsOf(sql, userIds), userIds);
    for (const row of view.messages) {
      const value: TurnMessage =
        row.role === 'system' ? { role: 'user', content: `${SYSTEM_MESSAGE_MARK}\n${clip(row.body)}` } : { role: row.role, content: clip(row.body) };
      history.push({ value, label: row.label, source: `message:${row.id}` });
      const parts = attached.get(row.id);
      if (parts !== undefined) history.push(...attachmentHistory(parts));
    }
    // Who else is here (D-125): the agents that joined before this task, as a note of the system after
    // the chat, never in the system prompt. The same for every step of the task, so its prefix stays.
    const present = history.length === 0 ? [] : await participantsAt(sql, task.conversationId, task.createdAt);
    const note = participantsNote(present);
    if (note !== undefined) {
      const label = maxLabel(...present.map((name) => nameLabelOf(agents.get(name))));
      history.push({ value: { role: 'user', content: `${SYSTEM_MESSAGE_MARK}\n${note}` }, label, source: `participants:${task.conversationId}` });
    }
  }
  // A profile.share the user decided (D-114, tappa C): the model reads the decision, never the text.
  // A waiting share (D-114) or link to another site (D-264): the model reads the decision of the user.
  // A waiting card of a folder of the Mac (D-314): the model reads the decision of the user.
  const shared = new Map([...(await shareResults(sql, task.id, turns)), ...(await browserResults(sql, task.id, turns)), ...(await macResults(sql, task.id, turns))]);
  // A card sent back (D-235): each note after the turns before it, as the user's.
  const returns = task.conversationId === null ? await loadCardReturns(sql, task.id) : [];
  let nextReturn = 0;
  let reportedUpTo = 0;
  const notesUpTo = (step: number): void => {
    for (let note = returns[nextReturn]; note !== undefined && note.afterStep < step; note = returns[nextReturn]) {
      // A delegation of the card before the note (it ran in the cloud): its report first, as the brief of a new delegation has it.
      const done = delegations.filter((item) => item.status === 'ok' && item.result !== null && item.step > reportedUpTo && item.step <= note.afterStep).at(-1);
      if (done?.result !== undefined && done.result !== null) {
        const files = (done.files ?? []).map((file) => `- ${file.path}`);
        const content = [`Your report last time:\n${done.result}`, ...(files.length === 0 ? [] : [`Files you changed last time:\n${files.join('\n')}`])].join('\n\n');
        history.push({ value: { role: 'user', content }, label: done.resultLabel ?? done.label, source: `delegation:${task.id}:${String(done.step)}` });
      }
      reportedUpTo = note.afterStep;
      history.push({ value: { role: 'user', content: returnNoteText(note.note) }, label: note.label, source: `card-return:${task.id}:${String(nextReturn)}` });
      nextReturn += 1;
    }
  };
  for (const turn of turns) {
    notesUpTo(turn.step);
    const source = `turn:${task.id}:${String(turn.step)}`;
    history.push({ value: { role: 'assistant', content: answerText(turn.answer) }, label: turn.label, source });
    if (turn.result !== null) {
      // What a tool of the Mac returned (D-314) keeps the source `mac:`: Private wherever it goes next, whatever its label.
      const resultSource = turn.answer.action === 'call' && isMacTool(turn.answer.tool) ? `mac:${source}` : source;
      history.push({ value: { role: 'tool', content: clip(shared.get(turn.step) ?? turn.result) }, label: turn.label, source: resultSource });
    } else if (turn.answer.action === 'call' && turn.answer.tool === DELEGATE) {
      // A call that opened a delegation: its outcome is the result.
      const result = delegationResult(delegations.find((delegation) => delegation.step === turn.step));
      history.push({ value: { role: 'tool', content: result.text }, label: result.label, source: `delegation:${task.id}:${String(turn.step)}` });
    }
  }
  notesUpTo(Number.MAX_SAFE_INTEGER);
  return history;
}

/** What separates two messages of the same role joined into one. */
export const JOIN_SEPARATOR = '\n\n';

/**
 * Consecutive messages of the same role joined into one (D-092): chat
 * templates that require user and assistant to alternate (Gemma) reject or
 * mangle two `user` messages in a row, as a system message, the summary
 * (D-077) and the user's question can be. `tool` results are never joined:
 * each is fenced on its own (chatMessages). The order stays; the joined
 * entry carries the highest label of its parts and their sources, `+`-separated.
 *
 * Deterministic and append-only for the prefix cache (D-075): the same
 * parts give the same bytes, and a part added at the end changes only the
 * last entry, and only when it has the same role, by appending
 * `JOIN_SEPARATOR` and its text: every byte before stays where it was.
 * An empty part adds no separator (its label and source still count).
 *
 * chatMessages (packages/agents/src/protocol.ts) sends a `tool` result as
 * `user`: a `tool` followed by a `user` would still be two user messages in
 * the template. It does not happen today: the task's turns (assistant, then
 * its result) always come after the messages of the chat.
 */
export function joinSameRole(parts: readonly Labeled<TurnMessage>[]): Labeled<TurnMessage>[] {
  const joined: Labeled<TurnMessage>[] = [];
  for (const part of parts) {
    const last = joined.at(-1);
    if (last !== undefined && last.value.role === part.value.role && part.value.role !== 'tool') {
      joined[joined.length - 1] = {
        value: { role: last.value.role, content: [last.value.content, part.value.content].filter((text) => text !== '').join(JOIN_SEPARATOR) },
        label: maxLabel(last.label, part.label),
        source: `${last.source}+${part.source}`,
      };
    } else {
      joined.push({ value: { ...part.value }, label: part.label, source: part.source });
    }
  }
  return joined;
}

/** The text a chat action writes for the user, or undefined for a call or a plan. */
function chatText(answer: Answer): string | undefined {
  switch (answer.action) {
    case 'reply':
      return answer.text;
    case 'refuse':
      return answer.reason;
    case 'call':
      return CHAT_TOOLS.includes(answer.tool) ? String(answer.arguments.question) : undefined;
    case 'plan':
      return undefined;
  }
}

/**
 * What the step after a `task.delegate` call does: a plan of the delegation,
 * or for an agent with `executor_choice: ask` (D-159) the user's choice to
 * wait for (`choose`) or the "Non ora" to answer (`declined`).
 */
type StepPlan = DelegationPlan | { kind: 'choose'; delegation: Delegation; approvalId: string } | { kind: 'declined'; delegation: Delegation; label: Label };

/** The result of a delegation the user chose not to start now (D-159). */
const NOT_STARTED = 'the user chose not to start this work now';

// Shown to the model after its plan, so that the next step acts on it.
const PLAN_NOTED = 'Plan noted. Now carry out its first step with one tool call, or reply if nothing is left to do.';

/** The temperature of the second writing of a character's chat reply (D-225, tappa A). */
export const LIVELY_TEMPERATURE = 0.7;

/** Where the block of a person of the series comes from (`seriesSource`, D-214): `character:serie/<id>`. */
const SERIES_SOURCE_PREFIX = seriesSource('');

/**
 * Whether the pieces of a step read within `label` may go live to the chat
 * (D-249): the checks `finish` applies to the stored reply, before the text
 * exists. Above the conversation's clearance the reply is refused, and L3
 * never reaches the web channel (the gateway blocks it).
 */
export function showsLive(label: Label, clearance: Label): boolean {
  return isAtMost(label, clearance) && label !== 'L3';
}

/**
 * The reply of the second writing (D-225), when it is a reply with a text;
 * otherwise the first, as it was: a tool or a refusal there changes nothing.
 */
export function livelierReply(first: ReadAnswer, second: ReadAnswer | undefined): ReadAnswer {
  return second?.answer.action === 'reply' && second.answer.text.trim() !== '' ? second : first;
}

/**
 * The thinking stored with an answer of the local orchestrator (D-249): the
 * thoughts of the steps since the task's last answer and this step's, one
 * paragraph each, with their times added up. Nothing when no step thought:
 * the reply then keeps what came live (the reasoning a server sends apart).
 */
export function answerThought(turns: readonly Pick<Turn, 'thought' | 'thoughtMs' | 'messageId'>[], thought: string | undefined, thoughtMs: number | undefined): { thought?: string; thoughtMs?: number } {
  const lastAnswer = turns.findLastIndex((turn) => turn.messageId !== null);
  const steps = [...turns.slice(lastAnswer + 1).map((turn) => ({ thought: turn.thought ?? undefined, thoughtMs: turn.thoughtMs ?? undefined })), { thought, thoughtMs }];
  const texts = steps.flatMap((step) => (step.thought === undefined || step.thought.trim() === '' ? [] : [step.thought.trim()]));
  if (texts.length === 0) return {};
  const times = steps.flatMap((step) => (step.thoughtMs === undefined ? [] : [step.thoughtMs]));
  return { thought: texts.join('\n\n'), ...(times.length === 0 ? {} : { thoughtMs: times.reduce((sum, ms) => sum + ms, 0) }) };
}

/**
 * The orchestrator, and who may do a card of a plan now (D-235): the user and the agents the planner may choose.
 * `warmupRequests` (D-316): the requests that warm the local model, see there.
 */
export type Orchestrator = StepExecutor & { planAssignees(): string[]; warmupRequests(): Promise<WarmupRequest[]> };

/** Which first step a warm-up request copies (D-316, with D-314): a new private conversation, or a new work one without a project. */
export type WarmupPart = 'private' | 'work';
export interface WarmupRequest {
  part: WarmupPart;
  request: ChatRequest;
}

/** The message of the warm-up (D-316): fixed, L0, never a word of the user's. */
export const WARMUP_MESSAGE = 'Ciao';

export function createOrchestrator(options: OrchestratorOptions): Orchestrator {
  const { sql } = options;
  const env: DelegateEnv = {
    sql,
    agents: options.agents,
    settings: options.settings,
    rules: options.rules,
    model: options.model,
    ...(options.claude === undefined ? {} : { claude: options.claude }),
    ...(options.codex === undefined ? {} : { codex: options.codex }),
    ...(options.directPrompt === undefined ? {} : { directPrompt: options.directPrompt }),
    ...(options.chatPrompt === undefined ? {} : { chatPrompt: options.chatPrompt }),
    ...(options.codexChatPrompt === undefined ? {} : { codexChatPrompt: options.codexChatPrompt }),
    ...(options.characterChatPrompt === undefined ? {} : { characterChatPrompt: options.characterChatPrompt }),
    ...(options.plannerPrompt === undefined ? {} : { plannerPrompt: options.plannerPrompt }),
    ...(options.skills === undefined ? {} : { skills: options.skills }),
    ...(options.advise === undefined ? {} : { advise: options.advise }),
    ...(options.mcp === undefined ? {} : { mcp: options.mcp }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
  };
  /** What `plan` decided for a step with an open delegation, for its `run`. */
  const plans = new Map<string, StepPlan>();
  /** What `plan` decided about Claude (or ChatGPT, D-212) answering directly (null: Arianna answers), for its `run`. */
  const directs = new Map<string, DirectTarget | null>();
  const summaryEnv = { sql, model: options.model };
  const attachmentEnv = { sql, model: options.model, dir: options.attachmentsDir };
  const localSpec = (task: Task): RunSpec => ({ agent: task.assignee, executor: ORCHESTRATOR_EXECUTOR, locality: 'local', model: ORCHESTRATOR_MODEL });

  /** One line of activity in the chat (D-054); a card's is saved for its detail (D-235). Never fails the step. */
  async function show(task: Task, step: number, kind: ActivityKind, detail = ''): Promise<void> {
    if (task.conversationId === null) {
      await postCardActivity(sql, { taskId: task.id, step, kind, detail }).catch(() => undefined);
      return;
    }
    await postActivity(sql, { conversationId: task.conversationId, taskId: task.id, step, kind, detail }).catch(() => undefined);
  }

  async function ask(
    tools: readonly ToolId[],
    prompt: string,
    history: readonly TurnMessage[],
    signal: AbortSignal,
    delegates: readonly DelegateTarget[],
    planner: Planner,
    tail: string,
    trailer = '',
    lively = false,
    live?: ChatReply,
    free = false,
  ): Promise<{ read: ReadAnswer | undefined; tokensIn: number; tokensOut: number; thoughtMs?: number; draftKept?: DraftReason }> {
    // Tokens of both calls count, the discarded one too.
    let tokensIn = 0;
    let tokensOut = 0;
    // The thinking of the first call, live in the chat (D-249): the `thought` field as the JSON arrives,
    // and the reasoning a server sends apart; the reply's text too, unless a livelier one or the free text (D-251) may replace it.
    let thoughtMs: number | undefined;
    let shown: Promise<void> = Promise.resolve();
    const queue = (send: () => Promise<void>): void => {
      // In order, one at a time; a piece refused (a vault secret) or a failed notice is dropped, the step goes on.
      shown = shown.then(send).catch(() => undefined);
    };
    const watching = (): Pick<ChatRequest, 'onText' | 'onReasoning'> & { ended: () => number | undefined } => {
      if (live === undefined) return { ended: () => undefined };
      const fields = new JsonFieldStream();
      const started = performance.now();
      let ended: number | undefined;
      return {
        onText: (piece) => {
          for (const field of fields.feed(piece)) {
            if (field.key === 'thought') queue(() => live.thought(field.text));
            else if (field.key === 'text' && !lively && !free && fields.values.get('action') === 'reply') queue(() => live.delta(field.text));
          }
          // The thought is over once the next field starts.
          if (ended === undefined && fields.values.has('thought') && fields.values.size > 1) ended = performance.now() - started;
        },
        onReasoning: (piece) => {
          queue(() => live.thought(piece));
        },
        ended: () => ended,
      };
    };
    const messagesOf = (thought: boolean) => chatMessages(prompt, tools, history, thought, tail, delegates, planner, trailer);
    const call = async (thought: boolean, temperature = 0, watch = false) => {
      const watched = watch ? watching() : undefined;
      const result = await options.model().chat({
        model: ORCHESTRATOR_MODEL,
        messages: messagesOf(thought),
        schema: { name: RESPONSE_SCHEMA_NAME, schema: responseSchema(tools, thought, delegates, planner) },
        temperature,
        maxTokens: options.maxTokens ?? 2048,
        signal,
        // Streamed, the token counts come only when asked for (D-199).
        ...(watched?.onText === undefined ? {} : { onText: watched.onText, streamUsage: true }),
        ...(watched?.onReasoning === undefined ? {} : { onReasoning: watched.onReasoning }),
      });
      await shown;
      const ended = watched?.ended();
      if (ended !== undefined) thoughtMs = Math.round(ended);
      tokensIn += result.usage?.promptTokens ?? 0;
      tokensOut += result.usage?.completionTokens ?? 0;
      return readAnswer(result.value, tools, thought, delegates, planner);
    };
    let read: ReadAnswer | undefined;
    let thought = true;
    let draftKept: DraftReason | undefined;
    try {
      read = await call(true, 0, true);
    } catch (error) {
      if (!(error instanceof LocalModelError) || error.kind !== 'bad-response') throw error;
    }
    // Not JSON, or outside the schema: once more without the thought (D-052).
    if (read === undefined) {
      thought = false;
      thoughtMs = undefined;
      read = await call(false);
    }
    // The reply written as free text (D-251), from the JSON's draft: same messages, then the draft and an instruction.
    // For a character it is the livelier writing too, at LIVELY_TEMPERATURE, instead of a second JSON.
    if (free && read?.answer.action === 'reply') {
      const written = await writeFreeReply(options.model(), {
        model: ORCHESTRATOR_MODEL,
        messages: messagesOf(thought),
        draft: read.answer.text,
        temperature: lively ? LIVELY_TEMPERATURE : 0,
        signal,
        ...(live === undefined
          ? {}
          : {
              onText: (piece: string) => {
                queue(() => live.delta(piece));
              },
            }),
      });
      await shown;
      tokensIn += written.tokensIn;
      tokensOut += written.tokensOut;
      draftKept = written.draftKept;
      read = { ...read, answer: { action: 'reply', text: written.text } };
    } else if (lively && read?.answer.action === 'reply') {
      // A chat reply of a character (D-225, tappa A): the same request once more at LIVELY_TEMPERATURE,
      // byte for byte (the cache of oMLX holds its prompt), for a less rigid voice. The first call chose
      // the reply at temperature 0; the second is kept only when it is a reply too, never a tool.
      try {
        read = livelierReply(read, await call(thought, LIVELY_TEMPERATURE));
      } catch (error) {
        // Stopped: the engine decides. Any other failure of the local model keeps the first reply.
        if (signal.aborted || !(error instanceof LocalModelError)) throw error;
      }
    }
    return { read, tokensIn, tokensOut, ...(thoughtMs === undefined || read?.thought === undefined ? {} : { thoughtMs }), ...(draftKept === undefined ? {} : { draftKept }) };
  }

  /**
   * The Claude model that answers this task directly: in a work system chat
   * where the user chose one, while Claude can run and what it would read
   * (the task and the chat) is within L1. `label` is that, for the run's
   * record. Otherwise Arianna answers on the local model. In the plain chat
   * with ChatGPT (D-212) the same, on `codex`.
   */
  async function directFor(task: Task): Promise<{ target: DirectTarget; label: Label } | undefined> {
    if (task.conversationId === null) return undefined;
    const target = directTargetOf(await loadConversation(sql, task.conversationId), enabledCloudModels(env.settings().cloud));
    if (target === undefined || !canAnswerDirectly(env, target.executor)) return undefined;
    const history = await historyOf(sql, options.agents, task, [], []);
    const label = maxLabel(task.effectiveLabel, ...history.map((part) => part.label));
    return isAtMost(label, 'L1') ? { target, label } : undefined;
  }

  /**
   * The step that follows a `task.delegate` call: planned by the router, or
   * closed here. In the direct chat (D-111) the delegation was written with
   * the user's message, at the task's first step: no local step comes before it.
   */
  async function delegationPlanFor(task: Task, step: number, direct: boolean): Promise<StepPlan | undefined> {
    const delegation = await openDelegation(sql, task.id);
    if (delegation === undefined || (delegation.step >= step && !direct)) return undefined;
    if (isAgentCard(task)) {
      // The cloud executor the user chose for a card (D-159): the router takes that one only.
      // With prefer-first and no choice of the user's, the first executor of the card (cardStart took it, D-298).
      const card = options.agents.get(task.assignee)?.card;
      const ask = card !== undefined && choosesWay(card);
      const chosen = ask ? await chosenExecutor(sql, task.id) : undefined;
      const only = ask ? cloudOf(chosen ?? (card.executorChoice === 'prefer-first' ? card.executors[0] : undefined)) : undefined;
      // An agent that asks never delegates without a cloud choice of the user's: the delegation is closed, never routed.
      if (ask && only === undefined) {
        return { kind: 'closed', delegation, status: 'refused', result: `error: task.delegate: the user did not choose a cloud executor for ${task.assignee}` };
      }
      return planDelegation(env, task, delegation, only);
    }
    // A delegation of the chat to an agent that asks (D-159): only the way the user chose for it. The direct chat
    // does not ask: the user chose who answers, and that it goes to the cloud, when the conversation was created (D-111).
    const target = options.agents.get(delegation.agent);
    if (direct || target === undefined || !choosesWay(target.card)) return planDelegation(env, task, delegation);
    const asked = await delegationExecutorApproval(sql, delegation);
    if (asked === undefined) {
      // prefer-first (D-298): no choice was asked because the first executor could take the work; checked again here.
      const first = target.card.executorChoice === 'prefer-first' ? target.card.executors[0] : undefined;
      if (first === undefined) {
        return { kind: 'closed', delegation, status: 'refused', result: `error: task.delegate: the user did not choose where ${delegation.agent} works` };
      }
      const now = waysFor(env, target.card, delegation.label, approvedRepo(env, delegation.repo), outOfQuotaOf(await budgetOf(sql)));
      if (preferredWay(target.card, now) === undefined) {
        return { kind: 'closed', delegation, status: 'refused', result: `error: task.delegate: ${first} can no longer take this work: tell the user, who may ask again` };
      }
      return planDelegation(env, task, delegation, first);
    }
    if (asked.state === 'pending') return { kind: 'choose', delegation, approvalId: asked.id };
    if (asked.state !== 'approved' || asked.choice === undefined) return { kind: 'declined', delegation, label: asked.label };
    // Checked again: what was allowed when the user chose may not be now (the work above L1, the executor off).
    const ways = waysFor(env, target.card, delegation.label, approvedRepo(env, delegation.repo));
    if (!ways.options.includes(asked.choice)) {
      return { kind: 'closed', delegation, status: 'refused', result: `error: task.delegate: ${asked.choice} can no longer take this work: tell the user, who may ask again` };
    }
    return planDelegation(env, task, delegation, asked.choice);
  }

  /**
   * A step that delegated to an agent that asks (a crash after its turn,
   * D-159): it waits again while the choice is pending; decided, the next
   * step reads it. Undefined for any other turn.
   */
  async function executorReplay(turn: Turn, delegations: readonly Delegation[]): Promise<StepOutcome | undefined> {
    if (turn.answer.action !== 'call' || turn.answer.tool !== DELEGATE || turn.result !== null) return undefined;
    const delegation = delegations.find((candidate) => candidate.step === turn.step);
    if (delegation?.status !== 'pending') return undefined;
    const asked = await delegationExecutorApproval(sql, delegation);
    if (asked === undefined) return undefined;
    return asked.state === 'pending' ? { kind: 'confirm', approvalId: asked.id, usage: { steps: 0 } } : { kind: 'continue', usage: { steps: 0 } };
  }

  /** "Non ora" on the choice for a delegation (D-159): the delegation ends, Arianna says so without the model. */
  async function notStarted(ctx: StepContext, delegation: Delegation, label: Label): Promise<StepOutcome> {
    const { task, runId } = ctx;
    await updateDelegation(sql, delegation.id, { status: 'refused', result: `error: ${DELEGATE}: ${NOT_STARTED}`, resultLabel: delegation.label });
    if (task.conversationId === null) return { kind: 'wait-user', reason: `the user did not choose where ${delegation.agent} works`, usage: { steps: 0 } };
    const reply = await openReply(sql, task.id, { runId });
    const result = await reply.finish(notStartedText(delegation.agent), maxLabel(task.effectiveLabel, label));
    if (!result.stored) {
      return { kind: 'wait-user', reason: result.reason === 'blocked' ? 'the gateway blocked the answer' : 'the answer is above what the conversation may hold', usage: { steps: 0 } };
    }
    return { kind: 'answered', messageId: result.message.id, usage: { steps: 0 } };
  }

  /**
   * The first step of a card of an agent (D-159): the way it runs. Undefined:
   * on the local model, through the steps below. Otherwise the outcome: the
   * user's choice to wait for, or the card's delegation opened at this step
   * (with the declassification of the card when it is above what the agent
   * may send to the cloud); the next step runs it.
   */
  async function cardStart(ctx: StepContext, agent: LoadedAgent): Promise<StepOutcome | undefined> {
    const { task, step } = ctx;
    // Already at work on the local model: the steps go on, while the card stays within what the agent may read.
    if ((await loadTurns(sql, task.id)).length > 0) {
      if (isAtMost(cardLabel(task), agent.card.maxLabel)) return undefined;
      return { kind: 'wait-user', reason: `the card is above what ${task.assignee} may read (${agent.card.maxLabel}): the local model does not take it`, usage: { steps: 0 } };
    }
    const latest = (await loadDelegations(sql, task.id)).at(-1);
    // Sent back after its last delegation, or with none (D-235): a new one starts with the note.
    const sentBack = (await loadCardReturns(sql, task.id)).at(-1);
    const fresh = sentBack !== undefined && (latest === undefined || sentBack.afterStep >= latest.step);
    // The brief of a card sent back carries its last report and the note: the ways are chosen on the highest of their labels.
    const last = fresh ? latest : undefined;
    const briefLabel = sentBack !== undefined && fresh ? maxLabel(cardLabel(task), sentBack.label, last?.resultLabel ?? 'L0') : cardLabel(task);
    const wayTask: Task = { ...task, label: briefLabel };
    const ceiling = briefCeiling(agent.card);
    const opened = (label: Label, brief: string): StepOutcome =>
      isAtMost(label, ceiling) ? { kind: 'continue', usage: { steps: 0 } } : { kind: 'declassify', text: brief, from: label, to: ceiling, usage: { steps: 0 } };
    // This step ran before a crash: the same outcome again, never a second delegation.
    if (latest !== undefined && latest.step === step && (latest.status === 'pending' || latest.status === 'running')) return opened(latest.label, latest.brief);
    if (!fresh && latest !== undefined && latest.step === step - 1 && latest.status !== 'pending' && latest.status !== 'running') {
      return cardEnd(task, latest, { kind: 'continue', usage: { steps: 0 } });
    }
    let only: CloudExecutor | undefined;
    if (choosesWay(agent.card)) {
      const decided = ctx.approval?.kind === 'executor' ? ctx.approval : undefined;
      if (decided?.state === 'rejected') return { kind: 'wait-user', reason: `the user did not choose where ${task.assignee} works: resume the card to choose again`, usage: { steps: 0 } };
      let choice = choiceOf(decided);
      if (choice === undefined) {
        const pending = await pendingExecutorApproval(sql, task.id);
        if (pending !== undefined) return { kind: 'confirm', approvalId: pending, usage: { steps: 0 } };
        const prefers = agent.card.executorChoice === 'prefer-first';
        const choices = executorOptions(env, agent.card, wayTask, prefers ? outOfQuotaOf(await budgetOf(sql)) : []);
        // prefer-first (D-298): a way the user already chose for this card stays, while allowed (the next step reads
        // the same choice); else the first executor of the card when it can take it. Only otherwise the user is asked.
        const earlier = prefers ? await chosenExecutor(sql, task.id) : undefined;
        choice = earlier === undefined ? preferredWay(agent.card, choices) : choices.options.includes(earlier) ? earlier : undefined;
        if (choice === undefined) {
          if (choices.options.length === 0) return { kind: 'wait-user', reason: noWayReason(task.assignee, agent.card, choices.excluded), usage: { steps: 0 } };
          return { kind: 'confirm', approvalId: await requestExecutor(sql, task, step, task.assignee, choices), usage: { steps: 0 } };
        }
      } else if (!executorOptions(env, agent.card, wayTask).options.includes(choice)) {
        // Checked again: what was allowed when the user chose may not be now.
        return { kind: 'wait-user', reason: `${choice} can no longer take this card: resume it to choose again`, usage: { steps: 0 } };
      }
      only = cloudOf(choice);
      if (only === undefined) return undefined;
    } else {
      const way = defaultWay(env, agent.card, wayTask);
      if (way === undefined) return { kind: 'wait-user', reason: noWayReason(task.assignee, agent.card, executorOptions(env, agent.card, wayTask).excluded), usage: { steps: 0 } };
      if (way === 'local') return undefined;
    }
    // The card itself is the brief, in the card's project: the way of a delegation (delegate.ts).
    // Sent back (D-235): with the last report, the files it touched and the note, at the highest of their labels.
    const brief =
      sentBack === undefined || !fresh
        ? cardBrief(task)
        : cardBrief(task, { report: last?.status === 'ok' ? last.result : null, files: (last?.files ?? []).map((file) => file.path), note: sentBack.note });
    const label = briefLabel;
    const repo = cardRepo(env, task);
    await createDelegation(sql, { taskId: task.id, step, agent: task.assignee, brief, label, ...(repo === undefined ? {} : { repo }) });
    return opened(label, brief);
  }

  /** The outcome of a card's delegated step: the card ends with it (cardEnd). */
  async function cardDone(task: Task, outcome: StepOutcome): Promise<StepOutcome> {
    return cardEnd(task, (await loadDelegations(sql, task.id)).at(-1), outcome);
  }

  /** The task is a message of the direct chat with its assignee (D-111). */
  async function isDirectChat(task: Task): Promise<boolean> {
    // The agent of the Finances (D-183) answers its marked conversation with its own tools on the local model, as Arianna does;
    // so does the local model of «Con chi parli», and the plain chats with Claude or ChatGPT answer in the step itself (D-111, tappa B).
    return task.assignee !== CHAT_AGENT && !task.finance && !answersWithoutDelegation(task.assignee) && (await directChatOf(sql, task, task.assignee)) !== undefined;
  }

  /**
   * How a task of the direct chat ends (D-111): with the agent's message, or
   * waiting for the user with why the delegation ended without one. Nobody
   * else reads the result: the local model never runs in this chat.
   */
  async function directChatEnd(task: Task, outcome: StepOutcome, runId?: string): Promise<StepOutcome> {
    if (outcome.kind !== 'continue') return outcome;
    const usage = outcome.usage;
    const delegation = (await loadDelegations(sql, task.id)).at(-1);
    if (delegation?.status === 'ok' && delegation.messageId !== null) {
      return { kind: 'answered', messageId: delegation.messageId, ...(usage === undefined ? {} : { usage }) };
    }
    // A brief the gateway refused (D-250): no other way here, so Arianna says why in the chat and the task ends.
    const refused = delegation?.status === 'failed' ? gatewayRefusalOf(delegation.result) : undefined;
    if (refused !== undefined && task.conversationId !== null) {
      const reply = await openReply(sql, task.id, runId === undefined ? {} : { runId });
      const result = await reply.finish(gatewayRefusalReply(refused, delegation?.executor ?? null), 'L0');
      if (result.stored) return { kind: 'answered', messageId: result.message.id, ...(usage === undefined ? {} : { usage }) };
    }
    const why = (delegation?.result ?? 'the delegation did not end').replace(/^error: [^:]+: /, '');
    return { kind: 'wait-user', reason: `${task.assignee} could not answer: ${why}`, ...(usage === undefined ? {} : { usage }) };
  }

  /**
   * One step of a message the user addressed to the agents (D-107, tappa B2):
   * the core writes the delegation to the next agent of the list as Arianna's
   * model would (delegateCall: gateway, caps, declassification, the user's
   * choice of the executor, the entrance in the chat), the next step runs it.
   * When every agent was asked the task answers with the last report; with
   * none, it waits for the user with why.
   */
  async function addressedStep(ctx: StepContext, addressed: AddressedTask, turns: readonly Turn[], delegations: readonly Delegation[]): Promise<StepOutcome> {
    const { task, step, runId } = ctx;
    const [message] = await sql<{ body: string }[]>`
      SELECT body FROM messages WHERE task_id = ${task.id} AND role = 'user' ORDER BY id LIMIT 1`;
    const brief = message === undefined ? undefined : addressedBrief(message.body);
    if (brief === undefined || brief === '') return { kind: 'wait-user', reason: 'the message for the agents has no text' };
    const asked = turns.filter((turn) => turn.answer.action === 'call' && turn.answer.tool === DELEGATE).length;
    const next = addressed.agents[asked];
    if (next !== undefined) {
      const args = { agent: next, brief, reason: ADDRESSED_REASON[addressed.kind] };
      const answer: Answer = { action: 'call', tool: DELEGATE, arguments: args };
      const targets = delegateTargets(env, task.assignee);
      // An agent the user may name whose executor does not run now: the user reads why, not "does not take delegated steps".
      if (!targets.some((target) => target.name === next)) {
        const error = `${next} cannot work now: its executor is off (Claude or Codex disabled in the settings, or no local model)`;
        await recordTurn(sql, { taskId: task.id, step, runId, answer, label: task.effectiveLabel, result: `error: ${DELEGATE}: ${error}` });
        await show(task, step, 'error', error);
        return { kind: 'continue', usage: { steps: 0 } };
      }
      // The brief is the user's own text: the label of the message, as the task holds it.
      return delegateCall(ctx, { taskId: task.id, step, runId, answer }, task.effectiveLabel, args, { steps: 0, tokensIn: 0, tokensOut: 0 }, targets, true);
    }
    const answered = delegations.filter((delegation) => delegation.status === 'ok' && delegation.messageId !== null).at(-1);
    if (answered?.messageId != null) return { kind: 'answered', messageId: answered.messageId };
    // Only an error says why: a report is the agent's text, never a reason to show.
    const error = [...delegations.map((delegation) => delegation.result), ...turns.map((turn) => turn.result)].findLast((result) => result?.startsWith('error: ') === true);
    const why = (error ?? 'error: nobody answered').replace(/^error: (?:[^:]+: )?/, '');
    return { kind: 'wait-user', reason: `${addressed.agents.join(', ')} could not answer: ${why}` };
  }

  /**
   * The model called `task.delegate`: the turn and the delegation are
   * written together. A brief above what the agent may read (L1 for the
   * cloud, the agent's clearance on the local model) asks the user's
   * declassification first; the next step runs the delegation (or reads why
   * it could not). Only an agent offered at this step is taken.
   */
  async function delegateCall(
    ctx: StepContext,
    turn: Omit<NewTurn, 'label' | 'result' | 'messageId'>,
    label: Label,
    args: Record<string, unknown>,
    usage: { steps: number; tokensIn: number; tokensOut: number },
    delegates: readonly DelegateTarget[],
    byUser = false,
  ): Promise<StepOutcome> {
    const { task, step } = ctx;
    const agentName = String(args.agent);
    const brief = String(args.brief).trim();
    const reason = typeof args.reason === 'string' ? args.reason.replace(/\s+/g, ' ').trim() : '';
    const target = options.agents.get(agentName);
    const where = target === undefined || !delegates.some((item) => item.name === agentName) ? undefined : delegationRoute(target.card);
    // Only a run on Claude Code or Codex works in a project folder.
    const conversation = isCloudRoute(where) && task.conversationId !== null ? await loadConversation(sql, task.conversationId) : undefined;
    const repo = isCloudRoute(where) ? repoFor(conversation?.workspace, workParts(options.settings().projects)) : undefined;
    // An agent that asks (D-159): the user chooses among the ways allowed for this work, a card's own rules.
    // With prefer-first (D-298) the first executor takes the work without asking when it can (no approval).
    const asks = target !== undefined && choosesWay(target.card) && !isAgentCard(task);
    const prefers = asks && target.card.executorChoice === 'prefer-first';
    const allowed = asks ? waysFor(env, target.card, label, approvedRepo(env, repo), prefers ? outOfQuotaOf(await budgetOf(sql)) : []) : undefined;
    const ways = allowed === undefined || target === undefined || preferredWay(target.card, allowed) !== undefined ? undefined : allowed;
    // The caps of one message of the user (D-107, tappa B2): agents never bounce on each other's work without end.
    const before = await loadDelegations(sql, task.id);
    let error: string | undefined;
    if (before.length >= MAX_INTERVENTIONS) error = `${String(MAX_INTERVENTIONS)} agents already worked for this message of the user: answer with what you have`;
    else if (before.filter((item) => item.agent === agentName).length >= MAX_PER_AGENT) {
      error = `${agentName} already worked ${String(MAX_PER_AGENT)} times for this message of the user: answer with what you have, or ask another agent`;
    } else if (target === undefined || where === undefined) error = `${agentName} does not take delegated steps`;
    else if (brief === '') error = 'the brief is empty';
    else if (reason === '') error = 'the reason is empty: say in one short line why you bring this agent in';
    else if (ways !== undefined && ways.options.length === 0) error = noWayReason(agentName, target.card, ways.excluded, 'work');
    // No project here (D-303): a private conversation has none, a work one may have none or one no longer approved.
    // A prefer-first card whose first way is the local model (D-298) works without a folder.
    const local = allowed !== undefined && target !== undefined && preferredWay(target.card, allowed) === 'local';
    // A change to the files of the Mac (D-314, M1: the tools only read) handed by the model to an agent that works in a
    // project, in a private conversation of the user with Arianna: our words say that the Mac is read only, never those of
    // D-303 about projects, nor a card to send the brief to a project (with a single project a private conversation has it).
    // Not when the user named the agent: then the answer is about that agent.
    const readOnly =
      error === undefined && ways === undefined && !local && !byUser && isCloudRoute(where) && conversation?.mode === 'private' && options.mac !== undefined && task.conversationId !== null &&
      (await macConversation(sql, task.conversationId)) && (await macFilesInPlay(sql, task.conversationId, task.id, brief));
    const noProject = !readOnly && error === undefined && ways === undefined && !local && isCloudRoute(where) && conversation !== undefined ? noProjectCase(conversation.mode, repo, approvedRepo(env, repo)) : undefined;
    if (readOnly || noProject !== undefined) {
      // Arianna says why with our fixed words, not the model's (D-303): there is no other way in this conversation.
      const result = `error: ${DELEGATE}: ${readOnly || noProject === undefined ? MAC_READ_ONLY_ERROR : noProjectError(agentName, noProject)}`;
      const reply = await openReply(sql, task.id, { runId: ctx.runId });
      const stored = await reply.finish(readOnly || noProject === undefined ? MAC_READ_ONLY_REPLY : noProjectReply(agentName, noProject), 'L0');
      if (!stored.stored) {
        await recordTurn(sql, { ...turn, label, result: `${UNDELIVERED} (${stored.reason})` });
        return { kind: 'wait-user', reason: undelivered(stored.reason), usage };
      }
      await recordTurn(sql, { ...turn, label, result, messageId: stored.message.id });
      return { kind: 'answered', messageId: stored.message.id, usage };
    }
    if (error === undefined && ways === undefined && !local && isCloudRoute(where) && repo === undefined) error = NO_PROJECT;
    if (error !== undefined || target === undefined) {
      const result = `error: ${DELEGATE}: ${error ?? ''}`;
      await recordTurn(sql, { ...turn, label, result });
      await show(task, step, 'error', error);
      return { kind: 'continue', usage };
    }
    // The agent joins the conversation with its first delegation there (D-125): the reason reaches the
    // chat as the model wrote it, through the gateway towards the web chat like an answer.
    const conversationId = task.conversationId;
    // Called by the user (D-219): the line says so, with no reason to pass the gateway.
    const shown = byUser || conversationId === null || (await isParticipant(sql, conversationId, agentName)) ? undefined : await reasonForChat(task, reason, label, ctx.runId);
    const asked = await sql.begin(async (tx) => {
      await recordTurn(tx, { ...turn, label });
      const delegation = await createDelegation(tx, { taskId: task.id, step, agent: agentName, brief, label, ...(repo === undefined ? {} : { repo }) });
      // The facts the user agreed to give this agent (D-114, tappa C): bound to this delegation, once.
      if (isCloudRoute(where)) await bindSharedFacts(tx, task, delegation);
      // The choice is written with the delegation: a crash leaves both or neither (the replay waits for it again).
      const approvalId = ways === undefined ? undefined : await requestDelegationExecutor(tx, task, delegation, ways);
      if (conversationId === null) return approvalId;
      await enterOnDelegation(tx, {
        conversationId,
        taskId: task.id,
        delegationId: delegation.id,
        agent: agentName,
        reason: shown,
        reasonLabel: label,
        nameLabel: nameLabelOf(target),
        byUser,
      });
      return approvalId;
    });
    await show(task, step, 'delegate', agentName);
    // Nothing leaves before the user's choice; a cloud choice is within what the agent may send there, a local one within its max_label.
    if (asked !== undefined) return { kind: 'confirm', approvalId: asked, usage };
    // The brief carries what the step has read: above what the agent may read it leaves only as the text the user approves.
    const ceiling = briefCeiling(target.card);
    return isAtMost(label, ceiling) ? { kind: 'continue', usage } : { kind: 'declassify', text: brief, from: label, to: ceiling, usage };
  }

  /**
   * The reason of a delegation as the chat may show it: allowed by the gateway
   * towards the web chat (logged in gateway_log), else undefined and the line
   * says only who joins. Never above what the task may hold.
   */
  async function reasonForChat(task: Task, reason: string, label: Label, runId: string): Promise<string | undefined> {
    if (!isAtMost(label, task.clearance)) return undefined;
    const decision = await passGateway(sql, [{ value: reason, label, source: `task:${task.id}` }], contextOf(task, label), { kind: 'channel', id: 'web' }, { taskId: task.id, runId });
    return decision.decision === 'allow' ? decision.texts[0] : undefined;
  }

  /**
   * D-316: the first step of Arianna in a new private conversation and in a new work conversation
   * without a project, as `ask` sends them, with the fixed WARMUP_MESSAGE in place of the user's and
   * one token each: oMLX loads the model, compiles the grammar of each schema and keeps the blocks
   * of each system prompt. Two: their tools differ (web.fetch only in work, D-262; the tools of the
   * folders of the Mac only in a private one, D-314), so the two prompts part from the list of tools on. Work without a
   * project because a new work conversation of the chat starts so more often than with one, and a
   * project changes nothing before the list of tools but the planner (Claude when it is on, as here).
   * The same tools as those steps (they are in the prompt and in the schema), chosen by the same
   * functions: in work, web.fetch (a first message of a work conversation is at most Internal) and
   * the browser when its image is built, never the mac tools. Whether the profile «Su di te» exists
   * only decides two tool ids, its text never enters. No persona and no profile in the tail: they
   * come after the examples, so the blocks before them (D-075) are the step's. Empty without
   * Arianna's card.
   */
  async function warmupRequests(): Promise<WarmupRequest[]> {
    const agent = options.agents.get(ORCHESTRATOR_AGENT);
    if (agent === undefined) return [];
    const privateStep = await warmupOf(agent, 'private');
    return [{ part: 'private', request: privateStep }, { part: 'work', request: await warmupOf(agent, 'work') }];
  }

  async function warmupOf(agent: LoadedAgent, part: WarmupPart): Promise<ChatRequest> {
    const tailClearance = minLabel(clearanceFor(part), agent.card.maxLabel);
    const delegates = delegateTargets(env, ORCHESTRATOR_AGENT);
    const shareTargets = delegates.filter((target) => {
      const card = options.agents.get(target.name)?.card;
      return card !== undefined && isCloudRoute(delegationRoute(card));
    });
    const readsProfile = agent.card.tools.includes(PROFILE_READ);
    const facts = await listUserFacts(sql);
    const sharesFacts = orchestratorTools(agent, delegates.length > 0, false, false, false, false, shareTargets.length > 0).includes(PROFILE_SHARE);
    const profile = profilePart(facts, tailClearance, { readTool: readsProfile, shareTool: sharesFacts });
    const work = part === 'work';
    const tools = orchestratorTools(
      agent,
      delegates.length > 0,
      false,
      false,
      false,
      readsProfile && profile?.topicsOnly === true,
      profile !== undefined && shareTargets.length > 0,
      true,
      work,
      work && options.browser?.installed() === true,
      !work && options.mac !== undefined,
      // milestone.propose (D-313): offered with routine.propose, in every conversation of Arianna the warm-up stands for.
      true,
    );
    // The planner of a work conversation within L1 (plannerFor): Claude when it is on; the local model in a private one.
    const planner: Planner = work && tools.includes(PLAN) && canAnswerDirectly(env) && plannerModelOf({ mode: 'work', model: null }, enabledCloudModels(env.settings().cloud)) !== undefined ? 'claude' : 'self';
    return {
      model: ORCHESTRATOR_MODEL,
      messages: chatMessages(agent.prompt, tools, [{ role: 'user', content: WARMUP_MESSAGE }], true, '', delegates, planner, ''),
      schema: { name: RESPONSE_SCHEMA_NAME, schema: responseSchema(tools, true, delegates, planner) },
      temperature: 0,
      maxTokens: 1,
    };
  }

  return {
    planAssignees: () => ['user', ...delegateTargets(env, ORCHESTRATOR_AGENT).map((target) => target.name)],
    warmupRequests,

    async plan(task: Task, step: number): Promise<RunSpec> {
      const key = `${task.id}:${String(step)}`;
      // The trial chat of a local model (D-142): that model answers, nothing else runs.
      const trial = await trialModelOf(sql, task.conversationId);
      if (trial !== undefined) return { agent: task.assignee, executor: 'local', locality: 'local', model: trial };
      // «/progetta» (D-235): the chat task answers without a model; the card «Piano» may call the local model.
      const planning = await planningOf(sql, task.id);
      if (planning === 'request') return { agent: task.assignee, executor: ORCHESTRATOR_EXECUTOR, locality: 'local' };
      if (planning === 'card') return localSpec(task);
      const directChat = await isDirectChat(task);
      const planned = await delegationPlanFor(task, step, directChat);
      // Nothing left to run in the direct chat: the step only closes the task (directChatEnd). Its run row says
      // local and no model, as for a delegation closed without running: no model is called.
      if (planned === undefined && directChat) return { agent: task.assignee, executor: ORCHESTRATOR_EXECUTOR, locality: 'local' };
      // «@name» or «/giro» (D-107, tappa B2): the core writes the next delegation, or closes the task; no model is called.
      if (planned === undefined && (await addressedTask(sql, task.id)) !== undefined) return { agent: task.assignee, executor: ORCHESTRATOR_EXECUTOR, locality: 'local' };
      if (planned === undefined) {
        const direct = await directFor(task);
        directs.set(key, direct?.target ?? null);
        // The run reads the task and the chat: their label, recorded with it.
        // A plain chat on the cloud that cannot answer now calls no model: it waits for the user (run).
        if (direct === undefined && CLOUD_CHAT_AGENTS.includes(task.assignee)) return { agent: task.assignee, executor: ORCHESTRATOR_EXECUTOR, locality: 'local' };
        return direct === undefined
          ? localSpec(task)
          : { agent: task.assignee, executor: direct.target.executor, locality: 'cloud', model: direct.target.model, effectiveLabel: direct.label };
      }
      plans.set(key, planned);
      // Waiting for the user's choice, or the "Non ora" answered without a model: no model is called.
      if (planned.kind === 'choose' || planned.kind === 'declined') return { agent: task.assignee, executor: ORCHESTRATOR_EXECUTOR, locality: 'local' };
      // The delegated run reads only the brief (and the agent's prompt): that label, not the task's.
      if (planned.kind === 'cloud') return { agent: planned.delegation.agent, executor: planned.executor, locality: 'cloud', model: planned.model, effectiveLabel: planned.label };
      if (planned.kind === 'local') {
        const agent = options.agents.get(planned.delegation.agent);
        // An agent gone meanwhile: never lower than a user's prompt (the delegation fails anyway).
        const prompt: Label = agent === undefined ? 'L1' : promptLabelOf(agent);
        return { agent: planned.delegation.agent, executor: 'local', locality: 'local', model: planned.model, effectiveLabel: maxLabel(planned.label, prompt) };
      }
      return localSpec(task);
    },

    async run(ctx: StepContext): Promise<StepOutcome> {
      const { task, step, runId } = ctx;
      const key = `${task.id}:${String(step)}`;
      const trial = await trialModelOf(sql, task.conversationId);
      if (trial !== undefined) return runTrialChat(sql, ctx, trial, options.trialModel?.(trial));
      // «/progetta» (D-235): the line of the chat and the card «Piano», then the card's plan; never Arianna's model.
      const planning = await planningOf(sql, task.id);
      if (planning === 'request') {
        const [answered] = await sql<{ id: string }[]>`
          SELECT id::text FROM messages WHERE task_id = ${task.id} AND role = 'assistant' AND agent IS NULL ORDER BY id LIMIT 1`;
        if (answered !== undefined) return { kind: 'answered', messageId: answered.id };
        return planRequestStep(sql, ctx);
      }
      if (planning === 'card') {
        return planCardStep({ env, model: options.model, localAlias: ORCHESTRATOR_MODEL, localExecutor: ORCHESTRATOR_EXECUTOR, delegates: delegateTargets(env, task.assignee) }, ctx);
      }
      const directChat = await isDirectChat(task);
      const card = isAgentCard(task);
      const planned = plans.get(key) ?? (await delegationPlanFor(task, step, directChat));
      plans.delete(key);
      const plannedDirect = directs.get(key);
      directs.delete(key);
      if (planned !== undefined) {
        // The decision goes to router_decisions before anything acts on it.
        const decision = 'decision' in planned ? planned.decision : undefined;
        if (decision !== undefined) await recordRouteDecision(sql, decision, { taskId: task.id, runId, step });
        switch (planned.kind) {
          case 'choose':
            return { kind: 'confirm', approvalId: planned.approvalId, usage: { steps: 0 } };
          case 'declined':
            return notStarted(ctx, planned.delegation, planned.label);
          case 'cloud': {
            const outcome = await runDelegation(env, ctx, planned);
            return directChat ? directChatEnd(task, outcome, runId) : card ? cardDone(task, outcome) : outcome;
          }
          case 'local': {
            const outcome = await runLocalDelegation(env, ctx, planned);
            return directChat ? directChatEnd(task, outcome, runId) : card ? cardDone(task, outcome) : outcome;
          }
          case 'workspace':
            await show(task, step, 'wait', `workspace · ${planned.repo}`);
            return { kind: 'workspace', repo: planned.repo, files: planned.files, step: planned.delegation.step, agent: planned.delegation.agent };
          case 'budget':
            await show(task, step, 'wait', `budget · ${planned.model}`);
            return { kind: 'budget', executor: planned.executor, model: planned.model, step: planned.delegation.step };
          case 'retry': {
            // The cloud executor the agent's card names first: the one the user expects to see waiting.
            const card = options.agents.get(planned.delegation.agent)?.card;
            const waiting = card === undefined ? undefined : delegationRoute(card);
            await show(task, step, 'wait', `${isCloudRoute(waiting) ? waiting : 'claude'} · ${planned.at.toISOString()}`);
            return { kind: 'retry', at: planned.at, reason: planned.decision.reason };
          }
          case 'closed':
            // Nothing to run: the local step goes on, with the error as the result of the call.
            await updateDelegation(sql, planned.delegation.id, { status: planned.status, result: planned.result, resultLabel: planned.delegation.label });
            // In the direct chat and on a card no other way is tried (D-250): the line says so.
            await show(task, step, directChat || card ? 'stop' : 'error', planned.result.replace(/^error: [^:]+: /, ''));
            // A card ends here: nobody else reads the result (D-159).
            if (card) return cardDone(task, { kind: 'continue', usage: { steps: 0 } });
            break;
        }
      }
      // The direct chat never reaches the local model (D-111).
      if (directChat) return directChatEnd(task, { kind: 'continue', usage: { steps: 0 } }, runId);

      // The plain chat with Claude (D-111, tappa B): Claude answers, or nobody; never the local model in its place.
      if (planned === undefined && CLOUD_CHAT_AGENTS.includes(task.assignee) && (await directChatOf(sql, task, task.assignee)) !== undefined) {
        const [answered] = await sql<{ id: string }[]>`
          SELECT id::text FROM messages WHERE task_id = ${task.id} AND role = 'assistant' AND agent IS NULL ORDER BY id LIMIT 1`;
        if (answered !== undefined) return { kind: 'answered', messageId: answered.id };
        const target = plannedDirect === undefined ? (await directFor(task))?.target : (plannedDirect ?? undefined);
        if (target === undefined) {
          return { kind: 'wait-user', reason: `${task.assignee} cannot answer now: it is off in the configuration, or the conversation holds more than it may read` };
        }
        const history = await historyOf(sql, options.agents, task, [], []);
        if (history.length === 0) return { kind: 'wait-user', reason: 'the task has no request to work on' };
        return runDirect(env, ctx, target.model, history, true, target.executor);
      }

      const agent = options.agents.get(task.assignee);
      if (agent === undefined) return { kind: 'wait-user', reason: `no agent card for ${task.assignee}` };
      // A card of an agent (D-159): its first step chooses the way, a delegation or the local model.
      if (card) {
        const started = await cardStart(ctx, agent);
        if (started !== undefined) return started;
      }
      if (!agent.card.executors.includes('local')) return { kind: 'wait-user', reason: `${task.assignee} does not run on the local model` };

      // A chat task ends with one message of Arianna: if it is there, the task is
      // answered (a crash after the message, before the engine recorded the step).
      const [answered] = await sql<{ id: string }[]>`
        SELECT id::text FROM messages WHERE task_id = ${task.id} AND role = 'assistant' AND agent IS NULL ORDER BY id LIMIT 1`;
      if (answered !== undefined) return { kind: 'answered', messageId: answered.id };

      // The user decided a confirmation of the secretary (D-144): the answer is written here, without the model.
      if (ctx.approval?.kind === 'commitment') return decisionAnswer(sql, ctx);
      // The user decided a plan (D-159): the cards are already created, the answer is written here too.
      if (ctx.approval?.kind === 'plan') return planDecisionAnswer(sql, ctx);
      // The user decided an IM item above what the IM holds (D-167, P4b): written now, the answer here too.
      if (ctx.approval?.kind === 'im') return imDecisionAnswer(sql, ctx, options.ims);
      // The user decided a fact Arianna proposed (D-114, tappa D): written with the decision, the answer here.
      if (ctx.approval?.kind === 'fact') return proposeDecisionAnswer(sql, ctx);
      // The user decided a routine Arianna proposed (D-256): active or discarded with the decision, the answer here.
      if (ctx.approval?.kind === 'routine') return routineDecisionAnswer(sql, ctx);
      // The user decided a milestone Arianna proposed (D-313, seguito 2): created with its cards with the decision, the answer here.
      if (ctx.approval?.kind === 'milestone_plan') return milestoneDecisionAnswer(sql, ctx);

      // Claude answers the system chat (D-064): what `plan` chose, so that the run matches its record.
      // An addressed message (D-107, tappa B2) is never answered by Claude in a system chat: the agents named answer it.
      const addressedNow = planned === undefined ? await addressedTask(sql, task.id) : undefined;
      const direct =
        planned !== undefined || addressedNow !== undefined ? undefined : plannedDirect === undefined ? (await directFor(task))?.target : (plannedDirect ?? undefined);
      if (direct !== undefined) {
        const history = await historyOf(sql, options.agents, task, [], []);
        if (history.length === 0) return { kind: 'wait-user', reason: 'the task has no request to work on' };
        return runDirect(env, ctx, direct.model, history, false, direct.executor);
      }

      const turns = await loadTurns(sql, task.id);
      const delegations = await loadDelegations(sql, task.id);
      // This step already completed before a crash or a lost lock: give the
      // same outcome again, without calling the model.
      const done = turns.find((turn) => turn.step === step);
      if (done !== undefined) {
        // A confirmation asked at that step and still pending: wait for it again.
        const waiting = (await secretaryReplay(sql, ctx, done)) ?? (await planReplay(sql, ctx, done)) ?? (await imReplay(sql, ctx, done, options.ims)) ??
          (await shareReplay(sql, ctx, done)) ??
          (await browserReplay(sql, ctx, done)) ??
          (await macReplay(sql, ctx, done)) ??
          (await proposeReplay(sql, ctx, done)) ??
          (await routineReplay(sql, ctx, done)) ??
          (await milestoneReplay(sql, ctx, done)) ??
          (await executorReplay(done, delegations));
        if (waiting !== undefined) return waiting;
        const ceilingOf = (name: string): Label => {
          const card = options.agents.get(name)?.card;
          return card === undefined ? 'L1' : briefCeiling(card);
        };
        return replay(task, done, delegations, turns, ceilingOf);
      }

      // «@name» or «/giro» (D-107, tappa B2): the agents answer, one after the other; Arianna's model is never called.
      const addressed = await addressedTask(sql, task.id);
      if (addressed !== undefined) return addressedStep(ctx, addressed, turns, delegations);

      // The anchor jumped (D-077): at the first step of the task the local
      // model summarizes what it left behind, before the answer; the later
      // steps only read, so their prefix stays the one of the first.
      // The images of the message (D-247): read once by the vision model, before the first answer reads them.
      if (step === 1) await readPendingImages(attachmentEnv, task, { runId, signal: ctx.signal });
      let view = task.conversationId === null ? undefined : await conversationView(sql, task.conversationId, task.id, MAX_TEXT);
      let summarized: SummarizeOutcome | undefined;
      if (view !== undefined && task.conversationId !== null && step === 1 && view.missing.length > 0) {
        summarized = await writeMissingSummaries(summaryEnv, task, { runId, signal: ctx.signal }, view);
        // Read again only when the pieces changed: ours, or another task's that came first.
        if (summarized.written > 0 || summarized.degraded === 'conflict') view = await conversationView(sql, task.conversationId, task.id, MAX_TEXT);
      }
      const history = await historyOf(sql, options.agents, task, turns, delegations, view);
      if (history.length === 0) return { kind: 'wait-user', reason: 'the task has no request to work on' };
      // The tail of the prompt (D-107, tappa A3): the assignee's persona, within the lower of its card's
      // clearance and the task's (never the user's text for an L0 agent or task). It counts in the label of the step.
      const tailClearance = minLabel(task.clearance, agent.card.maxLabel);
      // Then the profile «Su di te» (D-114, tappa B), within the same clearance: on this machine only, nothing for an
      // L0 agent or task. Past its limit the topics alone, and profile.read when the card lists it.
      // The agents this step may delegate to (D-119, tappa T3): the Coder and the user's active ones.
      const delegates = delegateTargets(env, task.assignee);
      // In an incognito conversation nothing that outlives it is offered (D-136): no KB note, no card.
      const incognito = task.conversationId !== null && (await isIncognitoConversation(sql, task.conversationId));
      // The secretary's conversation (D-144): the commitments, and no delegation.
      const secretary = !incognito && (await isSecretaryConversation(sql, task.conversationId));
      // routine.propose (D-256): offered to Arianna in every conversation but incognito and the secretary's, so that
      // it does not split the fixed prompt of a private and a work conversation (the prefix cache, D-075; the tools of
      // the folders of the Mac, D-314, offered in private conversations only, do split them from the list of tools on); the core
      // writes a routine only in a private conversation of the user with her (routineProposalAllowed), else an error.
      const routinesOffered = !incognito && !secretary && task.conversationId !== null && task.assignee === ORCHESTRATOR_AGENT;
      const routines = routinesOffered && (await routineProposalAllowed(sql, task.conversationId));
      // The cloud agents profile.share may give a fact to, with what a brief to each carries (D-114, tappa C).
      const shareTargets = new Map<string, Label>();
      for (const target of delegates) {
        const card = options.agents.get(target.name)?.card;
        if (card !== undefined && isCloudRoute(delegationRoute(card))) shareTargets.set(target.name, briefCeiling(card));
      }
      const readsProfile = agent.card.tools.includes(PROFILE_READ);
      // The Private chat of an access (D-281): while it holds the browser of that access, only the site and the user
      // enter it. No profile, no knowledge, no other agent: the browser tools and user.ask alone.
      const browserChat = options.browser === undefined || task.conversationId === null || task.clearance !== 'L2' || task.finance || incognito
        ? undefined
        : await browserChatSite(sql, options.browser.agent, task.conversationId);
      // The folders of the Mac (D-314): only in a private conversation of the user with Arianna, on the local model.
      const macOffered = options.mac !== undefined && browserChat === undefined && task.clearance === 'L2' && task.assignee === ORCHESTRATOR_AGENT && !secretary && (await macConversation(sql, task.conversationId));
      const facts = browserChat === undefined ? await listUserFacts(sql) : [];
      // A private fact says how to ask for it when profile.share is offered at this step (D-213).
      const sharesFacts = orchestratorTools(agent, delegates.length > 0, false, incognito, secretary, false, shareTargets.size > 0).includes(PROFILE_SHARE);
      const profile = browserChat === undefined ? profilePart(facts, tailClearance, { readTool: readsProfile, shareTool: sharesFacts }) : undefined;
      // The switch «Personaggio» of the conversation (D-225): off, neither the character's block nor its lines.
      const character = await characterOn(sql, task.conversationId);
      const tail = [...tailParts(env.settings(), task.assignee, tailClearance, { lines: true, character }), ...(profile === undefined ? [] : [profile])];
      // Real lines of the character drawn by the core for this answer (D-224), L0, after the history.
      const lines = linesPart(env.settings(), task.assignee, tailClearance, task.conversationId ?? `task:${task.id}`, character);
      // The date and time of now (D-311), L0, after the lines: in the last message, never in the fixed prompt (D-075).
      const clock = clockPart((options.now ?? (() => new Date()))(), options.timeZone);
      // The skills of an assignee other than Arianna (D-161), as in a local delegation: after its
      // prompt, a block of L0 data within the local limit; never for Arianna, never for a card
      // closing untrusted_content (skillsPart). The user's own skills of Claude Code (D-255) within
      // the step's clearance, in a fragment of their own: they count in the label of the step.
      const skills = task.assignee === ORCHESTRATOR_AGENT ? [] : await skillsPart(env, { task, step }, agent, task.assignee, SKILLS_DELIVERY_BYTES.local, tailClearance);
      const label = maxLabel(task.effectiveLabel, ...history.map((part) => part.label), ...tail.map((part) => part.label), ...skills.map((part) => part.label));
      // With the task's finance mark (D-183): the local model reads it, nothing of it goes further.
      // The chat of an access declares its context as one that read L2 only from that site and the user (D-281).
      let context: Context = browserChat === undefined ? contextOf(task, label) : createContext(task.clearance, label, { browserSite: browserChat });
      // The skills pass the gateway with the rest.
      const decision = await passGateway(
        sql,
        [
          ...history.map((part) => ({ value: part.value.content, label: part.label, source: part.source })),
          ...skills.map((part) => ({ value: part.text, label: part.label, source: part.source })),
          ...tail.map((part) => ({ value: part.text, label: part.label, source: part.source })),
          ...(lines === undefined ? [] : [{ value: lines.text, label: lines.label, source: lines.source }]),
          { value: clock.text, label: clock.label, source: clock.source },
        ],
        context,
        { kind: 'executor', id: ORCHESTRATOR_EXECUTOR, locality: 'local' },
        { taskId: task.id, runId, what: 'local-turn' },
      );
      if (decision.decision === 'block') return { kind: 'wait-user', reason: `the local model cannot read this task: ${decision.reason}` };
      const skillsCount = skills.length;
      const linesCount = lines === undefined ? 0 : 1;
      if (decision.texts.length !== history.length + skillsCount + tail.length + linesCount + 1) throw new Error('the gateway allowed a different number of texts');
      const allowedSkills = skills.length === 0 ? undefined : decision.texts.slice(history.length, history.length + skillsCount).join('\n\n');
      const allowedTail = promptTail(decision.texts.slice(history.length + skillsCount, history.length + skillsCount + tail.length));
      // The assignee plays a person of the series in this step (D-225), as the gateway let its block out:
      // a chat reply may be written once more, livelier.
      const playing = tail.some((part, index) => part.source.startsWith(SERIES_SOURCE_PREFIX) && (decision.texts[history.length + skillsCount + index] ?? '') !== '');
      // After history, skills and tail: the lines when drawn (D-224), then the time (D-311).
      const trailing = history.length + skillsCount + tail.length;
      const allowedLines = lines === undefined ? '' : (decision.texts[trailing] ?? '');
      const trailer = joinTrailer(allowedLines, decision.texts[trailing + linesCount] ?? '');
      const prompt = allowedSkills === undefined || allowedSkills === '' ? agent.prompt : `${agent.prompt}\n\n${allowedSkills}`;
      // Joined after the gateway (D-092): gateway_log keeps each part with its own source and label.
      const allowed = joinSameRole(history.map((part, index) => ({ ...part, value: { role: part.value.role, content: decision.texts[index] ?? '' } }))).map(
        (part) => part.value,
      );

      const offered =
        browserChat === undefined
          ? orchestratorTools(
              agent,
              delegates.length > 0,
              !incognito && (await updateOffered(sql, task)),
              incognito,
              secretary,
              readsProfile && profile?.topicsOnly === true,
              profile !== undefined && shareTargets.size > 0,
              routinesOffered,
              // A public page (D-262): only while the step has read nothing above Internal, nor finance data.
              webFetchOffered(context, incognito),
              browserOffered(context, incognito, options.browser?.installed() === true),
              macOffered,
              // milestone.propose (D-313): where routine.propose is offered, so that the fixed prompt does not split.
              routinesOffered,
            )
          : browserChatTools(agent);
      // A conversation that read private or finance data keeps no browser (D-264, passo 3); the chat of an access keeps its own (D-281).
      if (browserChat === undefined && options.browser !== undefined && task.conversationId !== null && options.browser.agent.holder === task.conversationId && !webFetchOffered(context, incognito)) {
        await options.browser.agent.release(task.conversationId);
      }
      // Who writes the cards of a plan (D-164): Claude in a work conversation, from the request alone.
      const plannerModel = offered.includes(PLAN) ? await plannerFor(env, task.conversationId, label) : undefined;
      // A plan of Claude that failed in this task is not asked again by the local model: one call per task.
      const tools = plannerModel !== undefined && turns.some(failedPlan) ? offered.filter((tool) => tool !== PLAN) : offered;
      const planner: Planner = plannerModel === undefined ? 'self' : 'claude';
      // After «Apri» of a card of the browser (D-286): the core makes the approved call again itself, as this step,
      // and the model reads its outcome after; never the old page first.
      const redo = await approvedRedo(sql, task.id, turns, tools);
      // After a yes on a card of a folder of the Mac (D-314): the core makes the same call again itself, as this step.
      const macAgain = redo === undefined ? await macRedo(sql, task.id, turns, tools) : undefined;
      // A click or a typed text only on the element as it was read, within REDO_ELEMENT_MS (D-286): otherwise the model reads the page again.
      if (redo?.element !== undefined) {
        const agentBrowser = options.browser?.agent;
        const same = !redo.stale && agentBrowser !== undefined && task.conversationId !== null && (await agentBrowser.sameElement(task.conversationId, redo.element.ref, redo.element.url));
        if (!same) {
          await recordTurn(sql, { taskId: task.id, step, runId, answer: redo.answer, label, result: PAGE_CHANGED });
          await appendEvent(sql, { kind: 'browser.redo', label: 'L0', taskId: task.id, runId, payload: { approvalId: redo.approvalId, tool: redo.answer.tool, outcome: 'page-changed' } });
          await show(task, step, 'error', 'browser · la pagina è cambiata: la rileggo');
          return { kind: 'continue', usage: { steps: 0 } };
        }
      }
      const redone = redo?.answer ?? macAgain?.answer;
      // The call made again by the core is recorded as such (D-286): the card and the tool, never its arguments.
      if (redo !== undefined) await appendEvent(sql, { kind: 'browser.redo', label: 'L0', taskId: task.id, runId, payload: { approvalId: redo.approvalId, tool: redo.answer.tool, outcome: 'redone' } });
      if (redone === undefined) await show(task, step, 'thinking');
      // The reply of this step, opened before the model writes (D-249): its thinking and text go live; it is stored only if the step answers.
      const live = task.conversationId === null || redone !== undefined ? undefined : await openReply(sql, task.id, { runId });
      let asked: Awaited<ReturnType<typeof ask>>;
      if (redone !== undefined) asked = { read: { answer: redone }, tokensIn: 0, tokensOut: 0 };
      else try {
        // Only at the first step of the task: a reply after a tool keeps what the tool said, at temperature 0.
        // Live pieces skip the checks of `finish`: shown only when the reply could be stored and shown (D-249).
        const lively = options.livelyReplies === true && playing && turns.length === 0;
        // A chat reply as free text (D-251): only where there is a chat; a card keeps the text of the JSON in its turn.
        const free = options.freeReplies === true && task.conversationId !== null;
        asked = await ask(tools, prompt, allowed, ctx.signal, delegates, planner, allowedTail, trailer, lively, showsLive(label, task.clearance) ? live : undefined, free);
      } catch (error) {
        if (error instanceof LocalModelError && error.kind === 'no-endpoint') {
          return { kind: 'wait-user', reason: 'no local model serves the orchestrator: assign one in [roles] (pnpm arianna:init)' };
        }
        if (error instanceof LocalModelError && error.kind === 'bad-response') {
          return { kind: 'wait-user', reason: INVALID_ANSWER };
        }
        // Down, stuck or cancelled: the engine retries the step, or stops it.
        throw error;
      }
      // Why the free text was not kept (D-251): a reason of a closed list, never a text, for the trial on the real model.
      if (asked.draftKept !== undefined) {
        await appendEvent(sql, { kind: 'reply.draft-kept', label: 'L0', taskId: task.id, runId, payload: { conversationId: task.conversationId, reason: asked.draftKept } }).catch(() => undefined);
      }
      const usage = { steps: 1, tokensIn: asked.tokensIn + (summarized?.tokensIn ?? 0), tokensOut: asked.tokensOut + (summarized?.tokensOut ?? 0) };
      if (asked.read === undefined) return { kind: 'wait-user', reason: INVALID_ANSWER, usage };
      const { answer, thought } = asked.read;
      const turn = { taskId: task.id, step, runId, answer, ...(thought === undefined ? {} : { thought, ...(asked.thoughtMs === undefined ? {} : { thoughtMs: asked.thoughtMs }) }) };

      const text = chatText(answer);
      if (text !== undefined) {
        if (task.conversationId === null) {
          // No chat to write in: the text stays in the turn, for the user to read on the card.
          await recordTurn(sql, { ...turn, label, result: NO_CONVERSATION });
          return { kind: 'done', evidence: [{ kind: 'turn', ref: String(step) }], usage };
        }
        const reply = live ?? (await openReply(sql, task.id, { runId }));
        // The thinking of every step since the task's last answer, this one included (D-249): each was read within `label`.
        // Written again without the thought (D-052): what came live belonged to the discarded call, and is not kept.
        const kept = answerThought(turns, thought, asked.thoughtMs);
        const result = await reply.finish(text, label, thought === undefined && kept.thought === undefined ? { thought: '' } : kept);
        if (!result.stored) {
          await recordTurn(sql, { ...turn, label, result: `${UNDELIVERED} (${result.reason})` });
          return { kind: 'wait-user', reason: undelivered(result.reason), usage };
        }
        await recordTurn(sql, { ...turn, label, messageId: result.message.id });
        // A reply that says it closes the browser closes it (D-287): the local model wrote it without browser.close.
        const agentBrowser = options.browser?.agent;
        if (agentBrowser !== undefined && agentBrowser.holder === task.conversationId && promisesClose(text) && (await agentBrowser.closeAfterReply(task.conversationId))) {
          await appendEvent(sql, { kind: BROWSER_ACTION_EVENT, label: 'L0', taskId: task.id, runId, payload: { conversationId: task.conversationId, action: 'close', outcome: 'ok', from: 'reply' } }).catch(() => undefined);
        }
        return { kind: 'answered', messageId: result.message.id, usage };
      }

      if (answer.action === 'plan') {
        await recordTurn(sql, { ...turn, label, result: PLAN_NOTED });
        await show(task, step, 'plan', answer.steps.map((item, index) => `${String(index + 1)}. ${item}`).join(' · '));
        return { kind: 'continue', usage };
      }

      // A call: the schema allowed only offered tools, checked again here.
      if (answer.action !== 'call' || !tools.includes(answer.tool)) {
        return { kind: 'wait-user', reason: 'the local model asked for a tool it does not have', usage };
      }
      if (answer.tool === DELEGATE) return delegateCall(ctx, turn, label, answer.arguments, usage, delegates);
      if (answer.tool === PLAN) {
        const assignees = ['user', ...delegates.map((target) => target.name)];
        const showPlan = (kind: ActivityKind, detail?: string) => show(task, step, kind, detail);
        if (plannerModel === undefined) return runPlanTool(sql, ctx, { turn, label, args: answer.arguments, usage, assignees }, showPlan);
        const { title, request } = answer.arguments;
        const written = await writePlan(env, ctx, { title: String(title), request: String(request), label, agents: delegates, model: plannerModel });
        const total = {
          steps: usage.steps,
          tokensIn: usage.tokensIn + (written.usage?.tokensIn ?? 0),
          tokensOut: usage.tokensOut + (written.usage?.tokensOut ?? 0),
          ...(written.usage?.cost === undefined ? {} : { cost: written.usage.cost }), // the local step costs nothing
        };
        // Out of quota: the step runs again then, the local model too; nothing was recorded.
        if (written.kind === 'retry') return { kind: 'retry', at: written.at, reason: written.reason, usage: total };
        if (written.kind === 'error') {
          await recordTurn(sql, { ...turn, label, result: `error: ${PLAN}: ${written.reason}. Tell the user in plain words that the plan was not written.` });
          await show(task, step, 'error', `${PLAN}: ${written.reason}`);
          return { kind: 'continue', usage: total };
        }
        return runPlanTool(sql, ctx, { turn, label: written.label, args: written.args, usage: total, assignees }, showPlan);
      }
      if (isSecretaryTool(answer.tool)) {
        return runSecretaryTool(sql, ctx, { turn, label, tool: answer.tool, args: answer.arguments, usage }, (kind, detail) => show(task, step, kind, detail));
      }
      // The browser (D-264, passo 3): never stopped as a repeated call, reading the same page again after a click is the point.
      if (isBrowserTool(answer.tool)) {
        const ran = await browserTool(answer.tool, answer.arguments, { task, context, incognito, ...(options.browser === undefined ? {} : { browser: { browser: options.browser.agent, sql, runId } }) });
        // A saved private value of the user (D-283): the card «Apri / No», written with the turn.
        const saved = ran.private;
        // A value the user just said «No» to (D-286): stopped, without the same card again.
        if (saved !== undefined && task.conversationId !== null && (await refusedOnlyIn(sql, task.conversationId, saved.saved))) {
          await recordTurn(sql, { ...turn, label: maxLabel(label, ran.label), result: REFUSED_SAVED });
          await show(task, step, 'error', 'browser · hai detto No a questo dato: non lo riprovo');
          return { kind: 'continue', usage };
        }
        if (saved !== undefined) {
          const approvalId = await sql.begin(async (tx) => {
            await recordTurn(tx, { ...turn, label: maxLabel(label, ran.label), result: WAITING_PRIVATE });
            return requestSavedPrivate(tx, { taskId: task.id, step, tool: answer.tool, refs: saved.saved, browser: saved.browser, site: saved.site ?? null });
          });
          await show(task, step, 'wait', ran.detail);
          return { kind: 'confirm', approvalId, usage };
        }
        // A send to the site of an access (D-281): the card «Invia / No», written with the turn.
        const send = ran.send;
        if (send !== undefined) {
          const approvalId = await sql.begin(async (tx) => {
            await recordTurn(tx, { ...turn, label: maxLabel(label, ran.label), result: WAITING_SEND });
            return requestBrowserSend(tx, { taskId: task.id, step, site: send.site, element: send.element });
          });
          await show(task, step, 'wait', ran.detail);
          return { kind: 'confirm', approvalId, usage };
        }
        // A link to a site the consent does not cover: the card «Apri / No», written with the turn.
        const confirm = ran.confirm;
        if (confirm !== undefined) {
          const approvalId = await sql.begin(async (tx) => {
            await recordTurn(tx, { ...turn, label, result: WAITING_BROWSER });
            return requestBrowserOpen(tx, { taskId: task.id, step, label, url: confirm.url, site: confirm.site });
          });
          await show(task, step, 'wait', ran.detail);
          return { kind: 'confirm', approvalId, usage };
        }
        await recordTurn(sql, { ...turn, label: maxLabel(label, ran.label), result: ran.text });
        await show(task, step, ran.text.startsWith('error: ') ? 'error' : answer.tool === 'browser.read' ? 'read' : 'tool', ran.detail);
        return { kind: 'continue', usage };
      }
      // The folders of the Mac (D-314): read at once inside an allowed folder; otherwise the card with three choices.
      if (isMacTool(answer.tool) && options.mac !== undefined) {
        const ran = await macTool(answer.tool, answer.arguments, step, {
          mac: options.mac,
          sql,
          task,
          incognito,
          turns,
          ...(macAgain === undefined ? {} : { once: macAgain.folder }),
        });
        const macLabel = maxLabel(label, MAC_RESULT_LABEL);
        if (ran.kind === 'ask') {
          const approvalId = await sql.begin(async (tx) => {
            await recordTurn(tx, { ...turn, label: macLabel, result: WAITING_MAC });
            return requestMacRead(tx, { taskId: task.id, detail: ran.detail });
          });
          await show(task, step, 'wait', ran.activity);
          return { kind: 'confirm', approvalId, usage };
        }
        await recordTurn(sql, { ...turn, label: macLabel, result: ran.text });
        await show(task, step, ran.kind === 'error' ? 'error' : answer.tool === 'mac.find' ? 'search' : 'read', ran.detail);
        return { kind: 'continue', usage };
      }
      if (!isLocalTool(answer.tool)) return { kind: 'wait-user', reason: 'the local model asked for a tool it does not have', usage };
      const tool = answer.tool;
      // The same call again is not run (D-076): the model reads where its
      // result already is; every third one the task waits for the user, and
      // after the user resumes it the count starts again.
      // A web.fetch may run again after a card of saved values the user approved (D-283), never after a «No».
      const earlier = earlierCall(turns, tool, answer.arguments, tool === WEB_FETCH ? await approvedPrivateSteps(sql, task.id) : undefined);
      if (earlier !== undefined) {
        const stopped = stoppedRepeats(turns).length;
        // A search that said private pages were left out, asked again (D-241): what the user wants may
        // be there. The model is told to say so; at the second time the core says it, instead of waiting.
        const privateLeftOut = tool === 'kb.search' && turns.find((past) => past.step === earlier)?.result?.endsWith(SKIPPED_NOTE) === true;
        // Only the stops of this same call count, not those of other calls of the task.
        const sameStopped = turns.filter((past) => past.result?.startsWith(`error: ${tool}: the same call as step ${String(earlier)}, `) === true).length;
        if (privateLeftOut && sameStopped >= 1 && task.conversationId !== null) {
          const reply = await openReply(sql, task.id, { runId });
          const result = await reply.finish(PRIVATE_ONLY_REPLY, label);
          if (!result.stored) {
            await recordTurn(sql, { ...turn, label, result: `${UNDELIVERED} (${result.reason})` });
            return { kind: 'wait-user', reason: undelivered(result.reason), usage };
          }
          await recordTurn(sql, { ...turn, label, result: repeatedResult(tool, earlier, false), messageId: result.message.id });
          await show(task, step, 'error', `the same call as step ${String(earlier)}, not run again`);
          return { kind: 'answered', messageId: result.message.id, usage };
        }
        const waits = (stopped + 1) % MAX_REPEATS === 0;
        await recordTurn(sql, { ...turn, label, result: repeatedResult(tool, earlier, waits, privateLeftOut) });
        await show(task, step, 'error', `the same call as step ${String(earlier)}, not run again`);
        return waits ? { kind: 'wait-user', reason: REPEATING, usage } : { kind: 'continue', usage };
      }
      // A page (D-262) is read before the transaction, for up to 15 s on the network: read again after a crash, it counts once more.
      // The browser of the conversation (D-283): what the user let go for it holds for web.fetch too.
      const browserAgent = options.browser === undefined || task.conversationId === null ? undefined : options.browser.agent;
      const browserSaved = browserAgent === undefined || task.conversationId === null ? undefined : browserAgent.savedFor(task.conversationId);
      const browserLast = browserAgent === undefined || task.conversationId === null ? null : browserAgent.lastOpenedAt(task.conversationId);
      const userSites = browserAgent === undefined || task.conversationId === null ? [] : browserAgent.userAddressesOf(task.conversationId);
      const fetched = tool === WEB_FETCH ? await runTool(tool, answer.arguments, { sql, kb: options.kb, task, context, autonomy: agent.card.autonomy, incognito, web: { sql, runId, signal: ctx.signal, browserLast, userSites, ...(browserSaved === undefined ? {} : { browserSaved }), ...(options.fetchLink === undefined ? {} : { fetchLink: options.fetchLink }) } }) : undefined;
      // A value the user just said «No» to (D-286): web.fetch stops without the same card again.
      const refusedFetch = fetched?.private !== undefined && task.conversationId !== null && (await refusedOnlyIn(sql, task.conversationId, fetched.private.saved));
      // The tool and its turn commit together: after a crash the step either
      // finds its turn or runs again with nothing done (a card is not created twice).
      const result = await sql.begin(async (tx) => {
        const ran = fetched ?? await runTool(tool, answer.arguments, {
          sql: tx,
          kb: options.kb,
          task,
          context,
          autonomy: agent.card.autonomy,
          ...(options.ims === undefined ? {} : { ims: options.ims }),
          profileClearance: tailClearance,
          shareTargets,
          routines,
          ...(routinesOffered ? { milestones: { projects: options.settings().projects.map(({ name, label }) => ({ name, label })) } } : {}),
        });
        // A finance read marks the step's context at once (D-183): whatever the step does after it, it does marked.
        if (ran.context !== undefined) context = ran.context;
        // An IM item above what the IM holds (D-167): the turn and the confirmation together, nothing written yet.
        // A fact to share or to remember (D-114, tappe C e D): the turn and the approval together; nothing leaves, nothing is written yet.
        if (ran.share !== undefined) {
          await recordTurn(tx, { ...turn, label: maxLabel(label, ran.label), result: WAITING_SHARE });
          return { ...ran, approvalId: await requestShare(tx, { taskId: task.id, step, detail: ran.share }) };
        }
        if (ran.propose !== undefined) {
          await recordTurn(tx, { ...turn, label: maxLabel(label, ran.label), result: WAITING_PROPOSE });
          return { ...ran, approvalId: await requestPropose(tx, { taskId: task.id, step, label: maxLabel(label, ran.label), proposal: ran.propose }) };
        }
        // A routine (D-256): written off with the turn and its approval; nothing runs before the user approves it.
        if (ran.routine !== undefined) {
          await recordTurn(tx, { ...turn, label: maxLabel(label, ran.label), result: WAITING_ROUTINE });
          const written = await writeRoutineProposal(tx, { taskId: task.id, step, label: maxLabel(label, ran.label), proposal: ran.routine });
          return { ...ran, approvalId: written.approvalId };
        }
        // A milestone (D-313, seguito 2): the turn and its approval together; nothing is created before the user approves it.
        if (ran.milestone !== undefined) {
          await recordTurn(tx, { ...turn, label: maxLabel(label, ran.label), result: WAITING_MILESTONE });
          return { ...ran, approvalId: await writeMilestoneProposal(tx, { taskId: task.id, step, label: maxLabel(label, ran.label), proposal: ran.milestone }) };
        }
        // A saved private value of the user in the address of web.fetch (D-283): the card «Apri / No» with the turn.
        if (ran.private !== undefined && refusedFetch) {
          await recordTurn(tx, { ...turn, label: maxLabel(label, ran.label), result: REFUSED_SAVED });
          return { ...ran, private: undefined, text: REFUSED_SAVED, approvalId: undefined };
        }
        if (ran.private !== undefined) {
          await recordTurn(tx, { ...turn, label: maxLabel(label, ran.label), result: WAITING_PRIVATE });
          return { ...ran, approvalId: await requestSavedPrivate(tx, { taskId: task.id, step, tool, refs: ran.private.saved, browser: browserLast, site: ran.private.site ?? null }) };
        }
        if (ran.confirm !== undefined) {
          await recordTurn(tx, { ...turn, label: maxLabel(label, ran.label), result: WAITING_IM });
          return { ...ran, approvalId: await requestIm(tx, { taskId: task.id, step, label: maxLabel(label, ran.label), proposal: ran.confirm }) };
        }
        await recordTurn(tx, { ...turn, label: maxLabel(label, ran.label), result: ran.text });
        return { ...ran, approvalId: undefined };
      });
      if (result.approvalId !== undefined) {
        // The IM number only: the title stays in the approval. A fact: the tool's name only (D-213).
        if (result.private !== undefined) await show(task, step, 'wait', 'web · C’è un dato che hai salvato fra i clienti: chiedo a te se può uscire.');
        else if (result.share !== undefined || result.propose !== undefined || result.routine !== undefined || result.milestone !== undefined) await show(task, step, 'wait', tool);
        else await show(task, step, 'write', `${tool} · IM-${String(result.confirm?.number ?? '')}`);
        return { kind: 'confirm', approvalId: result.approvalId, usage };
      }
      // An error of a profile tool names topics: the activity shows the tool alone (D-114b).
      // A page (D-262): «web · <reason>», or «web · <address> · <title>» read by the chat as a link.
      if (result.text.startsWith('error: ')) {
        const reason = result.text.replace(/^error: [^:]+: /, '');
        await show(task, step, 'error', PROFILE_TOOLS.includes(tool) ? tool : tool === WEB_FETCH ? `web · ${reason}` : reason);
      } else await show(task, step, TOOL_ACTIVITY[tool], result.page === undefined ? toolDetail(tool, answer.arguments) : webDetail(result.page));
      return { kind: 'continue', usage };
    },
  };
}

const TOOL_ACTIVITY: Record<LocalTool, ActivityKind> = {
  'kb.search': 'search',
  'kb.read': 'read',
  'kb.write': 'write',
  'task.create': 'card',
  'task.update': 'card',
  'im.add': 'write',
  'finance.summary': 'read',
  'finance.search': 'search',
  'finance.alerts': 'read',
  'profile.read': 'read',
  'profile.share': 'wait',
  'profile.propose': 'write',
  'routine.propose': 'wait',
  'milestone.propose': 'wait',
  'web.fetch': 'read',
};

/** The argument that tells what the tool did: the query, the path, the card title, the card and its new status. */
function toolDetail(tool: LocalTool, args: Record<string, unknown>): string {
  // The finance tools and profile.read show only their name (D-183, D-114): what the model looks for stays in the turn.
  // routine.propose too (D-256), and milestone.propose (D-313): its title is the user's text, it stays in the approval.
  if (tool.startsWith('finance.') || PROFILE_TOOLS.includes(tool) || tool === ROUTINE_PROPOSE || tool === MILESTONE_PROPOSE) return tool;
  if (tool === UPDATE) return `${String(args.task_id).slice(0, 8)} → ${String(args.status)}`;
  const field = tool === 'kb.search' ? 'query' : tool === 'task.create' || tool === 'im.add' ? 'title' : 'path';
  return String(args[field]);
}

/** The line of a page read (D-262): the address first, so that a long title is what the cut of the detail takes. */
function webDetail(page: WebPage): string {
  return page.title === undefined || page.title.trim() === '' ? `web · ${page.url}` : `web · ${page.url} · ${page.title}`;
}

/** A `task.plan` call of this task that ended in an error (D-164). */
function failedPlan(turn: Turn): boolean {
  return turn.answer.action === 'call' && turn.answer.tool === PLAN && turn.result?.startsWith(`error: ${PLAN}: `) === true;
}

const INVALID_ANSWER = 'the local model did not give a valid answer';
const REPEATING = 'the local model keeps repeating the same call';
/** Every this many repeated calls stopped in a task, it waits for the user (D-076). */
const MAX_REPEATS = 3;

/** What the user reads when the local model keeps searching for what only a private conversation may read (D-241). */
export const PRIVATE_ONLY_REPLY =
  'Non trovo altro nelle note che questa conversazione può leggere. Se cerchi un documento privato, come una fattura, una spesa o una nota personale, chiedimelo in «Nuova conversazione» → «Privata»: lì lo legge solo il modello locale.';

function repeatedResult(tool: ToolId, step: number, waits: boolean, privateLeftOut = false): string {
  const next = waits
    ? 'The task now waits for the user.'
    : privateLeftOut
      ? 'If what the user asks for is not in the results above, it may be in the private pages this conversation may not read: reply now with what you have, and tell the user to open a private conversation for a private document.'
      : 'Take a different step, or reply with what you have.';
  return `error: ${tool}: the same call as step ${String(step)}, not run again: its result is above. ${next}`;
}

/**
 * The step of an earlier call of this task to `tool` with the same arguments,
 * in any key order (a default written out, like `limit`, makes another call:
 * a step more, never a call lost). A page written in the task can change what
 * a search or a read returns: those look only after the last write. An
 * update of a card looks only after the last update of the same card that
 * went through with other arguments (waiting, ready, waiting again); failed
 * updates never restart the count.
 */
/** Whether every value of a card was refused by the user a moment ago in the conversation (D-286). */
async function refusedOnlyIn(sql: Queryable, conversationId: string, refs: readonly string[]): Promise<boolean> {
  if (refs.length === 0) return false;
  const refused = await refusedSaved(sql, conversationId);
  return refs.every((ref) => refused.has(ref));
}

export function earlierCall(turns: readonly Turn[], tool: ToolId, args: Record<string, unknown>, approvedSaved: ReadonlySet<number> = new Set()): number | undefined {
  const key = canonical(args);
  const lastWrite =
    tool === 'kb.read' || tool === 'kb.search'
      ? turns.findLastIndex(wrotePage)
      // A page the user let go with «Apri» (D-283): the same web.fetch may run again after it; after «No» it may not.
      : tool === WEB_FETCH
        ? turns.findLastIndex((past) => past.result === WAITING_PRIVATE && approvedSaved.has(past.step))
      : tool === UPDATE
        ? turns.findLastIndex((past) => canonical(past.answer.action === 'call' ? past.answer.arguments : null) !== key && updatedCard(past, args))
        : -1;
  return turns
    .slice(lastWrite + 1)
    .find((past) => past.answer.action === 'call' && past.answer.tool === tool && canonical(past.answer.arguments) === key)?.step;
}

/** Whether `turn` is a `task.update` that went through on the card `args` names (its id or a prefix of it). */
function updatedCard(turn: Turn, args: Record<string, unknown>): boolean {
  if (turn.answer.action !== 'call' || turn.answer.tool !== UPDATE || turn.result?.startsWith(`${UPDATED} `) !== true) return false;
  const card = turn.result.slice(UPDATED.length + 1).split(':')[0] ?? '';
  const named = String(args.task_id).trim().toLowerCase();
  return named !== '' && card.startsWith(named);
}

function wrotePage(turn: Turn): boolean {
  return turn.answer.action === 'call' && turn.answer.tool === 'kb.write' && turn.result?.startsWith('written ') === true;
}

/**
 * The repeated calls the core stopped in a task, in order, read from the
 * turns rather than from the text of their results; every MAX_REPEATS-th one
 * made the task wait.
 */
export function stoppedRepeats(turns: readonly Turn[]): { step: number; waits: boolean }[] {
  const stopped: { step: number; waits: boolean }[] = [];
  turns.forEach((past, index) => {
    if (past.answer.action !== 'call' || !isLocalTool(past.answer.tool)) return;
    if (earlierCall(turns.slice(0, index), past.answer.tool, past.answer.arguments) === undefined) return;
    stopped.push({ step: past.step, waits: (stopped.length + 1) % MAX_REPEATS === 0 });
  });
  return stopped;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([name, item]) => `${JSON.stringify(name)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
const UNDELIVERED = 'error: the answer was not delivered';
const NO_CONVERSATION = 'answer for the user, kept here: the task has no conversation';

function undelivered(reason: string): string {
  return reason === 'blocked' ? 'the gateway blocked the answer' : 'the answer is above what the conversation may hold';
}

/** The outcome a completed step had, from its turn. */
/** `ceilingOf`: what a brief to that agent may carry without a declassification (`briefCeiling`); L1 for an agent no longer there. */
function replay(task: Task, turn: Turn, delegations: readonly Delegation[], turns: readonly Turn[], ceilingOf: (agent: string) => Label): StepOutcome {
  if (turn.messageId !== null) return { kind: 'answered', messageId: turn.messageId, usage: { steps: 0 } };
  if (stoppedRepeats(turns).some((stopped) => stopped.step === turn.step && stopped.waits)) {
    return { kind: 'wait-user', reason: REPEATING, usage: { steps: 0 } };
  }
  if (turn.result?.startsWith(UNDELIVERED) === true) {
    return { kind: 'wait-user', reason: undelivered(turn.result.includes('(blocked)') ? 'blocked' : 'above-clearance'), usage: { steps: 0 } };
  }
  if (turn.result === NO_CONVERSATION && task.conversationId === null) {
    return { kind: 'done', evidence: [{ kind: 'turn', ref: String(turn.step) }], usage: { steps: 0 } };
  }
  if (turn.answer.action === 'call' && turn.answer.tool === DELEGATE && turn.result === null) {
    // The declassification was asked and not yet decided: ask it again.
    const delegation = delegations.find((candidate) => candidate.step === turn.step);
    const ceiling = delegation === undefined ? 'L1' : ceilingOf(delegation.agent);
    if (delegation?.status === 'pending' && !isAtMost(delegation.label, ceiling)) {
      return { kind: 'declassify', text: delegation.brief, from: delegation.label, to: ceiling, usage: { steps: 0 } };
    }
  }
  return { kind: 'continue', usage: { steps: 0 } };
}
