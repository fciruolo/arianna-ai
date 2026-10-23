import type { ThemeListing } from './themes.ts';
import type { GatewayLogPage } from './gateway-log.ts';
import type { ChangelogRef, GodCarry, GodLandingView, GodStatus, LandAction } from './god.ts';
import type { GodPlan, GodSubtask, MessagePlan, SubtaskAction } from './god-work.ts';
import type { CallInfo } from './calls.ts';
import type { PlanBody, PlanChoice } from './plan-approval.ts';
import type { Client, ClientContact, ClientForm, ClientLogo, ClientProject, ClientSummary, ContactForm } from './clients.ts';
import type { CardDetailData, CardFile, CardLink, CardWall, ChecklistItem, MoveTarget } from './cardwall.ts';
import { pendingFromBody, type Progress as DevProgress } from './dev-progress.ts';
import type { GraphData, KnowledgePage } from './graph.ts';
import { parseEndResult, parseNotice, type EndResult, type IncognitoNotice } from './incognito.ts';
import { parseInstallation, parseReadiness, type InstallationInfo, type ReadinessReport } from './installation.ts';
import type { NewsPair } from './design-news.ts';
import type { FollowedAccount, FollowedProject, ProjectChoice } from './followed-projects.ts';
import type { OmlxReleaseView } from './omlx-release.ts';
import type { CatalogStatus as DesignCatalogStatus, StyleListing as DesignStyleListing, StyleText as DesignStyleText } from './design-catalog.ts';
import type { SkillListing, SkillsStatus, SkillText } from './skills-catalog.ts';
import type { ClaudeSkillsStatus } from './claude-skills.ts';
import type { AgentRoleListing, AgentRoleText, AgentsStatus } from './agents-catalog.ts';
import type { HubCard, HubSearchResult } from './huggingface.ts';
import type { ClientDashboard } from './client-dashboard.ts';
import type { ClientDocument, DocumentForm } from './client-documents.ts';
import type { Account, BankProfile, Budget, Category, FinanceAlert, ImportRecord, Preview, Rule, Summary, Tx } from './finance.ts';
import type { ImCalendar, ImInvoice, ImOverview, NewInvoice } from './im-billing.ts';
import type { ImClosing, ImDetail, ImItemRef, ImItemState, ImOutcome, ImReportJob, ImSummary, ReportAgent, ReportLanguage } from './im.ts';
import type { ModelAction } from './model-actions.ts';
import type { FactLabel, ShareProposal, UserFact } from './profile.ts';
import type { CaseComparison, Comparison } from './model-compare.ts';
import type { ModelEval } from './model-evals.ts';
import type { ModelsOverview } from './models-page.ts';
import type { KnowledgeSource } from './route.ts';
import type { SearchResult } from './search.ts';
import type { UsagePeriod, UsageReport } from './usage.ts';
import type { ChangesReport } from './changes.ts';
import type { Deck, ExamplesStatus, MockupList, MockupText, StyleSamples, TranslationsStatus } from './studio.ts';
import type { ModelRole, PrivacyProposal, PrivacySection, SettingsBody, SettingsValues, SettingsView } from './settings.ts';
import type { BrowsableContainer, BrowsableProject, CommitDiff, OpenedNote, ProjectFile, ProjectGit, ProjectKnowledge, ServiceLog, ServiceState, TreeEntry } from './projects.ts';
import type { Note, NoteListing } from './thoughts.ts';
import type { DashboardTile, Suggestion, TileKind, TileWidth } from './dashboard.ts';
import type { CalendarWeek } from './routine-calendar.ts';
import type { Routine, RoutineBody } from './routines.ts';
import type { ApproveItem, ApproveResult, ArchiveListing } from './archive.ts';
import { parseControl, parseMovedTo, type BlockedNavigation, type ControlState } from './browser-screen.ts';
import { actionPath, checkFailure, needsVerification, onRemoteOrigin, sessionEnded, stepUpHeader } from './remote.ts';
import type { VersionComparison, WikiListing, WikiPageView, WikiProposal } from './wiki.ts';
import type { VideoJob } from './video.ts';
import type { Approval, AttachmentInfo, Changelog, CharacterChoice, ChatCharacter, Commitment, CharacterListing, CloudModel, Conversation, ConversationAgent, ConversationMode, DelegationDiff, DirectAgent, ExecutorChoice, OffInterlocutor, FilePreview, Label, Message, MessageCredit, Participant, ProjectInfo, QueuedMessage, QueueView, RecentDelegation, SavedActivity, SavedTerminal, SideThread, StatusSnapshot, Task, TaskFailure } from './types.ts';

/**
 * Calls to the core's API from the page, same origin. Writes send JSON, which
 * the core requires (no form can forge one from another site).
 */
export class ApiError extends Error {
  override name = 'ApiError';
  readonly status: number;
  /** The whole answer of the core, for the fields beside `error` (the cause of a closed incognito conversation, D-136). */
  readonly body: Record<string, unknown>;

  constructor(status: number, message: string, body: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function call<T>(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const send = (extra: Record<string, string> = {}): Promise<Response> =>
    fetch(path, {
      method,
      credentials: 'same-origin',
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  let response = await send();
  let data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  // From the phone (D-292, step-up): a decision the core refuses without Face ID; asked for exactly it, then sent again once.
  if (method === 'POST' && needsVerification(onRemoteOrigin(window.location), response.status, data)) {
    let header: Record<string, string>;
    try {
      header = await stepUpHeader(actionPath(path, window.location.origin), body);
    } catch (error) {
      // Face ID cancelled, the check refused, the session ended meanwhile: an ApiError with an Italian text, as every other refusal.
      const failed = checkFailure(error);
      if (sessionEnded(true, failed.status, failed.body)) window.location.reload();
      throw new ApiError(failed.status, failed.text, failed.body);
    }
    response = await send(header);
    data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  }
  // From the phone (D-292): the session ended (12 hours, idle, unlinked): back to «Entra con Face ID».
  if (sessionEnded(onRemoteOrigin(window.location), response.status, data)) window.location.reload();
  if (!response.ok) throw new ApiError(response.status, typeof data.error === 'string' ? data.error : `HTTP ${String(response.status)}`, data);
  return data as T;
}

/** A trial notice from the core (I-1), the same way as a real one: every open page shows it. How many pages it reached. */
export async function testNotice(kind: 'reply' | 'approval' | 'failure'): Promise<number> {
  return (await call<{ sent: string; pages: number }>('POST', '/api/notifications/test', { kind })).pages;
}

/** The list, or the archived conversations (up to 200, the most the core gives in one page). */
export async function listConversations(archived = false): Promise<Conversation[]> {
  return (await call<{ conversations: Conversation[] }>('GET', archived ? '/api/conversations?archived=1&limit=200' : '/api/conversations')).conversations;
}

/** The system chats (D-064), not archived. */
export async function listSystemChats(): Promise<Conversation[]> {
  return (await call<{ conversations: Conversation[] }>('GET', '/api/conversations?origin=system')).conversations;
}

/** Why a task failed; null when nothing was recorded. */
export async function loadTaskFailure(taskId: string): Promise<TaskFailure | null> {
  return (await call<{ error: TaskFailure | null }>('GET', `/api/tasks/${encodeURIComponent(taskId)}/error`)).error;
}

/** Retries a failed task from the step that failed. */
export async function retryTask(taskId: string): Promise<Task> {
  return (await call<{ task: Task }>('POST', `/api/tasks/${encodeURIComponent(taskId)}/retry`, {})).task;
}

/** Opens the system chat of a failed task, or the one already open. */
export async function openSystemChat(taskId: string): Promise<Conversation> {
  return (await call<{ conversation: Conversation }>('POST', `/api/tasks/${encodeURIComponent(taskId)}/system-chat`, {})).conversation;
}

/** Attaches the question of the failed task to its system chat. */
export async function attachQuestion(conversationId: string): Promise<Message> {
  return (await call<{ message: Message }>('POST', `/api/conversations/${encodeURIComponent(conversationId)}/question`, {})).message;
}

/** Deletes the texts of an archived conversation for good (D-057). */
/** "Elimina" (D-157): the conversation and everything it left go for good; the user confirmed it. */
export async function eraseConversation(conversationId: string): Promise<void> {
  await call('POST', `/api/conversations/${encodeURIComponent(conversationId)}/erase`, {});
}

export async function loadConversation(conversationId: string): Promise<Conversation> {
  return (await call<{ conversation: Conversation }>('GET', `/api/conversations/${encodeURIComponent(conversationId)}`)).conversation;
}

/** The secretary's conversation (D-144): the one there is, or a new one the first time. */
export async function openSecretary(): Promise<Conversation> {
  return (await call<{ conversation: Conversation }>('POST', '/api/secretary', {})).conversation;
}

/** The secretary's conversation for the address `/segretaria` (D-156): no new session (D-146); null before the first click. */
export async function findSecretary(): Promise<Conversation | null> {
  return (await call<{ conversation: Conversation | null }>('GET', '/api/secretary')).conversation;
}

/** "Fatto" on a commitment: the click is the confirmation. */
export async function markCommitmentDone(id: string): Promise<Commitment> {
  return (await call<{ commitment: Commitment }>('POST', `/api/commitments/${encodeURIComponent(id)}/done`, {})).commitment;
}

/** The cardwall (I-13, D-152): cards and commitments with their column, the projects and agents a card may name. */
export async function loadCards(): Promise<CardWall> {
  return call<CardWall>('GET', '/api/cards');
}

/** What the user writes on a card: `goal` is the "Descrizione" (Markdown), `criteria` "Fatto quando", `priority` 0-4, `planned` "Data esecuzione". */
export interface CardFieldsInput {
  title?: string;
  project?: string | null;
  assignee?: string;
  due?: string | null;
  goal?: string | null;
  criteria?: string | null;
  priority?: number;
  planned?: string | null;
  /** A style of Open Design, by slug; only on a Designer card (D-163). */
  style?: string | null;
  /** Skills of the catalog, `owner/repo/slug`; only on a Designer card (D-163). */
  skills?: string[];
}

/** A card written on the wall: it starts in the inbox. Its id. */
export async function createCard(input: CardFieldsInput & { title: string }): Promise<string> {
  return (await call<{ card: { id: string } }>('POST', '/api/cards', input)).card.id;
}

/** Changes a card; null takes a project, a day or a text away. */
export async function updateCard(id: string, fields: CardFieldsInput): Promise<void> {
  await call('POST', `/api/cards/${encodeURIComponent(id)}`, fields);
}

/** The card in full: body, criteria, links, checklist, files, history (tasks only). */
export async function loadCardDetail(id: string): Promise<CardDetailData> {
  return (await call<{ card: CardDetailData }>('GET', `/api/cards/${encodeURIComponent(id)}`)).card;
}

export async function addCardLink(id: string, url: string, title?: string): Promise<CardLink> {
  return (await call<{ link: CardLink }>('POST', `/api/cards/${encodeURIComponent(id)}/links`, { url, ...(title === undefined || title === '' ? {} : { title }) })).link;
}

export async function removeCardLink(id: string, link: string): Promise<void> {
  await call('DELETE', `/api/cards/${encodeURIComponent(id)}/links/${encodeURIComponent(link)}`, {});
}

export async function addChecklistItem(id: string, body: string): Promise<ChecklistItem> {
  return (await call<{ item: ChecklistItem }>('POST', `/api/cards/${encodeURIComponent(id)}/checklist`, { body })).item;
}

export async function updateChecklistItem(id: string, item: string, fields: { body?: string; done?: boolean }): Promise<ChecklistItem> {
  return (await call<{ item: ChecklistItem }>('POST', `/api/cards/${encodeURIComponent(id)}/checklist/${encodeURIComponent(item)}`, fields)).item;
}

export async function removeChecklistItem(id: string, item: string): Promise<void> {
  await call('DELETE', `/api/cards/${encodeURIComponent(id)}/checklist/${encodeURIComponent(item)}`, {});
}

/** Attaches a file: its bytes in base64, since the API takes only JSON. */
export async function uploadCardFile(id: string, file: { name: string; type: string; data: string }): Promise<CardFile> {
  return (await call<{ file: CardFile }>('POST', `/api/cards/${encodeURIComponent(id)}/files`, file)).file;
}

export async function removeCardFile(id: string, file: string): Promise<void> {
  await call('DELETE', `/api/cards/${encodeURIComponent(id)}/files/${encodeURIComponent(file)}`, {});
}

/** Where the browser opens (or downloads) an attached file; also the `src` of a thumbnail. */
export function cardFileUrl(id: string, file: string): string {
  return `/api/cards/${encodeURIComponent(id)}/files/${encodeURIComponent(file)}`;
}

/** A card moved by hand; the core refuses (409) a move it does not allow. */
export async function moveCard(id: string, to: MoveTarget): Promise<void> {
  await call('POST', `/api/cards/${encodeURIComponent(id)}/move`, { to });
}

/**
 * "Avvia", "Riprendi" and "Riprova" of a card (D-159); `run`, a drag into "In
 * corso", and `stop`, "Ferma" (D-235). The core refuses (409) what it does not allow.
 */
export async function cardAction(id: string, action: 'start' | 'resume' | 'retry' | 'run' | 'stop'): Promise<{ left: boolean }> {
  const body = await call<{ left?: unknown }>('POST', `/api/cards/${encodeURIComponent(id)}/${action}`, {});
  // Only "Ferma" says whether the card is still at work after the core waited for it.
  return { left: body.left === true };
}

/** «Rimanda» (D-235): an agent's card back to work with a note; `L2` keeps it on the local model, `L1` lets it go back to the cloud. */
export async function sendBackCard(id: string, note: string, label: 'L1' | 'L2'): Promise<void> {
  await call('POST', `/api/cards/${encodeURIComponent(id)}/send-back`, { note, label });
}

/** "Aspetta anche…": `id` waits for `on` to be done. */
export async function addCardDependency(id: string, on: string): Promise<void> {
  await call('POST', `/api/cards/${encodeURIComponent(id)}/dependencies`, { on });
}

export async function removeCardDependency(id: string, on: string): Promise<void> {
  await call('DELETE', `/api/cards/${encodeURIComponent(id)}/dependencies/${encodeURIComponent(on)}`, {});
}

export async function renameConversation(conversationId: string, title: string): Promise<Conversation> {
  return (await call<{ conversation: Conversation }>('POST', `/api/conversations/${encodeURIComponent(conversationId)}/title`, { title })).conversation;
}

/** Archives a conversation, or brings it back to the list: nothing is deleted. */
export async function archiveConversation(conversationId: string, archived: boolean): Promise<Conversation> {
  return (await call<{ conversation: Conversation }>('POST', `/api/conversations/${encodeURIComponent(conversationId)}/archive`, { archived }))
    .conversation;
}

/** Pins a conversation at the top of the list, or unpins it (D-089): no limit of number. */
export async function pinConversation(conversationId: string, pinned: boolean): Promise<Conversation> {
  return (await call<{ conversation: Conversation }>('POST', `/api/conversations/${encodeURIComponent(conversationId)}/${pinned ? 'pin' : 'unpin'}`, {}))
    .conversation;
}

/** "Cerca" (D-089): conversations, messages, notes and pages up to L2; the query never goes to a log. */
export async function search(query: string, limit: number, signal?: AbortSignal): Promise<SearchResult> {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  const response = await fetch(`/api/search?${params.toString()}`, { credentials: 'same-origin', ...(signal === undefined ? {} : { signal }) });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new ApiError(response.status, typeof data.error === 'string' ? data.error : `HTTP ${String(response.status)}`, data);
  return data as unknown as SearchResult;
}

/** What this installation is (D-089, D-098); undefined when the core does not say. */
export async function loadInstallation(): Promise<InstallationInfo | undefined> {
  return parseInstallation(await call<unknown>('GET', '/api/installation'));
}

/** «Pronta per i dati veri» (D-192): the last outcome, null before the first check. */
export async function loadReadiness(): Promise<ReadinessReport | null> {
  return readinessOf(await call<unknown>('GET', '/api/installation/readiness'));
}

/** Checks again; the core runs one check at a time and at most every 10 s. */
export async function checkReadiness(): Promise<ReadinessReport | null> {
  return readinessOf(await call<unknown>('POST', '/api/installation/readiness', {}));
}

function readinessOf(value: unknown): ReadinessReport | null {
  const report = parseReadiness(value);
  if (report === undefined) throw new ApiError(502, 'invalid answer');
  return report;
}

/** Opens a conversation; a work one may name an approved project (D-058). */
export async function createConversation(mode: ConversationMode, project?: string, agent?: ConversationAgent, incognito = false, trialModel?: string, character?: string): Promise<Conversation> {
  const body = {
    mode,
    // A chat with a person of the series on Claude (D-225, tappa B).
    ...(character === undefined ? {} : { character }),
    ...(project === undefined || project === '' ? {} : { project }),
    ...(agent === undefined ? {} : { agent }),
    ...(incognito ? { incognito: true } : {}),
    // "Prova in chat" (D-142): only that local model answers.
    ...(trialModel === undefined ? {} : { trialModel }),
  };
  return (await call<{ conversation: Conversation }>('POST', '/api/conversations', body)).conversation;
}

/** "Cosa resta fuori da Arianna" before the first message of an incognito conversation (D-136): only whether it reaches the cloud, and the project. */
export async function loadIncognitoNotice(mode: ConversationMode, project?: string): Promise<IncognitoNotice> {
  const params = new URLSearchParams({ mode });
  if (mode === 'work' && project !== undefined && project !== '') params.set('project', project);
  const notice = parseNotice(await call<unknown>('GET', `/api/incognito/notice?${params.toString()}`));
  if (notice === undefined) throw new ApiError(500, 'malformed notice');
  return notice;
}

/** "Termina" (D-136): the core stops the work, deletes the texts and says what it deleted and what stays outside; undefined when its answer is not the contract's. */
export async function endIncognito(conversationId: string): Promise<EndResult | undefined> {
  return parseEndResult(await call<unknown>('POST', `/api/conversations/${encodeURIComponent(conversationId)}/end`, {}));
}

/** The page of GOD (D-127): project, clone, conversations. */
export async function loadGod(): Promise<GodStatus> {
  return call<GodStatus>('GET', '/api/god');
}

/** "Crea il clone" / "Aggiorna il clone" (D-127): the core runs pnpm god:clone's steps. */
export async function syncGodClone(): Promise<GodStatus> {
  return call<GodStatus>('POST', '/api/god/clone', {});
}

/** The plans of GOD approved, the newest first, with their subtasks (D-127, G2-G3). */
export async function loadGodPlans(): Promise<GodPlan[]> {
  return (await call<{ plans: GodPlan[] }>('GET', '/api/god/plans')).plans;
}

/** The plan under an answer of GOD: the proposal checked by the core, and the approved plan if any. */
export async function loadMessagePlan(messageId: string): Promise<MessagePlan> {
  return call<MessagePlan>('GET', `/api/god/messages/${encodeURIComponent(messageId)}/plan`);
}

/** "Approva e avvia": the subtasks start, each in a clone of its own. */
export async function approveGodPlan(messageId: string): Promise<GodPlan> {
  return (await call<{ plan: GodPlan }>('POST', '/api/god/plans', { messageId })).plan;
}

/** Ferma, Riprendi, Scarta, Prepara il ramo of a subtask. */
export async function actOnSubtask(id: string, action: SubtaskAction): Promise<GodSubtask> {
  return (await call<{ subtask: GodSubtask }>('POST', `/api/god/subtasks/${encodeURIComponent(id)}/${action}`, {})).subtask;
}

/** «Prova», «Approva funzionalità», «Non funziona» (D-179) on a subtask or on a whole plan: the work goes on in the core. */
export async function landGod(kind: 'subtasks' | 'plans', id: string, action: LandAction, text = ''): Promise<GodLandingView> {
  return (await call<{ landing: GodLandingView }>('POST', `/api/god/${kind}/${encodeURIComponent(id)}/land/${action}`, action === 'reject' ? { text } : {})).landing;
}

/** "Riassumi e riparti" (D-127, G4): a new conversation with GOD from a summary of this one. */
/** «Nuova sessione» of the Designer (I-20, D-185): the same conversation, a fresh session; `open` is the mockup open in the Studio. */
export async function startDesignerSession(conversationId: string, open?: string): Promise<Conversation> {
  return (await call<{ conversation: Conversation }>('POST', `/api/conversations/${encodeURIComponent(conversationId)}/session`, open === undefined ? {} : { open })).conversation;
}

export async function restartGodConversation(conversationId: string): Promise<Conversation> {
  return (await call<{ conversation: Conversation }>('POST', `/api/god/conversations/${encodeURIComponent(conversationId)}/restart`, {})).conversation;
}

/** The summary a conversation with GOD restarts from, or null. */
export async function loadGodCarry(conversationId: string): Promise<GodCarry | null> {
  return (await call<{ carry: GodCarry | null }>('GET', `/api/god/conversations/${encodeURIComponent(conversationId)}/carry`)).carry;
}

/** "Parlane con GOD" (I-6, D-178): a new conversation with GOD about an entry of "Novità"; the core finds it again in git. */
export async function discussWithGod(ref: ChangelogRef): Promise<Conversation> {
  return (await call<{ conversation: Conversation }>('POST', '/api/god/changelog', ref)).conversation;
}

/** The agents the user may talk with directly now (D-111d). */
/** Who the user may talk with directly (D-111d), with the interlocutors of «Con chi parli» that cannot answer now (D-111, tappa B; absent from an older core). */
export async function listDirectChoices(): Promise<{ agents: DirectAgent[]; off: OffInterlocutor[]; characters: ChatCharacter[] }> {
  const answer = await call<{ agents: DirectAgent[]; off?: OffInterlocutor[]; characters?: ChatCharacter[] }>('GET', '/api/direct-agents');
  // The people of the series Claude may play (D-225, tappa B); absent from an older core.
  return { agents: answer.agents, off: answer.off ?? [], characters: answer.characters ?? [] };
}

/** The projects the user approved, which a new work conversation may choose. */
export async function listProjects(): Promise<ProjectInfo[]> {
  return (await call<{ projects: ProjectInfo[] }>('GET', '/api/projects')).projects;
}

/** The cloud models a work conversation may choose on this installation. */
export async function listModels(): Promise<CloudModel[]> {
  return (await call<{ models: CloudModel[] }>('GET', '/api/models')).models;
}

/** Sets the model of a work conversation; null lets the router choose. */
export async function setModel(conversationId: string, model: string | null): Promise<Conversation> {
  return (await call<{ conversation: Conversation }>('POST', `/api/conversations/${encodeURIComponent(conversationId)}/model`, { model })).conversation;
}

/** Turns the switch «Personaggio» of a conversation on or off (D-225). */
export async function setCharacter(conversationId: string, on: boolean): Promise<Conversation> {
  return (await call<{ conversation: Conversation }>('POST', `/api/conversations/${encodeURIComponent(conversationId)}/character`, { on })).conversation;
}

export async function listMessages(conversationId: string, beforeId?: string): Promise<Message[]> {
  const query = new URLSearchParams({ limit: '100', ...(beforeId === undefined ? {} : { before: beforeId }) });
  const path = `/api/conversations/${encodeURIComponent(conversationId)}/messages?${query.toString()}`;
  return (await call<{ messages: Message[] }>('GET', path)).messages;
}

/**
 * `design`: the style and skills chosen in the Studio (I-19, D-184), only for the direct chat with the Designer.
 * While an answer is at work the core queues the message (D-218): `queued` instead of the message and its task.
 */
export async function sendMessage(
  conversationId: string,
  body: string,
  design?: { style?: string; skills?: string[] },
  attachments?: readonly string[],
): Promise<{ message: Message; task: Task } | { queued: QueuedMessage }> {
  // The images and files of the message (D-247): ids of pending attachments, only when there are some.
  const attached = attachments === undefined || attachments.length === 0 ? {} : { attachments: [...attachments] };
  return call('POST', `/api/conversations/${encodeURIComponent(conversationId)}/messages`, { body, ...design, ...attached });
}

/** An image or a file pasted, dropped or chosen (D-247): kept pending by the core until the message leaves. */
export async function uploadAttachment(name: string, data: string): Promise<AttachmentInfo> {
  return (await call<{ attachment: AttachmentInfo }>('POST', '/api/attachments', { name, data })).attachment;
}

/** «×» on an attachment not sent yet: the core removes it and its file. */
export async function discardAttachment(id: string): Promise<void> {
  await call('DELETE', `/api/attachments/${encodeURIComponent(id)}`, {});
}

/** «Chiedi a lato» (D-232): the side threads of a conversation, by the answer they are about. */
export async function listSides(conversationId: string): Promise<SideThread[]> {
  return (await call<{ sides: SideThread[] }>('GET', `/api/conversations/${encodeURIComponent(conversationId)}/sides`)).sides;
}

/** The side thread of an answer, created the first time and found again after (D-232). */
export async function openSide(conversationId: string, messageId: string): Promise<Conversation> {
  return (await call<{ conversation: Conversation }>('POST', `/api/conversations/${encodeURIComponent(conversationId)}/sides`, { messageId })).conversation;
}

/** The routines (D-110 tappa A, D-254), oldest first. */
export async function loadRoutines(): Promise<Routine[]> {
  return (await call<{ routines: Routine[] }>('GET', '/api/routines')).routines;
}

/** A new routine from the form: active at once, in the time zone of this Mac. */
export async function createRoutine(body: RoutineBody): Promise<Routine> {
  return (await call<{ routine: Routine }>('POST', '/api/routines', body)).routine;
}

export async function updateRoutine(id: string, body: Partial<RoutineBody>): Promise<Routine> {
  return (await call<{ routine: Routine }>('PATCH', `/api/routines/${encodeURIComponent(id)}`, body)).routine;
}

/** «In pausa» or «Attiva». */
export async function setRoutineActive(id: string, active: boolean): Promise<Routine> {
  return (await call<{ routine: Routine }>('POST', `/api/routines/${encodeURIComponent(id)}/${active ? 'resume' : 'pause'}`, {})).routine;
}

/** «Togli». */
export async function retireRoutine(id: string): Promise<void> {
  await call('POST', `/api/routines/${encodeURIComponent(id)}/retire`, {});
}

/** «Attiva» or «Scarta» of a routine Arianna proposed in the chat (D-256): the card in the chat is decided with it. */
export async function decideRoutine(id: string, approve: boolean): Promise<Routine> {
  return (await call<{ routine: Routine }>('POST', `/api/routines/${encodeURIComponent(id)}/${approve ? 'approve' : 'discard'}`, {})).routine;
}

/** «Prova adesso»: the report now, in the routine's chat. */
export async function tryRoutine(id: string): Promise<void> {
  await call('POST', `/api/routines/${encodeURIComponent(id)}/run`, {});
}

/** The calendar of the routines (D-257): their times in the days asked, on the wall clock of `timezone`. */
export async function loadRoutineCalendar(from: string, to: string, timezone?: string): Promise<CalendarWeek> {
  const query = new URLSearchParams(timezone === undefined ? { from, to } : { from, to, tz: timezone });
  return call<CalendarWeek>('GET', `/api/routines/calendar?${query.toString()}`);
}

/** «Solo <giorno>» of the calendar (D-257): the routine gives `day` to a new one on `to` at `at`, in one step. */
export async function splitRoutine(id: string, day: number, to: number, at: string): Promise<{ routine: Routine; created: Routine }> {
  return call<{ routine: Routine; created: Routine }>('POST', `/api/routines/${encodeURIComponent(id)}/split`, { day, to, at });
}

/** «Annulla» of a split (D-257): the routine split off goes and the first gets back the day it gave, in one step. */
export async function unsplitRoutine(id: string, created: string): Promise<Routine> {
  return (await call<{ routine: Routine }>('POST', `/api/routines/${encodeURIComponent(id)}/unsplit`, { created })).routine;
}

/** Dashboard (D-248): the tiles, after the refreshes that ended are settled. */
export async function loadTiles(): Promise<DashboardTile[]> {
  return (await call<{ tiles: DashboardTile[] }>('GET', '/api/dashboard/tiles')).tiles;
}

/** The answers of a conversation already pinned, with their tile. */
export async function loadPinned(conversationId: string): Promise<{ messageId: string; tileId: string }[]> {
  return (await call<{ pinned: { messageId: string; tileId: string }[] }>('GET', `/api/conversations/${encodeURIComponent(conversationId)}/pinned`)).pinned;
}

/** What «Fissa» proposes: the question rewritten by the local model, or the user's message. */
export async function suggestTile(messageId: string): Promise<Suggestion> {
  return call<Suggestion>('POST', '/api/dashboard/suggest', { messageId });
}

export async function pinTile(messageId: string, title: string, question: string, width: TileWidth, kind: TileKind): Promise<DashboardTile> {
  return (await call<{ tile: DashboardTile }>('POST', '/api/dashboard/tiles', { messageId, title, question, width, kind })).tile;
}

/** The chart of a tile again from the answer it holds (the local model). */
export async function chartTile(id: string): Promise<DashboardTile> {
  return (await call<{ tile: DashboardTile }>('POST', `/api/dashboard/tiles/${encodeURIComponent(id)}/chart`, {})).tile;
}

export async function updateTile(id: string, change: { title?: string; width?: TileWidth; kind?: TileKind; question?: string }): Promise<DashboardTile> {
  return (await call<{ tile: DashboardTile }>('PATCH', `/api/dashboard/tiles/${encodeURIComponent(id)}`, change)).tile;
}

export async function orderTiles(ids: readonly string[]): Promise<DashboardTile[]> {
  return (await call<{ tiles: DashboardTile[] }>('POST', '/api/dashboard/order', { ids })).tiles;
}

export async function refreshTile(id: string): Promise<DashboardTile> {
  return (await call<{ tile: DashboardTile }>('POST', `/api/dashboard/tiles/${encodeURIComponent(id)}/refresh`, {})).tile;
}

export async function cancelTileRefresh(id: string): Promise<DashboardTile> {
  return (await call<{ tile: DashboardTile }>('POST', `/api/dashboard/tiles/${encodeURIComponent(id)}/cancel`, {})).tile;
}

export async function removeTile(id: string): Promise<void> {
  await call('POST', `/api/dashboard/tiles/${encodeURIComponent(id)}/remove`, {});
}

/** The messages waiting for the answer at work (D-218), and whether "Ferma" paused them. */
export async function loadQueue(conversationId: string): Promise<QueueView> {
  return (await call<{ queue: QueueView }>('GET', `/api/conversations/${encodeURIComponent(conversationId)}/queue`)).queue;
}

export async function resumeQueue(conversationId: string): Promise<QueueView> {
  return (await call<{ queue: QueueView }>('POST', `/api/conversations/${encodeURIComponent(conversationId)}/queue/resume`, {})).queue;
}

export async function editQueued(id: string, body: string): Promise<QueuedMessage> {
  return (await call<{ queued: QueuedMessage }>('PATCH', `/api/queued-messages/${encodeURIComponent(id)}`, { body })).queued;
}

export async function removeQueued(id: string): Promise<void> {
  // A body, as every other write: the core wants JSON on anything but a GET.
  await call('DELETE', `/api/queued-messages/${encodeURIComponent(id)}`, {});
}

/** "Invia ora": the queued message leaves at once. */
export async function sendQueuedNow(id: string): Promise<{ message: Message; task: Task }> {
  return call('POST', `/api/queued-messages/${encodeURIComponent(id)}/send`, {});
}

/** Who «@» may call in a conversation with Arianna (D-107, tappa B2). */
export async function loadMentionable(): Promise<string[]> {
  return (await call<{ agents: string[] }>('GET', '/api/chat/mentionable')).agents;
}

/** «Ha visto solo il brief» (D-107, tappa B2): the text of the request a delegated agent received from this conversation. */
export async function loadBrief(conversationId: string, delegationId: string): Promise<{ agent: string; brief: string; label: Label }> {
  return call('GET', `/api/conversations/${encodeURIComponent(conversationId)}/delegations/${encodeURIComponent(delegationId)}/brief`);
}

/** "Ferma" (D-218): the answers at work in the conversation stop, its queue pauses. */
export async function stopConversation(conversationId: string): Promise<{ stopped: number }> {
  return call('POST', `/api/conversations/${encodeURIComponent(conversationId)}/stop`, {});
}

/** "/nota" (D-080) and "Salva in inbox" (D-084): a new L2 note in kb/inbox; the answer holds path and label, never the text. */
export async function captureNote(note: {
  text: string;
  kind: 'note' | 'link' | 'thought';
  url?: string;
  title?: string;
  from?: Label;
  /** The conversation "/nota" was written in: the core refuses it from an incognito one (D-136). */
  conversationId?: string;
}): Promise<{ path: string; label: string; organizing?: boolean }> {
  return call('POST', '/api/capture', note);
}

export async function loadTask(id: string): Promise<Task> {
  return (await call<{ task: Task }>('GET', `/api/tasks/${encodeURIComponent(id)}`)).task;
}

export async function listPendingApprovals(): Promise<Approval[]> {
  return (await call<{ approvals: Approval[] }>('GET', '/api/approvals?state=pending')).approvals;
}

/** Decided approvals, most recently decided first. */
export async function listDecidedApprovals(state: 'approved' | 'rejected', limit = 20): Promise<Approval[]> {
  return (await call<{ approvals: Approval[] }>('GET', `/api/approvals?state=${state}&limit=${String(limit)}`)).approvals;
}

/**
 * `choice`: the executor chosen for a card, with an approval of kind executor (D-159).
 * `plan`: the cards of a plan to start at once, «Avvia subito», by their number, and the revision shown (D-235).
 */
export async function decide(approvalId: string, state: 'approved' | 'rejected', choice?: ExecutorChoice, plan?: PlanChoice): Promise<Approval> {
  // From the phone (D-292) the core asks Face ID for exactly this decision: call() asks it and sends again.
  return (
    await call<{ approval: Approval }>('POST', `/api/approvals/${encodeURIComponent(approvalId)}/decision`, {
      state,
      ...(choice === undefined ? {} : { choice }),
      ...(plan === undefined ? {} : { starts: plan.starts, revision: plan.revision }),
    })
  ).approval;
}

/** The user's edit of a pending plan (D-235): the cards replaced, checked again by the core. */
export async function editPlan(approvalId: string, plan: PlanBody): Promise<Approval> {
  return (await call<{ approval: Approval }>('PUT', `/api/approvals/${encodeURIComponent(approvalId)}/plan`, plan)).approval;
}

/** The status panel: agents, last router decision, gateway today. */
export async function loadStatus(): Promise<StatusSnapshot> {
  return call<StatusSnapshot>('GET', '/api/status');
}

/** The character packs and who wears what (D-060). */
export async function loadCharacters(): Promise<CharacterListing> {
  return call<CharacterListing>('GET', '/api/characters');
}

/** The themes the core serves already checked, the chosen one and the one in use (D-103). */
export async function loadThemes(): Promise<ThemeListing> {
  return call<ThemeListing>('GET', '/api/themes');
}

/** Downloads the characters of pixel-agents into data/characters/pixel-agents (D-206): only their PNGs and licence. */
export async function downloadPixelAgents(): Promise<PixelAgentsResult> {
  return call<PixelAgentsResult>('POST', '/api/characters/pixel-agents');
}

/** The pack written by a download of pixel-agents (D-206). */
export interface PixelAgentsResult {
  pack: string;
  characters: number;
  replaced: boolean;
}

/** Where the sheet of a character is served; `version` changes the address after a replacement (D-118). */
export function sheetUrl(choice: CharacterChoice, version = 0): string {
  const path = `/api/characters/${encodeURIComponent(choice.pack)}/${encodeURIComponent(choice.character)}`;
  return version === 0 ? path : `${path}?v=${String(version)}`;
}

/** A sheet saved by the core in the pack `miei` (D-118). */
export interface UploadedCharacter {
  pack: string;
  character: string;
  name: string;
  rows: 3 | 4;
  replaced: boolean;
}

/**
 * Uploads a sheet (`png` in base64) under `name`. A character of the same
 * name is not replaced unless `replace`: the core answers with the one it
 * has, and the page asks the user.
 */
export async function uploadCharacter(
  name: string,
  png: string,
  replace = false,
): Promise<{ saved: UploadedCharacter } | { existing: { id: string; name: string } }> {
  const response = await fetch('/api/characters/upload', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(replace ? { name, png, replace } : { name, png }),
  });
  const data = (await response.json().catch(() => ({}))) as { character?: UploadedCharacter; existing?: { id: string; name: string }; error?: unknown };
  if (response.status === 409 && data.existing !== undefined) return { existing: data.existing };
  if (!response.ok || data.character === undefined) throw new ApiError(response.status, typeof data.error === 'string' ? data.error : `HTTP ${String(response.status)}`);
  return { saved: data.character };
}

/** The model that draws a character (D-123), as `[sprites]` of arianna.toml names it. */
export type SpriteModel = 'sonnet' | 'opus' | 'local';

/** What draws and what leaves, before "Genera personaggio". */
export interface SpriteInfo {
  model: SpriteModel;
  available: boolean;
  reason: string | null;
  sends: string[];
}

/** A drawing not saved yet: "Tieni" sends `png` to uploadCharacter. */
export interface GeneratedSprite {
  png: string;
  rows: 4;
  model: SpriteModel;
  label: 'L1';
}

export function loadSpriteInfo(): Promise<SpriteInfo> {
  return call<SpriteInfo>('GET', '/api/characters/generate');
}

/** A refused drawing keeps the core's code (`invalid`, `unavailable`, `busy`, `quota`, `bad-reply`…) and the reset of the quota. */
export class SpriteApiError extends ApiError {
  override name = 'SpriteApiError';
  readonly code: string;
  readonly resetsAt: string | null;

  constructor(status: number, message: string, code: string, resetsAt: string | null) {
    super(status, message);
    this.code = code;
    this.resetsAt = resetsAt;
  }
}

/** One drawing by the model of `[sprites]` (D-123), from the agent's texts and the user's hint. */
export async function generateSprite(subject: { name: string; description: string; prompt: string; hint: string }): Promise<GeneratedSprite> {
  const response = await fetch('/api/characters/generate', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(subject),
  });
  const data = (await response.json().catch(() => ({}))) as Partial<GeneratedSprite> & { error?: unknown; code?: unknown; resetsAt?: unknown };
  if (!response.ok || typeof data.png !== 'string') {
    throw new SpriteApiError(
      response.status,
      typeof data.error === 'string' ? data.error : `HTTP ${String(response.status)}`,
      typeof data.code === 'string' ? data.code : '',
      typeof data.resetsAt === 'string' ? data.resetsAt : null,
    );
  }
  return data as GeneratedSprite;
}

/** The trials of catalog models, newest first (D-081). */
export async function listModelEvals(limit = 20, modelId?: string): Promise<ModelEval[]> {
  const model = modelId === undefined ? '' : `&modelId=${encodeURIComponent(modelId)}`;
  return (await call<{ evals: ModelEval[] }>('GET', `/api/model-evals?limit=${String(limit)}${model}`)).evals;
}

/** «Confronto dei modelli» (D-199): every trial of a role, with the model in use as reference. */
export async function loadModelComparison(role = 'orchestrator'): Promise<Comparison> {
  return (await call<{ comparison: Comparison }>('GET', `/api/model-comparison?role=${encodeURIComponent(role)}`)).comparison;
}

/** The fake questions with different outcomes among 2-3 trials on the same questions (D-199). */
export async function loadComparisonCases(ids: readonly string[]): Promise<CaseComparison> {
  return (await call<{ cases: CaseComparison }>('GET', `/api/model-comparison/cases?ids=${ids.map(encodeURIComponent).join(',')}`)).cases;
}

/** Every model, local and cloud, for Impostazioni → Modelli (I-3); read only and L0. */
export async function loadModelsOverview(): Promise<ModelsOverview> {
  return call<ModelsOverview>('GET', '/api/models/overview');
}

/** «Server dei modelli (oMLX)» (D-265): the version installed and the newest release, all L0. */
export async function loadOmlxRelease(): Promise<OmlxReleaseView> {
  return call<OmlxReleaseView>('GET', '/api/models/omlx-release');
}

/** «Controlla ora»: the version and GitHub, in the background; the card reads again while `checking`. */
export async function checkOmlxRelease(): Promise<void> {
  await call('POST', '/api/models/omlx-release/check', {});
}

/** Reads the version installed again (`--version` of the oMLX endpoint), without asking GitHub. */
export async function readOmlxVersion(): Promise<OmlxReleaseView> {
  return call<OmlxReleaseView>('POST', '/api/models/omlx-release/version', {});
}

/** Starts a download or verification of a local model in the background (I-3, M4); the progress comes with the overview. */
export async function startModelAction(modelId: string, kind: 'download' | 'verify'): Promise<ModelAction> {
  return (await call<{ action: ModelAction }>('POST', `/api/models/${encodeURIComponent(modelId)}/${kind}`, {})).action;
}

export async function cancelModelAction(modelId: string): Promise<ModelAction> {
  return (await call<{ action: ModelAction }>('POST', `/api/models/${encodeURIComponent(modelId)}/cancel`, {})).action;
}

/** The router's advisor (D-207): the path of the usage bar's status file, the week as read now, today's opinions. */
export interface AdvisorStatus {
  usageFile: string | null;
  weekPercent: number | null;
  today: number;
  dailyCap: number;
  weekLimit: number;
}

export async function loadAdvisor(): Promise<AdvisorStatus> {
  return call<AdvisorStatus>('GET', '/api/router/advisor');
}

/** An empty path removes it. */
export async function saveAdvisor(usageFile: string): Promise<AdvisorStatus> {
  return call<AdvisorStatus>('POST', '/api/router/advisor', { usageFile });
}

/** «Consumi» (D-093, idea 10): counts, times and names of the period, never a text. */
export async function loadUsage(period: UsagePeriod): Promise<UsageReport> {
  return call<UsageReport>('GET', `/api/usage?period=${encodeURIComponent(period)}`);
}

/** «Registro del gateway» (D-296): one page of decisions, metadata only; `query` from queryOf of lib/gateway-log.ts. */
export async function loadGatewayLog(query: string): Promise<GatewayLogPage> {
  return call<GatewayLogPage>('GET', `/api/gateway/log${query}`);
}

/** «Cosa è cambiato» (D-233): the core takes a fresh picture of the installation, then answers what it observed. */
export async function loadChanges(): Promise<ChangesReport> {
  return call<ChangesReport>('GET', '/api/changes');
}

/** Closes the line that asks to restart oMLX by hand after a download (D-201). */
export async function dismissModelReload(): Promise<void> {
  await call<{ ok: boolean }>('POST', '/api/models/reload/dismiss', {});
}

/** Moves the files of a local model into the bin next to them (data/models/eliminati, or data/guard/models/eliminati, D-203); `confirm` is the id typed by the user. Where they went. */
export async function removeModel(modelId: string, confirm: string): Promise<string> {
  return (await call<{ folder: string }>('POST', `/api/models/${encodeURIComponent(modelId)}/remove`, { confirm })).folder;
}

export async function unloadLocalModel(modelId: string): Promise<'unloaded' | 'failed'> {
  return (await call<{ outcome: 'unloaded' | 'failed' }>('POST', `/api/models/${encodeURIComponent(modelId)}/unload`, {})).outcome;
}

/** Erases the bin of the models, after the user's confirmation; how many folders and bytes. */
export async function emptyModelTrash(): Promise<{ removed: number; sizeBytes: number }> {
  return call<{ removed: number; sizeBytes: number }>('POST', '/api/models/trash/empty', { confirm: true });
}

/** Searches the MLX models of Hugging Face (I-10, D-139): only `query` leaves, through the gateway. */
export async function searchHuggingFace(query: string): Promise<HubSearchResult[]> {
  return (await call<{ results: HubSearchResult[] }>('POST', '/api/models/huggingface/search', { query })).results;
}

/** The card of a repository of Hugging Face: files, sizes, sha256 of the weights, why it cannot be added. */
export async function huggingFaceCard(repo: string): Promise<HubCard> {
  return (await call<{ card: HubCard }>('POST', '/api/models/huggingface/card', { repo })).card;
}

/** Adds the repository at the commit of its card to the user catalog; the id of the new entry. */
export async function addFromHuggingFace(repo: string, revision: string): Promise<string> {
  return (await call<{ modelId: string }>('POST', '/api/models/huggingface/add', { repo, revision })).modelId;
}

/** The roles a model added from Hugging Face may have. */
export async function promoteModel(modelId: string, roles: ModelRole[]): Promise<ModelRole[]> {
  return (await call<{ roles: ModelRole[] }>('POST', `/api/models/${encodeURIComponent(modelId)}/promote`, { roles })).roles;
}

/** Takes a model added from Hugging Face out of the catalog; `confirm` is the id typed by the user. */
export async function forgetModel(modelId: string, confirm: string): Promise<void> {
  await call<{ modelId: string }>('POST', `/api/models/${encodeURIComponent(modelId)}/forget`, { confirm });
}

/** The catalog of Open Design (D-160): adopted version, version waiting with the comparison, download running. */
export async function loadDesignCatalog(): Promise<DesignCatalogStatus> {
  return call<DesignCatalogStatus>('GET', '/api/design-catalog');
}

/** "Scarica/Aggiorna catalogo": starts the download in the background. */
export async function updateDesignCatalog(): Promise<DesignCatalogStatus> {
  return call<DesignCatalogStatus>('POST', '/api/design-catalog/update', {});
}

/** "Usa questa versione": the commit the user saw in the summary. */
export async function adoptDesignCatalog(commit: string): Promise<DesignCatalogStatus> {
  return call<DesignCatalogStatus>('POST', '/api/design-catalog/adopt', { commit });
}

/** "Scarta": the version waiting is deleted. */
export async function discardDesignCatalog(): Promise<DesignCatalogStatus> {
  return call<DesignCatalogStatus>('POST', '/api/design-catalog/discard', {});
}

/** Styles and skills of the adopted version: slug, name, description. */
export async function listDesignStyles(): Promise<DesignStyleListing> {
  return call<DesignStyleListing>('GET', '/api/design-catalog/styles');
}

/** The text of one style, with the license notice at the head. */
export async function loadDesignStyle(slug: string): Promise<DesignStyleText> {
  return (await call<{ style: DesignStyleText }>('GET', `/api/design-catalog/styles/${encodeURIComponent(slug)}`)).style;
}

/** The catalog of skills (D-161): the sources followed with their versions, and the suggestions. */
export async function loadSkillsCatalog(): Promise<SkillsStatus> {
  return call<SkillsStatus>('GET', '/api/skills-catalog');
}

/** Follows https://github.com/<owner>/<repo>: nothing is downloaded yet. */
export async function addSkillSource(url: string): Promise<SkillsStatus> {
  return call<SkillsStatus>('POST', '/api/skills-catalog/sources', { url });
}

/** Stops following a source (`owner/repo`) and deletes its files. */
export async function removeSkillSource(source: string): Promise<SkillsStatus> {
  return call<SkillsStatus>('POST', '/api/skills-catalog/remove', { source });
}

/** "Scarica/Aggiorna": the download of a source in the background. */
export async function updateSkillSource(source: string): Promise<SkillsStatus> {
  return call<SkillsStatus>('POST', '/api/skills-catalog/update', { source });
}

/** "Usa questa versione": the commit the user saw in the summary of that source. */
export async function adoptSkillSource(source: string, commit: string): Promise<SkillsStatus> {
  return call<SkillsStatus>('POST', '/api/skills-catalog/adopt', { source, commit });
}

/** "Scarta": the version waiting of that source is deleted. */
export async function discardSkillSource(source: string): Promise<SkillsStatus> {
  return call<SkillsStatus>('POST', '/api/skills-catalog/discard', { source });
}

/** Every skill of the adopted versions: id, name, description, license. */
export async function listSkills(): Promise<SkillListing> {
  return call<SkillListing>('GET', '/api/skills-catalog/skills');
}

/** The text of one skill (`owner/repo/slug`), with source, commit and license at the head. */
export async function loadSkill(id: string): Promise<SkillText> {
  return (await call<{ skill: SkillText }>('GET', `/api/skills-catalog/skill?id=${encodeURIComponent(id)}`)).skill;
}

/** The user's own skills of Claude Code (D-255): what was copied, with the label of each. */
export async function loadClaudeSkills(): Promise<ClaudeSkillsStatus> {
  return call<ClaudeSkillsStatus>('GET', '/api/skills-catalog/claude');
}

/** «Importa»/«Aggiorna»: the core reads the skills folder of Claude Code again and replaces the copy. */
export async function importClaudeSkills(): Promise<ClaudeSkillsStatus> {
  return call<ClaudeSkillsStatus>('POST', '/api/skills-catalog/claude/import', {});
}

/** «Togli»: deletes the copy; the folder of Claude Code stays as it is. */
export async function removeClaudeSkills(): Promise<ClaudeSkillsStatus> {
  return call<ClaudeSkillsStatus>('POST', '/api/skills-catalog/claude/remove', {});
}

/** Marks one skill shareable with the agents in the cloud (L1), or private again (L2). */
export async function shareClaudeSkill(skill: string, shared: boolean, sha256?: string): Promise<ClaudeSkillsStatus> {
  return call<ClaudeSkillsStatus>('POST', '/api/skills-catalog/claude/share', { skill, shared, ...(sha256 === undefined ? {} : { sha256 }) });
}

/** The catalog of agents (D-079): the sources followed with their versions, the queue, the space and the suggestions. */
export async function loadAgentsCatalog(): Promise<AgentsStatus> {
  return call<AgentsStatus>('GET', '/api/agents-catalog');
}

/** Follows https://github.com/<owner>/<repo>: nothing is downloaded yet. */
export async function addAgentSource(url: string): Promise<AgentsStatus> {
  return call<AgentsStatus>('POST', '/api/agents-catalog/sources', { url });
}

/** Stops following a source (`owner/repo`) and deletes its files; the agents already made from it stay. */
export async function removeAgentSource(source: string): Promise<AgentsStatus> {
  return call<AgentsStatus>('POST', '/api/agents-catalog/remove', { source });
}

/** "Scarica/Aggiorna": the download of a source in the background, or in the queue behind another. */
export async function updateAgentSource(source: string): Promise<AgentsStatus> {
  return call<AgentsStatus>('POST', '/api/agents-catalog/update', { source });
}

/** "Usa questa versione": the commit the user saw in the summary of that source. */
export async function adoptAgentSource(source: string, commit: string): Promise<AgentsStatus> {
  return call<AgentsStatus>('POST', '/api/agents-catalog/adopt', { source, commit });
}

/** "Scarta": the version waiting of that source is deleted. */
export async function discardAgentSource(source: string): Promise<AgentsStatus> {
  return call<AgentsStatus>('POST', '/api/agents-catalog/discard', { source });
}

/** Every role of the adopted versions: id, name, description, division, license. */
export async function listAgentRoles(): Promise<AgentRoleListing> {
  return call<AgentRoleListing>('GET', '/api/agents-catalog/agents');
}

/** One role (`owner/repo/slug`) with its source, commit, license and text. */
export async function loadAgentRole(id: string): Promise<AgentRoleText> {
  return (await call<{ agent: AgentRoleText }>('GET', `/api/agents-catalog/agent?id=${encodeURIComponent(id)}`)).agent;
}

/** Queues a trial of a catalog model for the orchestrator role; the id of the trial. */
export async function requestModelEval(modelId: string): Promise<string> {
  return (await call<{ id: string }>('POST', '/api/model-evals', { modelId, role: 'orchestrator' })).id;
}

export async function cancelModelEval(id: string): Promise<ModelEval> {
  return (await call<{ eval: ModelEval }>('POST', `/api/model-evals/${encodeURIComponent(id)}/cancel`, {})).eval;
}

/** A candidate of the voice trial page (D-066). */
export interface TrialModel {
  id: string;
  family: string;
  kind: 'stt' | 'tts';
  present: boolean;
  assigned: boolean;
  sizeBytes: number;
  voices: string[];
  /** A voice of macOS (D-290): its name; `present` says it is installed. */
  systemVoice?: string;
}

export interface VoiceTrial {
  /** `off` without [voice]; `not-installed` without data/voice/venv; else the state of the watchdog. */
  state: string;
  voice: string | null;
  models: TrialModel[];
}

export interface TrialTranscript {
  id: string;
  family: string;
  text?: string;
  seconds?: number;
  error?: string;
}

export async function loadVoiceTrial(): Promise<VoiceTrial> {
  return call<VoiceTrial>('GET', '/api/voice/trial');
}

/** The same recording written by every speech-to-text candidate on disk. */
export async function transcribeTrial(pcm16: string): Promise<TrialTranscript[]> {
  return (await call<{ results: TrialTranscript[] }>('POST', '/api/voice/trial/transcribe', { pcm16 })).results;
}

/** One candidate says `text`: the WAV and the seconds it took. */
export async function speakTrial(text: string, model: string, voice: string): Promise<{ audio: Blob; seconds: number | undefined; first: number | undefined }> {
  const response = await fetch('/api/voice/trial/speak', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, model, voice }),
  });
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    throw new ApiError(response.status, typeof data.error === 'string' ? data.error : `HTTP ${String(response.status)}`);
  }
  const header = (name: string): number | undefined => {
    const value = Number(response.headers.get(name));
    return response.headers.has(name) && Number.isFinite(value) ? value : undefined;
  };
  // The seconds to the first audio are what a call waits before Arianna speaks (D-068).
  return { audio: await response.blob(), seconds: header('x-seconds-spent'), first: header('x-first-audio') };
}

/** A voice copied from a sample (D-069): the sample stays on this computer, L2. */
export interface CopiedVoice {
  id: string;
  name: string;
  createdAt: string;
  seconds: number;
}

export async function listCopiedVoices(): Promise<CopiedVoice[]> {
  return (await call<{ clones: CopiedVoice[] }>('GET', '/api/voice/clones')).clones;
}

/** Saves a voice: 5-30 s of 16 kHz samples (base64), what they say, and the consent of the person. */
export async function saveCopiedVoice(name: string, text: string, pcm16: string): Promise<CopiedVoice> {
  return (await call<{ clone: CopiedVoice }>('POST', '/api/voice/clones', { name, text, pcm16, consent: true })).clone;
}

export async function deleteCopiedVoice(id: string): Promise<void> {
  await call('DELETE', `/api/voice/clones/${encodeURIComponent(id)}`, {});
}

/** Ends a call from its id (one left open by a page that was reloaded). */
export async function endCall(callId: string): Promise<void> {
  await call('POST', `/api/calls/${encodeURIComponent(callId)}/end`, {});
}

/** The agents in the conversation besides Arianna and the user (D-125). */
export async function listParticipants(conversationId: string): Promise<Participant[]> {
  return (await call<{ participants: Participant[] }>('GET', `/api/conversations/${encodeURIComponent(conversationId)}/participants`)).participants;
}

/** The user takes an agent out of the conversation (D-125): it comes back with the next delegation. */
export async function removeParticipant(conversationId: string, agent: string): Promise<void> {
  await call('POST', `/api/conversations/${encodeURIComponent(conversationId)}/participants/${encodeURIComponent(agent)}/remove`, {});
}

/** The calls of a conversation, as receipts (D-066). */
export async function listConversationCalls(conversationId: string): Promise<CallInfo[]> {
  return (await call<{ calls: CallInfo[] }>('GET', `/api/conversations/${encodeURIComponent(conversationId)}/calls`)).calls;
}

/** The call in progress on this machine, if any: a reloaded page finds it and can close it. */
export async function loadLiveCall(): Promise<CallInfo | null> {
  return (await call<{ call: CallInfo | null }>('GET', '/api/calls/live')).call;
}

/** Declines a call of Arianna that is ringing: she writes instead (D-066). */
export async function declineCall(callId: string): Promise<void> {
  await call('POST', `/api/calls/${encodeURIComponent(callId)}/decline`, {});
}

/** "Chiamami quando finisci": a call when the task is over. */
export async function callWhenDone(taskId: string): Promise<CallInfo> {
  return (await call<{ call: CallInfo }>('POST', `/api/tasks/${encodeURIComponent(taskId)}/call-when-done`, {})).call;
}

export async function cancelScheduledCall(callId: string): Promise<void> {
  await call('POST', `/api/calls/${encodeURIComponent(callId)}/cancel`, {});
}

/** The VAPID public key of [push] (or [voice.push], D-292), or null when push is off. */
export async function loadPushKey(): Promise<string | null> {
  return (await call<{ publicKey: string | null }>('GET', '/api/push/key')).publicKey;
}

export async function subscribePush(subscription: PushSubscriptionJSON): Promise<void> {
  await call('POST', '/api/push/subscribe', { subscription });
}

/** The push address of this browser, on the Mac of the core (D-128). */
export async function tellThisMac(endpoint: string): Promise<void> {
  await call('POST', '/api/notifications/this-mac', { endpoint });
}

/** The settings page (D-071): values, catalog, fingerprint, local servers. */
export async function loadSettings(): Promise<SettingsView> {
  return call<SettingsView>('GET', '/api/settings');
}

/** Models, cloud models, characters, [voice]: written at once over the file the page read. */
export async function saveSettings(fingerprint: string, values: SettingsBody): Promise<SettingsView> {
  return call<SettingsView>('POST', '/api/settings', { fingerprint, values });
}

/** Cloud executors, Telegram, projects, local servers: what would change and leave, nothing written yet. */
export async function preparePrivacy(fingerprint: string, values: Partial<Pick<SettingsValues, PrivacySection>>): Promise<PrivacyProposal> {
  return call<PrivacyProposal>('POST', '/api/settings/privacy/prepare', { fingerprint, values });
}

/** "Proponi bozza" (I-14 R2, D-175): the local model drafts the rules of a project; nothing is saved. */
export async function draftProjectRules(project: string): Promise<{ text: string; model: string | null; partial?: string }> {
  return call<{ text: string; model: string | null; partial?: string }>('POST', `/api/projects/${encodeURIComponent(project)}/rules-draft`, {});
}

/** new: not there; same: already the rules; arianna: written by Arianna, replaced; foreign: the user's, left alone (D-176). */
export type RulesExportStatus = 'new' | 'same' | 'arianna' | 'foreign' | 'stale';

/** The preview of "Esporta in CLAUDE.md e AGENTS.md" (I-14 R3, D-176). */
export async function previewRulesExport(project: string): Promise<{ text: string; files: { path: string; status: RulesExportStatus }[]; contents?: Record<'CLAUDE.md' | 'AGENTS.md', string> }> {
  return call<{ text: string; files: { path: string; status: RulesExportStatus }[]; contents?: Record<'CLAUDE.md' | 'AGENTS.md', string> }>('GET', `/api/projects/${encodeURIComponent(project)}/rules-export`);
}

/** Writes the files of this preview; 409 when the rules or the files changed meanwhile. */
export async function writeRulesExport(project: string, preview: { text: string; files: { path: string; status: RulesExportStatus }[] }): Promise<{ files: { path: string; status: 'written' | 'same' | 'foreign' | 'removed' }[] }> {
  return call<{ files: { path: string; status: 'written' | 'same' | 'foreign' | 'removed' }[] }>('POST', `/api/projects/${encodeURIComponent(project)}/rules-export`, { text: preview.text, files: preview.files });
}

/** Writes exactly the change prepared with this id. */
export async function confirmPrivacy(id: string): Promise<SettingsView> {
  return call<SettingsView>('POST', '/api/settings/privacy/confirm', { id });
}

/** "Riavvia oMLX": answered before the model has loaded. */
export async function restartLocal(id: string): Promise<void> {
  await call('POST', `/api/local/${encodeURIComponent(id)}/restart`, {});
}

/** The end of the server's log: may hold private texts, shown only here. */
export async function loadLocalLog(id: string): Promise<string> {
  return (await call<{ log: string }>('GET', `/api/local/${encodeURIComponent(id)}/log`)).log;
}

/** Who wrote the cloud answers of a conversation, and the files of each run (D-082). */
export async function listCredits(conversationId: string): Promise<MessageCredit[]> {
  return (await call<{ credits: MessageCredit[] }>('GET', `/api/conversations/${encodeURIComponent(conversationId)}/credits`)).credits;
}

/**
 * A token for the live screen of the conversation's browser (D-264, passo 4),
 * valid while that browser lives. Refused with 409 `no-browser`, 403 for a
 * Private or incognito conversation, 409 `too-many-screens`.
 */
export async function openBrowserScreen(conversationId: string): Promise<string> {
  const { token } = await call<{ token: unknown }>('POST', '/api/browser/screen', { conversationId });
  if (typeof token !== 'string' || token === '') throw new ApiError(500, 'no token');
  return token;
}

/**
 * Whether the conversation holds Arianna's browser now (D-264, passo 4): the
 * bar above the composer. Never for a Private or incognito one. With the token
 * of an open screen (passo 5), whether that screen drives, and the last page
 * refused while the user drove. The Private chat of an access (D-281) has
 * the browser too (`chat`), and a work conversation whose browser passed to
 * one says which (`movedTo`).
 */
export async function browserStatus(
  conversationId: string,
  screen?: string,
): Promise<{ open: boolean; site: string | null; url: string | null; acting: boolean; control: ControlState | null; blocked: BlockedNavigation | null; access: string | null; chat: boolean; login: boolean; movedTo: string | null }> {
  const query = `conversationId=${encodeURIComponent(conversationId)}${screen === undefined ? '' : `&screen=${encodeURIComponent(screen)}`}`;
  const body = await call<{ open: unknown; site?: unknown; url?: unknown; acting?: unknown }>('GET', `/api/browser/screen?${query}`);
  const open = body.open === true;
  const { control, blocked, access, chat, login } = parseControl(body);
  return {
    open,
    site: open && typeof body.site === 'string' && body.site !== '' ? body.site : null,
    // The address of the page, to an open screen only (D-286): the field of its bar.
    url: open && typeof body.url === 'string' && /^https?:/.test(body.url) ? body.url : null,
    acting: open && body.acting === true,
    control: open ? control : null,
    blocked: open ? blocked : null,
    access: open ? access : null,
    chat: open && chat,
    login: open && login,
    movedTo: open ? null : parseMovedTo(body),
  };
}

/**
 * «Prendi il controllo» from the screen of `screen` (its token, D-264 passo
 * 5): `you` when it drives now, `waiting` while Arianna ends the action under
 * way (then the status says when it is its own). 409 `no-screen` or `no-browser`.
 */
export async function takeBrowserControl(conversationId: string, screen: string): Promise<'you' | 'waiting'> {
  const body = await call<{ control?: unknown; waiting?: unknown }>('POST', '/api/browser/control', { conversationId, action: 'take', screen });
  return body.waiting === true ? 'waiting' : 'you';
}

/**
 * A command of the bar of the screen (D-286), from the open screen of
 * `screen` (its token): the page it opened, or why not (`confirm-private`:
 * the address carries a value the user saved, `values` what it is and whose;
 * sent again with the token of that question, `ask`, after «Apri»). 409 `no-screen` or `no-browser`.
 */
export async function navigateBrowser(
  conversationId: string,
  screen: string,
  command: 'back' | 'forward' | 'reload' | 'open',
  url?: string,
  ask?: string,
): Promise<{ ok: true; url: string; site: string | null } | { ok: false; reason: string; values: { kind: string; client: string }[]; ask: string | null }> {
  const body = await call<{ ok?: unknown; url?: unknown; site?: unknown; reason?: unknown; values?: unknown; ask?: unknown }>('POST', '/api/browser/navigate', {
    conversationId,
    screen,
    command,
    ...(command === 'open' && url !== undefined ? { url } : {}),
    ...(command === 'open' && ask !== undefined ? { ask } : {}),
  });
  if (body.ok === true && typeof body.url === 'string') return { ok: true, url: body.url, site: typeof body.site === 'string' && body.site !== '' ? body.site : null };
  const values = Array.isArray(body.values)
    ? (body.values as unknown[]).flatMap((value) => {
        const entry = (value ?? {}) as Record<string, unknown>;
        return typeof entry.kind === 'string' && typeof entry.client === 'string' ? [{ kind: entry.kind, client: entry.client }] : [];
      })
    : [];
  return { ok: false, reason: typeof body.reason === 'string' ? body.reason : 'error', values, ask: typeof body.ask === 'string' ? body.ask : null };
}

/** «Restituisci ad Arianna» (D-264, passo 5); a control already gone back (409 `not-driving`) counts as returned. */
export async function returnBrowserControl(conversationId: string): Promise<void> {
  try {
    await call('POST', '/api/browser/control', { conversationId, action: 'return' });
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 409) return;
    throw cause;
  }
}

/**
 * «Chiudi» (D-264, passo 4): closes the browser of the conversation, after
 * the action under way. A browser already gone (409 `no-browser`) counts as
 * closed.
 */
export async function closeBrowser(conversationId: string): Promise<void> {
  try {
    await call('POST', '/api/browser/close', { conversationId });
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 409) return;
    throw cause;
  }
}

/** The activity lines a task saved (D-083), oldest first. */
export async function listActivities(taskId: string): Promise<SavedActivity[]> {
  return (await call<{ activities: SavedActivity[] }>('GET', `/api/tasks/${encodeURIComponent(taskId)}/activities`)).activities;
}

/** The terminal a task's runs of the Coder saved (D-095), oldest first. */
export async function listTerminal(taskId: string): Promise<SavedTerminal[]> {
  return (await call<{ terminal: SavedTerminal[] }>('GET', `/api/tasks/${encodeURIComponent(taskId)}/terminal`)).terminal;
}

/** How many lines each task of a conversation saved (D-083). */
export async function activityCounts(conversationId: string): Promise<Record<string, number>> {
  return (await call<{ counts: Record<string, number> }>('GET', `/api/conversations/${encodeURIComponent(conversationId)}/activity-counts`)).counts;
}

/** The latest delegations, metadata only. */
export async function listDelegations(limit = 10): Promise<RecentDelegation[]> {
  return (await call<{ delegations: RecentDelegation[] }>('GET', `/api/delegations?limit=${String(limit)}`)).delegations;
}

/** The diff of every file of a delegation (D-117), computed on request. */
export async function loadDelegationDiff(delegationId: string): Promise<DelegationDiff> {
  return (await call<{ diff: DelegationDiff }>('GET', `/api/delegations/${encodeURIComponent(delegationId)}/diff`)).diff;
}

/** A file changed by a run, as it is now in the approved project. */
export async function loadDelegationFile(delegationId: string, index: number): Promise<FilePreview> {
  return (await call<{ file: FilePreview }>('GET', `/api/delegations/${encodeURIComponent(delegationId)}/files/${String(index)}`)).file;
}

/** "Apri" (D-117, tappa 3): the link of a page or an image of the delegation, served sandboxed for a few minutes. */
export async function openDelegationFile(delegationId: string, index: number): Promise<string> {
  return (await call<{ url: string }>('POST', `/api/delegations/${encodeURIComponent(delegationId)}/open`, { index })).url;
}

/** The graph of kb/ (D-087), or of Arianna's own documents (D-155): pages up to L2 with their links and tags, never their text. */
export async function loadKnowledgeGraph(source: KnowledgeSource = 'kb'): Promise<GraphData> {
  return call<GraphData>('GET', source === 'arianna' ? '/api/knowledge/graph?source=arianna' : '/api/knowledge/graph');
}

/** One page of kb/ (or of Arianna's documents) with its text, up to L2; 404 for anything else. */
export async function loadKnowledgePage(id: string, source: KnowledgeSource = 'kb'): Promise<KnowledgePage> {
  const from = source === 'arianna' ? '&source=arianna' : '';
  return (await call<{ page: KnowledgePage }>('GET', `/api/knowledge/page?path=${encodeURIComponent(id)}${from}`)).page;
}

/** The notes of kb/inbox (D-086), newest first: header fields only, never the text. */
export async function listNotes(limit = 200): Promise<NoteListing> {
  return call<NoteListing>('GET', `/api/notes?limit=${String(limit)}`);
}

/** One note of kb/inbox with its text, up to L2. */
export async function loadNote(name: string): Promise<Note> {
  return (await call<{ note: Note }>('GET', `/api/notes/${encodeURIComponent(name)}`)).note;
}

/** "Elimina" of a thought (D-157): its file goes for good; the user confirmed it. */
export async function deleteNote(name: string): Promise<void> {
  await call('POST', `/api/notes/${encodeURIComponent(name)}/delete`, {});
}

/** "Elimina" of a page of the Conoscenza (D-157), by its id relative to kb/. */
export async function deleteKnowledgePage(id: string): Promise<void> {
  await call('POST', '/api/knowledge/page/delete', { path: id });
}

/** Queues a new note to be organized again by the local model. */
export async function organizeNote(name: string): Promise<void> {
  await call('POST', `/api/notes/${encodeURIComponent(name)}/organize`, {});
}

/** "Scarica e riassumi" (D-154): the link of the note downloaded and summarized, whatever its site. */
export async function fetchNoteLink(name: string): Promise<void> {
  await call('POST', `/api/notes/${encodeURIComponent(name)}/fetch`, {});
}

/** «Riassumi il video» (D-273): queued only with the approval of the user for this video, given in the card of the panel. */
export async function summarizeNoteVideo(name: string): Promise<void> {
  await call('POST', `/api/notes/${encodeURIComponent(name)}/video`, { approved: true });
}

/** The job of the video of a note: queued, at work with its stage, failed with its reason, done; null without one. */
export async function loadNoteVideo(name: string): Promise<VideoJob | null> {
  return (await call<{ video: VideoJob | null }>('GET', `/api/notes/${encodeURIComponent(name)}/video`)).video;
}

/** "Da archiviare" (D-195): the proposals of the Archivist and the folders a thought may go to. */
export async function loadArchive(): Promise<ArchiveListing> {
  return call<ArchiveListing>('GET', '/api/archive');
}

/** Approves one or more proposals, with the corrections of the user; one result per note. */
export async function approveArchive(items: ApproveItem[]): Promise<ApproveResult[]> {
  return (await call<{ results: ApproveResult[] }>('POST', '/api/archive/approve', { items })).results;
}

/** "Scarta": the thought stays in the inbox. */
export async function discardArchive(name: string, version: string): Promise<void> {
  await call('POST', '/api/archive/discard', { name, version });
}

/** "Proponi di nuovo": the Archivist proposes again where the thought goes. */
export async function proposeArchiveAgain(name: string): Promise<void> {
  await call('POST', `/api/notes/${encodeURIComponent(name)}/archive`, {});
}

/** The Wiki (D-280): folders, pages and how many proposals wait. */
export async function loadWiki(): Promise<WikiListing> {
  return call<WikiListing>('GET', '/api/wiki');
}

/** One page of the Wiki (`laravel/octane/swoole`), or the index of a folder (`laravel/_indice`, `_indice`). */
export async function loadWikiPage(path: string): Promise<WikiPageView> {
  return (await call<{ page: WikiPageView }>('GET', `/api/wiki/page?path=${encodeURIComponent(path)}`)).page;
}

/** The proposals of the local model, newest first, each with its diff. */
export async function loadWikiProposals(): Promise<WikiProposal[]> {
  return (await call<{ proposals: WikiProposal[] }>('GET', '/api/wiki/proposals')).proposals;
}

/** «Approva»: `path` only when the user changed the place of a new page or the destination of a move. */
export async function approveWikiProposal(id: string, path?: string): Promise<{ path: string; kind: string }> {
  return call<{ path: string; kind: string }>('POST', `/api/wiki/proposals/${encodeURIComponent(id)}/approve`, path === undefined ? {} : { path });
}

export async function discardWikiProposal(id: string): Promise<void> {
  await call('POST', `/api/wiki/proposals/${encodeURIComponent(id)}/discard`, {});
}

/** «Proponi di nuovo»: the local model writes a new proposal from the same note. */
export async function proposeWikiAgain(id: string): Promise<void> {
  await call('POST', `/api/wiki/proposals/${encodeURIComponent(id)}/again`, {});
}

/** «Confronta» an old version with the page now (D-285): what changes, title included, and the page compared (`base`). */
export async function compareWikiVersion(path: string, version: string): Promise<VersionComparison> {
  return (await call<{ comparison: VersionComparison }>('GET', `/api/wiki/version?path=${encodeURIComponent(path)}&version=${encodeURIComponent(version)}`)).comparison;
}

/** «Ripristina» an old version, only if the page is still the version shown (`base`). */
export async function restoreWikiPage(path: string, version: string, base: string): Promise<void> {
  await call('POST', '/api/wiki/restore', { path, version, base });
}

/**
 * A save of a page of the Wiki by the user, over the page as shown (`base`). With `session` (D-284, the page
 * that saves by itself) the core keeps the version before only once per writing session. Gives the new version,
 * and whether a version went to «Versioni precedenti».
 */
export async function editWikiPage(path: string, base: string, title: string, body: string, session?: string): Promise<{ version: string; kept: boolean }> {
  const saved = await call<{ version: string; kept?: boolean }>('POST', '/api/wiki/edit', session === undefined ? { path, base, title, body } : { path, base, title, body, session });
  return { version: saved.version, kept: saved.kept === true };
}

/** «Nuova pagina» of the Wiki by the user (`topic/article`): it starts with the sections to fill, or with `body` («Duplica», D-284). */
export async function createWikiPage(path: string, title: string, body?: string): Promise<{ path: string; version: string }> {
  return call<{ path: string; version: string }>('POST', '/api/wiki/create', body === undefined ? { kind: 'page', path, title } : { kind: 'page', path, title, body });
}

/** «Nuova cartella» of the Wiki by the user: it stays, empty, until a page goes in it. */
export async function createWikiFolder(path: string): Promise<void> {
  await call('POST', '/api/wiki/create', { kind: 'folder', path });
}

/** «Sposta o rinomina» (or a drag in the tree) of a page — as shown, `base` — or of a folder, at once. Gives where it is now. */
export async function moveWikiNow(kind: 'page' | 'folder', from: string, to: string, base?: string): Promise<string> {
  return (await call<{ path: string }>('POST', '/api/wiki/move-now', kind === 'page' ? { kind, from, to, base } : { kind, from, to })).path;
}

/** A note or page the editor of the Wiki suggests after «[[» (D-282). */
export interface WikiCitationTarget {
  target: string;
  title: string;
  kind: 'note' | 'page';
}

/** The notes and pages a citation may name, whose path or title holds the words typed after «[[». */
export async function loadWikiTargets(query: string): Promise<WikiCitationTarget[]> {
  return (await call<{ targets: WikiCitationTarget[] }>('GET', `/api/wiki/targets?q=${encodeURIComponent(query)}`)).targets;
}

/** «Elimina cartella»: only an empty folder of the Wiki. */
export async function deleteWikiFolder(path: string): Promise<void> {
  await call('POST', '/api/wiki/folder/delete', { path });
}

/** «Elimina» a page of the Wiki as it was shown (`base`): its old versions and the proposals waiting on it go too. */
export async function deleteWikiPage(path: string, base: string): Promise<void> {
  await call('POST', '/api/wiki/delete', { path, base });
}

/** «Proponi per la Wiki» of a note of kb/ (`inbox/x.md`): the local model prepares a proposal in the background. */
export async function proposeForWiki(page: string): Promise<void> {
  await call('POST', '/api/wiki/propose', { page });
}

/** "Sviluppo di Arianna" (D-102): progress read from the documents, and the longest answer the core takes. */
export async function loadDevProgress(): Promise<{ progress: DevProgress; maxAnswer: number }> {
  return call<{ progress: DevProgress; maxAnswer: number }>('GET', '/api/dev/progress');
}

/** How many open questions wait for the user (D-120): only the number, for the dot of the settings. */
export async function loadDevPending(): Promise<number> {
  return pendingFromBody(await call<unknown>('GET', '/api/dev/pending'));
}

/** Appends an answer to docs/RISPOSTE.md for Claude Code; the question is named by its key only. */
/** `logged` false: the answer is saved but its event did not reach the chain. */
export async function sendDevAnswer(key: string, text: string): Promise<{ key: string; at: string; logged: boolean }> {
  return call<{ key: string; at: string; logged: boolean }>('POST', '/api/dev/answers', { key, text });
}

/**
 * Asks Claude Code to rewrite a question more clearly (D-153): a fixed entry in
 * data/dev/RISPOSTE.md, no text of the user; `already` when one was still waiting.
 */
/** `logged` is missing for a request already there: its event was the first one's. */
export async function askDevRewrite(key: string): Promise<{ key: string; at: string; already: boolean; logged?: boolean }> {
  return call<{ key: string; at: string; already: boolean; logged?: boolean }>('POST', '/api/dev/answers', { key, rewrite: true });
}

/** "Novità di Open Design" (I-21, D-186): the news of the version waiting and of the one in use, with what was already chosen. */
export async function loadOdNews(): Promise<NewsPair> {
  return (await call<{ news: NewsPair }>('GET', '/api/dev/od-news')).news;
}

/** "Da rifare nello Studio": the entry, named by its key only, goes to data/dev/RISPOSTE.md; `already` when it was there. */
export async function sendOdNewsRedo(key: string): Promise<{ key: string; at: string; already: boolean; logged?: boolean }> {
  return call<{ key: string; at: string; already: boolean; logged?: boolean }>('POST', '/api/dev/od-news', { key });
}

/** «Su di te, per chi sviluppa Arianna» (D-114, D-226): the text in data/dev/UTENTE.md and the longest the core takes. */
export async function loadDevUserNote(): Promise<{ note: { text: string; at: string | null }; max: number }> {
  return call<{ note: { text: string; at: string | null }; max: number }>('GET', '/api/dev/user-note');
}

/** Replaces data/dev/UTENTE.md through the gateway towards Claude Code; empty text removes it. */
export async function saveDevUserNote(text: string): Promise<{ text: string; at: string | null }> {
  return (await call<{ note: { text: string; at: string | null } }>('POST', '/api/dev/user-note', { text })).note;
}

/** «Su di te» (D-114): the facts of the profile, written only from the Settings. */
export async function loadUserFacts(): Promise<UserFact[]> {
  return (await call<{ facts: UserFact[] }>('GET', '/api/profile/facts')).facts;
}

/** A new fact: «Solo in casa» (L2) unless `label` is L1. */
export async function createUserFact(fields: { topic: string; text: string; label: FactLabel }): Promise<UserFact> {
  return (await call<{ fact: UserFact }>('POST', '/api/profile/facts', fields)).fact;
}

/** Changes a fact; raising it to «Solo in casa» is immediate, the other way goes through prepareFactShare. */
export async function updateUserFact(id: string, fields: { topic?: string; text?: string; label?: FactLabel }): Promise<UserFact> {
  return (await call<{ fact: UserFact }>('POST', `/api/profile/facts/${encodeURIComponent(id)}`, fields)).fact;
}

export async function removeUserFact(id: string): Promise<void> {
  await call('DELETE', `/api/profile/facts/${encodeURIComponent(id)}`, {});
}

/** «Condivisibile», first step: what will be written, with the id to confirm. */
export async function prepareFactShare(id: string, fields: { topic: string; text: string }): Promise<ShareProposal> {
  return call<ShareProposal>('POST', `/api/profile/facts/${encodeURIComponent(id)}/share/prepare`, fields);
}

/** «Condivisibile», second step: once, within a few minutes. */
export async function confirmFactShare(id: string): Promise<UserFact> {
  return (await call<{ fact: UserFact }>('POST', '/api/profile/facts/share/confirm', { id })).fact;
}

/** "Progetti seguiti" (D-202): the projects followed for ideas, with their last news and what was already chosen. */
export async function loadFollowedProjects(): Promise<{ projects: FollowedProject[]; max: number; accounts: FollowedAccount[]; maxAccounts: number }> {
  return call<{ projects: FollowedProject[]; max: number; accounts: FollowedAccount[]; maxAccounts: number }>('GET', '/api/dev/projects');
}

export async function addFollowedProject(url: string): Promise<void> {
  await call('POST', '/api/dev/projects', { url });
}

export async function removeFollowedProject(id: string): Promise<void> {
  await call('DELETE', '/api/dev/projects', { id });
}

/** «Controlla novità» of a project or an account (D-271): the check runs in the core; the page reads again while it is `checking`. */
export async function checkFollowedProject(id: string): Promise<void> {
  await call('POST', '/api/dev/projects/check', { id });
}

/** «Implementiamo» / «Non interessa»: the entry, named by its key only, goes to data/dev/RISPOSTE.md; `already` when it was there. */
export async function sendProjectChoice(key: string, choice: ProjectChoice): Promise<{ key: string; at: string; already: boolean; logged?: boolean }> {
  return call<{ key: string; at: string; already: boolean; logged?: boolean }>('POST', '/api/dev/projects/choice', { key, choice });
}

/** "Novità": the register of the versions, read by the core from CHANGELOG.md. */
export async function loadChangelog(): Promise<Changelog> {
  return (await call<{ changelog: Changelog }>('GET', '/api/changelog')).changelog;
}

// The page "Progetti" (D-134): an approved project, read only.
const browse = (project: string): string => `/api/browse/${encodeURIComponent(project)}`;

/** The parts File, Git and Servizi read, and the containers they belong to (D-145). */
export async function listBrowsableProjects(): Promise<{ projects: BrowsableProject[]; containers: BrowsableContainer[] }> {
  const body = await call<{ projects: BrowsableProject[]; containers?: BrowsableContainer[] }>('GET', '/api/browse');
  return { projects: body.projects, containers: body.containers ?? [] };
}

/** The tab "Conoscenza" (D-145): the management folders of a container with their labels, and the notes. */
export async function readProjectKnowledge(project: string): Promise<ProjectKnowledge> {
  return (await call<{ knowledge: ProjectKnowledge }>('GET', `${browse(project)}/knowledge`)).knowledge;
}

/** "+ Conoscenza" (D-145): a new note; the header is written by the core, the label never below the folder's. */
export async function addProjectNote(project: string, note: { folder: string; title: string; label: Label; text: string }): Promise<{ path: string; label: Label }> {
  return (await call<{ note: { path: string; label: Label } }>('POST', `${browse(project)}/knowledge`, note)).note;
}

/** A note of a project opened in "Conoscenza", by its path there. */
export async function readProjectNote(project: string, path: string): Promise<OpenedNote> {
  return (await call<{ note: OpenedNote }>('GET', `${browse(project)}/knowledge/note?${new URLSearchParams({ path }).toString()}`)).note;
}

/** A note edited by hand: written only over the version opened; `lower` confirms a label that goes down. */
export async function editProjectNote(project: string, note: { path: string; title: string; label: Label; header: string[]; text: string; version: string; lower: boolean }): Promise<OpenedNote> {
  return (await call<{ note: OpenedNote }>('POST', `${browse(project)}/knowledge/note`, note)).note;
}

/** "Elimina" of a note of a project (D-157), by its path in the tab "Conoscenza". */
export async function deleteProjectNote(project: string, path: string): Promise<void> {
  await call('POST', `${browse(project)}/knowledge/delete`, { path });
}

/** A work conversation of the project a released note may go to (I-11 P5, D-187). */
export interface ReleaseTarget {
  id: string;
  title: string | null;
  workspace: string;
  agent: string | null;
}

/** "Fai uscire una volta" (D-187): the work conversations of the project. */
export async function noteReleaseTargets(project: string): Promise<ReleaseTarget[]> {
  return (await call<{ targets: ReleaseTarget[] }>('GET', `${browse(project)}/knowledge/release`)).targets;
}

/** The anonymous version of a Private note by the local model, never saved; `warnings` are what the scanner still finds. */
export async function anonymizeProjectNote(project: string, path: string): Promise<{ text: string; model: string; version: string; warnings: string[] }> {
  return call('POST', `${browse(project)}/knowledge/anonymize`, { path });
}

/** The approved text leaves once, as a message of the chosen work conversation; the password is never kept. */
export async function releaseProjectNote(project: string, input: { path: string; version: string; text: string; conversationId: string; password: string }): Promise<{ conversationId: string; messageId: string }> {
  return call('POST', `${browse(project)}/knowledge/release`, input);
}

/** "Sposta" and "Ripristina" in the tab File (I-20, D-185): nothing already there is replaced. */
export async function moveProjectPath(project: string, from: string, to: string): Promise<{ from: string; to: string; kind: 'file' | 'dir' }> {
  return call('POST', `${browse(project)}/move`, { from, to });
}

/** "Elimina" in the tab File (I-20, D-185): for good, after the window. */
export async function deleteProjectPath(project: string, path: string): Promise<{ path: string; kind: 'file' | 'dir'; entries: number }> {
  return call('POST', `${browse(project)}/delete`, { path });
}

export async function listProjectDir(project: string, dir: string): Promise<{ entries: TreeEntry[]; more: number }> {
  return call('GET', `${browse(project)}/tree?${new URLSearchParams({ dir }).toString()}`);
}

export async function readProjectFile(project: string, path: string): Promise<ProjectFile> {
  return (await call<{ file: ProjectFile }>('GET', `${browse(project)}/file?${new URLSearchParams({ path }).toString()}`)).file;
}

// The section "IM" of the cardwall (D-167): the Iteration Meetings of a project, read and written in their files by the core.
export async function listIms(project: string): Promise<ImSummary[]> {
  return (await call<{ ims: ImSummary[] }>('GET', `${browse(project)}/im`)).ims;
}

export async function readIm(project: string, number: number): Promise<ImDetail> {
  return (await call<{ im: ImDetail }>('GET', `${browse(project)}/im/${String(number)}`)).im;
}

/** "+ Voce": a new item in Da fare; 409 when the file changed since `version`. */
export async function addImItem(project: string, number: number, title: string, version: string): Promise<ImDetail> {
  return (await call<{ im: ImDetail }>('POST', `${browse(project)}/im/${String(number)}/items`, { title, version })).im;
}

/** An item moved to another column; 409 when the file changed since `version`. */
export async function setImItemState(project: string, number: number, line: number, state: ImItemState, version: string): Promise<ImDetail> {
  return (await call<{ im: ImDetail }>('POST', `${browse(project)}/im/${String(number)}/items/${String(line)}`, { state, version })).im;
}

/** "Nuovo IM": the next one; `date` ("YYYY-MM-DD HH:MM") only for the first IM of the project. */
export async function createIm(project: string, date?: string): Promise<ImDetail> {
  return (await call<{ im: ImDetail }>('POST', `${browse(project)}/im`, date === undefined ? {} : { date })).im;
}

/** The card of an item (D-167, P4b): made the first time, and the item's line gets `#card-<sigla>`; 409 when the item changed in the file. */
export async function openImItemCard(project: string, number: number, item: ImItemRef): Promise<{ cardId: string; im: ImDetail }> {
  return call('POST', `${browse(project)}/im/${String(number)}/card`, item);
}

/** "Scrivi il report" (D-167, P4c): 202 with the job; 409 `has-report` when the section has text and `replace` is not set. */
export async function startImReport(project: string, number: number, agent: ReportAgent, language: ReportLanguage, replace = false): Promise<ImReportJob> {
  return (await call<{ job: ImReportJob }>('POST', `${browse(project)}/im/${String(number)}/report`, replace ? { agent, language, replace } : { agent, language })).job;
}

/** The last report job of the IM since the core started; null when none. */
export async function loadImReport(project: string, number: number): Promise<ImReportJob | null> {
  return (await call<{ job: ImReportJob | null }>('GET', `${browse(project)}/im/${String(number)}/report`)).job;
}

// The tab "IM" of "Progetti" (P4d, D-169): the calendar in IM/calendario.md, prices and invoices Privati (L2) in the database.
export async function readImOverview(project: string): Promise<ImOverview> {
  return (await call<{ overview: ImOverview }>('GET', `${browse(project)}/im-overview`)).overview;
}

/** The calendar written in its file; `version` is the one read ('' when there is no file): 409 when it changed meanwhile. */
export async function saveImCalendar(project: string, calendar: ImCalendar, version: string): Promise<ImOverview> {
  return (await call<{ overview: ImOverview }>('POST', `${browse(project)}/im-calendar`, { ...calendar, version })).overview;
}

/** The last day of the IM (`fine` in IM/calendario.md, D-169); null takes it away and the IM go on. */
export async function saveImEnd(project: string, end: string | null, version: string): Promise<ImOverview> {
  return (await call<{ overview: ImOverview }>('POST', `${browse(project)}/im-end`, { end, version })).overview;
}

/** The price of one IM of the project, in cents; null: no price. */
export async function saveImPrice(project: string, amountCents: number | null, currency: string): Promise<ImOverview> {
  return (await call<{ overview: ImOverview }>('POST', `${browse(project)}/im-price`, { amountCents, currency })).overview;
}

/** The exception of one IM (its own price, null for the project's) and "non fatturato". */
export async function saveImBilling(project: string, number: number, overrideCents: number | null, notBilled: boolean): Promise<ImOverview> {
  return (await call<{ overview: ImOverview }>('POST', `${browse(project)}/im/${String(number)}/billing`, { overrideCents, notBilled })).overview;
}

export async function createImInvoice(project: string, invoice: NewInvoice & { ims: number[] }): Promise<{ invoice: ImInvoice; overview: ImOverview }> {
  return call('POST', `${browse(project)}/invoices`, invoice);
}

export async function updateImInvoice(project: string, id: string, change: { number?: string; issuedOn?: string; paidOn?: string | null; note?: string | null; documentCents?: number; dueOn?: string | null }): Promise<ImOverview> {
  return (await call<{ overview: ImOverview }>('POST', `${browse(project)}/invoices/${encodeURIComponent(id)}`, change)).overview;
}

export async function cancelImInvoice(project: string, id: string): Promise<ImOverview> {
  return (await call<{ overview: ImOverview }>('POST', `${browse(project)}/invoices/${encodeURIComponent(id)}/cancel`, {})).overview;
}

export async function removeFromImInvoice(project: string, id: string, im: number): Promise<ImOverview> {
  return (await call<{ overview: ImOverview }>('POST', `${browse(project)}/invoices/${encodeURIComponent(id)}/remove`, { im })).overview;
}

/** The closings of the IM asked in the secretary conversation, most recent first. */
export async function listImClosings(): Promise<ImClosing[]> {
  return (await call<{ closings: ImClosing[] }>('GET', '/api/im/closings')).closings;
}

export async function readImClosing(id: string): Promise<{ closing: ImClosing; im: ImDetail }> {
  return call('GET', `/api/im/closings/${encodeURIComponent(id)}`);
}

/** One answer of a closing; `closed` when it was the last one (the IM is closed and the next one made); 409 when the item changed or the closing is over. */
export async function answerImClosing(id: string, item: ImItemRef, outcome: ImOutcome): Promise<{ closing: ImClosing; im: ImDetail; closed: boolean }> {
  return call('POST', `/api/im/closings/${encodeURIComponent(id)}/answer`, { ...item, outcome });
}

/** "Mostra" (D-135): a covered secret with its text, once; an event in the chain. */
export async function revealProjectFile(project: string, path: string): Promise<ProjectFile> {
  return (await call<{ file: ProjectFile }>('POST', `${browse(project)}/reveal`, { path })).file;
}

/** "Mostra nascosti" (D-135): the consent for this project, kept until it is turned off. */
export async function setProjectHidden(project: string, on: boolean): Promise<void> {
  await call('POST', `${browse(project)}/hidden`, { on });
}

export async function openProjectFile(project: string, path: string): Promise<string> {
  return (await call<{ url: string }>('POST', `${browse(project)}/open`, { path })).url;
}

export async function readProjectGit(project: string): Promise<ProjectGit> {
  return (await call<{ git: ProjectGit }>('GET', `${browse(project)}/git`)).git;
}

export async function readCommitDiff(project: string, commit: string): Promise<CommitDiff> {
  return (await call<{ diff: CommitDiff }>('GET', `${browse(project)}/commits/${encodeURIComponent(commit)}`)).diff;
}

// The tab Servizi (D-134, tappa 2): started or stopped by name, after the user's confirmation in the page.
export async function listProjectServices(project: string): Promise<ServiceState[]> {
  return (await call<{ services: ServiceState[] }>('GET', `${browse(project)}/services`)).services;
}

export async function serviceLog(project: string, service: string): Promise<ServiceLog | null> {
  return (await call<{ run: ServiceLog | null }>('GET', `${browse(project)}/services/log?${new URLSearchParams({ service }).toString()}`)).run;
}

export async function startService(project: string, service: string, fingerprint: string): Promise<ServiceLog | null> {
  return (await call<{ run: ServiceLog | null }>('POST', `${browse(project)}/services/start`, { service, fingerprint })).run;
}

export async function stopService(project: string, service: string): Promise<ServiceLog | null> {
  return (await call<{ run: ServiceLog | null }>('POST', `${browse(project)}/services/stop`, { service })).run;
}

// ---------------------------------------------------------------------------
// The clients (I-16, D-168): private (L2), only between this page and the core.
// ---------------------------------------------------------------------------

/** Every client, archived included, and the approved projects a client may take. */
export async function listClients(): Promise<{ clients: ClientSummary[]; projects: string[] }> {
  return call<{ clients: ClientSummary[]; projects: string[] }>('GET', '/api/clients');
}

/** The documents of a client (I-16 C2, D-171), the archived ones too. */
export async function listClientDocuments(id: string): Promise<ClientDocument[]> {
  return (await call<{ documents: ClientDocument[] }>('GET', `/api/clients/${encodeURIComponent(id)}/documents`)).documents;
}

/** A new document: its bytes in base64, since the API takes only JSON; the core checks them against the name. */
export async function addClientDocument(id: string, document: DocumentForm & { fileName: string; data: string }): Promise<ClientDocument> {
  return (await call<{ document: ClientDocument }>('POST', `/api/clients/${encodeURIComponent(id)}/documents`, document)).document;
}

export async function updateClientDocument(id: string, document: string, change: Partial<DocumentForm>): Promise<ClientDocument> {
  return (await call<{ document: ClientDocument }>('POST', `/api/clients/${encodeURIComponent(id)}/documents/${encodeURIComponent(document)}`, change)).document;
}

export async function archiveClientDocument(id: string, document: string, archived: boolean): Promise<ClientDocument> {
  return (await call<{ document: ClientDocument }>('POST', `/api/clients/${encodeURIComponent(id)}/documents/${encodeURIComponent(document)}/archive`, { archived })).document;
}

/** "Apri" with the app of the Mac, or "Mostra nel Finder" (reveal): run by the core. */
export async function openClientDocument(id: string, document: string, reveal: boolean): Promise<void> {
  await call('POST', `/api/clients/${encodeURIComponent(id)}/documents/${encodeURIComponent(document)}/open`, { reveal });
}

/** The dashboard of a client (I-16 C3, D-170): the money of the IM of its projects. */
export async function readClientDashboard(id: string): Promise<ClientDashboard> {
  return (await call<{ dashboard: ClientDashboard }>('GET', `/api/clients/${encodeURIComponent(id)}/dashboard`)).dashboard;
}

export async function readClient(id: string): Promise<Client> {
  return (await call<{ client: Client }>('GET', `/api/clients/${encodeURIComponent(id)}`)).client;
}

export async function createClient(form: ClientForm): Promise<string> {
  return (await call<{ client: { id: string } }>('POST', '/api/clients', form)).client.id;
}

export async function updateClient(id: string, form: Partial<ClientForm>): Promise<void> {
  await call('POST', `/api/clients/${encodeURIComponent(id)}`, form);
}

export async function archiveClient(id: string, archived: boolean): Promise<void> {
  await call('POST', `/api/clients/${encodeURIComponent(id)}/archive`, { archived });
}

export async function addClientContact(id: string, contact: ContactForm): Promise<ClientContact> {
  return (await call<{ contact: ClientContact }>('POST', `/api/clients/${encodeURIComponent(id)}/contacts`, contact)).contact;
}

export async function updateClientContact(id: string, contactId: string, contact: Partial<ContactForm>): Promise<ClientContact> {
  return (await call<{ contact: ClientContact }>('POST', `/api/clients/${encodeURIComponent(id)}/contacts/${encodeURIComponent(contactId)}`, contact)).contact;
}

export async function removeClientContact(id: string, contactId: string): Promise<void> {
  await call('DELETE', `/api/clients/${encodeURIComponent(id)}/contacts/${encodeURIComponent(contactId)}`, {});
}

export async function linkClientProject(id: string, project: string): Promise<ClientProject> {
  return (await call<{ project: ClientProject }>('POST', `/api/clients/${encodeURIComponent(id)}/projects`, { project })).project;
}

export async function unlinkClientProject(id: string, linkId: string): Promise<void> {
  await call('DELETE', `/api/clients/${encodeURIComponent(id)}/projects/${encodeURIComponent(linkId)}`, {});
}

/** The logo as base64 in JSON (the core takes only JSON); the core finds its type from the bytes. */
export async function uploadClientLogo(id: string, data: string): Promise<ClientLogo> {
  return (await call<{ logo: ClientLogo }>('POST', `/api/clients/${encodeURIComponent(id)}/logo`, { data })).logo;
}

export async function removeClientLogo(id: string): Promise<void> {
  await call('DELETE', `/api/clients/${encodeURIComponent(id)}/logo`, {});
}

/** The client of a project, for the header of "Progetti"; null when none has it. */
export async function clientOfProject(project: string): Promise<{ id: string; displayName: string; logo: ClientLogo | null } | null> {
  return (await call<{ client: { id: string; displayName: string; logo: ClientLogo | null } | null }>('GET', `/api/clients/of-project/${encodeURIComponent(project)}`)).client;
}

// ---------------------------------------------------------------------------
// The finances (I-18, D-183, docs/FINANCE-API.md): private (L2, rule
// `finance`), only between this page and the core of this Mac.
// ---------------------------------------------------------------------------

const FINANCE = '/api/finance';

function financeId(id: string): string {
  return encodeURIComponent(id);
}

export async function listFinanceAccounts(): Promise<Account[]> {
  return (await call<{ accounts: Account[] }>('GET', `${FINANCE}/accounts`)).accounts;
}

export async function createFinanceAccount(name: string, currency?: string): Promise<Account> {
  return (await call<{ account: Account }>('POST', `${FINANCE}/accounts`, currency === undefined ? { name } : { name, currency })).account;
}

export async function updateFinanceAccount(id: string, change: { name?: string; archived?: boolean }): Promise<Account> {
  return (await call<{ account: Account }>('PATCH', `${FINANCE}/accounts/${financeId(id)}`, change)).account;
}

/** The file read in the browser, in base64; nothing is saved. */
export interface ImportRequest {
  account: string;
  name: string;
  data: string;
  profile?: BankProfile;
  sheet?: string;
}

export async function previewFinanceImport(request: ImportRequest): Promise<Preview> {
  return (await call<{ preview: Preview }>('POST', `${FINANCE}/imports/preview`, request)).preview;
}

export async function runFinanceImport(request: ImportRequest & { profile: BankProfile }): Promise<ImportRecord> {
  return (await call<{ import: ImportRecord }>('POST', `${FINANCE}/imports`, request)).import;
}

export async function listFinanceImports(account: string): Promise<ImportRecord[]> {
  return (await call<{ imports: ImportRecord[] }>('GET', `${FINANCE}/imports?${new URLSearchParams({ account }).toString()}`)).imports;
}

/** "Annulla" an import: its rows go away. */
export async function undoFinanceImport(id: string): Promise<void> {
  await call('DELETE', `${FINANCE}/imports/${financeId(id)}`, {});
}

/** `query` from `filterQuery` of finance.ts. */
export async function listFinanceTransactions(query: string): Promise<{ transactions: Tx[]; total: number }> {
  return call<{ transactions: Tx[]; total: number }>('GET', `${FINANCE}/transactions?${query}`);
}

export async function setTransactionCategory(id: string, category: string | null, rule: boolean): Promise<{ transaction: Tx; rule: Rule | null }> {
  return call<{ transaction: Tx; rule: Rule | null }>('PATCH', `${FINANCE}/transactions/${financeId(id)}`, rule ? { category, rule: true } : { category });
}

export async function listFinanceCategories(): Promise<Category[]> {
  return (await call<{ categories: Category[] }>('GET', `${FINANCE}/categories`)).categories;
}

export async function createFinanceCategory(name: string, kind: Category['kind']): Promise<Category> {
  return (await call<{ category: Category }>('POST', `${FINANCE}/categories`, { name, kind })).category;
}

export async function renameFinanceCategory(id: string, name: string): Promise<void> {
  await call('PATCH', `${FINANCE}/categories/${financeId(id)}`, { name });
}

export async function deleteFinanceCategory(id: string): Promise<void> {
  await call('DELETE', `${FINANCE}/categories/${financeId(id)}`, {});
}

export async function listFinanceRules(): Promise<Rule[]> {
  return (await call<{ rules: Rule[] }>('GET', `${FINANCE}/rules`)).rules;
}

export async function createFinanceRule(match: string, category: string): Promise<Rule> {
  return (await call<{ rule: Rule }>('POST', `${FINANCE}/rules`, { match, category })).rule;
}

export async function deleteFinanceRule(id: string): Promise<void> {
  await call('DELETE', `${FINANCE}/rules/${financeId(id)}`, {});
}

export async function listFinanceBudgets(): Promise<Budget[]> {
  return (await call<{ budgets: Budget[] }>('GET', `${FINANCE}/budgets`)).budgets;
}

export async function setFinanceBudget(category: string, monthly: number): Promise<Budget> {
  return (await call<{ budget: Budget }>('PUT', `${FINANCE}/budgets/${financeId(category)}`, { monthly })).budget;
}

export async function deleteFinanceBudget(category: string): Promise<void> {
  await call('DELETE', `${FINANCE}/budgets/${financeId(category)}`, {});
}

/** Without `from`/`to`, the last 12 months; without `account`, every account (and no balance). */
export async function readFinanceSummary(filter: { account?: string; from?: string; to?: string }): Promise<Summary> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) if (value !== '') params.set(key, value);
  const query = params.toString();
  return call<Summary>('GET', `${FINANCE}/summary${query === '' ? '' : `?${query}`}`);
}

/** The checks of a month (`YYYY-MM`), the current one without it. */
export async function readFinanceAlerts(month?: string): Promise<FinanceAlert[]> {
  return (await call<{ alerts: FinanceAlert[] }>('GET', `${FINANCE}/alerts${month === undefined ? '' : `?${new URLSearchParams({ month }).toString()}`}`)).alerts;
}

// ---------------------------------------------------------------------------
// The Studio (I-19, D-184, docs/STUDIO-API.md): the mockups of an approved
// project, read and written only on this Mac.
// ---------------------------------------------------------------------------

/**
 * Hands a built frame document to the core, which serves it back with a policy of its own
 * (a srcdoc frame would inherit the chat's policy and lose the mockup's inline scripts and styles).
 */
export async function studioFrame(html: string, print = false): Promise<string> {
  return (await call<{ url: string }>('POST', '/api/studio-frames', { html, print })).url;
}

function studioBase(project: string): string {
  return `/api/studio/${encodeURIComponent(project)}`;
}

export async function listMockups(project: string): Promise<MockupList> {
  return call<MockupList>('GET', `${studioBase(project)}/mockups`);
}

export async function readMockup(project: string, path: string): Promise<MockupText> {
  return call<MockupText>('GET', `${studioBase(project)}/file?${new URLSearchParams({ path }).toString()}`);
}

/** The direct edit (O6): only when the file is still `base`; 409 `changed` otherwise. */
export async function writeMockup(project: string, path: string, text: string, base: string): Promise<{ path: string; sha256: string }> {
  return call<{ path: string; sha256: string }>('PUT', `${studioBase(project)}/file`, { path, text, base });
}

/** Deletes a mockup (D-184): it moves to `<folder>/eliminati/` of the project, only if it is still the version read. */
export async function deleteMockup(project: string, path: string, base: string, permanent = false): Promise<{ path: string; retired: string | null }> {
  return call<{ path: string; retired: string | null }>('POST', `${studioBase(project)}/delete`, { path, base, ...(permanent ? { permanent: true } : {}) });
}

/** The examples of the styles written by Sonnet (I-20, D-185). */
export async function loadStyleExamples(): Promise<ExamplesStatus> {
  return call<ExamplesStatus>('GET', '/api/design-catalog/examples');
}

/** Queues the example of one style, or every missing one without `style`. */
export async function generateStyleExamples(style?: string): Promise<ExamplesStatus> {
  return call<ExamplesStatus>('POST', '/api/design-catalog/examples', style === undefined ? {} : { style });
}

export async function readStyleExample(slug: string, kind: 'landing' | 'deck'): Promise<string> {
  return (await call<{ text: string }>('GET', `/api/design-catalog/examples/${encodeURIComponent(slug)}/${kind}`)).text;
}

/** The Italian descriptions of the skills; `start` asks the core to translate the missing ones. */
export async function skillTranslations(start = false): Promise<TranslationsStatus> {
  return start ? call<TranslationsStatus>('POST', '/api/skills-catalog/translations', {}) : call<TranslationsStatus>('GET', '/api/skills-catalog/translations');
}

/** The Italian descriptions of the roles of the catalog of agents (D-185), as the skills; with `start` the missing ones are asked. */
export async function roleTranslations(start = false): Promise<TranslationsStatus> {
  return start ? call<TranslationsStatus>('POST', '/api/agents-catalog/translations', {}) : call<TranslationsStatus>('GET', '/api/agents-catalog/translations');
}

/** The small page of each style of the adopted catalog (I-20, D-185), by slug. */
export async function listStyleSamples(): Promise<StyleSamples> {
  return call<StyleSamples>('GET', '/api/design-catalog/samples');
}

/** The .pptx of a presentation, as a file to save. */
export async function exportMockupPptx(project: string, path: string, deck: Deck): Promise<Blob> {
  const response = await fetch(`${studioBase(project)}/pptx`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path, deck }),
  });
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    throw new ApiError(response.status, typeof data.error === 'string' ? data.error : `HTTP ${String(response.status)}`, data);
  }
  return response.blob();
}

/** A person of the series with its texts (D-223): the repository's, the user's rewrite and the block the model reads. */
export interface SeriesPersonaView {
  id: string;
  name: string;
  /** The series it comes from (D-224); absent with an older core. */
  show?: string;
  repository: { traits: string; scene: string; quotes: string[] };
  own: { traits?: string; scene?: string; quotes?: string[] } | null;
  /** The rewrite the model does not read (personal data or a vault value written by hand); absent with an older core. */
  refused?: boolean;
  blocks: { work: string; private: string };
}

export async function loadSeriesPersonas(): Promise<SeriesPersonaView[]> {
  return (await call<{ people: SeriesPersonaView[] }>('GET', '/api/series-personas')).people;
}

/** A real line of a person of the series (D-224): its number, the text, the episode when known; `named` lines go in private chats only. */
export interface SeriesLineView {
  n: number;
  text: string;
  episode?: string;
  named: boolean;
  /** Written by the user, not collected by Claude. */
  own?: boolean;
  /** Taken from the page of the series on it.wikiquote.org. */
  origin?: 'wikiquote';
}

/** The archive of real lines of a person of the series (D-224). */
export interface SeriesLinesStatus {
  character: string;
  lines: SeriesLineView[];
  max: number;
  running: boolean;
  /** Who collects now, or collected last. */
  job: 'claude' | 'wikiquote' | null;
  /** The pages of the series on Wikiquote (null when it has none) and whether the user already said yes to the download. */
  wikiquote: { page: string | null; host: string; consent: boolean };
  stopped: string | null;
  added: number | null;
}

export async function loadSeriesLines(character: string): Promise<SeriesLinesStatus> {
  return call<SeriesLinesStatus>('GET', `/api/series-lines/${encodeURIComponent(character)}`);
}

/** «Genera altre 100»: Claude collects them in the background. */
export async function generateSeriesLines(character: string): Promise<SeriesLinesStatus> {
  return call<SeriesLinesStatus>('POST', `/api/series-lines/${encodeURIComponent(character)}/generate`, {});
}

/** «Prendi da Wikiquote» (D-224): `consent` is the user's yes in the dialog, asked once. */
export async function importWikiquoteLines(character: string, consent: boolean): Promise<SeriesLinesStatus> {
  return call<SeriesLinesStatus>('POST', `/api/series-lines/${encodeURIComponent(character)}/wikiquote`, consent ? { consent: true } : {});
}

/** A line written by hand (D-224). */
export async function addSeriesLine(character: string, text: string): Promise<SeriesLinesStatus> {
  return call<SeriesLinesStatus>('POST', `/api/series-lines/${encodeURIComponent(character)}/add`, { text });
}

export async function removeSeriesLine(character: string, n: number): Promise<SeriesLinesStatus> {
  return call<SeriesLinesStatus>('DELETE', `/api/series-lines/${encodeURIComponent(character)}/${String(n)}`);
}

/** A paired device of the remote port (D-292), for Impostazioni → Dispositivi on the Mac. */
export interface RemoteDevice {
  id: string;
  /** The name the user gave when making the code. */
  name: string;
  createdAt: string;
  lastSeenAt: string | null;
}

export interface DevicesView {
  /** The `*.ts.net` name of [server.remote]. */
  host: string;
  devices: RemoteDevice[];
  /** A code waiting to be typed on the phone, until when; never the code itself. */
  code: { expiresAt: string } | null;
}

/** The paired devices; null when [server.remote] is not configured (404). */
export async function loadDevices(): Promise<DevicesView | null> {
  try {
    return await call<DevicesView>('GET', '/api/devices');
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

/** A new pairing code (5 minutes, one use), replacing the one before. */
export async function newPairingCode(name: string): Promise<{ code: string; expiresAt: string }> {
  return call('POST', '/api/devices/code', name.trim() === '' ? {} : { name: name.trim() });
}

/** «Scollega»: sessions and passkeys of the device end at once. */
export async function unlinkDevice(id: string): Promise<void> {
  await call('POST', `/api/devices/${encodeURIComponent(id)}/unlink`, {});
}
