import type { CallInfo } from './calls.ts';
import type { Approval, CharacterChoice, CharacterListing, CloudModel, Conversation, ConversationMode, Message, ProjectInfo, StatusSnapshot, Task, TaskFailure } from './types.ts';

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

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
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

/** Opens a conversation; a work one may name an approved project (D-058). */
export async function createConversation(mode: ConversationMode, project?: string): Promise<Conversation> {
  const body = project === undefined || project === '' ? { mode } : { mode, project };
  return (await call<{ conversation: Conversation }>('POST', '/api/conversations', body)).conversation;
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

/** Where the sheet of a character is served. */
export function sheetUrl(choice: CharacterChoice): string {
  return `/api/characters/${encodeURIComponent(choice.pack)}/${encodeURIComponent(choice.character)}`;
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
export async function speakTrial(text: string, model: string, voice: string): Promise<{ audio: Blob; seconds: number | undefined }> {
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
  const seconds = Number(response.headers.get('x-seconds-spent'));
  return { audio: await response.blob(), seconds: Number.isFinite(seconds) && response.headers.has('x-seconds-spent') ? seconds : undefined };
}

/** Ends a call from its id (one left open by a page that was reloaded). */
export async function endCall(callId: string): Promise<void> {
  await call('POST', `/api/calls/${encodeURIComponent(callId)}/end`, {});
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
