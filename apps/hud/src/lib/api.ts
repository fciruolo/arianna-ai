import type { CallInfo } from './calls.ts';
import { pendingFromBody, type Progress as DevProgress } from './dev-progress.ts';
import type { GraphData, KnowledgePage } from './graph.ts';
import { parseInstallation, type InstallationInfo } from './installation.ts';
import type { ModelEval } from './model-evals.ts';
import type { SearchResult } from './search.ts';
import type { PrivacyProposal, PrivacySection, SettingsBody, SettingsValues, SettingsView } from './settings.ts';
import type { Note, NoteListing } from './thoughts.ts';
import type { Approval, Changelog, CharacterChoice, CharacterListing, CloudModel, Conversation, ConversationAgent, ConversationMode, DelegationDiff, DirectAgent, FilePreview, Label, Message, MessageCredit, Participant, ProjectInfo, RecentDelegation, SavedActivity, StatusSnapshot, Task, TaskFailure } from './types.ts';

/**
 * Calls to the core's API from the page, same origin. Writes send JSON, which
 * the core requires (no form can forge one from another site).
 */
export class ApiError extends Error {
  override name = 'ApiError';
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
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
  if (!response.ok) throw new ApiError(response.status, typeof data.error === 'string' ? data.error : `HTTP ${String(response.status)}`);
  return data as T;
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
  if (!response.ok) throw new ApiError(response.status, typeof data.error === 'string' ? data.error : `HTTP ${String(response.status)}`);
  return data as unknown as SearchResult;
}

/** What this installation is (D-089, D-098); undefined when the core does not say. */
export async function loadInstallation(): Promise<InstallationInfo | undefined> {
  return parseInstallation(await call<unknown>('GET', '/api/installation'));
}

/** Opens a conversation; a work one may name an approved project (D-058). */
export async function createConversation(mode: ConversationMode, project?: string, agent?: ConversationAgent): Promise<Conversation> {
  const body = { mode, ...(project === undefined || project === '' ? {} : { project }), ...(agent === undefined ? {} : { agent }) };
  return (await call<{ conversation: Conversation }>('POST', '/api/conversations', body)).conversation;
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
export async function listModelEvals(limit = 20): Promise<ModelEval[]> {
  return (await call<{ evals: ModelEval[] }>('GET', `/api/model-evals?limit=${String(limit)}`)).evals;
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

/** The graph of kb/ (D-087): pages up to L2 with their links and tags, never their text. */
export async function loadKnowledgeGraph(): Promise<GraphData> {
  return call<GraphData>('GET', '/api/knowledge/graph');
}

/** One page of kb/ with its text, up to L2; 404 for anything else. */
export async function loadKnowledgePage(id: string): Promise<KnowledgePage> {
  return (await call<{ page: KnowledgePage }>('GET', `/api/knowledge/page?path=${encodeURIComponent(id)}`)).page;
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

/** "Novità": the register of the versions, read by the core from CHANGELOG.md. */
export async function loadChangelog(): Promise<Changelog> {
  return (await call<{ changelog: Changelog }>('GET', '/api/changelog')).changelog;
}
