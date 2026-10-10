import type { CallInfo } from './calls.ts';
import type { CardDetailData, CardFile, CardLink, CardWall, ChecklistItem, MoveTarget } from './cardwall.ts';
import { pendingFromBody, type Progress as DevProgress } from './dev-progress.ts';
import type { GraphData, KnowledgePage } from './graph.ts';
import { parseEndResult, parseNotice, type EndResult, type IncognitoNotice } from './incognito.ts';
import { parseInstallation, type InstallationInfo } from './installation.ts';
import type { HubCard, HubSearchResult } from './huggingface.ts';
import type { ModelAction } from './model-actions.ts';
import type { ModelEval } from './model-evals.ts';
import type { ModelsOverview } from './models-page.ts';
import type { KnowledgeSource } from './route.ts';
import type { SearchResult } from './search.ts';
import type { ModelRole, PrivacyProposal, PrivacySection, SettingsBody, SettingsValues, SettingsView } from './settings.ts';
import type { BrowsableContainer, BrowsableProject, CommitDiff, ProjectFile, ProjectGit, ProjectKnowledge, ServiceLog, ServiceState, TreeEntry } from './projects.ts';
import type { Note, NoteListing } from './thoughts.ts';
import type { Approval, Changelog, CharacterChoice, Commitment, CharacterListing, CloudModel, Conversation, ConversationAgent, ConversationMode, DelegationDiff, DirectAgent, FilePreview, Label, Message, MessageCredit, Participant, ProjectInfo, RecentDelegation, SavedActivity, StatusSnapshot, Task, TaskFailure } from './types.ts';

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

async function call<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
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
export async function purgeConversation(conversationId: string): Promise<void> {
  await call('POST', `/api/conversations/${encodeURIComponent(conversationId)}/purge`, {});
}

export async function loadConversation(conversationId: string): Promise<Conversation> {
  return (await call<{ conversation: Conversation }>('GET', `/api/conversations/${encodeURIComponent(conversationId)}`)).conversation;
}

/** The secretary's conversation (D-144): the one there is, or a new one the first time. */
export async function openSecretary(): Promise<Conversation> {
  return (await call<{ conversation: Conversation }>('POST', '/api/secretary', {})).conversation;
}

/** The open commitments and those of today (D-144), by day and time; `today` is the core's local day. */
export async function listCommitments(): Promise<{ today: string; commitments: Commitment[] }> {
  return call<{ today: string; commitments: Commitment[] }>('GET', '/api/commitments');
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

/** Opens a conversation; a work one may name an approved project (D-058). */
export async function createConversation(mode: ConversationMode, project?: string, agent?: ConversationAgent, incognito = false, trialModel?: string): Promise<Conversation> {
  const body = {
    mode,
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

/** The agents the user may talk with directly now (D-111d). */
export async function listDirectAgents(): Promise<DirectAgent[]> {
  return (await call<{ agents: DirectAgent[] }>('GET', '/api/direct-agents')).agents;
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

export async function listMessages(conversationId: string, beforeId?: string): Promise<Message[]> {
  const query = new URLSearchParams({ limit: '100', ...(beforeId === undefined ? {} : { before: beforeId }) });
  const path = `/api/conversations/${encodeURIComponent(conversationId)}/messages?${query.toString()}`;
  return (await call<{ messages: Message[] }>('GET', path)).messages;
}

export async function sendMessage(conversationId: string, body: string): Promise<{ message: Message; task: Task }> {
  return call('POST', `/api/conversations/${encodeURIComponent(conversationId)}/messages`, { body });
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

export async function decide(approvalId: string, state: 'approved' | 'rejected'): Promise<Approval> {
  return (await call<{ approval: Approval }>('POST', `/api/approvals/${encodeURIComponent(approvalId)}/decision`, { state })).approval;
}

/** The status panel: agents, last router decision, gateway today. */
export async function loadStatus(): Promise<StatusSnapshot> {
  return call<StatusSnapshot>('GET', '/api/status');
}

/** The character packs and who wears what (D-060). */
export async function loadCharacters(): Promise<CharacterListing> {
  return call<CharacterListing>('GET', '/api/characters');
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

/** Every model, local and cloud, for Impostazioni → Modelli (I-3); read only and L0. */
export async function loadModelsOverview(): Promise<ModelsOverview> {
  return call<ModelsOverview>('GET', '/api/models/overview');
}

/** Starts a download or verification of a local model in the background (I-3, M4); the progress comes with the overview. */
export async function startModelAction(modelId: string, kind: 'download' | 'verify'): Promise<ModelAction> {
  return (await call<{ action: ModelAction }>('POST', `/api/models/${encodeURIComponent(modelId)}/${kind}`, {})).action;
}

export async function cancelModelAction(modelId: string): Promise<ModelAction> {
  return (await call<{ action: ModelAction }>('POST', `/api/models/${encodeURIComponent(modelId)}/cancel`, {})).action;
}

/** Moves the files of a local model into data/models/eliminati; `confirm` is the id typed by the user. Where they went. */
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

/** "Chiamami alle…": a call of Arianna at that time, within a week. */
export async function scheduleCall(conversationId: string, at: Date): Promise<CallInfo> {
  return (await call<{ call: CallInfo }>('POST', '/api/calls/schedule', { conversationId, at: at.toISOString() })).call;
}

/** "Chiamami quando finisci": a call when the task is over. */
export async function callWhenDone(taskId: string): Promise<CallInfo> {
  return (await call<{ call: CallInfo }>('POST', `/api/tasks/${encodeURIComponent(taskId)}/call-when-done`, {})).call;
}

export async function cancelScheduledCall(callId: string): Promise<void> {
  await call('POST', `/api/calls/${encodeURIComponent(callId)}/cancel`, {});
}

/** The VAPID public key of [voice.push], or null when push is off. */
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

/** The activity lines a task saved (D-083), oldest first. */
export async function listActivities(taskId: string): Promise<SavedActivity[]> {
  return (await call<{ activities: SavedActivity[] }>('GET', `/api/tasks/${encodeURIComponent(taskId)}/activities`)).activities;
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

/** Queues a new note to be organized again by the local model. */
export async function organizeNote(name: string): Promise<void> {
  await call('POST', `/api/notes/${encodeURIComponent(name)}/organize`, {});
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

export async function listProjectDir(project: string, dir: string): Promise<{ entries: TreeEntry[]; more: number }> {
  return call('GET', `${browse(project)}/tree?${new URLSearchParams({ dir }).toString()}`);
}

export async function readProjectFile(project: string, path: string): Promise<ProjectFile> {
  return (await call<{ file: ProjectFile }>('GET', `${browse(project)}/file?${new URLSearchParams({ path }).toString()}`)).file;
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
