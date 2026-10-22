import { randomUUID } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, sep } from 'node:path';

import { WebSocketServer, type RawData, type WebSocket } from 'ws';

import { SERIES_PERSONAS, seriesPersonaBlock, withSeriesOverride, type NewUserAgent } from '@arianna/agents';
import type { CharacterChoices, Project, SeriesOverrides } from '@arianna/config';
import { createContext, isLabel, maxLabel, type Label, type LabelRules } from '@arianna/policy';

import { countConversationActivities, listTaskActivities } from '../activities.ts';
import { listTaskTerminal } from '../live-terminal.ts';
import { seriesFits } from '../prompt-tail.ts';
import { createAriannaDocs, type AriannaDocs } from '../arianna-docs.ts';
import { loadChangelog } from '../changelog.ts';
import { CaptureError, captureNote, isCaptureKind, MAX_CAPTURE_BYTES } from '../capture.ts';
import { advisorStatus, writeAdvisorSettings } from '../orchestrator/advisor.ts';
import { loadUsage, parsePeriod, USAGE_PERIODS } from '../usage.ts';
import { loadChanges, type ChangeWatcher } from '../install-changes.ts';
import { findConversationNote, saveConversation, type SavedLine } from '../saved-conversations.ts';
import { ApprovalChoiceError, isExecutorChoice, listApprovals, loadApproval, type ApprovalState } from '../approvals.ts';
import { localDay } from '../commitment-dates.ts';
import { addChecklistItem, addFile, addLink, cardDetail, isInline, MAX_FILE_BYTES, readCardFile, removeChecklistItem, removeFile, removeLink, updateChecklistItem } from '../card-details.ts';
import { addDependency, CardError, checkDesignChoice, createCard, listCards, moveCard, removeDependency, resumeCard, retryCard, runCard, sendBackCard, startCard, updateCard, type CardCatalog, type CardNames } from '../cardwall.ts';
import { CommitmentError, findSecretary, listCommitments, markDone, openSecretary } from '../commitments.ts';
import type { CalendarDay } from '../feasts.ts';
import { currentTheme, listThemes } from '../themes.ts';
import { assignCharacters, listPacks, MAX_UPLOAD_BODY, parseUpload, readSheet, UploadError, uploadSheet, type CharacterDirs } from '../characters.ts';
import { GithubError } from '../github-api.ts';
import { PixelAgentsError, type PixelAgentsResult } from '../pixel-agents-pack.ts';
import {
  archiveConversation,
  ChatError,
  createConversation,
  CLAUDE_CHAT_AGENT,
  CODEX_CHAT_AGENT,
  CODEX_CHAT_MODELS,
  DIRECT_MODELS,
  isUuid,
  listConversations,
  listMessages,
  loadConversation,
  loadMessage,
  pinConversation,
  setConversationCharacter,
  purgeConversation,
  renameConversation,
  setConversationModel,
} from '../conversations.ts';
import { editQueued, listQueue, postOrQueue, removeQueued, resumeQueue, sendQueuedNow } from '../message-queue.ts';
import { listSideThreads, openSideThread, sideThreadIds } from '../side-threads.ts';
import { chatBrief } from '../delegation-view.ts';
import type { Sql } from '../db/client.ts';
import {
  createOpenLinks,
  DelegationFileError,
  listCredits,
  listRecentDelegations,
  openDelegationFile,
  openHeaders,
  readDelegationDiff,
  readDelegationFile,
  readOpenFile,
  type OpenLinks,
} from '../delegation-view.ts';
import { addContact, archiveClient, ClientError, PROJECT_NAME as CLIENT_PROJECT_NAME, clientOfProject, createClient, linkProject, listClients, readClient, readLogo, removeContact, removeLogo, setLogo, unlinkProject, updateClient, updateContact, type ClientNames } from '../clients.ts';
import { CLIENT_FIELDS, CONTACT_FIELDS, MAX_LOGO_BYTES } from '../clients-format.ts';
import { completeItemCard, itemCard } from '../im-cards.ts';
import { finishClosing, listImClosings, loadImClosing, type ImClosing } from '../im-watch.ts';
import { addImItem, closeImItem, createIm, ImError, listIms, readIm, isLastIm, setImItemState, writeImCalendar, writeImEnd, type ImItemRef, type ImOutcome } from '../im.ts';
import { addDocument, archiveDocument, listDocuments, MAX_DOCUMENT_BYTES, openDocument, readDocument, updateDocument, type Opener } from '../client-documents.ts';
import { readClientDashboard } from '../client-dashboard.ts';
import { parseCalendarQuery, readCalendar } from '../routine-calendar.ts';
import { RoutineError, type RoutineService } from '../routines.ts';
import {
  alerts as financeAlerts,
  createAccount as createFinanceAccount,
  createCategory as createFinanceCategory,
  createRule as createFinanceRule,
  deleteBudget as deleteFinanceBudget,
  deleteCategory as deleteFinanceCategory,
  deleteRule as deleteFinanceRule,
  ensureCategories as ensureFinanceCategories,
  importFile as importFinanceFile,
  listAccounts as listFinanceAccounts,
  listBudgets as listFinanceBudgets,
  listCategories as listFinanceCategories,
  listImports as listFinanceImports,
  listRules as listFinanceRules,
  listTransactions as listFinanceTransactions,
  previewFile as previewFinanceFile,
  setBudget as setFinanceBudget,
  setTransactionCategory as setFinanceTransactionCategory,
  summary as financeSummary,
  undoImport as undoFinanceImport,
  updateAccount as updateFinanceAccount,
  updateCategory as updateFinanceCategory,
} from '../finance.ts';
import { dayParam, FinanceError, MAX_IMPORT_BODY, monthParam } from '../finance-format.ts';
import { cancelInvoice, createInvoice, CURRENCY, ImBillingError, readImOverview, removeFromInvoice, setImBilling, setImPrice, updateInvoice, type InvoiceChange } from '../im-billing.ts';
import { IM_STATES } from '../im-format.ts';
import { RELEASE_STATUS, ReleaseError, type NoteReleaser, type ProposalOutcome } from '../note-release.ts';
import { deleteProjectNote, editProjectNote, KnowledgeError, readProjectKnowledge, readProjectNote, writeProjectNote, type KnowledgeEnv } from '../project-knowledge.ts';
import { type DraftFailure, type DraftOutcome } from '../rules-draft.ts';
import type { ChartData, ChartInput } from '../dashboard-chart.ts';
import {
  cancelRefresh,
  chartFromBody,
  listTiles,
  orderTiles,
  pinnedMessages,
  pinTile,
  removeTile,
  settleDashboard,
  startRefresh,
  updateTile,
  type PinInput,
  type RefreshEnv,
  type Suggestion,
} from '../dashboard.ts';
import type { ExportOutcome, ExportPlan } from '../rules-export.ts';
import { browsableContainers, browsableProjects, hiddenConsents, hiddenShown, listProjectDir, notBusy, openBrowsedFile, readBrowsedFile, readCommitDiff, readProjectGit, revealBrowsedFile, serviceStates, setHiddenShown } from '../project-browser.ts';
import { pickService, ServiceError, type ServiceManager } from '../project-services.ts';
import { NEWS_KEY, type DesignNews, type NewsItem, type NewsPair } from '../design-news.ts';
import { MAX_ACCOUNTS } from '../followed-accounts.ts';
import { MAX_PROJECTS, PROJECT_KEY, type FollowedProjects, type ProjectNews } from '../followed-projects.ts';
import { answersByKey, DevAnswerError, eventKey, loadProgress, MAX_ANSWER_CHARS, MAX_USER_NOTE_CHARS, pendingQuestions, readUserNote, recordAnswer, saveAnswer, saveNewsRedo, saveProjectChoice, saveRewrite, saveUserNote, type AnswerGate, type ProjectChoice, type OpenQuestion } from '../dev-progress.ts';
import { createUserFacts, FACTS_STATUS, FactsError, MAX_FACT_TEXT, MAX_TOPIC } from '../user-facts.ts';
import { passGateway } from '../gateway.ts';
import { editPlan, PlanError } from '../card-plans.ts';
import { recordDecision, retryTask } from '../engine.ts';
import { loadFailure } from '../failures.ts';
import { SpriteError, type SpriteGenerator } from '../sprites/generate.ts';
import { ImReportError, REPORT_AGENTS, REPORT_LANGUAGES, type ImReporter } from '../im-report.ts';
import { UserAgentError, type CatalogNewUserAgent, type ConfirmedNewUserAgent, type UserAgents, type UserAgentView } from '../user-agents.ts';
import type { LiveFeed, LiveMessage } from '../live.ts';
import type { LocalReload } from '../local-reload.ts';
import type { LocalServerStatus } from '../local-servers.ts';
import { DesignCatalogError, type DesignCatalog } from '../design-catalog.ts';
import { createSampleCache } from '../style-sample.ts';
import { StyleExampleError, type StyleExamples } from '../style-examples.ts';
import type { SkillTranslations } from '../skill-translations.ts';
import { SeriesLinesError, type SeriesLines } from '../series-lines.ts';
import { roleSafetyText, skillSafetyText, type SafetyReports, type SafetyView } from '../safety-reports.ts';
import { openMockup, startDesignerSession } from '../designer-session.ts';
import { deleteProjectPath, moveProjectPath, PROJECT_FILE_STATUS, ProjectFileError } from '../project-files.ts';
import type { GodApi } from '../god/api.ts';
import { changelogRefOf } from '../god/changelog-carry.ts';
import { GodCloneError } from '../god/clone.ts';
import { GodError } from '../god/work.ts';
import { isPublicSkill, type SkillsCatalog } from '../skills-catalog.ts';
import type { AgentsCatalog } from '../agents-catalog.ts';
import { cleanBody } from '../git-catalog.ts';
import { HubError } from '../hub-http.ts';
import type { HuggingFace } from '../huggingface.ts';
import { OmlxBusyError, type OmlxReleases } from '../omlx-release.ts';
import { ModelActionError, type ModelActions } from '../model-actions.ts';
import { ModelEvalError, type ModelEvals } from '../model-evals.ts';
import type { MemorySnapshot } from '../model-memory.ts';
import type { ModelsOverview } from '../models-overview.ts';
import { buildAriannaGraph, buildKnowledgeGraph, readAriannaPage, readKnowledgePage, readPageFile, type GraphCache } from '../knowledge.ts';
import {
  approveWikiProposal,
  countWikiProposals,
  createUserWikiPage,
  createWikiFolder,
  deleteWikiFolder,
  deleteWikiPage,
  editWikiPage,
  discardWikiProposal,
  isWikiSource,
  listWikiProposals,
  moveWikiFolder,
  moveWikiPage,
  proposalSource,
  proposeMove,
  readWikiView,
  recordWikiEvent,
  restoreWikiVersion,
  WIKI_STATUS,
  WikiError,
  WikiWriteSessions,
  wikiCitationTargets,
  visibleWikiTree,
} from '../wiki.ts';
import { approveMany, ARCHIVE_STATUS, archiveFolders, ArchiveError, discardArchive, listProposals, MAX_APPROVE_ITEMS, recordArchived, recordDiscarded, type ApproveInput } from '../archivist.ts';
import { deleteKbPage, recordNoteDeleted } from '../note-delete.ts';
import { checkNoteName, headerFields, isNoteStatus, listNotes, NoteError, readNote } from '../notes.ts';
import { KB_DIR } from '../orchestrator/kb.ts';
import { SettingsError, type SettingsPage } from '../settings-page.ts';
import type { InstallationInfo } from '../installation.ts';
import type { Readiness } from '../readiness.ts';
import { AlreadySavedError, captureMessage, savedMessageNotes } from '../saved-messages.ts';
import { DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT, searchAll, SearchError } from '../search.ts';
import { projectFits, type DirectPolicy, type OffInterlocutor } from '../direct-chat.ts';
import type { ChatCharacter } from '../character-chat.ts';
import { activeParticipants, removeParticipant, type LeaveRule } from '../participants.ts';
import { eraseConversation, type EraseResult } from '../erase.ts';
import { attachmentFilesOf, attachmentIds, AttachmentError, discardAttachment, removeAttachmentFiles, MAX_IMAGE_BYTES, readAttachment, saveAttachment } from '../attachments.ts';
import { isFinanceConversation } from '../finance-mark.ts';
import { closeIncognito, incognitoClosedCause, isIncognitoConversation, isIncognitoTask, type IncognitoCause, type IncognitoReceipt } from '../incognito.ts';
import { loadStatus } from '../status.ts';
import { appendEvent, type NewEvent } from '../events.ts';
import { FrameStore, frameHeaders, MAX_FRAME_BYTES } from '../studio-frames.ts';
import { deleteMockup, exportPptx, listMockups, MAX_MOCKUP_BYTES, PPTX_TYPE, readMockup, STUDIO_STATUS, StudioError, writeMockup, type PptxCodec } from '../studio.ts';
import { attachQuestion, openFailureChat } from '../system-chats.ts';
import { loadTask, TaskError } from '../tasks.ts';
import { dismissWaitingTask, listWaitingTasks } from '../waiting.ts';
import { CallError, listCalls, liveCall, type CallEndReason, type Calls } from '../voice/calls.ts';
import type { Notice, NoticeBoard, NoticeKind } from '../notifications.ts';
import { isPushEndpoint, parseSubscription, PushError, type Pusher } from '../voice/push.ts';
import { callWhenDone, cancelCall, scheduleCall, ScheduleError } from '../voice/ringer.ts';
import { VoiceError, type VoiceService, type VoiceState } from '../voice/service.ts';
import { CloneError, deleteClone, listClones, MAX_CLONE_BODY, parseClone, saveClone } from '../voice/clones.ts';
import { MAX_TRANSCRIBE_BODY, speakCall, transcribeCall, TrialError, type TrialModel } from '../voice/trial.ts';
import { isYoutubeVideo } from '../video-url.ts';
import { isVideoFailure, VIDEO_FAILURE_TEXT, type VideoJobState } from '../video-job.ts';
import type { BrowserScreens } from '../browser/screen.ts';
import { allowedHosts, checkRequest, securityHeaders } from './security.ts';

/**
 * API, WebSocket and web chat of the core (task 1.11, D-039). `node:http`
 * without a framework; loopback only (config), same-origin only (security.ts).
 * Every action goes through HTTP; the WebSocket only pushes events and reply
 * fragments.
 */
/** What the chat sees of an approved project: the path as written, never resolved. */
export interface ProjectInfo {
  name: string;
  path: string;
  label: string;
}

export interface ApiServerOptions {
  sql: Sql;
  live: LiveFeed;
  host: string;
  port: number;
  /**
   * The projects the user approved (`[[project]]` of arianna.toml, D-058), read
   * at each request: the only ones a work conversation may name.
   */
  projects?: () => readonly ProjectInfo[];
  /** The cloud models a work conversation may choose (task 1.10), from the current configuration. */
  models?: () => readonly { executor: string; model: string }[];
  /** The model a new work conversation starts with (`[cloud.models] default`, D-071); undefined lets the router choose. */
  defaultModel?: (agent?: string) => string | undefined;
  /** The ids of the agents (agents/*.yaml): the status panel and the characters list them. */
  agents?: () => readonly string[];
  /** The agents that read finance data (I-18, D-183): like Arianna, never an assignee of a card or of an IM item. */
  financeAgents?: () => readonly string[];
  /**
   * The pixel characters (D-060): pack folders and the user's choices, read at each request; with
   * `themes` (D-103) the folder of the themes and the one chosen in `[appearance]`, whose costumes the
   * agents wear when `[characters]` names none. `names`: agent → the name the user wrote for it in
   * `[personas]` (D-214), which the chat shows instead of a character's.
   */
  characters?: {
    dirs: CharacterDirs;
    choices: () => CharacterChoices;
    /** `feasts` (D-246): the switch of `[appearance]` and the day the themes see, for the feast that takes the place of Base. */
    themes?: { dir: string; chosen: () => string; feasts?: () => { on: boolean; today: CalendarDay } };
    names?: () => Record<string, string>;
    /** `[series]` (D-223): what the user rewrote of the people of the series. */
    series?: () => SeriesOverrides;
    /** The archive of real lines (D-224): with lines, the block leaves the fixed catchphrases out. */
    lines?: Pick<SeriesLines, 'has'>;
    downloadPixelAgents?: () => Promise<PixelAgentsResult>;
  };
  /** apps/voice (D-066); its state is `off` while `[voice]` is not configured (D-071). */
  voice?: VoiceApi;
  /** Calls from the chat (D-066); refused while the voice is off. */
  calls?: Calls;
  /** Web Push for the calls of Arianna (D-066), read at each request: undefined without [voice.push]. */
  pusher?: () => Pusher | undefined;
  /** The last notice pushed (I-1), which the service worker asks for: kind and conversation only. */
  notices?: NoticeBoard;
  /** The settings page (D-071): arianna.toml read and written with its fingerprint. */
  settings?: SettingsPage;
  /** The local servers the core watches (D-071): state, restart, end of the log. */
  local?: LocalApi;
  /**
   * Capture into kb/inbox (D-080): the home whose kb/ receives the notes, and
   * the folder rules; the notes of kb/inbox are read with the same (D-086).
   * `organize` queues the organizing of a note by the local model; without it
   * notes are saved and read, not organized.
   */
  capture?: {
    home: string;
    rules: LabelRules;
    organize?: (path: string) => Promise<boolean>;
    /** "Scarica e riassumi" (D-154): organizes the note again with its link downloaded. */
    fetch?: (path: string) => Promise<boolean>;
    /** "Proponi di nuovo" (D-195): the Archivist proposes again where the note goes. */
    archive?: (path: string) => Promise<boolean>;
    /** «Riassumi il video» (D-273): queues the summary of the video of the note, approved by the user in the chat. */
    video?: (path: string) => Promise<boolean>;
    /** The job of the video of a note, as the chat shows it. */
    videoState?: (path: string) => Promise<VideoJobState | undefined>;
    /**
     * The Wiki (D-280): `propose` queues a proposal from a note of kb/
     * (relative to kb/, `inbox/x.md`), `index` the «In breve» of a folder
     * index. Without it the wiki is read, never proposed.
     */
    wiki?: { propose: (page: string, force: boolean) => Promise<boolean>; index: (folder: string) => Promise<boolean> };
    arianna?: AriannaDocs;
  };
  /** data/, where the router's advisor keeps the path of the usage status file (D-207); without it the routes answer 404. */
  advisorData?: string;
  /** «Cosa è cambiato» (D-233): a fresh picture of the installation before the page reads; without it the route answers 404. */
  changes?: Pick<ChangeWatcher, 'check'>;
  /** Trials of catalog models with the orchestrator evals (D-081). */
  modelEvals?: Pick<ModelEvals, 'request' | 'list' | 'get' | 'cancel' | 'compare' | 'compareCases'>;
  /** Every model, local and cloud, for the "Modelli" page (I-3, models-overview.ts); without it the route answers 404. */
  modelsOverview?: () => Promise<ModelsOverview>;
  /** Download, verify, remove and unload a local model, and the bin (I-3, stage M4); without it the routes answer 404. */
  modelActions?: ModelActions;
  /** oMLX after a download (D-201): the user closes the line that asks to restart it by hand. */
  modelReload?: Pick<LocalReload, 'dismiss'>;
  /** Search and add models from Hugging Face, promote them, take them out (I-10, D-139); without it the routes answer 404. */
  huggingface?: HuggingFace;
  /** «Server dei modelli (oMLX)» (D-265): version installed and newest release; without it the routes answer 404. */
  omlxReleases?: OmlxReleases;
  /** The catalog of Open Design (D-160): download, adopt, discard, read a style; without it the routes answer 404. */
  designCatalog?: DesignCatalog;
  /** The catalog of skills (D-161): sources, download, adopt, discard, read a skill; without it the routes answer 404. */
  skillsCatalog?: SkillsCatalog;
  /** The routines (D-110 tappa A, D-254): the page «Routine» and «Prova adesso»; without it the routes answer 404. */
  routines?: RoutineService;
  /** The catalog of agents (D-079): sources, download, adopt, discard, read a role; without it the routes answer 404. */
  agentsCatalog?: AgentsCatalog;
  /** How the Studio checks and writes a deck (D-184): `@arianna/pptx` when absent, a fake in the tests. */
  studioPptx?: PptxCodec;
  /** The examples of the styles written by Sonnet (I-20, D-185); without it the routes answer 404. */
  styleExamples?: StyleExamples;
  /** The Italian descriptions of the skills written by Sonnet (I-20, D-185); without it the routes answer 404. */
  skillTranslations?: SkillTranslations;
  /** The archive of real lines of the people of the series (D-224). */
  seriesLines?: SeriesLines;
  /** The Italian descriptions of the roles of the catalog of agents (D-185); without it the routes answer 404 and the English stays. */
  roleTranslations?: SkillTranslations;
  /** GOD (D-127): its clone, its conversations; without it the routes answer 404. */
  god?: GodApi;
  /** What this installation is (D-089), read at each request: mode, folder name, commit. */
  installation?: () => InstallationInfo;
  /** «Pronta per i dati veri» (D-192): the last outcome and a new check; without it the routes answer 404. */
  readiness?: Readiness;
  /**
   * The approved projects with their folders (D-058), read at each request:
   * where the preview of a file changed by the Coder is read (D-082).
   */
  approvedProjects?: () => readonly Project[];
  /**
   * The approved projects as containers (D-145), read at each request: the
   * page Progetti lists them with their parts, and the tab "Conoscenza" reads
   * and writes the notes of their management folders. `approvedProjects` are
   * their parts.
   */
  projectContainers?: () => readonly Project[];
  /** ARIANNA_HOME and labels.toml for the tab "Conoscenza" (kb/progetti, D-145); without it its routes answer 404. */
  knowledge?: KnowledgeEnv;
  /** "Proponi bozza" of the tab "Regole" (I-14 R2, D-175): the local model drafts a container's rules; without it the route answers 503. */
  rulesDraft?: (container: string) => Promise<DraftOutcome | undefined>;
  /** «Fissa alla Dashboard» (D-248): the local model rewrites the question of a tile; without it the page proposes the user's message. */
  dashboardSuggest?: (messageId: unknown) => Promise<Suggestion>;
  /** A chart tile of the Dashboard (D-248): the local model turns an answer into checked chart data; without it a chart waits. */
  dashboardChart?: (input: ChartInput) => Promise<ChartData | undefined>;
  /** "Fai uscire una volta" of a Private note (I-11 P5, D-187): anonymous proposal, master password, one message; without it the routes answer 503. */
  noteRelease?: NoteReleaser;
  /**
   * "Esporta in CLAUDE.md e AGENTS.md" of the tab "Regole" (I-14 R3, D-176):
   * the preview (null: the container has no rules) and the writing of the
   * text the user saw; without it the routes answer 503.
   */
  rulesExport?: { plan: (container: string) => ExportPlan | null; write: (container: string, seen: ExportPlan) => ExportOutcome };
  /** The tab Servizi of "Progetti" (D-134, tappa 2); without it the routes answer 404. */
  services?: ServiceManager;
  /** "Sviluppo di Arianna" (D-102): the home whose docs/ are read, and the event of an answer saved. */
  devProgress?: DevProgressApi;
  /** The cardwall (D-152): the folder of the files attached to cards (data/cards); without it the file routes answer 404. */
  cards?: { dir: string };
  /**
   * Images and files attached in the chat (D-247): their folder (data/attachments) and whether a model has
   * the `vision` role now; without it the attachment routes answer 404.
   */
  attachments?: { dir: string; vision: () => boolean };
  /** The clients (D-168): the folder of their logos (data/clients); without it the logo routes answer 404. */
  /** `opener`: "Apri" and "Mostra nel Finder" of the documents (D-171); `open` of macOS when absent, a fake in the tests. */
  clients?: { dir: string; opener?: Opener };
  /** "Novità": the home whose CHANGELOG.md is read, read only; without it the route answers 404. */
  changelog?: { home: string };
  /** The agents the user creates from the Agents page (D-119); without it the routes answer 404. */
  userAgents?: UserAgents;
  /** The safety reports of the agents made from the catalog (D-196); without it no report is shown or made. */
  safetyReports?: SafetyReports;
  /**
   * What the participant bar shows of an active agent (D-125): where it runs and the
   * label of its name in the lines of the chat; undefined for an agent no
   * longer active. Without it every agent reads as gone (executor null, L1).
   */
  participantAgent?: (agent: string) => { executor: string | null; nameLabel: Label } | undefined;
  /** Who the user may talk with in place of Arianna (D-111d); undefined, nobody. */
  directAgents?: () => readonly DirectPolicy[];
  /** The interlocutors of «Con chi parli» that cannot answer now, with why (D-111, tappa B); shown off in "+ Nuovo". */
  offInterlocutors?: () => readonly OffInterlocutor[];
  /** The people of the series the user may chat with on Claude (D-225, tappa B); undefined, none. */
  chatCharacters?: () => readonly ChatCharacter[];
  /** Removes the empty folder of a plain chat with Claude (D-111, tappa B) once its conversation is purged or erased; never fails the request. */
  chatFolderGone?: (conversationId: string) => Promise<void>;
  /**
   * Why a local model cannot open a trial chat now (D-142): undefined when it
   * can (in the catalog, a chat model, its files on the disk). Without it no
   * trial chat opens.
   */
  trialRefusal?: (modelId: string) => string | undefined;
  /** When an idle agent leaves a conversation (I-8, D-130), read at each message; undefined, none leaves. */
  leaveRule?: () => LeaveRule | undefined;
  /** The agents «@name» and «/giro» may call (D-107, tappa B2); without it every message goes to Arianna. */
  mentionable?: () => readonly string[];
  /**
   * Who may do a card of a plan the user edits (D-235): the user and the
   * agents the planner may choose now; without it, the user and `mentionable`.
   */
  planAssignees?: () => readonly string[];
  /** "Ferma" in the chat (D-218): stops the answers at work in a conversation; without it the route answers 404. */
  stopChat?: (conversationId: string) => Promise<{ stopped: number }>;
  /** "Ferma" of a card, or a drag out of "In corso" (D-235); without it the route answers 404. */
  stopCard?: (cardId: string) => Promise<{ stopped: boolean; left: boolean }>;
  /** "Genera personaggio" (D-123); without it the routes answer 404. */
  sprites?: SpriteGenerator;
  /** "Scrivi il report" of an IM (D-167, P4c); without it the routes answer 404. */
  imReports?: ImReporter;
  /**
   * Closes an incognito conversation (D-136) stopping its work in progress;
   * without it the route closes it without stopping a step of the worker.
   */
  incognito?: {
    close: (conversationId: string, cause: IncognitoCause) => Promise<IncognitoReceipt>;
    /** A local server keeps a cache of the prompts on the SSD (`--paged-ssd-cache-dir`, D-136): the opening card names it. Read at each request. */
    localCache?: () => boolean;
  };
  /**
   * "Elimina" of a conversation (D-157), stopping the steps of the worker
   * first; without it the route erases with no stop (a step at work: 409).
   */
  erase?: (conversationId: string) => Promise<EraseResult>;
  /** The screen of the browser of Arianna (D-264, passo 4); without it the routes answer 404. */
  browserScreens?: BrowserScreens;
  /** Built web chat (`apps/hud/dist`); without it only the API is served. */
  staticDir?: string;
  /** Errors are reported here, never sent to the client: they may hold data. */
  onError?: (error: unknown) => void;
}

/** What the routes need of the voice: the service and the trial candidates, read at each request. */
export interface VoiceApi {
  service: Pick<VoiceService, 'state' | 'request'>;
  models: () => TrialModel[];
  /** The voice of `[voice]`, read at each request. */
  voice: () => string;
  /** Where the voices copied from a sample live (D-069): data/voice/voices. */
  clones: string;
}

export interface LocalApi {
  status(): LocalServerStatus[];
  /** Resolves once the server has settled, which may take minutes: the route does not wait. */
  restart(id: string): Promise<boolean>;
  /** The end of data/<id>.log: may hold prompts (L2), shown only in the web chat. */
  log(id: string): string;
  /** The account of the local models and the swap level (D-107, stage E): catalog ids and numbers, L0. */
  memory?(): MemorySnapshot;
}

export interface ApiServer {
  /** The bound port, useful with port 0 in tests. */
  readonly port: number;
  /** Pages holding the live feed now: with none, a call of Arianna rings by Web Push (D-066). */
  clients(): number;
  /** Pages that said they are in view (I-1): with none, a notice goes by Web Push. */
  visiblePages(): number;
  /** Pages in view and in front with this conversation open (D-128): with none, the helper of the Mac shows the notice. */
  readingPages(conversationId: string): number;
  /** A notice (I-1) to every open page: a kind and a conversation id, never text; `helper` when the helper of the Mac shows it (D-128). */
  broadcast(notice: Notice & { kind: NoticeKind; helper?: boolean }): void;
  /** Native helpers connected (D-128, GET /api/notifications/stream). */
  helpers(): number;
  /** A notice to every helper: kind and conversation id only. */
  notifyHelpers(notice: Notice & { kind: NoticeKind }): number;
  /** The push addresses the pages of this Mac said are theirs: skipped for notices while a helper is connected. */
  macEndpoints(): ReadonlySet<string>;
  /** Pages that said this conversation is open in them, in view or not (D-136: an incognito with none closes). */
  pagesOn(conversationId: string): number;
  /** `conversation.incognito-closing` to every open page (D-136): an id and the seconds left, nothing else. */
  incognitoClosing(conversationId: string, inSeconds: number): void;
  close(): Promise<void>;
}

// A message of MAX_MESSAGE_LENGTH 4-byte characters, JSON-escaped, fits.
export const MAX_BODY_BYTES = 128 * 1024;
/** A file attached to a card, in base64 with its name: a third more than the file, and some room. */
const MAX_CARD_FILE_BODY = Math.ceil((MAX_FILE_BYTES * 4) / 3) + 64 * 1024;
/** What the user writes on a card, new or changed (cardwall.ts). */
const CARD_FIELDS = ['title', 'project', 'assignee', 'due', 'goal', 'criteria', 'priority', 'planned', 'style', 'skills'];
/** A logo comes as JSON with its bytes in base64: a third more than the image, and some room. */
const MAX_LOGO_BODY = Math.ceil((MAX_LOGO_BYTES * 4) / 3) + 4 * 1024;
const MAX_DOCUMENT_BODY = Math.ceil((MAX_DOCUMENT_BYTES * 4) / 3) + 64 * 1024;
const DOCUMENT_FIELDS = ['name', 'kind', 'otherType', 'project', 'documentOn', 'expiresOn'];
/** A client that reads this far behind is dropped; it catches up on reconnection. */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
/** Helpers of the Mac at once (D-128): one is enough, a few for a restart that overlaps. */
const MAX_HELPERS = 4;
const MAX_MAC_ENDPOINTS = 8;
const HELPER_BEAT_MS = 25_000;
const PING_MS = 30_000;
const PAGE_LIMIT = 200;

class HttpError extends Error {
  override name = 'HttpError';
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Params = Record<string, string>;
/** A JSON body, or `raw` bytes with their type (the character sheets). */
/** `raw` bytes are cached by the browser unless `noStore` (the voice trial's WAV, D-066). */
/** `lines` are sent as newline-delimited JSON while they come (a turn of a call, D-070). */
type Result =
  | { status?: number; body: unknown }
  | { raw: Buffer; type: string; headers?: Record<string, string>; noStore?: boolean }
  | { lines: AsyncIterableIterator<unknown> };
type Handler = (request: IncomingMessage, url: URL, params: Params) => Promise<Result>;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

function route(method: string, path: string, handler: Handler): Route {
  const keys: string[] = [];
  const source = path.replace(/:([a-zA-Z]+)/g, (_match, key: string) => {
    keys.push(key);
    return '([^/]+)';
  });
  return { method, pattern: new RegExp(`^${source}$`), keys, handler };
}

async function readJson(request: IncomingMessage, limit = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
  const declared = Number(request.headers['content-length'] ?? '0');
  if (declared > limit) throw new HttpError(413, 'body too large');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'body too large');
    chunks.push(chunk);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'body is not valid JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new HttpError(400, 'body must be a JSON object');
  return value as Record<string, unknown>;
}

function onlyFields(body: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new HttpError(400, `unknown field(s): ${unknown.join(', ')}`);
}

function limitParam(url: URL): number {
  const raw = url.searchParams.get('limit');
  if (raw === null) return 50;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_LIMIT) throw new HttpError(400, `limit must be 1-${String(PAGE_LIMIT)}`);
  return limit;
}

/** The id of a queued message (D-218): a bigint, as messages have. */
function queuedId(params: Params): string {
  const id = params.id ?? '';
  if (!/^\d{1,19}$/.test(id)) throw new HttpError(404, 'not found');
  return id;
}

function idParam(params: Params, key: string): string {
  const id = params[key] ?? '';
  if (!isUuid(id)) throw new HttpError(404, 'not found');
  return id;
}

const APPROVAL_STATES: readonly ApprovalState[] = ['pending', 'approved', 'rejected', 'expired'];

interface RouteOptions {
  cards: ApiServerOptions['cards'];
  clients?: ApiServerOptions['clients'];
  projects: () => readonly ProjectInfo[];
  models: () => readonly { executor: string; model: string }[];
  defaultModel: (agent?: string) => string | undefined;
  agents: () => readonly string[];
  financeAgents: () => readonly string[];
  characters: ApiServerOptions['characters'];
  voice: VoiceApi | undefined;
  calls: Calls | undefined;
  pusher: () => Pusher | undefined;
  settings: SettingsPage | undefined;
  local: LocalApi | undefined;
  capture: ApiServerOptions['capture'];
  modelEvals: ApiServerOptions['modelEvals'];
  advisorData: ApiServerOptions['advisorData'];
  changes: ApiServerOptions['changes'];
  approvedProjects: () => readonly Project[];
  projectContainers: () => readonly Project[];
  knowledge?: KnowledgeEnv | undefined;
  rulesDraft?: ApiServerOptions['rulesDraft'];
  dashboardSuggest?: ApiServerOptions['dashboardSuggest'];
  dashboardChart?: ApiServerOptions['dashboardChart'];
  rulesExport?: ApiServerOptions['rulesExport'];
  noteRelease?: NoteReleaser | undefined;
  installation: ApiServerOptions['installation'];
  readiness?: Readiness | undefined;
  directAgents?: (() => readonly DirectPolicy[]) | undefined;
  offInterlocutors?: (() => readonly OffInterlocutor[]) | undefined;
  chatCharacters?: (() => readonly ChatCharacter[]) | undefined;
  chatFolderGone?: ((conversationId: string) => Promise<void>) | undefined;
  trialRefusal?: ((modelId: string) => string | undefined) | undefined;
  services?: ServiceManager | undefined;
  leaveRule?: (() => LeaveRule | undefined) | undefined;
  stopChat?: ApiServerOptions['stopChat'];
  stopCard?: ApiServerOptions['stopCard'];
  mentionable?: ApiServerOptions['mentionable'];
  planAssignees?: ApiServerOptions['planAssignees'];
  incognito?: ApiServerOptions['incognito'];
  erase?: ApiServerOptions['erase'];
  attachments?: ApiServerOptions['attachments'];
  designCatalog?: DesignCatalog | undefined;
  skillsCatalog?: SkillsCatalog | undefined;
  routines?: RoutineService | undefined;
  onError: (error: unknown) => void;
}

/** The voice is configured: `[voice]` in arianna.toml (D-071: it turns on and off without a restart). */
function voiceOn(voice: VoiceApi | undefined): voice is VoiceApi {
  return voice !== undefined && voice.service.state !== 'off';
}

/** The token of the voice for one call: `Authorization: Bearer <token>`. */
function bearer(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  return typeof header === 'string' && header.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
}

const END_REASONS_FROM_VOICE: readonly CallEndReason[] = ['hangup', 'time-limit', 'disconnected', 'voice-error'];

function callRoutes(sql: Sql, voice: VoiceApi | undefined, calls: Calls | undefined, pushers: () => Pusher | undefined): Route[] {
  const need = (): Calls => {
    if (calls === undefined || voice?.service.state === 'off') throw new HttpError(503, 'voice off: add [voice] to arianna.toml');
    return calls;
  };
  const needPush = (): Pusher => {
    const pusher = pushers();
    if (pusher === undefined) throw new HttpError(503, 'push off: add [voice.push] to arianna.toml');
    return pusher;
  };
  return [
    // The call in progress, if any: a reloaded page finds it again.
    route('GET', '/api/calls/live', async () => ({ body: { call: (await liveCall(sql)) ?? null } })),
    route('GET', '/api/conversations/:id/calls', async (_request, _url, params) => ({ body: { calls: await listCalls(sql, idParam(params, 'id')) } })),
    // The page calls: its WebRTC offer in, the answer of apps/voice out.
    route('POST', '/api/calls', async (request) => {
      const body = await readJson(request);
      onlyFields(body, ['conversationId', 'sdp', 'type']);
      const { conversationId, sdp, type } = body;
      if (typeof conversationId !== 'string' || typeof sdp !== 'string' || typeof type !== 'string') throw new HttpError(400, 'conversationId, sdp and type are required');
      const started = need();
      // An incognito conversation has no calls (D-136); with the voice off the 503 comes first, as for any call.
      if (await isIncognitoConversation(sql, conversationId)) return { status: 409, body: { error: 'incognito' } };
      return { status: 201, body: await started.start(conversationId, { sdp, type }) };
    }),
    route('POST', '/api/calls/:id/end', async (request, _url, params) => {
      onlyFields(await readJson(request), []);
      return { body: { call: await need().end(idParam(params, 'id'), 'hangup') } };
    }),
    // A call of Arianna that is ringing: answered with the page's offer, or declined.
    route('POST', '/api/calls/:id/answer', async (request, _url, params) => {
      const body = await readJson(request);
      onlyFields(body, ['sdp', 'type']);
      const { sdp, type } = body;
      if (typeof sdp !== 'string' || typeof type !== 'string') throw new HttpError(400, 'sdp and type are required');
      return { body: await need().answer(idParam(params, 'id'), { sdp, type }) };
    }),
    route('POST', '/api/calls/:id/decline', async (request, _url, params) => {
      onlyFields(await readJson(request), []);
      return { body: { call: await need().decline(idParam(params, 'id')) } };
    }),
    // "Chiamami alle 18" and "chiamami quando finisci" (D-066, choice 8).
    route('POST', '/api/calls/schedule', async (request) => {
      const body = await readJson(request);
      onlyFields(body, ['conversationId', 'at']);
      const scheduling = need();
      if (typeof body.conversationId === 'string' && (await isIncognitoConversation(sql, body.conversationId))) return { status: 409, body: { error: 'incognito' } };
      const { conversationId, at } = body;
      if (typeof conversationId !== 'string' || !isUuid(conversationId) || typeof at !== 'string') throw new HttpError(400, 'conversationId and at (ISO time) are required');
      return { status: 201, body: { call: await scheduleCall(sql, conversationId, new Date(at), new Date(), (id) => scheduling.check(id)) } };
    }),
    route('POST', '/api/tasks/:id/call-when-done', async (request, _url, params) => {
      onlyFields(await readJson(request), []);
      const scheduling = need();
      if (await isIncognitoTask(sql, idParam(params, 'id'))) return { status: 409, body: { error: 'incognito' } };
      return { status: 201, body: { call: await callWhenDone(sql, idParam(params, 'id'), (id) => scheduling.check(id)) } };
    }),
    route('POST', '/api/calls/:id/cancel', async (request, _url, params) => {
      onlyFields(await readJson(request), []);
      return { body: { call: await cancelCall(sql, idParam(params, 'id')) } };
    }),
    // Web Push: the public key for the page, and the browsers that asked for it.
    route('GET', '/api/push/key', () => Promise.resolve({ body: { publicKey: pushers()?.publicKey ?? null } })),
    route('POST', '/api/push/subscribe', async (request) => {
      const pusher = needPush();
      const body = await readJson(request);
      onlyFields(body, ['subscription']);
      await pusher.subscribe(parseSubscription(body.subscription));
      return { status: 201, body: { ok: true } };
    }),
    route('POST', '/api/push/unsubscribe', async (request) => {
      const pusher = needPush();
      const body = await readJson(request);
      onlyFields(body, ['endpoint']);
      if (typeof body.endpoint !== 'string') throw new HttpError(400, 'endpoint is required');
      await pusher.unsubscribe(body.endpoint);
      return { body: { ok: true } };
    }),
    // From apps/voice, with the token of the call.
    route('POST', '/api/calls/:id/turn', async (request, _url, params) => {
      const body = await readJson(request);
      onlyFields(body, ['text']);
      return { lines: need().turnStream(idParam(params, 'id'), bearer(request), body.text) };
    }),
    route('POST', '/api/calls/:id/ended', async (request, _url, params) => {
      const body = await readJson(request);
      onlyFields(body, ['reason']);
      const reason = END_REASONS_FROM_VOICE.find((item) => item === body.reason);
      if (reason === undefined) throw new HttpError(400, `reason must be one of ${END_REASONS_FROM_VOICE.join(', ')}`);
      const token = bearer(request);
      if (token === undefined) throw new CallError('unauthorized', 'the token of the call is required');
      return { body: { call: await need().end(idParam(params, 'id'), reason, token) } };
    }),
  ];
}

/** A JSON answer of apps/voice, or the closed code of its error. */
function voiceJson(answer: { status: number; body: Buffer }): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer.body.toString('utf8'));
  } catch {
    throw new HttpError(502, 'voice: invalid answer');
  }
  if (answer.status !== 200) {
    const code = typeof parsed === 'object' && parsed !== null && 'error' in parsed && typeof parsed.error === 'string' ? parsed.error : 'error';
    throw new HttpError(502, `voice: ${code.slice(0, 200)}`);
  }
  return parsed;
}

function voiceRoutes(voice: VoiceApi | undefined): Route[] {
  const need = (): VoiceApi => {
    if (!voiceOn(voice)) throw new HttpError(503, 'voice off: add [voice] to arianna.toml');
    return voice;
  };
  return [
    // The trial page (D-066): service state, candidates on disk, voices.
    route('GET', '/api/voice/trial', () => {
      const state: VoiceState = voice === undefined ? 'off' : voice.service.state;
      return Promise.resolve({ body: { state, voice: voiceOn(voice) ? voice.voice() : null, models: voiceOn(voice) ? voice.models() : [] } });
    }),
    // Voices copied from a sample (D-069): L2 on disk, never in a log or an event.
    route('GET', '/api/voice/clones', () => Promise.resolve({ body: { clones: listClones(need().clones) } })),
    route('POST', '/api/voice/clones', async (request) => {
      const { clones } = need();
      return { status: 201, body: { clone: saveClone(clones, parseClone(await readJson(request, MAX_CLONE_BODY))) } };
    }),
    route('DELETE', '/api/voice/clones/:id', async (request, _url, params) => {
      onlyFields(await readJson(request), []);
      if (!deleteClone(need().clones, params.id ?? '')) throw new HttpError(404, 'not found');
      return { body: { ok: true } };
    }),
    route('POST', '/api/voice/trial/transcribe', async (request) => {
      const { service, models } = need();
      const call = transcribeCall(await readJson(request, MAX_TRANSCRIBE_BODY), models());
      // Loading two models the first time takes a while.
      return { body: voiceJson(await service.request('POST', '/trial/transcribe', { json: call, timeoutMs: 300_000 })) };
    }),
    route('POST', '/api/voice/trial/speak', async (request) => {
      const { service, models } = need();
      const call = speakCall(await readJson(request), models());
      const answer = await service.request('POST', '/trial/speak', { json: call, timeoutMs: 300_000, maxBytes: 32 * 1024 * 1024 });
      if (answer.status !== 200) voiceJson(answer);
      if (answer.body.subarray(0, 4).toString('latin1') !== 'RIFF') throw new HttpError(502, 'voice: invalid answer');
      // Seconds spent and to the first audio (D-068): numbers only, rewritten by the core.
      const headers: Record<string, string> = {};
      for (const name of ['x-seconds-spent', 'x-first-audio']) {
        const value = Number(answer.headers[name]);
        if (answer.headers[name] !== undefined && Number.isFinite(value)) headers[name] = value.toFixed(3);
      }
      return { raw: answer.body, type: 'audio/wav', noStore: true, ...(Object.keys(headers).length > 0 ? { headers } : {}) };
    }),
  ];
}

function settingsRoutes(settings: SettingsPage | undefined, local: LocalApi | undefined, onError: (error: unknown) => void): Route[] {
  const need = (): SettingsPage => {
    if (settings === undefined) throw new HttpError(404, 'not found');
    return settings;
  };
  const server = (params: Params): { local: LocalApi; found: LocalServerStatus } => {
    const found = local?.status().find((entry) => entry.id === params.id);
    if (local === undefined || found === undefined) throw new HttpError(404, 'not found');
    return { local, found };
  };
  return [
    // Values, catalog, fingerprint, what applies now and what waits for a restart, local servers.
    // With `memory`: the account of the local models and the swap level (D-107, stage E), L0.
    route('GET', '/api/settings', () => {
      const memory = local?.memory?.();
      return Promise.resolve({ body: { ...need().read(), local: local?.status() ?? [], ...(memory === undefined ? {} : { memory }) } });
    }),
    // Models, cloud models, characters, [voice]: written at once.
    route('POST', '/api/settings', async (request) => ({ body: need().update(await readJson(request)) })),
    // Cloud executors, Telegram, projects, local servers: shown first, written only on confirmation.
    route('POST', '/api/settings/privacy/prepare', async (request) => ({ body: need().prepare(await readJson(request)) })),
    route('POST', '/api/settings/privacy/confirm', async (request) => ({ body: need().confirm(await readJson(request)) })),
    // "Riavvia oMLX": only a server the core starts; answered before the model has loaded.
    route('POST', '/api/local/:id/restart', async (request, _url, params) => {
      onlyFields(await readJson(request), []);
      const { local: servers, found } = server(params);
      if (!found.managed) throw new HttpError(409, 'this server has no command in arianna.toml: the core only watches it');
      // Started outside the core: stopping it is not the core's to do.
      if (found.adopted) throw new HttpError(409, 'this server was already running when the core started: restart it where it was started');
      servers.restart(found.id).catch(onError);
      return { status: 202, body: { ok: true } };
    }),
    // The id is one the core watches, never a path.
    route('GET', '/api/local/:id/log', (_request, _url, params) => {
      const { local: servers, found } = server(params);
      return Promise.resolve({ body: { log: servers.log(found.id) } });
    }),
  ];
}

/**
 * "/nota" of the web chat (D-080): a new note in kb/inbox, L2, without a
 * model. The answer names the path and the label, never the text.
 */
const CAPTURE_BODY_BYTES = 2 * MAX_CAPTURE_BYTES + 4096;

function captureRoutes(sql: Sql, capture: ApiServerOptions['capture'], onError: (error: unknown) => void): Route[] {
  return [
    route('POST', '/api/capture', async (request) => {
      if (capture === undefined) throw new HttpError(404, 'not found');
      let body: Record<string, unknown>;
      try {
        // Room for a text at the limit, JSON-escaped, and the other fields.
        body = await readJson(request, CAPTURE_BODY_BYTES);
      } catch (error) {
        if (error instanceof HttpError && error.status === 413) throw new HttpError(413, `text is longer than ${String(MAX_CAPTURE_BYTES / 1024)} KiB`);
        throw error;
      }
      onlyFields(body, ['text', 'kind', 'url', 'title', 'from', 'messageId', 'conversationId']);
      const { kind, url, title, from, messageId, conversationId } = body;
      // "/nota" from an incognito conversation (D-136): nothing it says is kept.
      if (conversationId !== undefined && (typeof conversationId !== 'string' || !isUuid(conversationId))) throw new HttpError(400, 'conversationId must be a conversation id');
      if (conversationId !== undefined && (await isIncognitoConversation(sql, conversationId))) return { status: 409, body: { error: 'incognito' } };
      // Nor from a conversation of the Finances (I-18, D-183): nothing of it goes to kb/.
      if (conversationId !== undefined && (await isFinanceConversation(sql, conversationId))) return { status: 409, body: { error: 'finance' } };
      // A message of the chat saved once (D-089): its label and, without `text`, its text come from the database.
      if (messageId !== undefined && (typeof messageId !== 'string' || !/^[1-9]\d{0,18}$/.test(messageId))) {
        throw new HttpError(400, 'messageId must be a message id');
      }
      const message = messageId === undefined ? undefined : await loadMessage(sql, messageId);
      if (messageId !== undefined && message === undefined) throw new HttpError(404, 'message not found');
      if (message !== undefined && (await isIncognitoConversation(sql, message.conversationId))) return { status: 409, body: { error: 'incognito' } };
      if (message !== undefined && (await isFinanceConversation(sql, message.conversationId))) return { status: 409, body: { error: 'finance' } };
      const text = body.text ?? message?.body;
      if (typeof text !== 'string') throw new HttpError(400, 'text is required');
      const chosen = kind ?? 'note';
      if (!isCaptureKind(chosen)) throw new HttpError(400, 'kind must be thought, link or note');
      if (url !== undefined && typeof url !== 'string') throw new HttpError(400, 'url must be a string');
      if (title !== undefined && typeof title !== 'string') throw new HttpError(400, 'title must be a string');
      // The label of the message saved (D-084): it can only raise the note, and above L2 nothing is written.
      if (from !== undefined && !isLabel(from)) throw new HttpError(400, 'from must be a label');
      const raised = message === undefined ? from : maxLabel(message.label, from ?? message.label);
      const input = {
        home: capture.home,
        rules: capture.rules,
        text,
        kind: chosen,
        ...(url === undefined ? {} : { url }),
        ...(title === undefined ? {} : { title }),
        ...(raised === undefined ? {} : { from: raised }),
      };
      let note;
      try {
        note = message === undefined ? captureNote({ ...input, source: { channel: 'hud', id: randomUUID() } }) : captureMessage({ ...input, messageId: message.id });
      } catch (error) {
        // `note`: the file name of the note already saved, or null when it is above L2.
        if (error instanceof AlreadySavedError) return { status: 409, body: { error: error.message, note: error.note } };
        throw error;
      }
      // Organized in the background (D-086): the note is already saved, a failed queue leaves it new.
      let organizing = false;
      if (capture.organize !== undefined) {
        try {
          await capture.organize(note.path);
          organizing = true;
        } catch (error) {
          onError(error);
        }
      }
      return { status: 201, body: { path: note.path, label: note.label, organizing } };
    }),
    // The messages of a conversation already saved in kb/inbox (D-089): the chat shows "Salvato" after a reload,
    // and "Apri nella Conoscenza" with the file names of the notes up to L2 (`notes`, id → name).
    route('GET', '/api/conversations/:id/saved', async (_request, _url, params) => {
      const id = idParam(params, 'id');
      if (capture === undefined) throw new HttpError(404, 'not found');
      const loaded = await loadConversation(sql, id);
      if (loaded === undefined) throw new HttpError(404, 'not found');
      // Nothing of an incognito conversation is ever saved (D-136): read as one without saves.
      if (loaded.incognito) return { body: { messageIds: [], notes: {}, conversation: false, conversationNote: null, conversationSavedAt: null } };
      // Nor of a conversation of the Finances (I-18, D-183).
      if (loaded.finance) return { status: 409, body: { error: 'finance' } };
      const saved = savedMessageNotes(capture.home, capture.rules);
      // The whole conversation saved (I-7, D-131): "Salva in inbox" of the header becomes "Aggiorna"; its path and time only up to L2.
      const whole = findConversationNote(capture.home, capture.rules, id);
      const conversation = whole !== undefined;
      const conversationNote = whole?.visible === true ? whole.path : null;
      const conversationSavedAt = whole?.visible === true ? whole.savedAt : null;
      if (saved.size === 0) return { body: { messageIds: [], notes: {}, conversation, conversationNote, conversationSavedAt } };
      const rows = await sql<{ id: string }[]>`
        SELECT id::text FROM messages WHERE conversation_id = ${id} AND id = ANY (${[...saved.keys()]}::bigint[]) ORDER BY id`;
      const notes: Record<string, string> = {};
      for (const row of rows) {
        const name = saved.get(row.id);
        if (typeof name === 'string') notes[row.id] = name;
      }
      return { body: { messageIds: rows.map((row) => row.id), notes, conversation, conversationNote, conversationSavedAt } };
    }),
    // I-7 (D-131): the whole conversation in one note of kb/inbox, without the lines of the system; a second save replaces it.
    route('POST', '/api/conversations/:id/save', async (request, _url, params) => {
      const id = idParam(params, 'id');
      onlyFields(await readJson(request), []);
      if (capture === undefined) throw new HttpError(404, 'not found');
      const conversation = await loadConversation(sql, id);
      if (conversation === undefined) throw new HttpError(404, 'not found');
      if (conversation.incognito) return { status: 409, body: { error: 'incognito' } };
      if (conversation.finance) return { status: 409, body: { error: 'finance' } };
      const lines = await sql<SavedLine[]>`
        SELECT role, agent, label, body FROM messages WHERE conversation_id = ${id} AND role <> 'system' ORDER BY id`;
      const note = saveConversation({ home: capture.home, rules: capture.rules, conversationId: id, title: conversation.title, lines, floor: conversation.effectiveLabel });
      let organizing = false;
      if (capture.organize !== undefined) {
        try {
          await capture.organize(note.path);
          organizing = true;
        } catch (error) {
          onError(error);
        }
      }
      return { status: 201, body: { path: note.path, label: note.label, replaced: note.replaced, organizing } };
    }),
    ...noteRoutes(sql, capture, onError),
    ...knowledgeRoutes(sql, capture, onError),
    ...wikiRoutes(sql, capture, onError),
  ];
}

/**
 * "Cerca" (D-089): conversation titles, message texts, notes and pages of
 * kb/, up to L2, grouped by kind. The query never goes to a log: errors name
 * fixed reasons only.
 */
function searchRoutes(sql: Sql, capture: ApiServerOptions['capture']): Route[] {
  return [
    route('GET', '/api/search', async (_request, url) => {
      const raw = url.searchParams.get('limit');
      const limit = raw === null ? DEFAULT_SEARCH_LIMIT : Number(raw);
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT) throw new HttpError(400, `limit must be 1-${String(MAX_SEARCH_LIMIT)}`);
      const kb = capture === undefined ? {} : { kb: { home: capture.home, rules: capture.rules } };
      return { body: await searchAll(sql, url.searchParams.get('q') ?? '', { limit, ...kb }) };
    }),
  ];
}

/**
 * The graph of kb/ for the "Conoscenza" page (D-087): nodes and edges up to
 * L2, header fields only; the text of one page at a time, 404 for anything
 * outside kb/, hidden or above L2.
 */
function knowledgeRoutes(sql: Sql, capture: ApiServerOptions['capture'], onError: (error: unknown) => void): Route[] {
  const cache: GraphCache = new Map();
  let arianna: AriannaDocs | undefined;
  const need = (): NonNullable<ApiServerOptions['capture']> => {
    if (capture === undefined) throw new HttpError(404, 'not found');
    return capture;
  };
  /** `?source=arianna`: Arianna's own documents (D-155), read-only, a source apart from kb/. */
  const ariannaSource = (url: URL): boolean => {
    const source = url.searchParams.get('source');
    if (source === null || source === 'kb') return false;
    if (source === 'arianna') return true;
    throw new HttpError(400, 'unknown source');
  };
  // The instance of main.ts (one cache in the core); without it, one of these routes.
  const ariannaDocs = (): AriannaDocs => {
    const { home, rules, arianna: given } = need();
    arianna ??= given ?? createAriannaDocs({ home, rules });
    return arianna;
  };
  return [
    route('GET', '/api/knowledge/graph', (_request, url) => {
      if (ariannaSource(url)) return Promise.resolve({ body: buildAriannaGraph(ariannaDocs()) });
      const { home, rules } = need();
      return Promise.resolve({ body: buildKnowledgeGraph(home, rules, cache) });
    }),
    route('GET', '/api/knowledge/page', (_request, url) => {
      const path = url.searchParams.get('path') ?? '';
      if (ariannaSource(url)) return Promise.resolve({ body: { page: readAriannaPage(ariannaDocs(), path) } });
      const { home, rules } = need();
      return Promise.resolve({ body: { page: readKnowledgePage(home, rules, path) } });
    }),
    // "Elimina" of a page (D-157): the file goes for good; the user confirmed it in the page. Only up to L2, as the reading.
    route('POST', '/api/knowledge/page/delete', async (request) => {
      const { home, rules } = need();
      const body = await readJson(request);
      onlyFields(body, ['path']);
      if (typeof body.path !== 'string') throw new HttpError(400, 'path is required');
      const deleted = deleteKbPage(home, rules, body.path);
      await recordNoteDeleted(sql, deleted.where, deleted.path).catch(onError);
      return { body: { deleted: true } };
    }),
  ];
}

/**
 * The Wiki (D-280): the tree, a page or an index to read, the proposals with
 * their diff, approving (a new page where the user says), discarding, asking
 * again, moving a folder (a proposal in turn) and restoring an old version.
 * Everything up to L2, nothing leaves the Mac; events with counts only.
 */
function wikiRoutes(sql: Sql, capture: ApiServerOptions['capture'], onError: (error: unknown) => void): Route[] {
  // The writing sessions of the pages (D-284), in memory: one version in .storia per session.
  const writeSessions = new WikiWriteSessions();
  const need = (): NonNullable<ApiServerOptions['capture']> => {
    if (capture === undefined) throw new HttpError(404, 'not found');
    return capture;
  };
  const proposer = (): NonNullable<NonNullable<ApiServerOptions['capture']>['wiki']> => {
    const { wiki } = need();
    if (wiki === undefined) throw new HttpError(503, 'the wiki cannot be proposed now');
    return wiki;
  };
  return [
    route('GET', '/api/wiki', () => {
      const { home, rules } = need();
      return Promise.resolve({ body: { ...visibleWikiTree(home, rules), proposals: countWikiProposals(home, rules) } });
    }),
    route('GET', '/api/wiki/page', (_request, url) => {
      const { home, rules } = need();
      return Promise.resolve({ body: { page: readWikiView(home, rules, url.searchParams.get('path') ?? '') } });
    }),
    route('GET', '/api/wiki/proposals', () => {
      const { home, rules } = need();
      return Promise.resolve({ body: { proposals: listWikiProposals(home, rules) } });
    }),
    route('POST', '/api/wiki/proposals/:id/approve', async (request, _url, params) => {
      const { home, rules } = need();
      const body = await readJson(request);
      onlyFields(body, ['path']);
      if (body.path !== undefined && typeof body.path !== 'string') throw new HttpError(400, 'path must be a string');
      const approved = approveWikiProposal(home, rules, params.id ?? '', body.path === undefined ? {} : { path: body.path });
      await recordWikiEvent(sql, 'wiki.approved', { action: approved.kind, corrected: approved.corrected, points: approved.points, relinked: approved.relinked }).catch(onError);
      // The «In breve» of the folders touched, by the local model, in the background.
      const wiki = need().wiki;
      if (wiki !== undefined) for (const folder of approved.folders) await wiki.index(folder).catch(onError);
      return { body: { path: approved.path, kind: approved.kind } };
    }),
    route('POST', '/api/wiki/proposals/:id/discard', async (request, _url, params) => {
      const { home } = need();
      onlyFields(await readJson(request), []);
      const kind = discardWikiProposal(home, params.id ?? '');
      await recordWikiEvent(sql, 'wiki.discarded', { action: kind }).catch(onError);
      return { body: { discarded: true } };
    }),
    // «Proponi di nuovo»: the note of the proposal goes back to the local model; the new proposal replaces this one.
    route('POST', '/api/wiki/proposals/:id/again', async (request, _url, params) => {
      const { home, rules } = need();
      onlyFields(await readJson(request), []);
      const page = proposalSource(home, rules, params.id ?? '');
      await proposer().propose(page, true);
      return { status: 202, body: { proposing: true } };
    }),
    // «Proponi per la Wiki» of a note (Pensieri, Conoscenza): any page of kb/ up to L2 outside the wiki.
    route('POST', '/api/wiki/propose', async (request) => {
      const { home, rules } = need();
      const body = await readJson(request);
      onlyFields(body, ['page']);
      if (typeof body.page !== 'string' || !isWikiSource(body.page)) throw new HttpError(400, 'page must be a note of kb/ outside the wiki');
      // Up to L2 and existing, or the same 404.
      readKnowledgePage(home, rules, body.page);
      await proposer().propose(body.page, true);
      return { status: 202, body: { proposing: true } };
    }),
    // «Sposta o rinomina» a folder: a proposal the user approves in «Proposte».
    route('POST', '/api/wiki/move', async (request) => {
      const { home, rules } = need();
      const body = await readJson(request);
      onlyFields(body, ['from', 'to']);
      if (typeof body.from !== 'string' || typeof body.to !== 'string') throw new HttpError(400, 'from and to are required');
      const proposal = proposeMove(home, rules, body.from, body.to);
      await recordWikiEvent(sql, 'wiki.move_proposed', { pages: proposal.citations }).catch(onError);
      return { status: 201, body: { id: proposal.id } };
    }),
    // The user writes the wiki too (D-280), at once, no proposal: each change keeps the version before.
    route('POST', '/api/wiki/edit', async (request) => {
      const { home, rules } = need();
      const body = await readJson(request);
      onlyFields(body, ['path', 'base', 'title', 'body', 'session']);
      if (typeof body.path !== 'string' || typeof body.base !== 'string' || typeof body.title !== 'string' || typeof body.body !== 'string') throw new HttpError(400, 'path, base, title and body are required');
      if (body.session !== undefined && typeof body.session !== 'string') throw new HttpError(400, 'session must be a string');
      // The chat saves by itself while the user writes (D-284): one version in .storia per writing session.
      const edited = editWikiPage(home, rules, body.path, body.base, body.title, body.body, new Date(), body.session === undefined ? undefined : { sessions: writeSessions, token: body.session });
      await recordWikiEvent(sql, 'wiki.edited', {}).catch(onError);
      return { body: { version: edited.version } };
    }),
    route('POST', '/api/wiki/create', async (request) => {
      const { home, rules } = need();
      const body = await readJson(request);
      onlyFields(body, ['kind', 'path', 'title', 'body']);
      if (body.kind === 'folder') {
        if (typeof body.path !== 'string' || body.title !== undefined || body.body !== undefined) throw new HttpError(400, 'a folder takes a path only');
        createWikiFolder(home, rules, body.path);
        await recordWikiEvent(sql, 'wiki.created', { kind: 'folder' }).catch(onError);
        return { status: 201, body: { path: body.path } };
      }
      if (body.kind !== 'page' || typeof body.path !== 'string' || typeof body.title !== 'string') throw new HttpError(400, 'kind, path and title are required');
      if (body.body !== undefined && typeof body.body !== 'string') throw new HttpError(400, 'body must be a string');
      // «Duplica» (D-284): a new page with the text of the page duplicated, checked as any page the user writes.
      const created = createUserWikiPage(home, rules, body.path, body.title, body.body);
      await recordWikiEvent(sql, 'wiki.created', { kind: 'page' }).catch(onError);
      return { status: 201, body: created };
    }),
    route('POST', '/api/wiki/move-now', async (request) => {
      const { home, rules } = need();
      const body = await readJson(request);
      onlyFields(body, ['kind', 'from', 'to', 'base']);
      if (typeof body.from !== 'string' || typeof body.to !== 'string') throw new HttpError(400, 'from and to are required');
      let moved;
      if (body.kind === 'page') {
        if (typeof body.base !== 'string') throw new HttpError(400, 'base is required');
        moved = moveWikiPage(home, rules, body.from, body.to, body.base);
      } else if (body.kind === 'folder' && body.base === undefined) {
        moved = moveWikiFolder(home, rules, body.from, body.to);
      } else throw new HttpError(400, 'kind must be page or folder');
      await recordWikiEvent(sql, 'wiki.moved', { kind: body.kind, pages: moved.pages, relinked: moved.relinked }).catch(onError);
      return { body: { path: moved.path } };
    }),
    // What the editor suggests after «[[» (D-282): the notes and pages a citation may name, as the save checks them.
    route('GET', '/api/wiki/targets', (_request, url) => {
      const { home, rules } = need();
      const query = (url.searchParams.get('q') ?? '').slice(0, 100);
      return Promise.resolve({ body: { targets: wikiCitationTargets(home, rules, query) } });
    }),
    // «Elimina cartella»: only an empty folder, after the confirmation in the chat.
    route('POST', '/api/wiki/folder/delete', async (request) => {
      const { home, rules } = need();
      const body = await readJson(request);
      onlyFields(body, ['path']);
      if (typeof body.path !== 'string') throw new HttpError(400, 'path is required');
      deleteWikiFolder(home, rules, body.path);
      await recordWikiEvent(sql, 'wiki.folder_deleted', {}).catch(onError);
      return { body: { deleted: true } };
    }),
    // «Elimina» a page, after the confirmation in the chat: with its old versions and the proposals waiting on it.
    route('POST', '/api/wiki/delete', async (request) => {
      const { home, rules } = need();
      const body = await readJson(request);
      onlyFields(body, ['path', 'base']);
      if (typeof body.path !== 'string' || typeof body.base !== 'string') throw new HttpError(400, 'path and base are required');
      const deleted = deleteWikiPage(home, rules, body.path, body.base);
      await recordWikiEvent(sql, 'wiki.deleted', { versions: deleted.versions, proposals: deleted.proposals }).catch(onError);
      return { body: { deleted: true } };
    }),
    route('POST', '/api/wiki/restore', async (request) => {
      const { home, rules } = need();
      const body = await readJson(request);
      onlyFields(body, ['path', 'version', 'base']);
      if (typeof body.path !== 'string' || typeof body.version !== 'string' || typeof body.base !== 'string') throw new HttpError(400, 'path, version and base are required');
      restoreWikiVersion(home, rules, body.path, body.version, body.base);
      await recordWikiEvent(sql, 'wiki.restored', {}).catch(onError);
      return { body: { restored: true } };
    }),
  ];
}

/**
 * The notes of kb/inbox (D-086): listed by their header (never the body),
 * read one at a time up to L2, organized again on request.
 */
function noteRoutes(sql: Sql, capture: ApiServerOptions['capture'], onError: (error: unknown) => void): Route[] {
  const need = (): NonNullable<ApiServerOptions['capture']> => {
    if (capture === undefined) throw new HttpError(404, 'not found');
    return capture;
  };
  return [
    route('GET', '/api/notes', (_request, url) => {
      const { home, rules } = need();
      const status = url.searchParams.get('status');
      if (status !== null && !isNoteStatus(status)) throw new HttpError(400, 'status must be new or organized');
      const limit = limitParam(url);
      return Promise.resolve({ body: listNotes(home, rules, { limit, ...(status === null ? {} : { status }) }) });
    }),
    route('GET', '/api/notes/:name', (_request, _url, params) => {
      const { home, rules } = need();
      return Promise.resolve({ body: { note: readNote(home, rules, params.name ?? '') } });
    }),
    route('POST', '/api/notes/:name/organize', async (request, _url, params) => {
      const { home, rules, organize } = need();
      onlyFields(await readJson(request), []);
      const note = readNote(home, rules, params.name ?? '');
      if (note.status !== 'new') throw new HttpError(409, 'the note is already organized');
      if (organize === undefined) throw new HttpError(503, 'notes cannot be organized now');
      await organize(note.path);
      return { status: 202, body: { path: note.path, organizing: true } };
    }),
    // "Scarica e riassumi" (D-154): the link of the note downloaded once, whatever its site; only from the chat, on this machine.
    route('POST', '/api/notes/:name/fetch', async (request, _url, params) => {
      const { home, rules, fetch } = need();
      onlyFields(await readJson(request), []);
      const note = readNote(home, rules, params.name ?? '');
      if (note.url === null) throw new HttpError(409, 'the note has no link');
      if (isYoutubeVideo(note.url)) throw new HttpError(409, 'a video is summarized with «Riassumi il video»');
      if (note.fetchedAt !== null) throw new HttpError(409, 'the link is already downloaded');
      if (note.status !== 'new' && note.status !== 'organized') throw new HttpError(409, 'the note cannot be organized again');
      if (fetch === undefined) throw new HttpError(503, 'notes cannot be organized now');
      await fetch(note.path);
      return { status: 202, body: { path: note.path, organizing: true } };
    }),

    // «Riassumi il video» (D-273): only after the user approved it in the chat for this video; never by itself.
    route('POST', '/api/notes/:name/video', async (request, _url, params) => {
      const { home, rules, video } = need();
      const body = await readJson(request);
      onlyFields(body, ['approved']);
      // The confirmation card of the chat says what leaves; the request says it was approved there.
      if (body.approved !== true) throw new HttpError(400, 'approved must be true: the user approves each video');
      const note = readNote(home, rules, params.name ?? '');
      if (note.url === null || !isYoutubeVideo(note.url)) throw new HttpError(409, 'the note has no YouTube video');
      if (note.media === 'youtube') throw new HttpError(409, 'the video is already summarized');
      if (video === undefined) throw new HttpError(503, 'videos cannot be summarized now');
      const queued = await video(note.path);
      return { status: 202, body: { path: note.path, queued } };
    }),
    // The job of the video of a note: queued, at work (with its stage), failed (with its reason in Italian) or done.
    route('GET', '/api/notes/:name/video', async (_request, _url, params) => {
      const { home, rules, videoState } = need();
      const note = readNote(home, rules, params.name ?? '');
      const state = videoState === undefined ? undefined : await videoState(note.path);
      const reason = state?.reason;
      return { body: { video: state === undefined ? null : { ...state, ...(reason !== undefined && isVideoFailure(reason) ? { reasonText: VIDEO_FAILURE_TEXT[reason] } : {}) } } };
    }),

    // "Elimina" of a thought (D-157): the note of kb/inbox goes for good, with its organizing; the user confirmed it in the page.
    route('POST', '/api/notes/:name/delete', async (request, _url, params) => {
      const { home, rules } = need();
      onlyFields(await readJson(request), []);
      const deleted = deleteKbPage(home, rules, `inbox/${checkNoteName(params.name ?? '')}`);
      await recordNoteDeleted(sql, deleted.where, deleted.path).catch(onError);
      return { body: { deleted: true } };
    }),

    // The Archivist (D-195): proposals of where the organized notes go; the user approves, corrects or discards them.
    route('GET', '/api/archive', () => {
      const { home, rules } = need();
      return Promise.resolve({ body: { proposals: listProposals(home, rules), folders: archiveFolders(home, rules) } });
    }),
    route('POST', '/api/archive/approve', async (request) => {
      const { home, rules, wiki } = need();
      const body = await readJson(request);
      onlyFields(body, ['items']);
      const items = body.items;
      if (!Array.isArray(items) || items.length === 0 || items.length > MAX_APPROVE_ITEMS) throw new HttpError(400, `items must hold 1 to ${String(MAX_APPROVE_ITEMS)} notes`);
      const inputs = items.map((item: unknown): ApproveInput => {
        if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new HttpError(400, 'each item is an object');
        const fields = item as Record<string, unknown>;
        onlyFields(fields, ['name', 'version', 'folder', 'title', 'links']);
        const { name, version, folder, title, links } = fields;
        if (typeof name !== 'string' || typeof version !== 'string') throw new HttpError(400, 'name and version are required');
        if (folder !== undefined && typeof folder !== 'string') throw new HttpError(400, 'folder must be a string');
        if (title !== undefined && typeof title !== 'string') throw new HttpError(400, 'title must be a string');
        if (links !== undefined && (!Array.isArray(links) || !links.every((link) => typeof link === 'string'))) throw new HttpError(400, 'links must be a list of paths');
        return { name, version, ...(folder === undefined ? {} : { folder }), ...(title === undefined ? {} : { title }), ...(links === undefined ? {} : { links }) };
      });
      const results = [];
      for (const result of approveMany(home, rules, inputs, onError)) {
        if (!result.ok) {
          results.push(result);
          continue;
        }
        await recordArchived(sql, result.archived).catch(onError);
        // The Wiki (D-280): after every note filed, the local model proposes what it adds; a video was proposed when summarized.
        const archivedId = result.archived.path.slice(KB_DIR.length + 1);
        if (wiki !== undefined && headerFields(readPageFile(home, archivedId)?.raw ?? '').get('media') !== 'youtube') await wiki.propose(archivedId, false).catch(onError);
        results.push({ name: result.name, ok: true, path: result.archived.path, relinked: result.archived.relinked });
      }
      return { body: { results } };
    }),
    route('POST', '/api/archive/discard', async (request) => {
      const { home, rules } = need();
      const body = await readJson(request);
      onlyFields(body, ['name', 'version']);
      if (typeof body.name !== 'string' || typeof body.version !== 'string') throw new HttpError(400, 'name and version are required');
      discardArchive(home, rules, body.name, body.version);
      await recordDiscarded(sql).catch(onError);
      return { body: { discarded: true } };
    }),
    // "Proponi di nuovo": an organized note goes back to the Archivist, whatever proposal it has.
    route('POST', '/api/notes/:name/archive', async (request, _url, params) => {
      const { home, rules, archive } = need();
      onlyFields(await readJson(request), []);
      const note = readNote(home, rules, params.name ?? '');
      if (note.status !== 'organized') throw new HttpError(409, 'only an organized note can be archived');
      if (archive === undefined) throw new HttpError(503, 'notes cannot be archived now');
      await archive(note.path);
      return { status: 202, body: { path: note.path, proposing: true } };
    }),
  ];
}

/**
 * The router's advisor in Settings → Modelli (D-207): the path of the status
 * file of the user's usage bar app, the week as read now and today's
 * opinions. Only the path is written; the file itself is never served.
 */
function advisorRoutes(sql: Sql, data: string | undefined): Route[] {
  const need = (): string => {
    if (data === undefined) throw new HttpError(404, 'not found');
    return data;
  };
  return [
    route('GET', '/api/router/advisor', async () => ({ body: await advisorStatus(sql, need()) })),
    route('POST', '/api/router/advisor', async (request) => {
      const dir = need();
      const body = await readJson(request);
      onlyFields(body, ['usageFile']);
      if (typeof body.usageFile !== 'string') throw new HttpError(400, 'usageFile must be a string');
      try {
        await writeAdvisorSettings(dir, { usageFile: body.usageFile });
      } catch (error) {
        if (error instanceof TypeError) throw new HttpError(400, error.message);
        throw error;
      }
      return { body: await advisorStatus(sql, dir) };
    }),
  ];
}

/**
 * «Consumi» (D-093, idea 10): runs, delegations, exits and failures per model
 * and per kind of task over a period. Read only, metadata only (L0).
 */
function usageRoutes(sql: Sql): Route[] {
  return [
    route('GET', '/api/usage', async (_request, url) => {
      const period = parsePeriod(url.searchParams.get('period'));
      if (period === undefined) throw new HttpError(400, `period must be one of ${USAGE_PERIODS.join(', ')}`);
      return { body: await loadUsage(sql, period) };
    }),
  ];
}

/**
 * «Cosa è cambiato» (D-233, idea 11 of OpenWork): the observed changes of the
 * installation, most recent first. Only the events `installation.changed`,
 * which hold ids, versions and states (L0, project and agent names L1).
 */
function changesRoutes(sql: Sql, changes: Pick<ChangeWatcher, 'check'> | undefined): Route[] {
  return [
    route('GET', '/api/changes', async () => {
      if (changes === undefined) throw new HttpError(404, 'not found');
      // A failed picture is reported by the watcher: the page shows what is already in the log.
      await changes.check();
      return { body: await loadChanges(sql) };
    }),
  ];
}

/**
 * Trials of a catalog model (D-081): queued here, run by the core in the
 * background. Rows hold ids, outcomes, times and codes only (L0).
 */
function modelEvalRoutes(evals: ApiServerOptions['modelEvals']): Route[] {
  const need = (): NonNullable<ApiServerOptions['modelEvals']> => {
    if (evals === undefined) throw new HttpError(404, 'not found');
    return evals;
  };
  const evalId = (params: Params): string => {
    const id = params.id ?? '';
    if (!/^[1-9]\d{0,17}$/.test(id)) throw new HttpError(404, 'not found');
    return id;
  };
  return [
    route('GET', '/api/model-evals', async (_request, url) => {
      const modelId = url.searchParams.get('modelId');
      const limit = url.searchParams.get('limit') === null ? 20 : limitParam(url);
      return { body: { evals: await need().list({ ...(modelId === null ? {} : { modelId }), limit }) } };
    }),
    route('POST', '/api/model-evals', async (request) => {
      const body = await readJson(request);
      onlyFields(body, ['modelId', 'role']);
      const { modelId, role } = body;
      if (typeof modelId !== 'string' || typeof role !== 'string') throw new HttpError(400, 'modelId and role are required');
      return { status: 202, body: { id: await need().request(modelId, role) } };
    }),
    route('GET', '/api/model-evals/:id', async (_request, _url, params) => {
      const found = await need().get(evalId(params));
      if (found === undefined) throw new HttpError(404, 'not found');
      return { body: { eval: found } };
    }),
    route('POST', '/api/model-evals/:id/cancel', async (request, _url, params) => {
      onlyFields(await readJson(request), []);
      return { body: { eval: await need().cancel(evalId(params)) } };
    }),
    // «Confronto dei modelli» (D-199): every trial of a role, models gone from the catalog or the disk included.
    route('GET', '/api/model-comparison', async (_request, url) => {
      return { body: { comparison: await need().compare(url.searchParams.get('role') ?? 'orchestrator') } };
    }),
    // The fake questions with different outcomes among 2-3 trials on the same questions: ids, outcomes, closed codes.
    route('GET', '/api/model-comparison/cases', async (_request, url) => {
      const ids = (url.searchParams.get('ids') ?? '').split(',').filter((id) => id !== '');
      return { body: { cases: await need().compareCases(ids) } };
    }),
  ];
}

/**
 * «Server dei modelli (oMLX)» on the "Modelli" page (D-265): what is
 * installed and the newest release of oMLX, all L0. «Controlla ora» runs in
 * the background (202) and the page reads again while `checking`; no route
 * takes a command or an address, and none updates oMLX.
 */
function omlxReleaseRoutes(releases: OmlxReleases | undefined): Route[] {
  const need = (): OmlxReleases => {
    if (releases === undefined) throw new HttpError(404, 'not found');
    return releases;
  };
  return [
    route('GET', '/api/models/omlx-release', () => Promise.resolve({ body: need().view() })),
    route('POST', '/api/models/omlx-release/check', async (request) => {
      const found = need();
      onlyFields(await readJson(request, 1024), []);
      try {
        found.checkNow();
      } catch (error) {
        if (error instanceof OmlxBusyError) throw new HttpError(409, 'a check of oMLX is already running');
        throw error;
      }
      return { status: 202, body: { ok: true } };
    }),
    route('POST', '/api/models/omlx-release/version', async (request) => {
      const found = need();
      onlyFields(await readJson(request, 1024), []);
      return { body: await found.refreshVersion() };
    }),
  ];
}

/**
 * Hugging Face on the "Modelli" page (I-10, D-139). POST also for the search:
 * the text the user typed never sits in an address. Each request that leaves
 * passes the gateway inside `huggingface`.
 */
function huggingFaceRoutes(hub: HuggingFace | undefined): Route[] {
  const need = (): HuggingFace => {
    if (hub === undefined) throw new HttpError(404, 'not found');
    return hub;
  };
  return [
    route('POST', '/api/models/huggingface/search', async (request) => {
      const body = await readJson(request);
      onlyFields(body, ['query']);
      return { body: { results: await need().search(body.query) } };
    }),
    route('POST', '/api/models/huggingface/card', async (request) => {
      const body = await readJson(request);
      onlyFields(body, ['repo']);
      return { body: { card: await need().card(body.repo) } };
    }),
    route('POST', '/api/models/huggingface/add', async (request) => {
      const body = await readJson(request);
      onlyFields(body, ['repo', 'revision']);
      return { status: 201, body: await need().add(body.repo, body.revision) };
    }),
    route('POST', '/api/models/:id/promote', async (request, _url, params) => {
      const body = await readJson(request);
      onlyFields(body, ['roles']);
      return { body: need().promote(params.id ?? '', body.roles) };
    }),
    route('POST', '/api/models/:id/forget', async (request, _url, params) => {
      const body = await readJson(request);
      onlyFields(body, ['confirm']);
      return { body: need().forget(params.id ?? '', body.confirm) };
    }),
  ];
}

/**
 * The catalog of Open Design in Impostazioni → Agenti (D-160): its status
 * (polled while a download runs), "Scarica/Aggiorna catalogo" in the
 * background (202), "Usa questa versione" with the commit the user saw,
 * "Scarta", the list of styles and skills, the text of one style with the
 * license notice at the head. A slug is checked by the catalog; no route
 * takes a path.
 */
/**
 * The examples of the styles and the Italian descriptions of the skills (I-20,
 * D-185): made by Sonnet in the background when the user asks, read by the
 * window of style and skills of the Studio.
 */
function exampleRoutes(examples: StyleExamples | undefined, translations: SkillTranslations | undefined): Route[] {
  const needExamples = (): StyleExamples => {
    if (examples === undefined) throw new HttpError(404, 'not found');
    return examples;
  };
  const needTranslations = (): SkillTranslations => {
    if (translations === undefined) throw new HttpError(404, 'not found');
    return translations;
  };
  return [
    route('GET', '/api/design-catalog/examples', () => Promise.resolve({ body: needExamples().status() })),
    route('POST', '/api/design-catalog/examples', async (request) => {
      const body = await readJson(request);
      onlyFields(body, ['style']);
      return { status: 202, body: body.style === undefined ? needExamples().generateMissing() : needExamples().generate(body.style) };
    }),
    route('GET', '/api/design-catalog/examples/:slug/:kind', (_request, _url, params) => Promise.resolve({ body: { text: needExamples().read(params.slug, params.kind) } })),
    route('GET', '/api/skills-catalog/translations', () => Promise.resolve({ body: needTranslations().status() })),
    route('POST', '/api/skills-catalog/translations', async (request) => {
      onlyFields(await readJson(request), []);
      return { status: 202, body: needTranslations().translateMissing() };
    }),
  ];
}

/**
 * The archive of real lines of a person of the series (D-224): the numbered
 * list, «Genera altre 100» (Sonnet in the background, through the gateway,
 * from the names alone) and «togli». Text of the series (L0), served to the
 * local chat only.
 */
/** The preview of the block says where the lines go (D-224): they are drawn anew at each answer. */
function withLinesNote(block: string, lines: boolean): string {
  return lines ? `${block}\n\n(+ 5 citazioni vere pescate a ogni risposta, in fondo all'ultimo messaggio)` : block;
}

function seriesLinesRoutes(lines: SeriesLines | undefined): Route[] {
  const need = (): SeriesLines => {
    if (lines === undefined) throw new HttpError(404, 'not found');
    return lines;
  };
  const guarded = <T>(work: () => T): T => {
    try {
      return work();
    } catch (error) {
      if (error instanceof SeriesLinesError) throw new HttpError(['full', 'double', 'consent', 'unavailable'].includes(error.code) ? 409 : error.code === 'invalid' ? 400 : 404, error.message);
      throw error;
    }
  };
  return [
    route('GET', '/api/series-lines/:character', (_request, _url, params) => Promise.resolve({ body: guarded(() => need().status(params.character ?? '')) })),
    route('POST', '/api/series-lines/:character/generate', async (request, _url, params) => {
      onlyFields(await readJson(request), []);
      return { status: 202, body: guarded(() => need().generate(params.character ?? '')) };
    }),
    // «Prendi da Wikiquote» (D-224): the page of the series from it.wikiquote.org, after the user's yes (`consent`), asked once.
    route('POST', '/api/series-lines/:character/wikiquote', async (request, _url, params) => {
      const body = await readJson(request);
      onlyFields(body, ['consent']);
      return { status: 202, body: guarded(() => need().importWikiquote(params.character ?? '', body.consent === true)) };
    }),
    // A line the user writes by hand (D-224): Interno like the archive, refused with personal data.
    route('POST', '/api/series-lines/:character/add', async (request, _url, params) => {
      const body = await readJson(request);
      onlyFields(body, ['text']);
      return { status: 201, body: guarded(() => need().add(params.character ?? '', typeof body.text === 'string' ? body.text : '')) };
    }),
    route('DELETE', '/api/series-lines/:character/:n', (_request, _url, params) => {
      const n = Number(params.n);
      if (!Number.isSafeInteger(n) || n < 1) throw new HttpError(400, 'bad line number');
      return Promise.resolve({ body: guarded(() => need().remove(params.character ?? '', n)) });
    }),
  ];
}

function designCatalogRoutes(catalog: DesignCatalog | undefined): Route[] {
  const need = (): DesignCatalog => {
    if (catalog === undefined) throw new HttpError(404, 'not found');
    return catalog;
  };
  const samples = createSampleCache({ list: () => need().list(), styleText: (slug) => need().styleText(slug) });
  return [
    route('GET', '/api/design-catalog', () => Promise.resolve({ body: need().status() })),
    route('POST', '/api/design-catalog/update', async (request) => {
      onlyFields(await readJson(request), []);
      return { status: 202, body: need().update() };
    }),
    route('POST', '/api/design-catalog/adopt', async (request) => {
      const body = await readJson(request);
      onlyFields(body, ['commit']);
      return { body: need().adopt(body.commit) };
    }),
    route('POST', '/api/design-catalog/discard', async (request) => {
      onlyFields(await readJson(request), []);
      return { body: need().discard() };
    }),
    route('GET', '/api/design-catalog/styles', () => Promise.resolve({ body: need().list() })),
    route('GET', '/api/design-catalog/styles/:slug', (_request, _url, params) => Promise.resolve({ body: { style: need().styleText(params.slug ?? '') } })),
    // The small page of each style in the window of the Studio (I-20, D-185): colors, fonts and corners read from its DESIGN.md.
    route('GET', '/api/design-catalog/samples', () => Promise.resolve({ body: samples() })),
  ];
}

/**
 * The catalog of skills in Impostazioni → Agenti (D-161): the sources with
 * their status (polled while a download runs), add and remove a GitHub
 * repository, "Scarica/Aggiorna" in the background (202), "Usa questa
 * versione" with the commit the user saw, "Scarta", the list of skills and
 * the text of one with its notice. A source is `owner/repo`, a skill
 * `owner/repo/slug` in the query: the catalog checks both, no route takes a path.
 */
/** The page of GOD (D-127): status of the project and the clone, the conversations, "Aggiorna il clone". */
function godRoutes(god: GodApi | undefined): Route[] {
  const need = (): GodApi => {
    if (god === undefined) throw new HttpError(404, 'not found');
    return god;
  };
  return [
    route('GET', '/api/god', async () => ({ body: await need().status() })),
    route('POST', '/api/god/clone', async (request) => {
      onlyFields(await readJson(request), []);
      return { body: await need().syncClone() };
    }),
    // G2-G3: the plans approved, the plan under an answer of GOD, "Approva e avvia", the actions of a subtask.
    route('GET', '/api/god/plans', async () => ({ body: { plans: await needWork().plans() } })),
    route('GET', '/api/god/messages/:id/plan', async (_request, _url, params) => ({ body: await needWork().messagePlan(params.id ?? '') })),
    route('POST', '/api/god/plans', async (request) => {
      const body = await readJson(request);
      onlyFields(body, ['messageId']);
      if (typeof body.messageId !== 'string') throw new HttpError(400, 'messageId must be a string');
      return { status: 201, body: { plan: await needWork().approve(body.messageId) } };
    }),
    // G4: "Riassumi e riparti", and the summary a conversation restarts from.
    route('POST', '/api/god/conversations/:id/restart', async (request, _url, params) => {
      onlyFields(await readJson(request), []);
      return { status: 201, body: { conversation: await needWork().restart(idParam(params, 'id')) } };
    }),
    // I-6, D-178: "Parlane con GOD" from an entry of "Novità"; the core finds the entry again in the installation's main.
    route('POST', '/api/god/changelog', async (request) => {
      const body = await readJson(request);
      onlyFields(body, ['version', 'section', 'text']);
      return { status: 201, body: { conversation: await needWork().discuss(changelogRefOf(body)) } };
    }),
    route('GET', '/api/god/conversations/:id/carry', async (_request, _url, params) => ({ body: { carry: await needWork().carry(idParam(params, 'id')) } })),
    // D-179: «Prova», «Approva funzionalità», «Non funziona» on a subtask or a whole plan; the work goes on in the background.
    route('POST', '/api/god/:kind/:id/land/:action', async (request, _url, params) => {
      const body = await readJson(request);
      onlyFields(body, ['text']);
      const action = (['trial', 'approve', 'reject'] as const).find((item) => item === params.action);
      const kind = params.kind === 'subtasks' ? 'subtask' : params.kind === 'plans' ? 'plan' : undefined;
      const api = need();
      if (action === undefined || kind === undefined || api.land === undefined) throw new HttpError(404, 'not found');
      if (body.text !== undefined && typeof body.text !== 'string') throw new HttpError(400, 'text must be a string');
      const id = params.id ?? '';
      const target = kind === 'plan' ? { plan: id } : { subtask: id };
      return { status: 202, body: { landing: await api.land(target, action, typeof body.text === 'string' ? body.text : '') } };
    }),
    route('POST', '/api/god/subtasks/:id/:action', async (request, _url, params) => {
      onlyFields(await readJson(request), []);
      const action = (['stop', 'resume', 'discard', 'branch'] as const).find((item) => item === params.action);
      if (action === undefined) throw new HttpError(404, 'not found');
      return { body: { subtask: await needWork().act(params.id ?? '', action) } };
    }),
  ];
  function needWork(): NonNullable<GodApi['work']> {
    const work = need().work;
    if (work === undefined) throw new HttpError(404, 'not found');
    return work;
  }
}

function skillsCatalogRoutes(catalog: SkillsCatalog | undefined, reports?: SafetyReports): Route[] {
  const need = (): SkillsCatalog => {
    if (catalog === undefined) throw new HttpError(404, 'not found');
    return catalog;
  };
  const needClaude = (): NonNullable<SkillsCatalog['claude']> => {
    const claude = need().claude;
    if (claude === undefined) throw new HttpError(404, 'not found');
    return claude;
  };
  return [
    route('GET', '/api/skills-catalog', () => Promise.resolve({ body: need().status() })),
    route('POST', '/api/skills-catalog/sources', async (request) => {
      const body = await readJson(request);
      onlyFields(body, ['url']);
      return { status: 201, body: need().add(body.url) };
    }),
    route('POST', '/api/skills-catalog/remove', async (request) => {
      const body = await readJson(request);
      onlyFields(body, ['source']);
      return { body: need().remove(body.source) };
    }),
    route('POST', '/api/skills-catalog/update', async (request) => {
      const body = await readJson(request);
      onlyFields(body, ['source']);
      return { status: 202, body: need().update(body.source) };
    }),
    route('POST', '/api/skills-catalog/adopt', async (request) => {
      const body = await readJson(request);
      onlyFields(body, ['source', 'commit']);
      return { body: need().adopt(body.source, body.commit) };
    }),
    route('POST', '/api/skills-catalog/discard', async (request) => {
      const body = await readJson(request);
      onlyFields(body, ['source']);
      return { body: need().discard(body.source) };
    }),
    route('GET', '/api/skills-catalog/skills', () => Promise.resolve({ body: need().list() })),
    // The user's own skills of Claude Code (D-255): read again from their folder only on «Importa»/«Aggiorna»,
    // «Togli» deletes the copy; each one private (L2) until marked shareable (L1).
    route('GET', '/api/skills-catalog/claude', () => Promise.resolve({ body: needClaude().status() })),
    route('POST', '/api/skills-catalog/claude/import', async (request) => {
      onlyFields(await readJson(request), []);
      return { body: needClaude().import() };
    }),
    route('POST', '/api/skills-catalog/claude/remove', async (request) => {
      onlyFields(await readJson(request), []);
      return { body: needClaude().remove() };
    }),
    route('POST', '/api/skills-catalog/claude/share', async (request) => {
      const body = await readJson(request);
      onlyFields(body, ['skill', 'shared', 'sha256']);
      return { body: needClaude().share(body.skill, body.shared, body.sha256) };
    }),
    // D-196: the safety report of this version of the skill travels with its text; a GET never starts a reading.
    route('GET', '/api/skills-catalog/skill', (_request, url) => {
      const skill = need().text(url.searchParams.get('id') ?? '');
      // A report is for third-party text: never one for the user's own skills (D-255).
      const safety = isPublicSkill(skill) ? reports?.textView(skillSafetyText(skill)) : undefined;
      return Promise.resolve({ body: { skill: safety === undefined ? skill : { ...skill, safety } } });
    }),
    // Opening a skill makes its report, once per version (a POST: a page elsewhere cannot spend the quota); `redo` is «Rifai il rapporto».
    route('POST', '/api/skills-catalog/skill/safety', async (request) => {
      const body = await readJson(request);
      onlyFields(body, ['id', 'redo']);
      if (reports === undefined) throw new HttpError(404, 'not found');
      const skill = need().text(body.id);
      if (!isPublicSkill(skill)) throw new HttpError(409, 'no safety report for your own skills: they never go to Opus');
      const text = skillSafetyText(skill);
      return { body: { safety: body.redo === true ? reports.redoText(text) : reports.ensureText(text) } };
    }),
  ];
}

/**
 * The catalog of agents (D-079): the same steps as the skills, and the roles
 * of the versions in use. A role's text is third-party data (L0), shown to
 * the user as it is, its hidden characters out; nothing here makes a card.
 */
function agentsCatalogRoutes(catalog: AgentsCatalog | undefined, reports?: SafetyReports, translations?: SkillTranslations): Route[] {
  const need = (): AgentsCatalog => {
    if (catalog === undefined) throw new HttpError(404, 'not found');
    return catalog;
  };
  return [
    route('GET', '/api/agents-catalog', () => Promise.resolve({ body: need().status() })),
    route('POST', '/api/agents-catalog/sources', async (request) => {
      const body = await readJson(request);
      onlyFields(body, ['url']);
      return { status: 201, body: need().add(body.url) };
    }),
    route('POST', '/api/agents-catalog/remove', async (request) => {
      const body = await readJson(request);
      onlyFields(body, ['source']);
      return { body: need().remove(body.source) };
    }),
    route('POST', '/api/agents-catalog/update', async (request) => {
      const body = await readJson(request);
      onlyFields(body, ['source']);
      return { status: 202, body: need().update(body.source) };
    }),
    route('POST', '/api/agents-catalog/adopt', async (request) => {
      const body = await readJson(request);
      onlyFields(body, ['source', 'commit']);
      return { body: need().adopt(body.source, body.commit) };
    }),
    route('POST', '/api/agents-catalog/discard', async (request) => {
      const body = await readJson(request);
      onlyFields(body, ['source']);
      return { body: need().discard(body.source) };
    }),
    route('GET', '/api/agents-catalog/agents', () => Promise.resolve({ body: need().list() })),
    // D-196: opening a role (here or in «Nuovo agente → Dal catalogo») makes its safety report, once per version;
    // a POST, so that a page elsewhere cannot spend the quota; `redo` is «Rifai il rapporto».
    route('POST', '/api/agents-catalog/agent/safety', async (request) => {
      const body = await readJson(request);
      onlyFields(body, ['id', 'redo']);
      if (reports === undefined) throw new HttpError(404, 'not found');
      const text = roleSafetyText(need().role(body.id));
      return { body: { safety: body.redo === true ? reports.redoText(text) : reports.ensureText(text) } };
    }),
    // The Italian descriptions of the roles (request of the user of 2026-10-13), as for the skills (D-185): asked when a list of roles is read.
    route('GET', '/api/agents-catalog/translations', () => {
      if (translations === undefined) throw new HttpError(404, 'not found');
      return Promise.resolve({ body: translations.status() });
    }),
    route('POST', '/api/agents-catalog/translations', async (request) => {
      onlyFields(await readJson(request), []);
      if (translations === undefined) throw new HttpError(404, 'not found');
      return { status: 202, body: translations.translateMissing() };
    }),
    // The role with the report of its version, when there is one; a GET never starts a reading.
    route('GET', '/api/agents-catalog/agent', (_request, url) => {
      const role = need().role(url.searchParams.get('id') ?? '');
      const { id, source, entry, origin } = role;
      const safety = reports?.textView(roleSafetyText(role));
      return Promise.resolve({
        body: {
          agent: {
            id,
            source,
            page: origin.repository,
            commit: origin.commit,
            path: entry.path,
            sha256: entry.sha256,
            division: entry.division,
            name: entry.name,
            description: entry.description,
            emoji: entry.emoji ?? null,
            license: origin.license.name,
            licenseFile: origin.license.file,
            text: cleanBody(entry.body),
            ...(safety === undefined ? {} : { safety }),
          },
        },
      });
    }),
  ];
}

/**
 * The actions of the "Modelli" page on a local model (I-3, stage M4): a
 * download or a verification starts in the background (202) and its progress
 * comes with GET /api/models/overview; a removal needs the id typed by the
 * user, emptying the bin needs `confirm: true`. Catalog ids only: no route
 * takes a path.
 */
function modelActionRoutes(actions: ModelActions | undefined): Route[] {
  const need = (): ModelActions => {
    if (actions === undefined) throw new HttpError(404, 'not found');
    return actions;
  };
  return [
    route('POST', '/api/models/trash/empty', async (request) => {
      const body = await readJson(request);
      onlyFields(body, ['confirm']);
      return { body: need().emptyTrash(body.confirm) };
    }),
    route('POST', '/api/models/:id/download', async (request, _url, params) => {
      onlyFields(await readJson(request), []);
      return { status: 202, body: { action: need().download(params.id ?? '') } };
    }),
    route('POST', '/api/models/:id/verify', async (request, _url, params) => {
      onlyFields(await readJson(request), []);
      return { status: 202, body: { action: need().verify(params.id ?? '') } };
    }),
    route('POST', '/api/models/:id/cancel', async (request, _url, params) => {
      onlyFields(await readJson(request), []);
      return { body: { action: need().cancel(params.id ?? '') } };
    }),
    route('POST', '/api/models/:id/remove', async (request, _url, params) => {
      const body = await readJson(request);
      onlyFields(body, ['confirm']);
      return { body: await need().remove(params.id ?? '', body.confirm) };
    }),
    route('POST', '/api/models/:id/unload', async (request, _url, params) => {
      onlyFields(await readJson(request), []);
      return { body: await need().unload(params.id ?? '') };
    }),
  ];
}

/**
 * "Who did what" and "Files changed" (D-082): read only, metadata only. The
 * preview reads the file again from the approved project, as it is now; no
 * route opens Finder or runs `open` (the API has no authentication before 1.13).
 */
function delegationRoutes(sql: Sql, approvedProjects: () => readonly Project[], openLinks: OpenLinks): Route[] {
  const delegationId = (params: Params): string => {
    const id = params.id ?? '';
    if (!/^[1-9]\d{0,17}$/.test(id)) throw new HttpError(404, 'not found');
    return id;
  };
  return [
    route('GET', '/api/delegations', async (_request, url) => {
      const limit = url.searchParams.get('limit') === null ? 10 : limitParam(url);
      return { body: { delegations: await listRecentDelegations(sql, limit) } };
    }),
    route('GET', '/api/conversations/:id/credits', async (_request, _url, params) => {
      const id = idParam(params, 'id');
      if ((await loadConversation(sql, id)) === undefined) throw new HttpError(404, 'not found');
      return { body: { credits: await listCredits(sql, id) } };
    }),
    route('GET', '/api/delegations/:id/files/:index', async (_request, _url, params) => {
      const id = delegationId(params);
      const index = params.index ?? '';
      if (!/^\d{1,4}$/.test(index)) throw new HttpError(404, 'not found');
      return { body: { file: await readDelegationFile(sql, approvedProjects(), id, Number(index)) } };
    }),
    // «Ha visto solo il brief» (D-107, tappa B2): the text of the request an agent received from this chat.
    route('GET', '/api/conversations/:id/delegations/:delegation/brief', async (_request, _url, params) => {
      const id = idParam(params, 'id');
      const delegation = params.delegation ?? '';
      if (!/^\d{1,19}$/.test(delegation)) throw new HttpError(404, 'not found');
      const brief = await chatBrief(sql, id, delegation);
      if (brief === undefined) throw new HttpError(404, 'not found');
      return { body: brief };
    }),
    // D-117: what the run changed in each file, from the commit its files were listed against.
    route('GET', '/api/delegations/:id/diff', async (_request, _url, params) => {
      const id = delegationId(params);
      return { body: { diff: await readDelegationDiff(sql, approvedProjects(), id) } };
    }),
    // D-117, tappa 3: "Apri" on a page or an image the run changed: a link with a random token, same origin only.
    route('POST', '/api/delegations/:id/open', async (request, _url, params) => {
      const id = delegationId(params);
      const body = await readJson(request);
      const index = body.index;
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > 9999) throw new HttpError(400, 'index must be a file of the delegation');
      return { body: await openDelegationFile(sql, approvedProjects(), openLinks, id, index) };
    }),
    // The files behind the link, sandboxed: the page and the styles, scripts and images it loads from its project.
    {
      method: 'GET',
      pattern: /^\/api\/open\/([A-Za-z0-9_-]{32})\/(.+)$/,
      keys: ['token', 'path'],
      handler: async (request, _url, params) => {
        let path: string;
        try {
          path = (params.path ?? '').split('/').map(decodeURIComponent).join('/');
        } catch {
          throw new HttpError(400, 'bad path');
        }
        const file = await readOpenFile(approvedProjects(), openLinks, params.token ?? '', path);
        return { raw: file.body, type: file.type, headers: openHeaders(request.headers.host?.toLowerCase() ?? ''), noStore: true };
      },
    },
  ];
}

const IM_OUTCOMES: readonly ImOutcome[] = ['done', 'part', 'not-done'];

/** An item named in a body as the user saw it: its line, title and part (D-167). */
function itemRefOf(body: Record<string, unknown>): ImItemRef {
  const { line, title, part } = body;
  if (typeof line !== 'number' || !Number.isInteger(line) || line < 1 || typeof title !== 'string' || (part !== null && (typeof part !== 'number' || !Number.isInteger(part)))) {
    throw new HttpError(400, 'line, title and part are required');
  }
  return { line, title, part };
}

/**
 * The IM with the rest of Arianna (D-167, P4b): the card of an item, made the
 * first time it is opened; the closings asked in the secretary conversation,
 * answered item by item from the buttons under the message.
 */
function imRoutes(sql: Sql, containers: () => readonly Project[], env: KnowledgeEnv | undefined, names: () => CardNames, onError: (error: unknown) => void): Route[] {
  const need = (): KnowledgeEnv => {
    if (env === undefined) throw new HttpError(404, 'not found');
    return env;
  };
  const projectOf = (params: Params): Project => {
    const name = params.project ?? '';
    const project = PROJECT_PARAM.test(name) ? containers().find((item) => item.name === name) : undefined;
    if (project === undefined) throw new HttpError(404, 'not found');
    return project;
  };
  const closingOf = async (params: Params): Promise<ImClosing> => {
    const id = params.id ?? '';
    const closing = /^[1-9]\d{0,17}$/.test(id) ? await loadImClosing(sql, id) : undefined;
    if (closing === undefined || !containers().some((project) => project.name === closing.project)) throw new HttpError(404, 'not found');
    return closing;
  };
  return [
    route('POST', '/api/browse/:project/im/:number/card', async (request, _url, params) => {
      const project = projectOf(params);
      const number = imNumberParam(params);
      const body = await readJson(request);
      onlyFields(body, ['line', 'title', 'part']);
      return { body: await itemCard(sql, containers(), need(), names(), project.name, number, itemRefOf(body)) };
    }),
    // The tab "IM" of "Progetti" (P4d, D-169): the calendar in the file, prices and invoices private (L2) in the database.
    route('GET', '/api/browse/:project/im-overview', async (_request, _url, params) => {
      const project = projectOf(params);
      return { body: { overview: await readImOverview(sql, containers(), need(), project.name) } };
    }),
    route('POST', '/api/browse/:project/im-calendar', async (request, _url, params) => {
      const project = projectOf(params);
      const body = await readJson(request);
      onlyFields(body, ['weekday', 'time', 'every', 'version']);
      if (typeof body.weekday !== 'number' || typeof body.time !== 'string' || typeof body.every !== 'number' || typeof body.version !== 'string') {
        throw new HttpError(400, 'weekday, time, every and version are required');
      }
      writeImCalendar(containers(), project.name, need(), { weekday: body.weekday, time: body.time, every: body.every }, body.version);
      return { body: { overview: await readImOverview(sql, containers(), need(), project.name) } };
    }),
    // The last day of the IM (D-169), `fine` in the same file; null takes it away and the IM go on.
    route('POST', '/api/browse/:project/im-end', async (request, _url, params) => {
      const project = projectOf(params);
      const body = await readJson(request);
      onlyFields(body, ['end', 'version']);
      if ((body.end !== null && typeof body.end !== 'string') || typeof body.version !== 'string') throw new HttpError(400, 'end (YYYY-MM-DD or null) and version are required');
      writeImEnd(containers(), project.name, need(), body.end, body.version);
      return { body: { overview: await readImOverview(sql, containers(), need(), project.name) } };
    }),
    route('POST', '/api/browse/:project/im-price', async (request, _url, params) => {
      const project = projectOf(params);
      const body = await readJson(request);
      onlyFields(body, ['amountCents', 'currency']);
      if ((body.amountCents !== null && typeof body.amountCents !== 'number') || typeof body.currency !== 'string' || !CURRENCY.test(body.currency)) {
        throw new HttpError(400, 'amountCents (cents or null) and currency are required');
      }
      await setImPrice(sql, project.name, body.amountCents, body.currency);
      return { body: { overview: await readImOverview(sql, containers(), need(), project.name) } };
    }),
    route('POST', '/api/browse/:project/im/:number/billing', async (request, _url, params) => {
      const project = projectOf(params);
      const number = imNumberParam(params);
      const body = await readJson(request);
      onlyFields(body, ['overrideCents', 'notBilled']);
      if ((body.overrideCents !== null && typeof body.overrideCents !== 'number') || typeof body.notBilled !== 'boolean') throw new HttpError(400, 'overrideCents (cents or null) and notBilled are required');
      // Only an IM that is there.
      if (!listIms(containers(), project.name, need()).some((im) => im.number === number)) throw new HttpError(404, 'not found');
      await setImBilling(sql, project.name, number, body.overrideCents, body.notBilled);
      return { body: { overview: await readImOverview(sql, containers(), need(), project.name) } };
    }),
    route('POST', '/api/browse/:project/invoices', async (request, _url, params) => {
      const project = projectOf(params);
      const body = await readJson(request);
      onlyFields(body, ['number', 'issuedOn', 'documentCents', 'dueOn', 'note', 'ims']);
      const ims: unknown = body.ims;
      if (typeof body.number !== 'string' || typeof body.issuedOn !== 'string' || typeof body.documentCents !== 'number' || !Array.isArray(ims) || !ims.every((im): im is number => typeof im === 'number')) {
        throw new HttpError(400, 'number, issuedOn, documentCents and ims are required');
      }
      if (body.note !== undefined && body.note !== null && typeof body.note !== 'string') throw new HttpError(400, 'note must be a string');
      if (body.dueOn !== undefined && body.dueOn !== null && typeof body.dueOn !== 'string') throw new HttpError(400, 'dueOn must be a string or null');
      const invoice = await createInvoice(sql, containers(), need(), project.name, {
        number: body.number,
        issuedOn: body.issuedOn,
        documentCents: body.documentCents,
        dueOn: typeof body.dueOn === 'string' ? body.dueOn : null,
        note: typeof body.note === 'string' ? body.note : null,
        ims,
      });
      return { status: 201, body: { invoice, overview: await readImOverview(sql, containers(), need(), project.name) } };
    }),
    route('POST', '/api/browse/:project/invoices/:id', async (request, _url, params) => {
      const project = projectOf(params);
      const id = invoiceParam(params);
      const body = await readJson(request);
      onlyFields(body, ['number', 'issuedOn', 'paidOn', 'note', 'documentCents', 'dueOn']);
      const change: InvoiceChange = {};
      if (body.number !== undefined) {
        if (typeof body.number !== 'string') throw new HttpError(400, 'number must be a string');
        change.number = body.number;
      }
      if (body.issuedOn !== undefined) {
        if (typeof body.issuedOn !== 'string') throw new HttpError(400, 'issuedOn must be a string');
        change.issuedOn = body.issuedOn;
      }
      if (body.paidOn !== undefined) {
        if (body.paidOn !== null && typeof body.paidOn !== 'string') throw new HttpError(400, 'paidOn must be a string or null');
        change.paidOn = body.paidOn;
      }
      if (body.note !== undefined) {
        if (body.note !== null && typeof body.note !== 'string') throw new HttpError(400, 'note must be a string or null');
        change.note = body.note;
      }
      if (body.documentCents !== undefined) {
        if (typeof body.documentCents !== 'number') throw new HttpError(400, 'documentCents must be a number');
        change.documentCents = body.documentCents;
      }
      if (body.dueOn !== undefined) {
        if (body.dueOn !== null && typeof body.dueOn !== 'string') throw new HttpError(400, 'dueOn must be a string or null');
        change.dueOn = body.dueOn;
      }
      await updateInvoice(sql, project.name, id, change);
      return { body: { overview: await readImOverview(sql, containers(), need(), project.name) } };
    }),
    route('POST', '/api/browse/:project/invoices/:id/cancel', async (_request, _url, params) => {
      const project = projectOf(params);
      await cancelInvoice(sql, project.name, invoiceParam(params));
      return { body: { overview: await readImOverview(sql, containers(), need(), project.name) } };
    }),
    route('POST', '/api/browse/:project/invoices/:id/remove', async (request, _url, params) => {
      const project = projectOf(params);
      const id = invoiceParam(params);
      const body = await readJson(request);
      onlyFields(body, ['im']);
      if (typeof body.im !== 'number' || !Number.isInteger(body.im)) throw new HttpError(400, 'im is required');
      await removeFromInvoice(sql, project.name, id, body.im);
      return { body: { overview: await readImOverview(sql, containers(), need(), project.name) } };
    }),
    // The dashboard of a client (I-16 C3, D-170): the money of the IM of its projects, private (L2), computed by the code.
    route('GET', '/api/clients/:id/dashboard', async (_request, _url, params) => {
      const id = idParam(params, 'id');
      try {
        return { body: { dashboard: await readClientDashboard(sql, containers(), need(), id) } };
      } catch (error) {
        if (error instanceof ClientError && error.code === 'not-found') throw new HttpError(404, 'not found');
        throw error;
      }
    }),
    route('GET', '/api/im/closings', async () => {
      const known = new Set(containers().map((project) => project.name));
      return { body: { closings: (await listImClosings(sql)).filter((closing) => known.has(closing.project)) } };
    }),
    route('GET', '/api/im/closings/:id', async (_request, _url, params) => {
      const closing = await closingOf(params);
      return { body: { closing, im: readIm(containers(), closing.project, need(), closing.im) } };
    }),
    route('POST', '/api/im/closings/:id/answer', async (request, _url, params) => {
      const closing = await closingOf(params);
      if (closing.closedAt !== null) throw new HttpError(409, 'the closing is over');
      const body = await readJson(request);
      onlyFields(body, ['line', 'title', 'part', 'outcome']);
      const outcome = IM_OUTCOMES.find((value) => value === body.outcome);
      if (outcome === undefined) throw new HttpError(400, 'outcome must be done, part or not-done');
      const ref = itemRefOf(body);
      // The last IM (D-169): an item not finished keeps its card open in the cardwall, made now when missing.
      if (outcome !== 'done' && isLastIm(containers(), closing.project, need(), closing.im)) await itemCard(sql, containers(), need(), names(), closing.project, closing.im, ref);
      const { item } = closeImItem(containers(), closing.project, need(), closing.im, ref, outcome);
      // In part, the card goes on with the next part: only a finished item moves it.
      if (outcome === 'done') await completeItemCard(sql, containers(), need(), closing.project, item.card).catch(onError);
      const closed = await finishClosing(sql, containers(), need(), closing);
      return { body: { closing: await loadImClosing(sql, closing.id), im: readIm(containers(), closing.project, need(), closing.im), closed } };
    }),
  ];
}

/** The id of an invoice in the URL (P4d). */
function invoiceParam(params: Params): string {
  const value = params.id ?? '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) throw new HttpError(404, 'not found');
  return value;
}

/** The number of an IM in the URL (D-167). */
function imNumberParam(params: Params): number {
  const value = params.number ?? '';
  if (!/^[1-9]\d{0,5}$/.test(value)) throw new HttpError(404, 'not found');
  return Number(value);
}

/** A project or a part of a container (`<project>:<part>`, D-145): one URL segment, never a path. */
const PROJECT_PARAM = /^[A-Za-z0-9_-][A-Za-z0-9._:-]{0,199}$/;

/**
 * The project of an address (`/api/browse/:project/...`), decoded: the page
 * writes a part as `progetto-test%3Aprogetto-test-admin` (encodeURIComponent),
 * and the router hands parameters over as they are in the path. Undefined for
 * a name that is not a project's, so the route answers 404.
 */
export function projectFromParam(raw: string | undefined): string | undefined {
  let name: string;
  try {
    name = decodeURIComponent(raw ?? '');
  } catch {
    return undefined;
  }
  return PROJECT_PARAM.test(name) ? name : undefined;
}

/**
 * The tab "Conoscenza" of "Progetti" (D-145, tappa P2): the management folders
 * of a container with their labels and the notes in them; "+ Conoscenza"
 * writes a new note. The labels of the folders are not written here: they are
 * a privacy setting, changed only with the two steps of the Settings
 * (`/api/settings/privacy`), never by an agent or a tool of Arianna.
 */
function projectKnowledgeRoutes(sql: Sql, containers: () => readonly Project[], env: KnowledgeEnv | undefined, onError: (error: unknown) => void): Route[] {
  const need = (): KnowledgeEnv => {
    if (env === undefined) throw new HttpError(404, 'not found');
    return env;
  };
  const containerParam = (params: Params): Project => {
    const name = params.project ?? '';
    const project = PROJECT_PARAM.test(name) ? containers().find((item) => item.name === name) : undefined;
    if (project === undefined) throw new HttpError(404, 'not found');
    return project;
  };
  return [
    route('GET', '/api/browse/:project/knowledge', (_request, _url, params) => {
      const project = containerParam(params);
      return Promise.resolve({ body: { knowledge: readProjectKnowledge(containers(), project.name, need()) } });
    }),
    route('POST', '/api/browse/:project/knowledge', async (request, _url, params) => {
      const project = containerParam(params);
      const body = await readJson(request);
      onlyFields(body, ['folder', 'title', 'label', 'text']);
      if (typeof body.folder !== 'string' || typeof body.title !== 'string' || typeof body.text !== 'string' || !isLabel(body.label)) {
        throw new HttpError(400, 'folder, title, label and text are required');
      }
      const note = writeProjectNote(containers(), project.name, need(), { folder: body.folder, title: body.title, text: body.text, label: body.label, id: randomUUID() });
      return { status: 201, body: { note } };
    }),
    // A note opened and edited by hand: the user sees every note of the tab, any label.
    route('GET', '/api/browse/:project/knowledge/note', (_request, url, params) => {
      const project = containerParam(params);
      return Promise.resolve({ body: { note: readProjectNote(containers(), project.name, need(), url.searchParams.get('path') ?? '') } });
    }),
    route('POST', '/api/browse/:project/knowledge/note', async (request, _url, params) => {
      const project = containerParam(params);
      const body = await readJson(request);
      onlyFields(body, ['path', 'title', 'label', 'header', 'text', 'version', 'lower']);
      const header = body.header;
      if (
        typeof body.path !== 'string' ||
        typeof body.title !== 'string' ||
        typeof body.text !== 'string' ||
        typeof body.version !== 'string' ||
        !isLabel(body.label) ||
        !Array.isArray(header) ||
        !header.every((line): line is string => typeof line === 'string') ||
        (body.lower !== undefined && typeof body.lower !== 'boolean')
      ) {
        throw new HttpError(400, 'path, title, label, header, text and version are required');
      }
      const note = editProjectNote(containers(), project.name, need(), body.path, { title: body.title, label: body.label, header, text: body.text, version: body.version, lower: body.lower === true });
      return { body: { note } };
    }),
    // The IM of the project (D-167): the files of the folder IM, the items changed only while the file is the one the user saw.
    route('GET', '/api/browse/:project/im', (_request, _url, params) => {
      const project = containerParam(params);
      return Promise.resolve({ body: { ims: listIms(containers(), project.name, need()) } });
    }),
    route('POST', '/api/browse/:project/im', async (request, _url, params) => {
      const project = containerParam(params);
      const body = await readJson(request);
      onlyFields(body, ['date']);
      if (body.date !== undefined && typeof body.date !== 'string') throw new HttpError(400, 'date must be a string');
      return { status: 201, body: { im: createIm(containers(), project.name, need(), body.date) } };
    }),
    route('GET', '/api/browse/:project/im/:number', (_request, _url, params) => {
      const project = containerParam(params);
      return Promise.resolve({ body: { im: readIm(containers(), project.name, need(), imNumberParam(params)) } });
    }),
    route('POST', '/api/browse/:project/im/:number/items', async (request, _url, params) => {
      const project = containerParam(params);
      const number = imNumberParam(params);
      const body = await readJson(request);
      onlyFields(body, ['title', 'version']);
      if (typeof body.title !== 'string' || typeof body.version !== 'string') throw new HttpError(400, 'title and version are required');
      return { status: 201, body: { im: addImItem(containers(), project.name, need(), number, body.title, body.version) } };
    }),
    route('POST', '/api/browse/:project/im/:number/items/:line', async (request, _url, params) => {
      const project = containerParam(params);
      const number = imNumberParam(params);
      const lineText = params.line ?? '';
      if (!/^[1-9]\d{0,6}$/.test(lineText)) throw new HttpError(404, 'not found');
      const body = await readJson(request);
      onlyFields(body, ['state', 'version']);
      const state = IM_STATES.find((value) => value === body.state);
      if (state === undefined || typeof body.version !== 'string') throw new HttpError(400, 'state and version are required');
      const im = setImItemState(containers(), project.name, need(), number, Number(lineText), state, body.version);
      // An item checked moves its card to "Fatto" (D-167, P4b).
      if (state === 'done') await completeItemCard(sql, containers(), need(), project.name, im.items.find((item) => item.line === Number(lineText))?.card ?? null).catch(onError);
      return { body: { im } };
    }),
    // "Elimina" of a note of the project (D-157): the file goes for good; the user confirmed it in the tab.
    route('POST', '/api/browse/:project/knowledge/delete', async (request, _url, params) => {
      const project = containerParam(params);
      const body = await readJson(request);
      onlyFields(body, ['path']);
      if (typeof body.path !== 'string') throw new HttpError(400, 'path is required');
      deleteProjectNote(containers(), project.name, need(), body.path);
      await recordNoteDeleted(sql, 'project', body.path).catch(onError);
      return { body: { deleted: true } };
    }),
  ];
}

/** Why a draft of the rules was not written, for the page: a closed list (D-175). */
const DRAFT_FAILURE_STATUS: Record<DraftFailure, number> = { blocked: 403, unavailable: 503, timeout: 504, truncated: 502, 'bad-response': 502, 'model-error': 502 };

/**
 * "Proponi bozza" (I-14 R2, D-175): the draft of a container's rules by the
 * local model, returned to the page and never saved; the user's "Salva" makes
 * it rules. One at a time: the local model is one.
 */
function rulesDraftRoutes(containers: () => readonly Project[], draft: ApiServerOptions['rulesDraft']): Route[] {
  let running = false;
  return [
    route('POST', '/api/projects/:project/rules-draft', async (request, _url, params) => {
      if (draft === undefined) throw new HttpError(503, 'drafts are not available');
      const name = params.project ?? '';
      if (!PROJECT_PARAM.test(name) || !containers().some((project) => project.name === name)) throw new HttpError(404, 'not found');
      onlyFields(await readJson(request), []);
      if (running) throw new HttpError(409, 'a draft is already being written');
      running = true;
      try {
        const outcome = await draft(name);
        if (outcome === undefined) throw new HttpError(404, 'not found');
        if (!outcome.ok) throw new HttpError(DRAFT_FAILURE_STATUS[outcome.reason], `draft not written: ${outcome.reason}`);
        return { body: { text: outcome.text, model: outcome.model, ...(outcome.partial === undefined ? {} : { partial: outcome.partial }) } };
      } finally {
        running = false;
      }
    }),
  ];
}

/**
 * Dashboard (D-248): the tiles pinned from the chat, their order, title and
 * width, «Aggiorna» on the local model and its «Annulla», «Togli». The page
 * reads the tiles after the refreshes that ended are settled.
 */
function dashboardRoutes(
  sql: Sql,
  env: RefreshEnv,
  suggest: ApiServerOptions['dashboardSuggest'],
  stopChat: ApiServerOptions['stopChat'],
  chart: ApiServerOptions['dashboardChart'],
  onError: (error: unknown) => void,
): Route[] {
  return [
    route('GET', '/api/dashboard/tiles', async () => {
      await settleDashboard(sql);
      return { body: { tiles: await listTiles(sql) } };
    }),
    route('POST', '/api/dashboard/suggest', async (request) => {
      const body = await readJson(request);
      onlyFields(body, ['messageId']);
      if (suggest === undefined) throw new HttpError(503, 'the local model is not available');
      return { body: await suggest(body.messageId) };
    }),
    route('POST', '/api/dashboard/tiles', async (request) => {
      const body = await readJson(request);
      onlyFields(body, ['messageId', 'title', 'question', 'width', 'kind']);
      const tile = await pinTile(sql, body as unknown as PinInput);
      // A chart: its first data from the answer pinned; without valid data the tile says so and offers «Riprova».
      if (tile.kind !== 'chart' || chart === undefined) return { status: 201, body: { tile } };
      // The tile is pinned already: a chart that fails leaves it there, saying why («Riprova»).
      try {
        return { status: 201, body: { tile: await chartFromBody(sql, tile.id, chart) } };
      } catch (error) {
        onError(error);
        return { status: 201, body: { tile } };
      }
    }),
    route('POST', '/api/dashboard/order', async (request) => {
      const body = await readJson(request);
      onlyFields(body, ['ids']);
      return { body: { tiles: await orderTiles(sql, body.ids) } };
    }),
    route('PATCH', '/api/dashboard/tiles/:id', async (request, _url, params) => {
      const id = idParam(params, 'id');
      const body = await readJson(request);
      onlyFields(body, ['title', 'width', 'kind', 'question']);
      return { body: { tile: await updateTile(sql, id, body) } };
    }),
    // «Grafico» in the menu, and «Riprova» of a chart that failed on the answer it holds: the chart again from that answer.
    route('POST', '/api/dashboard/tiles/:id/chart', async (request, _url, params) => {
      const id = idParam(params, 'id');
      onlyFields(await readJson(request), []);
      if (chart === undefined) throw new HttpError(503, 'the local model is not available');
      return { body: { tile: await chartFromBody(sql, id, chart) } };
    }),
    route('POST', '/api/dashboard/tiles/:id/refresh', async (request, _url, params) => {
      const id = idParam(params, 'id');
      onlyFields(await readJson(request), []);
      return { body: { tile: await startRefresh(sql, id, env) } };
    }),
    route('POST', '/api/dashboard/tiles/:id/cancel', async (request, _url, params) => {
      const id = idParam(params, 'id');
      onlyFields(await readJson(request), []);
      if (stopChat === undefined) throw new HttpError(503, 'a refresh cannot be stopped here');
      return { body: { tile: await cancelRefresh(sql, id, stopChat) } };
    }),
    route('POST', '/api/dashboard/tiles/:id/remove', async (request, _url, params) => {
      const id = idParam(params, 'id');
      onlyFields(await readJson(request), []);
      await removeTile(sql, id);
      return { body: { removed: id } };
    }),
    route('GET', '/api/conversations/:id/pinned', async (_request, _url, params) => {
      const id = idParam(params, 'id');
      return { body: { pinned: await pinnedMessages(sql, id) } };
    }),
  ];
}

/** Why the anonymous version was not written, for the page: a closed list (D-187). */
const PROPOSAL_FAILURE_STATUS: Record<Exclude<ProposalOutcome, { ok: true }>['reason'], number> = {
  blocked: 403,
  unavailable: 503,
  timeout: 504,
  truncated: 502,
  'bad-response': 502,
  'model-error': 502,
  'too-large': 413,
};

/**
 * "Fai uscire una volta" of a Private note (I-11 P5, D-187): the work
 * conversations of the project it may go to, the anonymous version by the
 * local model (one at a time: the local model is one; never saved), and the
 * release with the master password. The password is read from the body and
 * never logged nor kept.
 */
function noteReleaseRoutes(containers: () => readonly Project[], releaser: NoteReleaser | undefined): Route[] {
  let proposing = false;
  const container = (params: Params): { name: string; found: NoteReleaser } => {
    if (releaser === undefined) throw new HttpError(503, 'the release of a note is not available');
    const name = params.project ?? '';
    if (!PROJECT_PARAM.test(name) || !containers().some((project) => project.name === name)) throw new HttpError(404, 'not found');
    return { name, found: releaser };
  };
  return [
    route('GET', '/api/browse/:project/knowledge/release', async (_request, _url, params) => {
      const { name, found } = container(params);
      return { body: { targets: await found.targets(name) } };
    }),
    route('POST', '/api/browse/:project/knowledge/anonymize', async (request, _url, params) => {
      const { name, found } = container(params);
      const body = await readJson(request);
      onlyFields(body, ['path']);
      if (typeof body.path !== 'string') throw new HttpError(400, 'path is required');
      if (proposing) throw new HttpError(409, 'an anonymous version is already being written');
      proposing = true;
      try {
        const outcome = await found.propose(name, body.path);
        if (!outcome.ok) throw new HttpError(PROPOSAL_FAILURE_STATUS[outcome.reason], `anonymous version not written: ${outcome.reason}`);
        return { body: { text: outcome.text, model: outcome.model, version: outcome.version, warnings: outcome.warnings } };
      } finally {
        proposing = false;
      }
    }),
    route('POST', '/api/browse/:project/knowledge/release', async (request, _url, params) => {
      const { name, found } = container(params);
      const body = await readJson(request);
      onlyFields(body, ['path', 'version', 'text', 'conversationId', 'password']);
      const { path, version, text, conversationId, password } = body;
      if (typeof path !== 'string' || typeof version !== 'string' || typeof text !== 'string' || typeof conversationId !== 'string' || typeof password !== 'string') {
        throw new HttpError(400, 'path, version, text, conversationId and password are required');
      }
      return { status: 201, body: await found.release(name, { path, version, text, conversationId, password }) };
    }),
  ];
}

/**
 * "Esporta in CLAUDE.md e AGENTS.md" (I-14 R3, D-176): GET is the preview,
 * POST writes the files of the text the preview showed, and only the new ones
 * and those Arianna wrote; the user's own files are never touched.
 */
function rulesExportRoutes(containers: () => readonly Project[], exporter: ApiServerOptions['rulesExport']): Route[] {
  const container = (params: Params): string => {
    if (exporter === undefined) throw new HttpError(503, 'export is not available');
    const name = params.project ?? '';
    if (!PROJECT_PARAM.test(name) || !containers().some((project) => project.name === name)) throw new HttpError(404, 'not found');
    return name;
  };
  return [
    route('GET', '/api/projects/:project/rules-export', (_request, _url, params) => {
      const name = container(params);
      const plan = exporter?.plan(name);
      if (plan === undefined || plan === null) throw new HttpError(409, 'the project has no rules');
      return Promise.resolve({ body: plan });
    }),
    route('POST', '/api/projects/:project/rules-export', async (request, _url, params) => {
      const name = container(params);
      const body = await readJson(request);
      onlyFields(body, ['text', 'files']);
      if (typeof body.text !== 'string') throw new HttpError(400, 'text must be the rules of the preview');
      const files = Array.isArray(body.files) ? body.files : null;
      const seen = files?.map((file: unknown) => {
        if (file === null || typeof file !== 'object') return null;
        const { path, status } = file as Record<string, unknown>;
        return typeof path === 'string' && typeof status === 'string' && ['new', 'same', 'arianna', 'foreign', 'stale'].includes(status) ? { path, status: status as ExportPlan['files'][number]['status'] } : null;
      });
      if (seen === undefined || seen.length > 1000 || seen.some((file) => file === null)) throw new HttpError(400, 'files must be the files of the preview');
      const outcome = exporter?.write(name, { text: body.text, files: seen.filter((file) => file !== null) });
      if (outcome === undefined) throw new HttpError(503, 'export is not available');
      if (!outcome.ok) throw new HttpError(409, outcome.reason === 'no-rules' ? 'the project has no rules' : 'the rules or the files changed after the preview');
      return { body: { files: outcome.files } };
    }),
  ];
}

/**
 * The page "Progetti" (D-134): an approved project read on this computer.
 * Read only: folders, files, branches, changes, commits and their diff;
 * "Apri" for a page or an image with the links of D-117. Nothing is written
 * in the project, nothing goes out. Hidden entries only with the consent of
 * D-135, which the core reads for each request.
 */
function projectBrowserRoutes(sql: Sql, approvedProjects: () => readonly Project[], openLinks: OpenLinks, containers: () => readonly Project[]): Route[] {
  const fileDeps = { projects: approvedProjects, record: (event: NewEvent) => appendEvent(sql, event), sql };
  const projectParam = (params: Params): string => {
    const name = projectFromParam(params.project);
    if (name === undefined) throw new HttpError(404, 'not found');
    return name;
  };
  const pathParam = (url: URL, key: string, required: boolean): string => {
    const value = url.searchParams.get(key) ?? '';
    if (value.length > 4096 || (required && value === '')) throw new HttpError(400, `${key} must be a path of the project`);
    return value;
  };
  return [
    // The parts (D-145) and the containers they belong to.
    route('GET', '/api/browse', async () => ({ body: { projects: browsableProjects(approvedProjects(), await hiddenConsents(sql)), containers: browsableContainers(containers()) } })),
    route('POST', '/api/browse/:project/hidden', async (request, _url, params) => {
      const name = projectParam(params);
      const body = await readJson(request);
      onlyFields(body, ['on']);
      if (typeof body.on !== 'boolean') throw new HttpError(400, 'on must be true or false');
      await setHiddenShown(sql, approvedProjects(), name, body.on);
      return { body: { hidden: body.on } };
    }),
    route('GET', '/api/browse/:project/tree', async (_request, url, params) => {
      const name = projectParam(params);
      const projects = approvedProjects();
      return { body: await listProjectDir(projects, name, pathParam(url, 'dir', false), await hiddenShown(sql, projects, name)) };
    }),
    route('GET', '/api/browse/:project/file', async (_request, url, params) => {
      const name = projectParam(params);
      const projects = approvedProjects();
      return { body: { file: await readBrowsedFile(projects, name, pathParam(url, 'path', true), { showHidden: await hiddenShown(sql, projects, name) }) } };
    }),
    // "Mostra" on a covered secret (D-135): a POST, so that no other page can write its event; the trace before the text.
    route('POST', '/api/browse/:project/reveal', async (request, _url, params) => {
      const name = projectParam(params);
      const body = await readJson(request);
      onlyFields(body, ['path']);
      if (typeof body.path !== 'string' || body.path === '' || body.path.length > 4096) throw new HttpError(400, 'path must be a file of the project');
      return { body: { file: await revealBrowsedFile(sql, approvedProjects(), name, body.path) } };
    }),
    route('POST', '/api/browse/:project/open', async (request, _url, params) => {
      const name = projectParam(params);
      const body = await readJson(request);
      onlyFields(body, ['path']);
      if (typeof body.path !== 'string' || body.path === '' || body.path.length > 4096) throw new HttpError(400, 'path must be a file of the project');
      return { body: await openBrowsedFile(approvedProjects(), openLinks, name, body.path) };
    }),
    // The tab "File" moves and deletes after the window of the page (I-20, D-185): no link, hidden part or running agent.
    route('POST', '/api/browse/:project/move', async (request, _url, params) => {
      const name = projectParam(params);
      const body = await readJson(request);
      onlyFields(body, ['from', 'to']);
      return { body: await moveProjectPath(fileDeps, name, { from: body.from, to: body.to }) };
    }),
    route('POST', '/api/browse/:project/delete', async (request, _url, params) => {
      const name = projectParam(params);
      const body = await readJson(request);
      onlyFields(body, ['path']);
      return { body: await deleteProjectPath(fileDeps, name, { path: body.path }) };
    }),
    route('GET', '/api/browse/:project/git', async (_request, _url, params) => ({ body: { git: await readProjectGit(sql, approvedProjects(), projectParam(params)) } })),
    route('GET', '/api/browse/:project/commits/:commit', async (_request, _url, params) => {
      const name = projectParam(params);
      const projects = approvedProjects();
      return { body: { diff: await readCommitDiff(sql, projects, name, params.commit ?? '', await hiddenShown(sql, projects, name)) } };
    }),
  ];
}

/**
 * The tab Servizi (D-134, tappa 2): the commands the project declares, each
 * started or stopped by name after the user's confirmation in the page; the
 * log of a run, from memory. Never a command written in the request.
 */
function projectServiceRoutes(sql: Sql, approvedProjects: () => readonly Project[], services: ServiceManager | undefined): Route[] {
  const need = (): ServiceManager => {
    if (services === undefined) throw new HttpError(404, 'not found');
    return services;
  };
  const projectParam = (params: Params): string => {
    const name = projectFromParam(params.project);
    if (name === undefined) throw new HttpError(404, 'not found');
    return name;
  };
  const serviceParam = (value: unknown): string => {
    if (typeof value !== 'string' || !/^(?:package\.json|compose|Makefile):[A-Za-z0-9][\w:.-]{0,63}$/.test(value)) throw new HttpError(400, 'service must be one of the project');
    return value;
  };
  const act = (verb: 'start' | 'stop') =>
    route('POST', `/api/browse/:project/services/${verb}`, async (request, _url, params) => {
      const manager = need();
      const name = projectParam(params);
      const body = await readJson(request);
      onlyFields(body, ['service', 'fingerprint']);
      const id = serviceParam(body.service);
      // A start runs what the confirmation showed, or nothing: the fingerprint of the command and its script.
      const fingerprint = body.fingerprint;
      if (fingerprint !== undefined && (typeof fingerprint !== 'string' || !/^[0-9a-f]{16}$/.test(fingerprint))) throw new HttpError(400, 'fingerprint must be the one of the list');
      if (verb === 'start' && fingerprint === undefined) throw new HttpError(400, 'fingerprint must be the one of the list');
      const { root, list } = await serviceStates(approvedProjects(), name, manager);
      const service = pickService(list, id, fingerprint);
      // Never while the Coder works there: it may be rewriting the scripts.
      if (verb === 'start') await notBusy(sql, name);
      if (verb === 'start') manager.start(name, root, service);
      else manager.stop(name, root, service);
      return { body: { run: manager.run(name, id) ?? null } };
    });
  return [
    route('GET', '/api/browse/:project/services', async (_request, _url, params) => {
      const manager = need();
      const { list } = await serviceStates(approvedProjects(), projectParam(params), manager);
      return { body: { services: list } };
    }),
    route('GET', '/api/browse/:project/services/log', (_request, url, params) => {
      const manager = need();
      const name = projectParam(params);
      const id = serviceParam(url.searchParams.get('service'));
      return Promise.resolve({ body: { run: manager.run(name, id) ?? null } });
    }),
    act('start'),
    act('stop'),
  ];
}

function routes(sql: Sql, { changes, cards, clients, projects, models, defaultModel, agents, financeAgents, characters, voice, calls, pusher, settings, local, capture, modelEvals, advisorData, approvedProjects, projectContainers, knowledge, rulesDraft, dashboardSuggest, dashboardChart, rulesExport, noteRelease, installation, readiness, onError, directAgents, offInterlocutors, chatCharacters, chatFolderGone, trialRefusal, leaveRule, stopChat, stopCard, mentionable, planAssignees, services, incognito, erase, attachments, designCatalog, skillsCatalog, routines }: RouteOptions): Route[] {
  // The links of "Apri" (D-117, tappa 3; D-134): in memory, gone with a restart.
  const openLinks = createOpenLinks();
  // Who may take a card or an IM item: not Arianna (she hands them out), not an agent of the Finances (D-183).
  const assignable = (): string[] => {
    const finance = new Set(financeAgents());
    return agents().filter((agent) => agent !== 'arianna' && !finance.has(agent));
  };
  return [
    ...delegationRoutes(sql, approvedProjects, openLinks),
    ...projectBrowserRoutes(sql, approvedProjects, openLinks, projectContainers),
    ...rulesDraftRoutes(projectContainers, rulesDraft),
    ...dashboardRoutes(sql, { agents, financeAgents }, dashboardSuggest, stopChat, dashboardChart, onError),
    ...rulesExportRoutes(projectContainers, rulesExport),
    ...noteReleaseRoutes(projectContainers, noteRelease),
    ...projectKnowledgeRoutes(sql, projectContainers, knowledge, onError),
    ...projectServiceRoutes(sql, approvedProjects, services),
    ...secretaryRoutes(sql),
    ...routineRoutes(routines, sql),
    ...cardwallRoutes(sql, () => ({ projects: projectContainers().map((project) => project.name), agents: assignable(), catalog: cardCatalog(designCatalog, skillsCatalog) }), cards, stopCard),
    ...clientRoutes(sql, () => ({ projects: projectContainers().map((project) => project.name) }), clients),
    ...financeRoutes(sql),
    ...imRoutes(sql, projectContainers, knowledge, () => ({ projects: projectContainers().map((project) => project.name), agents: assignable() }), onError),
    ...modelEvalRoutes(modelEvals),
    ...advisorRoutes(sql, advisorData),
    ...usageRoutes(sql),
    ...changesRoutes(sql, changes),
    ...voiceRoutes(voice),
    ...captureRoutes(sql, capture, onError),
    ...searchRoutes(sql, capture),
    ...settingsRoutes(settings, local, onError),
    ...callRoutes(sql, voice, calls, pusher),
    route('GET', '/api/health', () => Promise.resolve({ body: { ok: true } })),

    // The status panel (D-060): agents, last router decision, gateway today. Counts and labels only.
    route('GET', '/api/status', async () => ({ body: await loadStatus(sql, agents()) })),

    // What this installation is (D-089): development or production, the name of its folder, the commit.
    route('GET', '/api/installation', () => {
      if (installation === undefined) throw new HttpError(404, 'not found');
      return Promise.resolve({ body: { installation: installation() } });
    }),
    // «Pronta per i dati veri» (D-192): closed ids and outcomes only, never a detail or a path.
    // GET answers the last outcome (null before the first check); POST checks again, one at a time, at most every 10 s.
    route('GET', '/api/installation/readiness', () => {
      if (readiness === undefined) throw new HttpError(404, 'not found');
      return Promise.resolve({ body: { readiness: readiness.last() } });
    }),
    route('POST', '/api/installation/readiness', async (request) => {
      if (readiness === undefined) throw new HttpError(404, 'not found');
      onlyFields(await readJson(request), []);
      return { body: { readiness: await readiness.check() } };
    }),

    // The character packs and who wears what. Refused folders are named with the reason, never their content.
    route('GET', '/api/characters', async () => {
      if (characters === undefined) return { body: { packs: [], refused: [], agents: {}, names: {} } };
      const { packs, refused } = await listPacks(characters.dirs);
      let themed: Record<string, string> = {};
      if (characters.themes !== undefined) {
        const { themes } = await listThemes(characters.themes.dir);
        const current = currentTheme(characters.themes.chosen(), themes, characters.themes.feasts?.());
        themed = themes.find((theme) => theme.id === current)?.characters ?? {};
      }
      return { body: { packs, refused, agents: assignCharacters(agents(), characters.choices(), packs, themed), names: characters.names?.() ?? {} } };
    }),
    // The people of the series (D-223): the repository's text, the user's rewrite and the exact block the model
    // reads in a work step and in a private one, for their card in the settings. Text of the repository (L0)
    // and the user's own (L1), served to the local chat only.
    route('GET', '/api/series-personas', () => {
      const own = characters?.series?.() ?? {};
      const people = Object.entries(SERIES_PERSONAS).map(([id, persona]) => {
        const override = Object.hasOwn(own, id) ? own[id] : undefined;
        // A rewrite the tail would leave out (personal data, a vault value written by hand): the card shows what the model reads.
        const refused = override !== undefined && !seriesFits(override);
        const merged = withSeriesOverride(persona, refused ? undefined : override).persona;
        // As the tail (D-224): real lines drawn apart unless the user rewrote the catchphrases.
        const drawn = (named: boolean): boolean => (refused || override?.quotes === undefined) && characters?.lines?.has(id, named) === true;
        return {
          id,
          name: persona.name,
          show: persona.show,
          repository: { traits: persona.traits, scene: persona.scene, quotes: [...persona.quotes] },
          own: override ?? null,
          refused,
          blocks: {
            work: withLinesNote(seriesPersonaBlock(merged, { withName: true, withTraits: true, lines: drawn(false) }), drawn(false)),
            private: withLinesNote(seriesPersonaBlock(merged, { withName: true, withTraits: true, play: true, lines: drawn(true) }), drawn(true)),
          },
        };
      });
      return Promise.resolve({ body: { people } });
    }),
    // The themes (D-103): only those that pass the closed schema, the refused folders with the reason,
    // the one chosen in [appearance] and the one in use (Base when the chosen one is missing or invalid,
    // the feast of the day in place of Base when the switch is on, D-246).
    route('GET', '/api/themes', async () => {
      const themes = characters?.themes;
      if (themes === undefined) return { body: { themes: [], refused: [], chosen: 'base', current: 'base', seasonal: false } };
      const listing = await listThemes(themes.dir);
      const chosen = themes.chosen();
      const feasts = themes.feasts?.();
      return { body: { ...listing, chosen, current: currentTheme(chosen, listing.themes, feasts), seasonal: feasts?.on ?? false } };
    }),
    // A sheet uploaded from the chat (D-118): decoded, written again, saved in data/characters/miei.
    // A character of the same name answers 409 with `existing`: the page asks, then sends `replace`.
    route('POST', '/api/characters/upload', async (request) => {
      if (characters === undefined) throw new HttpError(404, 'not found');
      try {
        return { status: 201, body: { character: await uploadSheet(characters.dirs, parseUpload(await readJson(request, MAX_UPLOAD_BODY))) } };
      } catch (error) {
        if (error instanceof HttpError && error.status === 413) throw new HttpError(413, 'the sheet is too large');
        if (error instanceof UploadError && error.code === 'conflict') return { status: 409, body: { error: error.message, existing: error.existing } };
        throw error;
      }
    }),
    // The characters of pixel-agents (D-206): only their PNG sheets and licence, from the public API of
    // GitHub, into data/characters/pixel-agents; for personal use only, never in git.
    route('POST', '/api/characters/pixel-agents', async () => {
      if (characters?.downloadPixelAgents === undefined) throw new HttpError(404, 'not found');
      try {
        return { body: await characters.downloadPixelAgents() };
      } catch (error) {
        if (error instanceof GithubError && error.code === 'limited') throw new HttpError(429, 'GitHub limita le richieste senza account (60 l’ora): riprova fra un’ora');
        if (error instanceof GithubError || error instanceof PixelAgentsError) throw new HttpError(502, error.message);
        throw new HttpError(502, 'the download failed');
      }
    }),
    route('GET', '/api/characters/:pack/:character', async (_request, _url, params) => {
      const png = characters === undefined ? undefined : await readSheet(characters.dirs, params.pack ?? '', params.character ?? '');
      if (png === undefined) throw new HttpError(404, 'not found');
      return { raw: png, type: 'image/png' };
    }),

    // The cloud models of this installation: what the selector of a work conversation offers.
    route('GET', '/api/models', () => Promise.resolve({ body: { models: models() } })),

    // The approved projects (D-058): what a new work conversation may choose.
    route('GET', '/api/projects', () =>
      Promise.resolve({ body: { projects: projects().map(({ name, path, label }) => ({ name, path, label })) } }),
    ),

    // The list, with ?origin=system the system chats (D-064), with ?archived=1 the archived conversations (D-057).
    route('GET', '/api/conversations', async (_request, url) => {
      const archived = url.searchParams.get('archived');
      if (archived !== null && archived !== '0' && archived !== '1') throw new HttpError(400, 'archived must be 0 or 1');
      const asked = url.searchParams.get('origin');
      const origin = asked === null ? null : (['user', 'system'] as const).find((item) => item === asked);
      if (origin === undefined) throw new HttpError(400, 'origin must be user or system');
      if (origin !== null && archived === '1') throw new HttpError(400, 'the archive is not split by origin');
      const options = { archived: archived === '1', ...(origin === null ? {} : { origin }) };
      return { body: { conversations: await listConversations(sql, limitParam(url), options) } };
    }),

    // The agents the user may talk with directly now (D-111d), with what each one allows: no prompt, no permission.
    // The people of the series (D-225, tappa B): who Claude may play; off with Claude, as the plain chat with Claude.
    route('GET', '/api/direct-agents', () => Promise.resolve({ body: { agents: directAgents?.() ?? [], off: offInterlocutors?.() ?? [], characters: chatCharacters?.() ?? [] } })),
    route('POST', '/api/conversations', async (request) => {
      const body = await readJson(request);
      onlyFields(body, ['mode', 'project', 'agent', 'incognito', 'trialModel', 'character']);
      if (body.mode !== 'work' && body.mode !== 'private') throw new HttpError(400, 'mode must be work or private');
      if (body.incognito !== undefined && typeof body.incognito !== 'boolean') throw new HttpError(400, 'incognito must be true or false');
      // An incognito conversation is answered by Arianna (D-136): a direct chat keeps its agent's session.
      if (body.incognito === true && body.agent !== undefined) throw new HttpError(400, 'an incognito conversation has no direct agent');
      if (body.project !== undefined && typeof body.project !== 'string') throw new HttpError(400, 'project must be a string');
      // The trial chat of a local model (D-142): incognito, private, the model checked against the catalog and the disk.
      const trialModel = body.trialModel;
      if (trialModel !== undefined) {
        // The format of conversations.trial_model (0035): a longer catalog id would fail the INSERT.
        if (typeof trialModel !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,254}$/.test(trialModel)) throw new HttpError(400, 'trialModel must be a catalog id');
        if (body.incognito !== true || body.mode !== 'private' || body.agent !== undefined) throw new HttpError(400, 'a trial chat is an incognito private conversation');
        const refusal = trialRefusal === undefined ? 'trial chats are not available' : trialRefusal(trialModel);
        if (refusal !== undefined) throw new HttpError(409, refusal);
      }
      // Who answers in place of Arianna (D-111d): only here, at creation; no route changes it later. Its card says how.
      const policy = body.agent === undefined ? undefined : (directAgents?.() ?? []).find((item) => item.agent === body.agent);
      if (body.agent !== undefined && policy === undefined) throw new HttpError(400, 'agent is not one the user may talk with now');
      // GOD only on a clone of Arianna's code (D-127).
      if (policy !== undefined && !projectFits(policy, typeof body.project === 'string' ? body.project : undefined)) {
        throw new HttpError(400, `${policy.agent} works only on the project ${policy.container ?? ''}`);
      }
      const agent = policy === undefined ? undefined : { name: policy.agent, modes: policy.modes, project: policy.project, ...(policy.finance === true ? { finance: true } : {}) };
      // A chat with a person of the series (D-225, tappa B): the plain chat with Claude, with a character served now.
      const character = body.character;
      if (character !== undefined) {
        if (typeof character !== 'string' || !(chatCharacters?.() ?? []).some((entry) => entry.id === character)) throw new HttpError(400, 'character is not one the user may chat with now');
        if (policy?.agent !== CLAUDE_CHAT_AGENT || body.mode !== 'work' || body.project !== undefined) throw new HttpError(400, 'a character chats only in the plain chat with Claude, a work conversation without a project');
      }
      // A work conversation starts with the user's default model, while this installation offers it:
      // this check, against what the selector offers, is the one that counts. With an agent of its own
      // (GOD, the Designer…) the model chosen for that agent in [agents.<id>] (D-116), else the router
      // chooses; with Arianna the work agent's. The plain chat with Claude (D-111, tappa B) takes the work
      // agent's only when it is Sonnet or Opus (else Sonnet answers); the one with ChatGPT only when it is
      // a model of Codex (else Sol answers, D-212).
      const plain = policy === undefined || policy.agent === CLAUDE_CHAT_AGENT || policy.agent === CODEX_CHAT_AGENT;
      // With a character Sonnet answers unless the user chooses Opus in the chat (D-225): not the default of the work agent.
      const preferred = body.mode === 'work' && character === undefined ? defaultModel(plain ? undefined : policy.agent) : undefined;
      const model =
        policy?.agent === CLAUDE_CHAT_AGENT
          ? DIRECT_MODELS.find((entry) => entry === preferred)
          : policy?.agent === CODEX_CHAT_AGENT
            ? CODEX_CHAT_MODELS.find((entry) => entry === preferred)
            : preferred;
      const conversation = await createConversation(sql, {
        mode: body.mode,
        ...(body.project === undefined ? {} : { project: body.project }),
        ...(agent === undefined ? {} : { agent }),
        ...(body.incognito === true ? { incognito: true } : {}),
        ...(typeof trialModel === 'string' ? { trialModel } : {}),
        ...(typeof character === 'string' ? { seriesCharacter: character } : {}),
        projects: projects().map((project) => project.name),
        ...(model !== undefined && models().some((entry) => entry.model === model) ? { model } : {}),
      });
      return { status: 201, body: { conversation } };
    }),

    // «Nuova sessione» of the Designer (I-20, D-185): the same conversation, a fresh session from a summary.
    route('POST', '/api/conversations/:id/session', async (request, _url, params) => {
      const body = await readJson(request);
      onlyFields(body, ['open']);
      const open = openMockup(body.open);
      return { body: { conversation: await startDesignerSession(sql, idParam(params, 'id'), open) } };
    }),

    route('GET', '/api/conversations/:id', async (_request, _url, params) => {
      const id = idParam(params, 'id');
      const conversation = await loadConversation(sql, id);
      if (conversation === undefined) {
        // A closed incognito conversation says why it closed (D-136), so a page left open on it can tell.
        const closed = await incognitoClosedCause(sql, id);
        if (closed !== undefined) return { status: 404, body: { error: 'not found', closed } };
        throw new HttpError(404, 'not found');
      }
      return { body: { conversation } };
    }),

    // The user's model for the delegated steps of a work conversation; null lets the router choose.
    route('POST', '/api/conversations/:id/model', async (request, _url, params) => {
      const id = idParam(params, 'id');
      const body = await readJson(request);
      onlyFields(body, ['model']);
      if (body.model !== null && typeof body.model !== 'string') throw new HttpError(400, 'model must be a string or null');
      const conversation = await setConversationModel(sql, id, body.model, models().map((entry) => entry.model));
      return { body: { conversation } };
    }),

    route('POST', '/api/conversations/:id/title', async (request, _url, params) => {
      const id = idParam(params, 'id');
      const body = await readJson(request);
      onlyFields(body, ['title']);
      return { body: { conversation: await renameConversation(sql, id, body.title) } };
    }),

    // Archives a conversation, or brings it back to the list: nothing is deleted.
    route('POST', '/api/conversations/:id/archive', async (request, _url, params) => {
      const id = idParam(params, 'id');
      const body = await readJson(request);
      onlyFields(body, ['archived']);
      if (typeof body.archived !== 'boolean') throw new HttpError(400, 'archived must be true or false');
      return { body: { conversation: await archiveConversation(sql, id, body.archived) } };
    }),

    // Pins a conversation at the top of the list, or unpins it (D-089); an archived one is restored first (409).
    route('POST', '/api/conversations/:id/pin', async (request, _url, params) => {
      const id = idParam(params, 'id');
      onlyFields(await readJson(request), []);
      return { body: { conversation: await pinConversation(sql, id, true) } };
    }),
    route('POST', '/api/conversations/:id/unpin', async (request, _url, params) => {
      const id = idParam(params, 'id');
      onlyFields(await readJson(request), []);
      return { body: { conversation: await pinConversation(sql, id, false) } };
    }),

    // The switch «Personaggio» of a conversation (D-225): off, its agents speak without the character and its lines.
    route('POST', '/api/conversations/:id/character', async (request, _url, params) => {
      const id = idParam(params, 'id');
      const body = await readJson(request);
      onlyFields(body, ['on']);
      if (typeof body.on !== 'boolean') throw new HttpError(400, 'on must be true or false');
      return { body: { conversation: await setConversationCharacter(sql, id, body.on) } };
    }),

    // Deletes the texts of an archived conversation for good (D-057): the user confirmed it in the page.
    route('POST', '/api/conversations/:id/purge', async (request, _url, params) => {
      const id = idParam(params, 'id');
      onlyFields(await readJson(request), []);
      // Its side threads go with it (D-232): their empty folders of the plain chats too.
      const sides = await sideThreadIds(sql, id);
      // Its attachments (D-247): the rows go with the purge, the files right after it.
      const attached = attachments === undefined ? [] : await attachmentFilesOf(sql, id);
      await purgeConversation(sql, id);
      if (attachments !== undefined) await removeAttachmentFiles(sql, attachments.dir, attached).catch(onError);
      for (const side of [id, ...sides]) await chatFolderGone?.(side).catch(() => undefined);
      return { body: { purged: id } };
    }),

    // "Elimina" (D-157): the conversation and everything it left go for good, the log is sewn again; the user confirmed it in the page.
    route('POST', '/api/conversations/:id/erase', async (request, _url, params) => {
      const id = idParam(params, 'id');
      onlyFields(await readJson(request), []);
      const sides = await sideThreadIds(sql, id);
      const erased = erase === undefined ? await eraseConversation(sql, id) : await erase(id);
      for (const side of [id, ...sides]) await chatFolderGone?.(side).catch(() => undefined);
      return { body: { erased: true, cards: erased.cards } };
    }),

    // "Termina" of an incognito conversation (D-136): its work stops, its texts are deleted; the answer is the closing card.
    route('POST', '/api/conversations/:id/end', async (request, _url, params) => {
      const id = idParam(params, 'id');
      onlyFields(await readJson(request), []);
      try {
        return { body: incognito === undefined ? await closeIncognito(sql, id, 'user') : await incognito.close(id, 'user') };
      } catch (error) {
        if (error instanceof ChatError && error.code === 'not-incognito') return { status: 409, body: { error: 'not incognito' } };
        // The work did not stop in time, or the conversation was in use: a stable code, the chat tries again.
        if (error instanceof ChatError && error.code === 'busy') return { status: 409, body: { error: 'busy' } };
        throw error;
      }
    }),
    // What the opening card of an incognito conversation needs (D-136): whether anything may reach the cloud, and the project.
    route('GET', '/api/incognito/notice', (_request, url) => {
      const mode = url.searchParams.get('mode');
      if (mode !== 'private' && mode !== 'work') throw new HttpError(400, 'mode must be private or work');
      const project = url.searchParams.get('project');
      if (project !== null && mode !== 'work') throw new HttpError(400, 'only a work conversation has a project');
      if (project !== null && !projects().some((item) => item.name === project)) throw new HttpError(400, 'project is not among the approved projects');
      // A private conversation never leaves the Mac; a work one reaches Claude only while a cloud model can take a step.
      // `localCache`: a local server writes blocks of the prompts to the SSD; they stay until evicted.
      return Promise.resolve({ body: { cloud: mode === 'work' && models().length > 0, project, localCache: incognito?.localCache?.() ?? false } });
    }),

    // Attaches the question of the failed task to its system chat: only when the user asks (D-064).
    route('POST', '/api/conversations/:id/question', async (request, _url, params) => {
      const id = idParam(params, 'id');
      onlyFields(await readJson(request), []);
      return { status: 201, body: { message: await attachQuestion(sql, id) } };
    }),

    // «Chiedi a lato» (D-232): the side threads of a conversation (answer and thread, ids only), and one opened on an answer.
    route('GET', '/api/conversations/:id/sides', async (_request, _url, params) => {
      const id = idParam(params, 'id');
      if ((await loadConversation(sql, id)) === undefined) throw new HttpError(404, 'not found');
      return { body: { sides: await listSideThreads(sql, id) } };
    }),
    route('POST', '/api/conversations/:id/sides', async (request, _url, params) => {
      const id = idParam(params, 'id');
      const body = await readJson(request);
      onlyFields(body, ['messageId']);
      const opened = await openSideThread(sql, id, body.messageId);
      return { status: opened.created ? 201 : 200, body: { conversation: opened.conversation } };
    }),

    route('GET', '/api/conversations/:id/messages', async (_request, url, params) => {
      const id = idParam(params, 'id');
      if ((await loadConversation(sql, id)) === undefined) throw new HttpError(404, 'not found');
      const before = url.searchParams.get('before');
      if (before !== null && !/^\d{1,19}$/.test(before)) throw new HttpError(400, 'before must be a message id');
      const messages = await listMessages(sql, id, { limit: limitParam(url), ...(before === null ? {} : { beforeId: before }) });
      return { body: { messages } };
    }),

    route('POST', '/api/conversations/:id/messages', async (request, _url, params) => {
      const id = idParam(params, 'id');
      const body = await readJson(request);
      onlyFields(body, ['body', 'style', 'skills', 'attachments']);
      if (typeof body.body !== 'string') throw new HttpError(400, 'body must be a string');
      // The images and files of the message (D-247): ids of pending attachments, checked with the conversation.
      const attached = attachmentIds(body.attachments);
      // The style and skills chosen in the Studio (I-19, D-184): checked as on a Designer card (D-163).
      let design;
      try {
        design = checkDesignChoice(body, cardCatalog(designCatalog, skillsCatalog));
      } catch (error) {
        if (error instanceof CardError) throw new HttpError(400, error.message);
        throw error;
      }
      const leave = leaveRule?.();
      // While an answer is at work the message waits in the queue (D-218): 202 with it, instead of the message and its task.
      const named = mentionable?.();
      const posted = await postOrQueue(sql, id, body.body, {
        ...(leave === undefined ? {} : { leave }),
        ...(named === undefined ? {} : { mentionable: named }),
        ...(design === undefined ? {} : { design }),
        ...(attached.length === 0 ? {} : { attachments: attached }),
      });
      if ('queued' in posted) return { status: 202, body: { queued: posted.queued } };
      return { status: 201, body: posted.sent };
    }),

    // The queue of a conversation (D-218): the messages waiting for the answer at work, and whether "Ferma" paused it.
    route('GET', '/api/conversations/:id/queue', async (_request, _url, params) => {
      const id = idParam(params, 'id');
      if ((await loadConversation(sql, id)) === undefined) throw new HttpError(404, 'not found');
      return { body: { queue: await listQueue(sql, id) } };
    }),
    route('POST', '/api/conversations/:id/queue/resume', async (request, _url, params) => {
      const id = idParam(params, 'id');
      onlyFields(await readJson(request), []);
      await resumeQueue(sql, id);
      return { body: { queue: await listQueue(sql, id) } };
    }),
    route('PATCH', '/api/queued-messages/:id', async (request, _url, params) => {
      const body = await readJson(request);
      onlyFields(body, ['body']);
      if (typeof body.body !== 'string') throw new HttpError(400, 'body must be a string');
      return { body: { queued: await editQueued(sql, queuedId(params), body.body) } };
    }),
    route('DELETE', '/api/queued-messages/:id', async (_request, _url, params) => {
      await removeQueued(sql, queuedId(params));
      return { status: 204, body: null };
    }),
    route('POST', '/api/queued-messages/:id/send', async (request, _url, params) => {
      onlyFields(await readJson(request), []);
      const leave = leaveRule?.();
      const named = mentionable?.();
      return { status: 201, body: await sendQueuedNow(sql, queuedId(params), { ...(leave === undefined ? {} : { leave }), ...(named === undefined ? {} : { mentionable: named }) }) };
    }),
    // Who «@» may call in a conversation with Arianna (D-107, tappa B2): names of agents, L0.
    route('GET', '/api/chat/mentionable', () => Promise.resolve({ body: { agents: mentionable?.() ?? [] } })),
    // "Ferma" (D-218): the answers at work in the conversation stop, its queue pauses.
    route('POST', '/api/conversations/:id/stop', async (request, _url, params) => {
      const id = idParam(params, 'id');
      onlyFields(await readJson(request), []);
      if (stopChat === undefined) throw new HttpError(404, 'not found');
      if ((await loadConversation(sql, id)) === undefined) throw new HttpError(404, 'not found');
      return { body: await stopChat(id) };
    }),

    // The tasks waiting for the user, oldest first, up to L2; the others only counted (D-091). Before /api/tasks/:id.
    route('GET', '/api/tasks/waiting', async () => ({ body: await listWaitingTasks(sql) })),

    route('GET', '/api/tasks/:id', async (_request, _url, params) => {
      const task = await loadTask(sql, idParam(params, 'id'));
      if (task === undefined) throw new HttpError(404, 'not found');
      return { body: { task } };
    }),

    // The activity lines a task saved (D-083), read as the messages of its conversation are.
    route('GET', '/api/tasks/:id/activities', async (_request, _url, params) => {
      const activities = await listTaskActivities(sql, idParam(params, 'id'));
      if (activities === undefined) throw new HttpError(404, 'not found');
      return { body: { activities } };
    }),
    // The saved terminal of a task's runs of the Coder (D-095, migration 0062), read as its activity lines are.
    route('GET', '/api/tasks/:id/terminal', async (_request, _url, params) => {
      const terminal = await listTaskTerminal(sql, idParam(params, 'id'));
      if (terminal === undefined) throw new HttpError(404, 'not found');
      return { body: { terminal } };
    }),
    // How many lines each task of a conversation saved: the chat offers "Mostra i passi (N)" (D-083).
    route('GET', '/api/conversations/:id/activity-counts', async (_request, _url, params) => {
      const id = idParam(params, 'id');
      if ((await loadConversation(sql, id)) === undefined) throw new HttpError(404, 'not found');
      return { body: { counts: await countConversationActivities(sql, id) } };
    }),

    // Why the task failed (D-064): origin, code and scalar details; null when nothing was recorded.
    // `current` is false once the task is no longer failed (retried): the error is history then.
    route('GET', '/api/tasks/:id/error', async (_request, _url, params) => {
      const id = idParam(params, 'id');
      const task = await loadTask(sql, id);
      if (task === undefined) throw new HttpError(404, 'not found');
      return { body: { error: (await loadFailure(sql, id)) ?? null, current: task.status === 'failed' } };
    }),

    // The user retries a failed task from the step that failed (D-064).
    route('POST', '/api/tasks/:id/retry', async (request, _url, params) => {
      const id = idParam(params, 'id');
      onlyFields(await readJson(request), []);
      if ((await loadTask(sql, id)) === undefined) throw new HttpError(404, 'not found');
      return { body: { task: await retryTask(sql, id) } };
    }),

    // "Chiudi" in "Decisioni in attesa" (D-109): a waiting task closes as done, its pending approvals expire.
    route('POST', '/api/tasks/:id/dismiss', async (request, _url, params) => {
      const id = idParam(params, 'id');
      onlyFields(await readJson(request), []);
      if ((await loadTask(sql, id)) === undefined) throw new HttpError(404, 'not found');
      return { body: { task: await dismissWaitingTask(sql, id) } };
    }),

    // Opens the system chat of a failed task, or the one already open (D-064).
    route('POST', '/api/tasks/:id/system-chat', async (request, _url, params) => {
      const id = idParam(params, 'id');
      onlyFields(await readJson(request), []);
      // Claude answers by default only where Arianna could not (D-064): Sonnet, or Opus when Sonnet is off (D-071).
      const directModel = DIRECT_MODELS.find((model) => models().some((entry) => entry.executor === 'claude' && entry.model === model));
      const direct = directModel === undefined ? {} : { directModel };
      return { body: { conversation: await openFailureChat(sql, id, direct) } };
    }),

    route('GET', '/api/approvals', async (_request, url) => {
      const state = url.searchParams.get('state') ?? 'pending';
      const known = APPROVAL_STATES.find((candidate) => candidate === state);
      if (known === undefined) throw new HttpError(400, 'unknown state');
      // Each with its conversation and `incognito` (D-136: the chat shows those of an incognito only in its page); `conversation` keeps one.
      const conversation = url.searchParams.get('conversation');
      if (conversation !== null && !isUuid(conversation)) throw new HttpError(400, 'conversation must be a conversation id');
      return { body: { approvals: await listApprovals(sql, known, limitParam(url), conversation === null ? {} : { conversationId: conversation }) } };
    }),

    route('GET', '/api/approvals/:id', async (_request, _url, params) => {
      const approval = await loadApproval(sql, idParam(params, 'id'));
      if (approval === undefined) throw new HttpError(404, 'not found');
      return { body: { approval } };
    }),

    // The user edits a pending plan in its card (D-235): the cards are replaced, checked again; the plan keeps
    // the label of its conversation, and in a work conversation the scanner refuses what a message would not hold.
    route('PUT', '/api/approvals/:id/plan', async (request, _url, params) => {
      const id = idParam(params, 'id');
      const body = await readJson(request);
      onlyFields(body, ['title', 'cards']);
      try {
        return { body: { approval: await editPlan(sql, id, body, planAssignees?.() ?? ['user', ...(mentionable?.() ?? [])]) } };
      } catch (error) {
        if (error instanceof PlanError) throw new HttpError(error.code === 'not-found' ? 404 : error.code === 'conflict' ? 409 : 400, error.message);
        throw error;
      }
    }),

    // The web chat is the channel of the decision: a declassification can be decided only here.
    // `choice`: the executor chosen for a card (D-159), with an approval of kind executor only.
    // `starts`: the cards of a plan to start at once («Avvia subito», D-235), by their number; absent, the default.
    // `revision`: the version of the plan the chat showed; another one is a 409, nothing starts unseen.
    route('POST', '/api/approvals/:id/decision', async (request, _url, params) => {
      const id = idParam(params, 'id');
      const body = await readJson(request);
      onlyFields(body, ['state', 'choice', 'starts', 'revision']);
      if (body.state !== 'approved' && body.state !== 'rejected') throw new HttpError(400, 'state must be approved or rejected');
      if (body.choice !== undefined && !isExecutorChoice(body.choice)) throw new HttpError(400, 'choice must be claude, codex or local');
      const choice = isExecutorChoice(body.choice) ? body.choice : undefined;
      const current = await loadApproval(sql, id);
      if (current === undefined) throw new HttpError(404, 'not found');
      if (current.state !== 'pending') throw new HttpError(409, `the approval is already ${current.state}`);
      try {
        return { body: { approval: await recordDecision(sql, id, body.state, 'web', choice, { starts: body.starts, revision: body.revision }) } };
      } catch (error) {
        if (error instanceof ApprovalChoiceError) throw new HttpError(400, error.message);
        if (error instanceof PlanError) throw new HttpError(error.code === 'conflict' ? 409 : 400, error.message);
        // Decided meanwhile (another tab, Telegram): the database refused the second decision.
        if (error instanceof Error && /already decided/.test(error.message)) throw new HttpError(409, 'the approval is already decided');
        throw error;
      }
    }),
  ];
}

/**
 * The routines (D-110 tappa A, D-254): the cards of the page «Routine», the
 * form (closed choices and one line of title), pause, resume, «Togli» and
 * «Prova adesso», which writes the report in the routine's chat now.
 */
function routineRoutes(routines: RoutineService | undefined, sql: Sql): Route[] {
  const need = (): RoutineService => {
    if (routines === undefined) throw new HttpError(404, 'not found');
    return routines;
  };
  return [
    route('GET', '/api/routines', async () => ({ body: { routines: await need().list() } })),
    // The calendar (D-257): the times of the routines in at most two weeks, by id only (the titles come from the list).
    route('GET', '/api/routines/calendar', async (_request, url) => {
      need();
      const query = parseCalendarQuery({ from: url.searchParams.get('from'), to: url.searchParams.get('to'), timezone: url.searchParams.get('tz') });
      return { body: await readCalendar(sql, query) };
    }),
    route('POST', '/api/routines', async (request) => ({ status: 201, body: { routine: await need().create(await readJson(request)) } })),
    route('PATCH', '/api/routines/:id', async (request, _url, params) => {
      const id = idParam(params, 'id');
      return { body: { routine: await need().update(id, await readJson(request)) } };
    }),
    route('POST', '/api/routines/:id/pause', async (request, _url, params) => {
      const id = idParam(params, 'id');
      onlyFields(await readJson(request), []);
      return { body: { routine: await need().pause(id) } };
    }),
    route('POST', '/api/routines/:id/resume', async (request, _url, params) => {
      const id = idParam(params, 'id');
      onlyFields(await readJson(request), []);
      return { body: { routine: await need().resume(id) } };
    }),
    route('POST', '/api/routines/:id/retire', async (request, _url, params) => {
      const id = idParam(params, 'id');
      onlyFields(await readJson(request), []);
      await need().retire(id);
      return { body: { retired: id } };
    }),
    // «Solo <giorno>» of the calendar (D-257): the routine gives up a day to a new one, in one transaction.
    route('POST', '/api/routines/:id/split', async (request, _url, params) => {
      const id = idParam(params, 'id');
      return { status: 201, body: await need().split(id, await readJson(request)) };
    }),
    // Its «Annulla»: the routine split off goes, the first gets its days and time back, in one transaction.
    route('POST', '/api/routines/:id/unsplit', async (request, _url, params) => {
      const id = idParam(params, 'id');
      return { body: { routine: await need().unsplit(id, await readJson(request)) } };
    }),
    // A routine proposed in the chat (D-256): «Attiva» and «Scarta» of the page, as the card in the chat.
    route('POST', '/api/routines/:id/approve', async (request, _url, params) => {
      const id = idParam(params, 'id');
      onlyFields(await readJson(request), []);
      return { body: { routine: await need().decide(id, 'approved') } };
    }),
    route('POST', '/api/routines/:id/discard', async (request, _url, params) => {
      const id = idParam(params, 'id');
      onlyFields(await readJson(request), []);
      return { body: { routine: await need().decide(id, 'rejected') } };
    }),
    route('POST', '/api/routines/:id/run', async (request, _url, params) => {
      const id = idParam(params, 'id');
      onlyFields(await readJson(request), []);
      return { status: 201, body: await need().runNow(id) };
    }),
  ];
}

/**
 * The secretary (I-12, D-144): its conversation, opened by the "Segretaria"
 * button (one only, created the first time), and the commitments for the
 * list beside it with the "Fatto" button. The web chat is local: the text of
 * a commitment (L2) goes nowhere else; notifications never carry it.
 */
function secretaryRoutes(sql: Sql): Route[] {
  return [
    route('POST', '/api/secretary', async (request) => {
      onlyFields(await readJson(request), []);
      return { body: { conversation: await openSecretary(sql) } };
    }),
    // The address `/segretaria` of the chat (D-156): the conversation without a new session; null before the first click.
    route('GET', '/api/secretary', async () => ({ body: { conversation: (await findSecretary(sql)) ?? null } })),
    // The open commitments, the late ones first, and those of today in any status: written from SQL.
    route('GET', '/api/commitments', async () => {
      const today = localDay();
      const [open, ofToday] = await Promise.all([listCommitments(sql), listCommitments(sql, { from: today, to: today })]);
      const seen = new Set(open.map((item) => item.id));
      const commitments = [...open, ...ofToday.filter((item) => !seen.has(item.id))].sort((a, b) =>
        a.day === b.day ? (a.time ?? '99:99').localeCompare(b.time ?? '99:99') : a.day.localeCompare(b.day),
      );
      return { body: { today, commitments } };
    }),
    // "Fatto": the click is the user's confirmation.
    route('POST', '/api/commitments/:id/done', async (request, _url, params) => {
      const id = idParam(params, 'id');
      onlyFields(await readJson(request), []);
      try {
        return { body: { commitment: await markDone(sql, id) } };
      } catch (error) {
        if (error instanceof CommitmentError) throw new HttpError(error.code === 'not-found' ? 404 : 409, error.code === 'not-found' ? 'not found' : 'the commitment is not open');
        throw error;
      }
    }),
  ];
}

/** A body of the Studio: the text of a mockup up to 2 MiB, JSON-escaped (a control character is six bytes), and some room. */
const MAX_STUDIO_BODY = MAX_MOCKUP_BYTES * 6 + 64 * 1024;

/**
 * The Studio of design (I-19, D-184): the contract of docs/STUDIO-API.md.
 * Mockups of an approved project, read, rewritten with their sha256 and
 * exported as .pptx; errors answer `{ error: <code> }` (and the current
 * `sha256` with `changed`).
 */
function studioRoutes(sql: Sql, approvedProjects: () => readonly Project[], pptx: PptxCodec | undefined): Route[] {
  const deps = { projects: approvedProjects, record: (event: NewEvent) => appendEvent(sql, event), ...(pptx === undefined ? {} : { pptx }) };
  const guard =
    (handler: Handler): Handler =>
    async (request, url, params) => {
      try {
        return await handler(request, url, params);
      } catch (error) {
        if (error instanceof StudioError) return { status: STUDIO_STATUS[error.code], body: { error: error.code, ...(error.sha256 === undefined ? {} : { sha256: error.sha256 }) } };
        if (error instanceof HttpError) {
          if (error.status === 413) return { status: 413, body: { error: 'too-large' } };
          return error.status === 404 ? { status: 404, body: { error: 'not-found' } } : { status: 400, body: { error: 'invalid' } };
        }
        throw error;
      }
    };
  // Frames handed over by the page (studio-frames.ts): one store per server, in memory only.
  const frames = new FrameStore();
  const projectParam = (params: Params): string => {
    try {
      return decodeURIComponent(params.project ?? '');
    } catch {
      throw new HttpError(404, 'not found');
    }
  };
  return [
    route(
      'GET',
      '/api/studio/:project/mockups',
      guard(async (_request, _url, params) => ({ body: await listMockups(deps, projectParam(params)) })),
    ),
    route(
      'GET',
      '/api/studio/:project/file',
      guard(async (_request, url, params) => ({ body: await readMockup(deps, projectParam(params), url.searchParams.get('path') ?? undefined) })),
    ),
    route(
      'PUT',
      '/api/studio/:project/file',
      guard(async (request, _url, params) => {
        const project = projectParam(params);
        const body = await readJson(request, MAX_STUDIO_BODY);
        onlyFields(body, ['path', 'text', 'base']);
        return { body: await writeMockup(deps, project, { path: body.path, text: body.text, base: body.base }) };
      }),
    ),
    route(
      'POST',
      '/api/studio/:project/delete',
      guard(async (request, _url, params) => {
        const project = projectParam(params);
        const body = await readJson(request, MAX_STUDIO_BODY);
        onlyFields(body, ['path', 'base', 'permanent']);
        return { body: await deleteMockup(deps, project, { path: body.path, base: body.base, permanent: body.permanent }) };
      }),
    ),
    route(
      'POST',
      '/api/studio/:project/pptx',
      guard(async (request, _url, params) => {
        const project = projectParam(params);
        const body = await readJson(request, MAX_STUDIO_BODY);
        onlyFields(body, ['path', 'deck']);
        const { name, bytes } = await exportPptx(deps, project, { path: body.path, deck: body.deck });
        const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
        const encoded = encodeURIComponent(name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
        return { raw: bytes, type: PPTX_TYPE, headers: { 'content-disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}` }, noStore: true };
      }),
    ),
    route(
      'POST',
      '/api/studio-frames',
      guard(async (request) => {
        const body = await readJson(request, MAX_FRAME_BYTES * 6 + 1024);
        onlyFields(body, ['html', 'print']);
        const { html, print = false } = body;
        if (typeof html !== 'string' || typeof print !== 'boolean') throw new HttpError(400, 'invalid frame');
        if (Buffer.byteLength(html, 'utf8') > MAX_FRAME_BYTES) throw new HttpError(413, 'frame too large');
        return { status: 201, body: { url: `/api/studio-frames/${frames.put({ html, print })}` } };
      }),
    ),
    route('GET', '/api/studio-frames/:token', (_request, _url, params) => {
      const token = params.token ?? '';
      const found = /^[0-9a-f]{32}$/.test(token) ? frames.get(token) : undefined;
      if (found === undefined) return Promise.resolve({ status: 404, body: { error: 'not-found' } });
      return Promise.resolve({ raw: Buffer.from(found.html, 'utf8'), type: 'text/html; charset=utf-8', headers: frameHeaders(found.print), noStore: true });
    }),
  ];
}

/** The SQLSTATE of an error of PostgreSQL, undefined for any other error. */
function postgresState(error: unknown): string | undefined {
  if (!(error instanceof Error) || error.name !== 'PostgresError') return undefined;
  const code = (error as Error & { code?: unknown }).code;
  return typeof code === 'string' ? code : 'XX000';
}

/**
 * The expense tracker (I-18, D-183): the contract of docs/FINANCE-API.md.
 * Private (L2, source finance:*): only the web chat reads and writes it, and
 * nothing of it goes out. Errors answer `{ error: <code> }`, which the page
 * translates; the file of an import comes as JSON with its bytes in base64
 * (the API takes only JSON, security.ts), up to 10 MiB decoded.
 */
function financeRoutes(sql: Sql): Route[] {
  const guard = (handler: Handler): Handler => async (request, url, params) => {
    try {
      return await handler(request, url, params);
    } catch (error) {
      if (error instanceof FinanceError) return { status: error.status, body: { error: error.code, ...(error.line === null ? {} : { line: error.line }) } };
      if (error instanceof HttpError) {
        const code = error.status === 413 ? 'too-large' : error.status === 404 ? 'not-found' : 'invalid';
        return { status: error.status, body: { error: code } };
      }
      // A refusal of the database carries the values of the row in its detail (descriptions, amounts):
      // answered with a code, and reported, if at all, by its SQLSTATE alone.
      const state = postgresState(error);
      if (state !== undefined) {
        if (state === '23505' || state === '23503' || state === '40001' || state === '40P01') return { status: 409, body: { error: 'conflict' } };
        if (state.startsWith('22') || state.startsWith('23')) return { status: 400, body: { error: 'invalid' } };
        // eslint-disable-next-line preserve-caught-error -- the cause is the error with the row's values: never attached
        throw new Error(`finance: the database refused the request (SQLSTATE ${state})`);
      }
      throw error;
    }
  };
  const done: Result = { status: 204, body: null };
  // A DELETE carries no body, or an empty object.
  const noBody = async (request: IncomingMessage): Promise<void> => {
    const declared = Number(request.headers['content-length'] ?? '0');
    if (declared === 0 && request.headers['transfer-encoding'] === undefined) return;
    onlyFields(await readJson(request), []);
  };
  const query = (url: URL, key: string): string | undefined => {
    const value = url.searchParams.get(key);
    return value === null || value === '' ? undefined : value;
  };
  const integer = (url: URL, key: string): number | undefined => {
    const value = query(url, key);
    if (value === undefined) return undefined;
    if (!/^\d{1,9}$/.test(value)) throw new FinanceError('invalid', 400, `${key} must be a whole number`);
    return Number(value);
  };
  const id = (params: Params, key: string): string => params[key] ?? '';
  return [
    route('GET', '/api/finance/accounts', guard(async () => {
      await ensureFinanceCategories(sql);
      return { body: { accounts: await listFinanceAccounts(sql) } };
    })),
    route('POST', '/api/finance/accounts', guard(async (request) => ({ status: 201, body: { account: await createFinanceAccount(sql, await readJson(request)) } }))),
    route('PATCH', '/api/finance/accounts/:id', guard(async (request, _url, params) => ({ body: { account: await updateFinanceAccount(sql, id(params, 'id'), await readJson(request)) } }))),

    route('POST', '/api/finance/imports/preview', guard(async (request) => ({ body: { preview: await previewFinanceFile(sql, await readJson(request, MAX_IMPORT_BODY)) } }))),
    route('POST', '/api/finance/imports', guard(async (request) => ({ status: 201, body: { import: await importFinanceFile(sql, await readJson(request, MAX_IMPORT_BODY)) } }))),
    route('GET', '/api/finance/imports', guard(async (_request, url) => ({ body: { imports: await listFinanceImports(sql, url.searchParams.get('account')) } }))),
    route('DELETE', '/api/finance/imports/:id', guard(async (request, _url, params) => {
      await noBody(request);
      await undoFinanceImport(sql, id(params, 'id'));
      return done;
    })),

    route('GET', '/api/finance/transactions', guard(async (_request, url) => {
      const uncategorized = query(url, 'uncategorized');
      if (uncategorized !== undefined && uncategorized !== '1' && uncategorized !== '0') throw new FinanceError('invalid', 400, 'uncategorized must be 1');
      const account = query(url, 'account');
      const from = dayParam(url.searchParams.get('from'), 'from', 'from');
      const to = dayParam(url.searchParams.get('to'), 'to', 'to');
      const category = query(url, 'category');
      const q = query(url, 'q');
      const listed = query(url, 'fingerprints');
      const fingerprints = listed === undefined ? undefined : listed.split(',').map((item) => item.trim()).filter((item) => item !== '');
      const limit = integer(url, 'limit');
      const offset = integer(url, 'offset');
      if (q !== undefined && q.length > 200) throw new FinanceError('invalid', 400, 'q is longer than 200 characters');
      return {
        body: await listFinanceTransactions(sql, {
          ...(account === undefined ? {} : { account }),
          ...(from === undefined ? {} : { from }),
          ...(to === undefined ? {} : { to }),
          ...(category === undefined ? {} : { category }),
          uncategorized: uncategorized === '1',
          ...(q === undefined ? {} : { q }),
          ...(fingerprints === undefined ? {} : { fingerprints }),
          ...(limit === undefined ? {} : { limit }),
          ...(offset === undefined ? {} : { offset }),
        }),
      };
    })),
    route('PATCH', '/api/finance/transactions/:id', guard(async (request, _url, params) => ({ body: await setFinanceTransactionCategory(sql, id(params, 'id'), await readJson(request)) }))),

    route('GET', '/api/finance/categories', guard(async () => {
      await ensureFinanceCategories(sql);
      return { body: { categories: await listFinanceCategories(sql) } };
    })),
    route('POST', '/api/finance/categories', guard(async (request) => ({ status: 201, body: { category: await createFinanceCategory(sql, await readJson(request)) } }))),
    route('PATCH', '/api/finance/categories/:id', guard(async (request, _url, params) => ({ body: { category: await updateFinanceCategory(sql, id(params, 'id'), await readJson(request)) } }))),
    route('DELETE', '/api/finance/categories/:id', guard(async (request, _url, params) => {
      await noBody(request);
      await deleteFinanceCategory(sql, id(params, 'id'));
      return done;
    })),

    route('GET', '/api/finance/rules', guard(async () => ({ body: { rules: await listFinanceRules(sql) } }))),
    route('POST', '/api/finance/rules', guard(async (request) => ({ status: 201, body: { rule: await createFinanceRule(sql, await readJson(request)) } }))),
    route('DELETE', '/api/finance/rules/:id', guard(async (request, _url, params) => {
      await noBody(request);
      await deleteFinanceRule(sql, id(params, 'id'));
      return done;
    })),

    route('GET', '/api/finance/budgets', guard(async () => ({ body: { budgets: await listFinanceBudgets(sql) } }))),
    route('PUT', '/api/finance/budgets/:category', guard(async (request, _url, params) => ({ body: { budget: await setFinanceBudget(sql, id(params, 'category'), await readJson(request)) } }))),
    route('DELETE', '/api/finance/budgets/:category', guard(async (request, _url, params) => {
      await noBody(request);
      await deleteFinanceBudget(sql, id(params, 'category'));
      return done;
    })),

    route('GET', '/api/finance/summary', guard(async (_request, url) => {
      const account = query(url, 'account');
      const from = dayParam(url.searchParams.get('from'), 'from', 'from');
      const to = dayParam(url.searchParams.get('to'), 'to', 'to');
      return {
        body: await financeSummary(sql, { ...(account === undefined ? {} : { account }), ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) }),
      };
    })),
    route('GET', '/api/finance/alerts', guard(async (_request, url) => ({ body: { alerts: await financeAlerts(sql, monthParam(url.searchParams.get('month'), 'month')) } }))),
  ];
}

/** An attachment comes as JSON with its bytes in base64: a third more than the largest image, and some room. */
const MAX_ATTACHMENT_BODY = Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 16 * 1024;

/**
 * Images and files attached in the chat (D-247): pasted or dropped, kept as
 * pending until the message that carries them leaves; shown small in its
 * bubble. Never run: an image is served with a sandbox and nosniff, a text
 * file only as a download.
 */
function attachmentRoutes(sql: Sql, attachments: ApiServerOptions['attachments']): Route[] {
  const need = (): NonNullable<ApiServerOptions['attachments']> => {
    if (attachments === undefined) throw new HttpError(404, 'not found');
    return attachments;
  };
  return [
    route('POST', '/api/attachments', async (request) => {
      const options = need();
      const body = await readJson(request, MAX_ATTACHMENT_BODY);
      onlyFields(body, ['name', 'data']);
      return { status: 201, body: { attachment: await saveAttachment(sql, options.dir, body, { vision: options.vision() }) } };
    }),
    route('GET', '/api/attachments/:id', async (_request, _url, params) => {
      const file = await readAttachment(sql, need().dir, idParam(params, 'id'));
      const image = file.mediaType.startsWith('image/');
      const ascii = file.name.replace(/[^\x20-\x7e]|["\\]/g, '_');
      const encoded = encodeURIComponent(file.name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
      return {
        raw: file.bytes,
        type: image ? file.mediaType : `${file.mediaType}; charset=utf-8`,
        headers: {
          'content-disposition': `${image ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encoded}`,
          'content-security-policy': "default-src 'none'; sandbox",
          'x-content-type-options': 'nosniff',
        },
        noStore: true,
      };
    }),
    route('DELETE', '/api/attachments/:id', async (request, _url, params) => {
      onlyFields(await readJson(request), []);
      await discardAttachment(sql, need().dir, idParam(params, 'id'));
      return { status: 204, body: null };
    }),
  ];
}

/**
 * The clients (I-16, D-168, tappa C1): the registry, the contacts, the
 * projects and the logo. Private (L2): only the web chat reads and writes
 * them, nothing goes out. A field that does not pass answers 400 with
 * `issues` (field and why), which the chat shows next to the field.
 */
function clientRoutes(sql: Sql, names: () => ClientNames, clients: ApiServerOptions['clients']): Route[] {
  const logosDir = (): string => {
    if (clients === undefined) throw new HttpError(404, 'not found');
    return clients.dir;
  };
  const guard = async (work: () => Promise<Result>): Promise<Result> => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof ClientError) {
        const status = error.code === 'not-found' ? 404 : error.code === 'invalid' ? 400 : 409;
        return { status, body: { error: error.message, ...(error.issues.length > 0 ? { issues: error.issues } : {}) } };
      }
      throw error;
    }
  };
  return [
    route('GET', '/api/clients', async () => ({ body: { clients: await listClients(sql), projects: names().projects } })),
    route('POST', '/api/clients', async (request) => {
      const body = await readJson(request);
      onlyFields(body, CLIENT_FIELDS);
      return guard(async () => ({ status: 201, body: { client: await createClient(sql, body) } }));
    }),
    // The client of a project, for the header of the page Progetti.
    route('GET', '/api/clients/of-project/:project', async (_request, _url, params) => {
      const project = params.project ?? '';
      if (!CLIENT_PROJECT_NAME.test(project)) throw new HttpError(404, 'not found');
      return { body: { client: await clientOfProject(sql, project) } };
    }),
    route('GET', '/api/clients/:id', async (_request, _url, params) => {
      const id = idParam(params, 'id');
      return guard(async () => ({ body: { client: await readClient(sql, id, names()) } }));
    }),
    route('POST', '/api/clients/:id', async (request, _url, params) => {
      const id = idParam(params, 'id');
      const body = await readJson(request);
      onlyFields(body, CLIENT_FIELDS);
      return guard(async () => ({ body: { client: await updateClient(sql, id, body) } }));
    }),
    route('POST', '/api/clients/:id/archive', async (request, _url, params) => {
      const id = idParam(params, 'id');
      const body = await readJson(request);
      onlyFields(body, ['archived']);
      if (typeof body.archived !== 'boolean') throw new HttpError(400, 'archived must be true or false');
      const archived = body.archived;
      return guard(async () => ({ body: { client: await archiveClient(sql, id, archived) } }));
    }),
    route('POST', '/api/clients/:id/contacts', async (request, _url, params) => {
      const id = idParam(params, 'id');
      const body = await readJson(request);
      onlyFields(body, CONTACT_FIELDS);
      return guard(async () => ({ status: 201, body: { contact: await addContact(sql, id, body) } }));
    }),
    route('POST', '/api/clients/:id/contacts/:contact', async (request, _url, params) => {
      const id = idParam(params, 'id');
      const contact = idParam(params, 'contact');
      const body = await readJson(request);
      onlyFields(body, CONTACT_FIELDS);
      return guard(async () => ({ body: { contact: await updateContact(sql, id, contact, body) } }));
    }),
    route('DELETE', '/api/clients/:id/contacts/:contact', async (request, _url, params) => {
      const id = idParam(params, 'id');
      const contact = idParam(params, 'contact');
      onlyFields(await readJson(request), []);
      return guard(async () => {
        await removeContact(sql, id, contact);
        return { body: { ok: true } };
      });
    }),
    route('POST', '/api/clients/:id/projects', async (request, _url, params) => {
      const id = idParam(params, 'id');
      const body = await readJson(request);
      onlyFields(body, ['project']);
      return guard(async () => ({ status: 201, body: { project: await linkProject(sql, id, body.project, names()) } }));
    }),
    route('DELETE', '/api/clients/:id/projects/:link', async (request, _url, params) => {
      const id = idParam(params, 'id');
      const link = idParam(params, 'link');
      onlyFields(await readJson(request), []);
      return guard(async () => {
        await unlinkProject(sql, id, link);
        return { body: { ok: true } };
      });
    }),
    // The logo comes as JSON with its bytes in base64: the API takes only JSON (security.ts).
    route('POST', '/api/clients/:id/logo', async (request, _url, params) => {
      const id = idParam(params, 'id');
      const dir = logosDir();
      let body: Record<string, unknown>;
      try {
        body = await readJson(request, MAX_LOGO_BODY);
      } catch (error) {
        if (error instanceof HttpError && error.status === 413) return { status: 413, body: { error: 'the logo is 1 MB at most', issues: [{ field: 'logo', code: 'too-long' }] } };
        throw error;
      }
      onlyFields(body, ['type', 'data']);
      return guard(async () => ({ body: { logo: await setLogo(sql, dir, id, body) } }));
    }),
    route('DELETE', '/api/clients/:id/logo', async (request, _url, params) => {
      const id = idParam(params, 'id');
      const dir = logosDir();
      onlyFields(await readJson(request), []);
      return guard(async () => {
        await removeLogo(sql, dir, id);
        return { body: { ok: true } };
      });
    }),
    // The documents of the client (D-171, tappa C2): in its private folder, the file as JSON with base64 like the logo.
    route('GET', '/api/clients/:id/documents', async (_request, _url, params) => {
      const id = idParam(params, 'id');
      return guard(async () => ({ body: { documents: await listDocuments(sql, id) } }));
    }),
    route('POST', '/api/clients/:id/documents', async (request, _url, params) => {
      const id = idParam(params, 'id');
      const dir = logosDir();
      let body: Record<string, unknown>;
      try {
        body = await readJson(request, MAX_DOCUMENT_BODY);
      } catch (error) {
        if (error instanceof HttpError && error.status === 413) return { status: 413, body: { error: 'a document is 25 MB at most', issues: [{ field: 'file', code: 'too-long' }] } };
        throw error;
      }
      onlyFields(body, [...DOCUMENT_FIELDS, 'fileName', 'data']);
      return guard(async () => ({ status: 201, body: { document: await addDocument(sql, dir, id, body) } }));
    }),
    route('POST', '/api/clients/:id/documents/:document', async (request, _url, params) => {
      const id = idParam(params, 'id');
      const document = idParam(params, 'document');
      const body = await readJson(request);
      onlyFields(body, DOCUMENT_FIELDS);
      return guard(async () => ({ body: { document: await updateDocument(sql, id, document, body) } }));
    }),
    route('POST', '/api/clients/:id/documents/:document/archive', async (request, _url, params) => {
      const id = idParam(params, 'id');
      const document = idParam(params, 'document');
      const body = await readJson(request);
      onlyFields(body, ['archived']);
      if (typeof body.archived !== 'boolean') throw new HttpError(400, 'archived must be true or false');
      const archived = body.archived;
      return guard(async () => ({ body: { document: await archiveDocument(sql, id, document, archived) } }));
    }),
    // "Apri" (the app of the Mac) and "Mostra nel Finder" (reveal): `open` of macOS, run by the core on this machine.
    route('POST', '/api/clients/:id/documents/:document/open', async (request, _url, params) => {
      const id = idParam(params, 'id');
      const document = idParam(params, 'document');
      const dir = logosDir();
      const body = await readJson(request);
      onlyFields(body, ['reveal']);
      if (typeof body.reveal !== 'boolean') throw new HttpError(400, 'reveal must be true or false');
      const reveal = body.reveal;
      return guard(async () => {
        await openDocument(sql, dir, id, document, reveal, clients?.opener);
        return { body: { ok: true } };
      });
    }),
    route('GET', '/api/clients/:id/documents/:document/file', async (_request, _url, params) => {
      const id = idParam(params, 'id');
      const document = idParam(params, 'document');
      const dir = logosDir();
      return guard(async () => {
        const { document: found, bytes } = await readDocument(sql, dir, id, document);
        // The extension once: kept when the name already ends with it.
        const file = found.name.toLowerCase().endsWith(`.${found.extension}`) ? found.name : `${found.name}.${found.extension}`;
        const ascii = file.replace(/[^\x20-\x7e]|["\\]/g, '_');
        return {
          raw: bytes,
          // Only PDF and images in the page; the rest is a download, never shown as a page of ours.
          type: found.preview ? found.mediaType : 'application/octet-stream',
          headers: {
            'content-disposition': `${found.preview ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`,
            // A PDF is shown in a frame of the page Documenti only (same origin), by the viewer of the browser; never run as a page of ours.
            'content-security-policy':
              found.mediaType === 'application/pdf' ? "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'" : "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
            ...(found.mediaType === 'application/pdf' ? { 'x-frame-options': 'SAMEORIGIN' } : {}),
          },
          noStore: true,
        };
      });
    }),
    route('GET', '/api/clients/:id/logo', async (_request, _url, params) => {
      const id = idParam(params, 'id');
      const dir = logosDir();
      return guard(async () => {
        const { type, bytes } = await readLogo(sql, dir, id);
        return {
          raw: bytes,
          type,
          // An image of the user's is shown, never run; X-Content-Type-Options: nosniff goes with every answer (security.ts).
          headers: { 'content-security-policy': "default-src 'none'; sandbox", 'x-content-type-options': 'nosniff' },
          noStore: true,
        };
      });
    }),
  ];
}

/**
 * What the adopted catalogs hold, for the style and the skills of a Designer
 * card (D-163): read once per request, at the first check, as the menus of
 * the chat list them. A catalog the core does not have holds nothing.
 */
function cardCatalog(design: DesignCatalog | undefined, skills: SkillsCatalog | undefined): CardCatalog {
  let styles: ReadonlySet<string> | undefined;
  let skillIds: ReadonlySet<string> | undefined;
  return {
    style: (slug) => (styles ??= new Set((design?.list().styles ?? []).map((item) => item.slug))).has(slug),
    skill: (id) => (skillIds ??= new Set((skills?.list().skills ?? []).map((item) => item.id))).has(id),
  };
}

/**
 * The cardwall (I-13 tappe C1-C2, D-152): the cards and the commitments with
 * their column, and what the user changes on a card by hand. Cards only
 * (tasks without a conversation): a task of a chat is the engine's.
 */
function cardwallRoutes(sql: Sql, names: () => CardNames, cards: ApiServerOptions['cards'], stopCard: ApiServerOptions['stopCard']): Route[] {
  const filesDir = (): string => {
    if (cards === undefined) throw new HttpError(404, 'not found');
    return cards.dir;
  };
  const guard = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof CardError) throw new HttpError(error.code === 'not-found' ? 404 : error.code === 'invalid' ? 400 : 409, error.message);
      throw error;
    }
  };
  // Arianna does not take cards from the wall (the caller leaves her out, with the agents of the Finances).
  const known = (): CardNames => {
    const current = names();
    return { projects: current.projects, agents: current.agents, ...(current.catalog === undefined ? {} : { catalog: current.catalog }) };
  };
  return [
    route('GET', '/api/cards', async () => {
      const today = localDay();
      const current = known();
      return { body: { today, cards: await listCards(sql, today), projects: current.projects, agents: current.agents } };
    }),
    route('POST', '/api/cards', async (request) => {
      const body = await readJson(request);
      onlyFields(body, CARD_FIELDS);
      return guard(async () => ({ status: 201, body: { card: { id: (await createCard(sql, body, known())).id } } }));
    }),
    route('POST', '/api/cards/:id', async (request, _url, params) => {
      const id = idParam(params, 'id');
      const body = await readJson(request);
      onlyFields(body, CARD_FIELDS);
      return guard(async () => ({ body: { card: { id: (await updateCard(sql, id, body, known())).id } } }));
    }),
    route('GET', '/api/cards/:id', async (_request, _url, params) => {
      const id = idParam(params, 'id');
      return guard(async () => ({ body: { card: await cardDetail(sql, id) } }));
    }),
    route('POST', '/api/cards/:id/links', async (request, _url, params) => {
      const id = idParam(params, 'id');
      const body = await readJson(request);
      onlyFields(body, ['url', 'title']);
      return guard(async () => ({ status: 201, body: { link: await addLink(sql, id, body) } }));
    }),
    route('DELETE', '/api/cards/:id/links/:link', async (request, _url, params) => {
      const id = idParam(params, 'id');
      const link = idParam(params, 'link');
      onlyFields(await readJson(request), []);
      return guard(async () => {
        await removeLink(sql, id, link);
        return { body: { ok: true } };
      });
    }),
    route('POST', '/api/cards/:id/checklist', async (request, _url, params) => {
      const id = idParam(params, 'id');
      const body = await readJson(request);
      onlyFields(body, ['body']);
      return guard(async () => ({ status: 201, body: { item: await addChecklistItem(sql, id, body) } }));
    }),
    route('POST', '/api/cards/:id/checklist/:item', async (request, _url, params) => {
      const id = idParam(params, 'id');
      const item = idParam(params, 'item');
      const body = await readJson(request);
      onlyFields(body, ['body', 'done']);
      return guard(async () => ({ body: { item: await updateChecklistItem(sql, id, item, body) } }));
    }),
    route('DELETE', '/api/cards/:id/checklist/:item', async (request, _url, params) => {
      const id = idParam(params, 'id');
      const item = idParam(params, 'item');
      onlyFields(await readJson(request), []);
      return guard(async () => {
        await removeChecklistItem(sql, id, item);
        return { body: { ok: true } };
      });
    }),
    // A file comes as JSON with its bytes in base64: the API takes only JSON (security.ts).
    route('POST', '/api/cards/:id/files', async (request, _url, params) => {
      const id = idParam(params, 'id');
      const dir = filesDir();
      const body = await readJson(request, MAX_CARD_FILE_BODY);
      onlyFields(body, ['name', 'type', 'data']);
      return guard(async () => ({ status: 201, body: { file: await addFile(sql, dir, id, body) } }));
    }),
    route('GET', '/api/cards/:id/files/:file', async (_request, _url, params) => {
      const id = idParam(params, 'id');
      const fileId = idParam(params, 'file');
      const dir = filesDir();
      return guard(async () => {
        const { file, bytes } = await readCardFile(sql, dir, id, fileId);
        const inline = isInline(file.mediaType);
        const ascii = file.name.replace(/[^\x20-\x7e]|["\\]/g, '_');
        return {
          raw: bytes,
          type: !inline ? 'application/octet-stream' : file.mediaType === 'text/plain' ? 'text/plain; charset=utf-8' : file.mediaType,
          headers: {
            'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`,
            // A file of the user's is shown, never run: no script, no form, no frame of ours.
            'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
          },
          noStore: true,
        };
      });
    }),
    route('DELETE', '/api/cards/:id/files/:file', async (request, _url, params) => {
      const id = idParam(params, 'id');
      const fileId = idParam(params, 'file');
      onlyFields(await readJson(request), []);
      return guard(async () => {
        await removeFile(sql, id, fileId);
        return { body: { ok: true } };
      });
    }),
    route('POST', '/api/cards/:id/move', async (request, _url, params) => {
      const id = idParam(params, 'id');
      const body = await readJson(request);
      onlyFields(body, ['to', 'reason']);
      return guard(async () => ({ body: { card: { id, status: (await moveCard(sql, id, body.to, body.reason)).status } } }));
    }),
    // D-159: "Avvia" for an agent's card never started, "Riprendi" and "Riprova" for one the engine stopped.
    route('POST', '/api/cards/:id/start', async (request, _url, params) => {
      const id = idParam(params, 'id');
      onlyFields(await readJson(request), []);
      return guard(async () => ({ body: { card: { id, status: (await startCard(sql, id, known().agents)).status } } }));
    }),
    // D-235: a drag into "In corso" starts, resumes or retries the card; nothing more when it is already at work.
    route('POST', '/api/cards/:id/run', async (request, _url, params) => {
      const id = idParam(params, 'id');
      onlyFields(await readJson(request), []);
      return guard(async () => ({ body: { card: { id, status: (await runCard(sql, id, known().agents)).status } } }));
    }),
    // D-235: «Rimanda», an agent's card in Da verificare back to work with a note and its label.
    route('POST', '/api/cards/:id/send-back', async (request, _url, params) => {
      const id = idParam(params, 'id');
      const body = await readJson(request);
      onlyFields(body, ['note', 'label']);
      return guard(async () => ({ body: { card: { id, status: (await sendBackCard(sql, id, body)).status } } }));
    }),
    // D-235: "Ferma" of a card, or a drag out of "In corso".
    route('POST', '/api/cards/:id/stop', async (request, _url, params) => {
      const id = idParam(params, 'id');
      onlyFields(await readJson(request), []);
      if (stopCard === undefined) throw new HttpError(404, 'not found');
      return guard(async () => ({ body: await stopCard(id) }));
    }),
    route('POST', '/api/cards/:id/resume', async (request, _url, params) => {
      const id = idParam(params, 'id');
      onlyFields(await readJson(request), []);
      return guard(async () => ({ body: { card: { id, status: (await resumeCard(sql, id)).status } } }));
    }),
    route('POST', '/api/cards/:id/retry', async (request, _url, params) => {
      const id = idParam(params, 'id');
      onlyFields(await readJson(request), []);
      return guard(async () => ({ body: { card: { id, status: (await retryCard(sql, id)).status } } }));
    }),
    route('POST', '/api/cards/:id/dependencies', async (request, _url, params) => {
      const id = idParam(params, 'id');
      const body = await readJson(request);
      onlyFields(body, ['on']);
      const on = typeof body.on === 'string' && isUuid(body.on) ? body.on : undefined;
      if (on === undefined) throw new HttpError(400, 'on must be the id of a card');
      return guard(async () => {
        await addDependency(sql, id, on);
        return { body: { ok: true } };
      });
    }),
    route('DELETE', '/api/cards/:id/dependencies/:on', async (request, _url, params) => {
      const id = idParam(params, 'id');
      const on = idParam(params, 'on');
      onlyFields(await readJson(request), []);
      return guard(async () => {
        await removeDependency(sql, id, on);
        return { body: { ok: true } };
      });
    }),
  ];
}

/** What the routes of "Sviluppo di Arianna" need (D-102). */
export interface DevProgressApi {
  /** ARIANNA_HOME: the documents are `docs/*.md` under it, the answers `data/dev/RISPOSTE.md`. */
  home: string;
  /** Tests only: the gateway and the event, which otherwise use the database of the core. */
  gate?: AnswerGate;
  recorded?: (saved: { key: string; question: OpenQuestion; rewrite?: boolean }) => Promise<void>;
  /** The news of Open Design (I-21, D-186), from the catalog; without it the section is empty. */
  news?: () => NewsPair;
  /** Tests only: the event of a news sent, which otherwise uses the database of the core. */
  newsRecorded?: (key: string) => Promise<void>;
  /** Tests only: the event of «Su di te, per chi sviluppa Arianna» saved (D-114), with the length only. */
  userNoteRecorded?: (chars: number) => Promise<void>;
  /** The projects followed for ideas (D-202); without them the section is empty. */
  projects?: FollowedProjects;
  /** Tests only: the event of a choice on a news of a project. */
  projectRecorded?: (key: string, choice: ProjectChoice) => Promise<void>;
}

/** An entry of the news as the page gets it: with the answer already in RISPOSTE.md, if any. */
function newsView<N extends DesignNews | ProjectNews>(news: N | null, answers: Map<string, { state: string; at: string }>): (N & { items: (NewsItem & { answer: { state: 'new' | 'done'; at: string } | null })[] }) | null {
  if (news === null) return null;
  return {
    ...news,
    items: news.items.map((item) => {
      const entry = answers.get(item.key);
      return { ...item, answer: entry === undefined ? null : { state: entry.state === 'done' ? 'done' : 'new', at: entry.at } };
    }),
  };
}

/**
 * "Sviluppo di Arianna" (D-102): progress read from the documents, and the
 * answers to the open questions appended to data/dev/RISPOSTE.md for Claude
 * Code. The client names a question by its key only: the path is fixed and the
 * question's text comes from the documents. Claude Code is a cloud reader:
 * every answer passes the gateway as L1 towards it, logged in gateway_log, and
 * only the text it allows is written. `{ key, rewrite: true }` in place of the
 * text asks Claude to rewrite the question more clearly (D-153): a fixed entry
 * written by the code, no text of the user, so nothing to pass the gateway.
 */
function devRoutes(sql: Sql, dev: DevProgressApi | undefined, onError: (error: unknown) => void): Route[] {
  const need = (): DevProgressApi => {
    if (dev === undefined) throw new HttpError(404, 'not found');
    return dev;
  };
  const needProjects = (): FollowedProjects => {
    const projects = need().projects;
    if (projects === undefined) throw new HttpError(404, 'not found');
    return projects;
  };
  // The destination logged is Claude Code; the user note is read by Codex too (D-226), under the same rules towards the cloud.
  const viaGateway: AnswerGate = async (answer, key) => {
    const decision = await passGateway(sql, [{ value: answer, label: 'L1', source: key === 'user-note' ? 'dev:user-note' : 'dev:answer' }], createContext('L1'), { kind: 'executor', id: 'claude', locality: 'cloud' }, { summary: key });
    if (decision.decision !== 'allow') return { allow: false, reason: decision.rule };
    const [text] = decision.texts;
    return text === undefined ? { allow: false, reason: 'empty' } : { allow: true, text };
  };
  return [
    route('GET', '/api/dev/progress', () => Promise.resolve({ body: { progress: loadProgress(need().home), maxAnswer: MAX_ANSWER_CHARS } })),
    // The dot of the chat (D-120): only the number leaves, no text of the documents.
    route('GET', '/api/dev/pending', () => Promise.resolve({ body: { pending: pendingQuestions(loadProgress(need().home)) } })),
    route('POST', '/api/dev/answers', async (request) => {
      const { home, gate = viaGateway, recorded = (saved) => recordAnswer(sql, saved) } = need();
      const body = await readJson(request, 64 * 1024);
      onlyFields(body, ['key', 'text', 'rewrite']);
      const { key, text, rewrite } = body;
      if (typeof key !== 'string' || !/^[A-Za-z0-9#-]{1,80}$/.test(key)) throw new HttpError(400, 'key must be the key of a question');
      if (rewrite !== undefined && (rewrite !== true || text !== undefined)) throw new HttpError(400, 'rewrite must be true, without text');
      if (rewrite === undefined && typeof text !== 'string') throw new HttpError(400, 'text is required');
      let saved;
      try {
        saved = typeof text === 'string' ? { ...(await saveAnswer(home, key, text, gate)), already: false } : saveRewrite(home, key);
      } catch (error) {
        if (!(error instanceof DevAnswerError)) throw error;
        throw new HttpError({ invalid: 400, 'unknown-question': 404, blocked: 422, unavailable: 503 }[error.code], error.message);
      }
      // A rewrite already asked and not yet applied: the same request again, no second entry nor event.
      if (saved.already) return { status: 200, body: { key: saved.key, at: saved.at, rewrite: true, already: true } };
      // The entry is in the file: an event that fails is reported, and the entry is not sent twice.
      let logged = true;
      try {
        await recorded({ key: saved.key, question: saved.question, ...(rewrite === true ? { rewrite: true } : {}) });
      } catch (error) {
        logged = false;
        onError(error);
      }
      return { status: 201, body: { key: saved.key, at: saved.at, ...(rewrite === true ? { rewrite: true, already: false } : {}), logged } };
    }),
    // «Su di te, per chi sviluppa Arianna» (D-114): the text saved now, and its limit.
    route('GET', '/api/dev/user-note', () => Promise.resolve({ body: { note: readUserNote(need().home), max: MAX_USER_NOTE_CHARS } })),
    // Replaces data/dev/UTENTE.md, through the gateway towards the cloud (Claude Code, Codex) as an answer; empty text removes it.
    route('POST', '/api/dev/user-note', async (request) => {
      const { home, gate = viaGateway, userNoteRecorded = async (chars: number) => {
        await appendEvent(sql, { kind: 'dev.user_note_saved', label: 'L0', payload: { chars } });
      } } = need();
      const body = await readJson(request, 64 * 1024);
      onlyFields(body, ['text']);
      if (typeof body.text !== 'string') throw new HttpError(400, 'text is required');
      let saved;
      try {
        saved = await saveUserNote(home, body.text, gate);
      } catch (error) {
        if (!(error instanceof DevAnswerError)) throw error;
        throw new HttpError({ invalid: 400, 'unknown-question': 404, blocked: 422, unavailable: 503 }[error.code], error.message);
      }
      // The file is written: an event that fails is reported, never the text.
      let logged = true;
      try {
        await userNoteRecorded(saved.text.length);
      } catch (error) {
        logged = false;
        onError(error);
      }
      return { body: { note: saved, logged } };
    }),
    // The news of Open Design (I-21, D-186): public text of the catalog (L0), with what was already sent.
    route('GET', '/api/dev/od-news', () => {
      const { home, news } = need();
      const pair = news?.() ?? { pending: null, adopted: null, preparing: false };
      const answers = answersByKey(home);
      return Promise.resolve({ body: { news: { pending: newsView(pair.pending, answers), adopted: newsView(pair.adopted, answers), preparing: pair.preparing } } });
    }),
    // "Da rifare nello Studio": the client names an entry by its key only; its text comes from the news of the core.
    route('POST', '/api/dev/od-news', async (request) => {
      const { home, news, gate = viaGateway, newsRecorded = (key: string) => appendEvent(sql, { kind: 'dev.od_news_redo', label: 'L0', payload: { key: eventKey(key) } }) } = need();
      const body = await readJson(request, 4 * 1024);
      onlyFields(body, ['key']);
      const { key } = body;
      if (typeof key !== 'string' || !NEWS_KEY.test(key)) throw new HttpError(400, 'key must be the key of a news entry');
      const pair = news?.() ?? { pending: null, adopted: null, preparing: false };
      const found = [pair.pending, pair.adopted].flatMap((item) => (item === null ? [] : item.items.map((entry) => ({ entry, version: item.to })))).find(({ entry }) => entry.key === key);
      if (found === undefined) throw new HttpError(404, 'the news entry is no longer there');
      let saved;
      try {
        saved = await saveNewsRedo(home, found.entry, found.version, gate);
      } catch (error) {
        if (!(error instanceof DevAnswerError)) throw error;
        throw new HttpError({ invalid: 400, 'unknown-question': 404, blocked: 422, unavailable: 503 }[error.code], error.message);
      }
      if (saved.already) return { status: 200, body: saved };
      let logged = true;
      try {
        await newsRecorded(saved.key);
      } catch (error) {
        logged = false;
        onError(error);
      }
      return { status: 201, body: { ...saved, logged } };
    }),
    // The projects followed for ideas (D-202): public text read from GitHub (L0), with what was already chosen;
    // and the accounts followed (D-271), with their new repositories.
    route('GET', '/api/dev/projects', () => {
      const { home, projects } = need();
      const answers = answersByKey(home);
      const list = (projects?.list() ?? []).map((project) => ({ ...project, news: newsView(project.news, answers) }));
      return Promise.resolve({ body: { projects: list, max: MAX_PROJECTS, accounts: projects?.accounts() ?? [], maxAccounts: MAX_ACCOUNTS } });
    }),
    // A repository or, since D-271, an account (`https://github.com/<owner>`, whose id has no `/`).
    route('POST', '/api/dev/projects', async (request) => {
      const projects = needProjects();
      const body = await readJson(request, 4 * 1024);
      onlyFields(body, ['url']);
      const added = projects.add(body.url);
      return { status: 201, body: added.id.includes('/') ? { project: added } : { account: added } };
    }),
    route('DELETE', '/api/dev/projects', async (request) => {
      const projects = needProjects();
      const body = await readJson(request, 4 * 1024);
      onlyFields(body, ['id']);
      const removed = projects.remove(body.id);
      return { body: removed.id.includes('/') ? { project: removed } : { account: removed } };
    }),
    // «Controlla novità»: the check runs in the background; the page reads again while `checking`.
    route('POST', '/api/dev/projects/check', async (request) => {
      const projects = needProjects();
      const body = await readJson(request, 4 * 1024);
      onlyFields(body, ['id']);
      projects.check(body.id);
      return { status: 202, body: { ok: true } };
    }),
    // «Implementiamo» / «Non interessa»: the client names an entry by its key; its text comes from the news of the core.
    route('POST', '/api/dev/projects/choice', async (request) => {
      const { home, gate = viaGateway, projectRecorded = (key: string, choice: string) => appendEvent(sql, { kind: 'dev.project_news_choice', label: 'L0', payload: { key: eventKey(key), choice } }) } = need();
      const projects = needProjects();
      const body = await readJson(request, 4 * 1024);
      onlyFields(body, ['key', 'choice']);
      const { key, choice } = body;
      if (typeof key !== 'string' || !PROJECT_KEY.test(key)) throw new HttpError(400, 'key must be the key of a news entry');
      if (choice !== 'implement' && choice !== 'skip') throw new HttpError(400, 'choice must be implement or skip');
      const found = projects.findItem(key);
      if (found === undefined) throw new HttpError(404, 'the news entry is no longer there');
      let saved;
      try {
        saved = await saveProjectChoice(home, found.item, { id: found.project.id, from: found.news.from, to: found.news.to }, choice, gate);
      } catch (error) {
        if (!(error instanceof DevAnswerError)) throw error;
        throw new HttpError({ invalid: 400, 'unknown-question': 404, blocked: 422, unavailable: 503 }[error.code], error.message);
      }
      if (saved.already) return { status: 200, body: saved };
      let logged = true;
      try {
        await projectRecorded(saved.key, choice);
      } catch (error) {
        logged = false;
        onError(error);
      }
      return { status: 201, body: { ...saved, logged } };
    }),
  ];
}

/**
 * «Su di te» (D-114, tappa A): the facts of the user's profile, read and
 * written only by the page of the Settings in the local web chat; no agent or
 * tool reaches these calls. Making a fact shareable (L2 → L1) is prepared and
 * confirmed, as a privacy change of the Settings (D-071).
 */
function profileRoutes(sql: Sql): Route[] {
  const facts = createUserFacts(sql);
  return [
    route('GET', '/api/profile/facts', async () => ({ body: { facts: await facts.list(), max: { topic: MAX_TOPIC, text: MAX_FACT_TEXT } } })),
    route('POST', '/api/profile/facts', async (request) => ({ status: 201, body: { fact: await facts.create(await readJson(request)) } })),
    route('POST', '/api/profile/facts/share/confirm', async (request) => ({ body: { fact: await facts.confirmShare(await readJson(request)) } })),
    route('POST', '/api/profile/facts/:id', async (request, _url, params) => ({ body: { fact: await facts.update(idParam(params, 'id'), await readJson(request)) } })),
    route('DELETE', '/api/profile/facts/:id', async (request, _url, params) => {
      const id = idParam(params, 'id');
      onlyFields(await readJson(request), []);
      await facts.remove(id);
      return { body: { ok: true } };
    }),
    route('POST', '/api/profile/facts/:id/share/prepare', async (request, _url, params) => ({ body: await facts.prepareShare(idParam(params, 'id'), await readJson(request)) })),
  ];
}

/**
 * "Novità": the register of the versions from CHANGELOG.md, documentation of
 * the repository (L2 by default, as the documents of D-102), served only to
 * the local web chat like /api/dev/progress.
 */
function changelogRoutes(changelog: { home: string } | undefined): Route[] {
  return [
    route('GET', '/api/changelog', () => {
      if (changelog === undefined) throw new HttpError(404, 'not found');
      return Promise.resolve({ body: { changelog: loadChangelog(changelog.home) } });
    }),
  ];
}

/**
 * The user's agents (D-119). Promotion into agents/ lifts the L1/A1 ceiling:
 * it needs `{ confirm: true }`, sent only by the confirmation of the page;
 * so does taking it back, and a deletion needs the agent's name.
 */
function userAgentRoutes(userAgents: UserAgents | undefined, reports?: SafetyReports, translations?: SkillTranslations): Route[] {
  const need = (): UserAgents => {
    if (userAgents === undefined) throw new HttpError(404, 'not found');
    return userAgents;
  };
  const answer = async (run: () => Result | Promise<Result>): Promise<Result> => {
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof UserAgentError)) throw error;
      throw new HttpError(error.code === 'not-found' ? 404 : error.code === 'conflict' ? 409 : 400, error.message);
    }
  };
  const name = (params: Params): string => params.id ?? '';
  /**
   * D-196: an agent made from the catalog carries its safety report; the list starts the ones
   * whose texts changed (skills assigned or changed) or that may run again now (Claude back).
   */
  const withSafety = (agent: UserAgentView): UserAgentView & { safety?: SafetyView; descriptionIt?: string } => {
    if (agent.catalog === undefined) return agent;
    // The description of a role, in Italian when it was translated (shown; the card keeps the original for Arianna).
    const descriptionIt = translations?.lookup(agent.description);
    const safety = reports?.ensure(agent.name);
    return { ...agent, ...(safety === undefined ? {} : { safety }), ...(descriptionIt === undefined ? {} : { descriptionIt }) };
  };
  return [
    route('GET', '/api/agents', () =>
      answer(() => {
        const listing = need().list();
        return { body: { ...listing, user: listing.user.map(withSafety) } };
      }),
    ),
    // «Rifai il rapporto» (D-196): never a second report while one runs for the same agent.
    route('POST', '/api/agents/:id/safety', async (request, _url, params) => {
      onlyFields(await readJson(request), []);
      return answer(() => {
        const safety = reports?.redo(name(params));
        if (safety === undefined) throw new HttpError(404, 'no safety report for this agent');
        return { body: { safety } };
      });
    }),
    route('GET', '/api/agents/sources', () => answer(() => ({ body: need().sources() }))),
    // Tappa T3b: a card is written only as `prepare` showed it, with the confirmation id it returned.
    // A role of the catalog of agents (D-079): only the role, a name, permissions and the yes to a missing license;
    // description and prompt come from the role, read again by the core.
    route('POST', '/api/agents/prepare', async (request) => {
      const service = need();
      const body = await readJson(request);
      if (Object.hasOwn(body, 'from')) {
        onlyFields(body, ['from', 'name', 'permissions']);
        return answer(() => ({ body: { proposal: service.prepareFromCatalog(body as unknown as CatalogNewUserAgent) } }));
      }
      onlyFields(body, ['name', 'description', 'prompt', 'permissions']);
      return answer(() => ({ body: { proposal: service.prepareCreate(body as unknown as NewUserAgent) } }));
    }),
    route('POST', '/api/agents', async (request) => {
      const service = need();
      const body = await readJson(request);
      if (Object.hasOwn(body, 'from')) {
        onlyFields(body, ['from', 'name', 'permissions', 'licenseAccepted', 'confirmation']);
        return answer(() => {
          const agent = service.createFromCatalog(body as unknown as CatalogNewUserAgent);
          // D-196: the report of the role is the catalog's (made when the role was opened); missing, it starts now.
          return { status: 201, body: { agent: withSafety(agent) } };
        });
      }
      onlyFields(body, ['name', 'description', 'prompt', 'permissions', 'confirmation']);
      return answer(() => ({ status: 201, body: { agent: service.create(body as unknown as ConfirmedNewUserAgent) } }));
    }),
    route('GET', '/api/agents/:id/permissions', (_request, _url, params) => answer(() => ({ body: { agent: need().permissions(name(params)) } }))),
    // A role of the catalog adopted again (D-079, tappa 4): what changes first, then only with that confirmation; the agent turns off.
    route('POST', '/api/agents/:id/reapply/prepare', async (request, _url, params) => {
      const service = need();
      onlyFields(await readJson(request), []);
      return answer(() => ({ body: { reapply: service.prepareReapply(name(params)) } }));
    }),
    route('POST', '/api/agents/:id/reapply', async (request, _url, params) => {
      const service = need();
      const body = await readJson(request);
      onlyFields(body, ['confirmation', 'licenseAccepted']);
      return answer(() => {
        const previous = service.catalogRole(name(params));
        const agent = service.reapply(name(params), body);
        // D-196: the new version of the role, read only in the lines that changed (once: another agent of the same role shares it).
        const now = service.catalogRole(agent.name);
        if (reports !== undefined && previous !== undefined && now !== undefined) {
          reports.changed({ kind: 'role', id: now.id, name: now.path, text: now.text, commit: now.commit }, { text: previous.text });
        }
        return { body: { agent: withSafety(agent) } };
      });
    }),
    route('POST', '/api/agents/:id/activate', async (request, _url, params) => {
      const service = need();
      onlyFields(await readJson(request), []);
      return answer(() => ({ body: { agent: service.activate(name(params)) } }));
    }),
    route('POST', '/api/agents/:id/deactivate', async (request, _url, params) => {
      const service = need();
      onlyFields(await readJson(request), []);
      return answer(() => ({ body: { agent: service.deactivate(name(params)) } }));
    }),
    route('POST', '/api/agents/:id/promote', async (request, _url, params) => {
      const service = need();
      const body = await readJson(request);
      onlyFields(body, ['confirm']);
      return answer(() => ({ body: { agent: service.promote(name(params), body.confirm) } }));
    }),
    // Tappa T3: read and change the texts, delete a disabled agent (its name as confirmation), take back a promotion.
    // The prompt is the user's own text (L1 by declaration), served only to the local web chat like the personas.
    route('GET', '/api/agents/:id/prompt', (_request, _url, params) => answer(() => ({ body: { prompt: need().prompt(name(params)) } }))),
    route('POST', '/api/agents/:id/prepare', async (request, _url, params) => {
      const service = need();
      const body = await readJson(request);
      onlyFields(body, ['description', 'prompt', 'permissions']);
      return answer(() => ({ body: { proposal: service.prepareEdit(name(params), body) } }));
    }),
    route('POST', '/api/agents/:id/edit', async (request, _url, params) => {
      const service = need();
      const body = await readJson(request);
      onlyFields(body, ['description', 'prompt', 'permissions', 'confirmation']);
      return answer(() => ({ body: { agent: service.update(name(params), body) } }));
    }),
    route('POST', '/api/agents/:id/delete', async (request, _url, params) => {
      const service = need();
      const body = await readJson(request);
      onlyFields(body, ['confirm']);
      return answer(() => ({ body: { deleted: service.remove(name(params), body.confirm) } }));
    }),
    route('POST', '/api/agents/:id/demote', async (request, _url, params) => {
      const service = need();
      const body = await readJson(request);
      onlyFields(body, ['confirm']);
      return answer(() => ({ body: { agent: service.demote(name(params), body.confirm) } }));
    }),
  ];
}

const SPRITE_STATUS: Record<SpriteError['code'], number> = { invalid: 400, unavailable: 409, busy: 409, blocked: 403, quota: 429, failed: 502, 'bad-reply': 502 };

/**
 * A character drawn by the model of `[sprites]` (D-123): what draws and what
 * leaves (GET), and one drawing (POST), returned as a PNG in base64 and never
 * saved here: "Tieni" sends it to /api/characters/upload (D-118).
 */
function spriteRoutes(sprites: SpriteGenerator | undefined): Route[] {
  const need = (): SpriteGenerator => {
    if (sprites === undefined) throw new HttpError(404, 'not found');
    return sprites;
  };
  return [
    route('GET', '/api/characters/generate', () => Promise.resolve({ body: need().info() })),
    route('POST', '/api/characters/generate', async (request) => {
      const service = need();
      const body = await readJson(request);
      // A page closed meanwhile stops the drawing: no quota spent for nobody, and the next one is not "busy".
      const closed = new AbortController();
      const abort = (): void => {
        closed.abort();
      };
      request.socket.once('close', abort);
      try {
        const drawn = await service.generate(body, closed.signal);
        return { body: { png: drawn.png.toString('base64'), rows: drawn.rows, model: drawn.model, label: drawn.label } };
      } catch (error) {
        if (!(error instanceof SpriteError)) throw error;
        return { status: SPRITE_STATUS[error.code], body: { error: error.message, code: error.code, resetsAt: error.resetsAt?.toISOString() ?? null } };
      } finally {
        // A kept-alive socket serves the next requests: no listener left behind.
        request.socket.off('close', abort);
      }
    }),
  ];
}

const IM_REPORT_STATUS: Record<ImReportError['code'], number> = {
  invalid: 400,
  'not-found': 404,
  'has-report': 409,
  busy: 409,
  'above-label': 403,
  unavailable: 409,
  blocked: 403,
  quota: 429,
  failed: 502,
  empty: 502,
  changed: 409,
};

/**
 * "Scrivi il report" of an IM (D-167, P4c): POST starts it with the agent the
 * user picked and in the language chosen (202 and the job; 409 `has-report` when the section has text,
 * unless `replace`), GET says how the last job of the IM went.
 */
function imReportRoutes(reporter: ImReporter | undefined, containers: () => readonly Project[]): Route[] {
  const need = (): ImReporter => {
    if (reporter === undefined) throw new HttpError(404, 'not found');
    return reporter;
  };
  const projectOf = (params: Params): string => {
    const name = params.project ?? '';
    if (!PROJECT_PARAM.test(name) || !containers().some((item) => item.name === name)) throw new HttpError(404, 'not found');
    return name;
  };
  return [
    route('GET', '/api/browse/:project/im/:number/report', (_request, _url, params) => {
      const service = need();
      return Promise.resolve({ body: { job: service.status(projectOf(params), imNumberParam(params)) } });
    }),
    route('POST', '/api/browse/:project/im/:number/report', async (request, _url, params) => {
      const service = need();
      const project = projectOf(params);
      const number = imNumberParam(params);
      const body = await readJson(request);
      onlyFields(body, ['agent', 'replace', 'language']);
      const agent = REPORT_AGENTS.find((value) => value === body.agent);
      if (agent === undefined) throw new HttpError(400, 'agent must be arianna or claude');
      if (body.replace !== undefined && typeof body.replace !== 'boolean') throw new HttpError(400, 'replace must be true or false');
      // Italian or English, chosen each time like the agent (D-167); Italian when not said.
      const language = body.language === undefined ? 'it' : REPORT_LANGUAGES.find((value) => value === body.language);
      if (language === undefined) throw new HttpError(400, 'language must be it or en');
      try {
        return { status: 202, body: { job: service.start(project, number, agent, body.replace === true, language) } };
      } catch (error) {
        if (!(error instanceof ImReportError)) throw error;
        return { status: IM_REPORT_STATUS[error.code], body: { error: error.message, code: error.code, detail: error.detail ?? null } };
      }
    }),
  ];
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

/** A file of the built web chat; unknown paths get index.html (client-side routes). */
async function staticFile(dir: string, pathname: string): Promise<{ body: Buffer; type: string } | undefined> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  if (decoded.includes('\0')) return undefined;
  const root = await realpath(normalize(dir)).catch(() => undefined);
  if (root === undefined) return undefined;
  const inside = (path: string): boolean => path === root || path.startsWith(root + sep);
  const candidate = normalize(join(root, decoded));
  if (!inside(candidate)) return undefined;
  for (const path of [candidate, join(root, 'index.html')]) {
    try {
      // A symbolic link inside the folder must not lead out of it.
      if (!inside(await realpath(path)) || !(await stat(path)).isFile()) continue;
      return { body: await readFile(path), type: CONTENT_TYPES[extname(path)] ?? 'application/octet-stream' };
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

/**
 * The first line is awaited before the headers, so a refused request still
 * gets its error status; then each line goes out as it comes. A client that
 * goes away stops the producer (the iterator's `return`).
 */
async function sendLines(response: ServerResponse, lines: AsyncIterableIterator<unknown>, headers: Record<string, string>): Promise<void> {
  const gone = () => {
    if (!response.writableFinished) void lines.return?.();
  };
  response.on('close', gone);
  try {
    let item = await lines.next();
    response.writeHead(200, { ...headers, 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
    while (item.done !== true) {
      response.write(`${JSON.stringify(item.value)}\n`);
      item = await lines.next();
    }
    response.end();
  } finally {
    response.off('close', gone);
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string>): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    ...headers,
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  response.end(text);
}

function errorStatus(error: unknown): { status: number; message: string } | undefined {
  if (error instanceof HttpError) return { status: error.status, message: error.message };
  if (error instanceof ChatError) {
    const status =
      error.code === 'not-found'
        ? 404
        : error.code === 'scanner'
          ? 422
          : error.code === 'archived' || error.code === 'busy' || error.code === 'incognito' || error.code === 'not-incognito'
            ? 409
            : 400;
    return { status, message: error.message };
  }
  if (error instanceof TaskError) return { status: 409, message: 'the task cannot do this now' };
  if (error instanceof RoutineError) return { status: { invalid: 400, 'not-found': 404, conflict: 409 }[error.code], message: error.message };
  if (error instanceof TrialError || error instanceof CloneError || error instanceof PushError || error instanceof ScheduleError) return { status: 400, message: error.message };
  if (error instanceof CallError) {
    const status = { 'not-found': 404, invalid: 400, archived: 409, busy: 409, 'voice-off': 503, 'not-ready': 409, unauthorized: 401, ended: 409, 'agent-off': 409 }[error.code];
    return { status, message: error.code === 'unauthorized' ? 'unauthorized' : `${error.code}: ${error.message}` };
  }
  if (error instanceof SettingsError) {
    const status = { invalid: 400, changed: 409, unreadable: 409, unknown: 404, expired: 410 }[error.code];
    return { status, message: error.message };
  }
  if (error instanceof CaptureError) {
    const status = { invalid: 400, 'too-large': 413, 'not-allowed': 403, unavailable: 503 }[error.code];
    return { status, message: error.message };
  }
  if (error instanceof NoteError) {
    const status = { invalid: 400, 'not-found': 404, 'above-clearance': 403, conflict: 409, changed: 409, unavailable: 503 }[error.code];
    return { status, message: error.message };
  }
  if (error instanceof ServiceError) return { status: error.code === 'unknown' ? 404 : 409, message: error.message };
  if (error instanceof ProjectFileError) return { status: PROJECT_FILE_STATUS[error.code], message: error.message };
  if (error instanceof StyleExampleError) return { status: error.code === 'invalid' ? 400 : 404, message: error.message };
  if (error instanceof DelegationFileError) {
    const status = { 'not-found': 404, deleted: 410, 'not-approved': 403, refused: 403, 'too-large': 413, binary: 415, archived: 409, busy: 409 }[error.code];
    return { status, message: error.message };
  }
  if (error instanceof ImError) {
    const status = { invalid: 400, 'not-found': 404, changed: 409, refused: 403, unavailable: 503, ended: 409 }[error.code];
    return { status, message: error.message };
  }
  if (error instanceof ImBillingError) return { status: { invalid: 400, 'not-found': 404, conflict: 409 }[error.code], message: error.message };
  if (error instanceof FactsError) return { status: FACTS_STATUS[error.code], message: `${error.code}: ${error.message}` };
  if (error instanceof ReleaseError) return { status: RELEASE_STATUS[error.code], message: `${error.code}: ${error.message}` };
  if (error instanceof ArchiveError) return { status: ARCHIVE_STATUS[error.code], message: `${error.code}: ${error.message}` };
  if (error instanceof WikiError) return { status: WIKI_STATUS[error.code], message: `${error.code}: ${error.message}` };
  if (error instanceof KnowledgeError) {
    const status = { changed: 409, invalid: 400, 'not-found': 404, refused: 403, 'too-large': 413, unavailable: 503 }[error.code];
    return { status, message: error.message };
  }
  if (error instanceof SearchError) return { status: 400, message: error.message };
  if (error instanceof AttachmentError) {
    const status = { invalid: 400, 'too-large': 413, type: 415, 'not-found': 404, conflict: 409, 'no-vision': 409 }[error.code];
    return { status, message: error.message };
  }
  if (error instanceof UploadError) return { status: error.code === 'invalid' ? 400 : 409, message: error.message };
  if (error instanceof HubError) return { status: { invalid: 400, blocked: 403, 'not-found': 404, conflict: 409, upstream: 502 }[error.code], message: error.message };
  if (error instanceof GodCloneError) return { status: 409, message: error.message };
  if (error instanceof GodError) return { status: { invalid: 400, 'not-found': 404, conflict: 409 }[error.code], message: error.message };
  if (error instanceof DesignCatalogError) return { status: { invalid: 400, 'not-found': 404, conflict: 409, blocked: 403, failed: 502 }[error.code], message: error.message };
  if (error instanceof ModelActionError) return { status: { 'not-found': 404, invalid: 400, conflict: 409 }[error.code], message: error.message };
  if (error instanceof ModelEvalError) return { status: { 'not-found': 404, invalid: 400, conflict: 409 }[error.code], message: error.message };
  if (error instanceof VoiceError) return { status: 503, message: error.code === 'off' ? 'voice not ready' : 'voice unreachable' };
  return undefined;
}

const AGENT_PARAM = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * The participants of a conversation (D-125): who is in it besides the user
 * and Arianna, with where each runs; the user takes one out with a click.
 */
function participantRoutes(sql: Sql, agentOf: NonNullable<ApiServerOptions['participantAgent']>): Route[] {
  return [
    route('GET', '/api/conversations/:id/participants', async (_request, _url, params) => {
      const id = idParam(params, 'id');
      if ((await loadConversation(sql, id)) === undefined) throw new HttpError(404, 'not found');
      const participants = (await activeParticipants(sql, id)).map((participant) => ({ ...participant, executor: agentOf(participant.agent)?.executor ?? null }));
      return { body: { participants } };
    }),
    route('POST', '/api/conversations/:id/participants/:agent/remove', async (request, _url, params) => {
      const id = idParam(params, 'id');
      const agent = params.agent ?? '';
      if (!AGENT_PARAM.test(agent)) throw new HttpError(404, 'not found');
      onlyFields(await readJson(request), []);
      await removeParticipant(sql, id, agent, agentOf(agent)?.nameLabel ?? 'L1');
      return { body: { removed: agent } };
    }),
  ];
}

const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * `{"type":"visibility","visible":true|false,"focused":true|false,"conversation":"<id>"|null}`,
 * the only frame a page may send; undefined for anything else. `focused`
 * (D-128): the page is also the window in front; without it, as visible.
 * `conversation`: the one open in the page, an id and nothing else; without
 * it, none.
 */
export function visibilityOf(frame: string): { visible: boolean; focused: boolean; conversation: string | null } | undefined {
  let value: unknown;
  try {
    value = JSON.parse(frame);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.some((key) => !['type', 'visible', 'focused', 'conversation'].includes(key))) return undefined;
  const { type, visible, focused, conversation } = value as { type?: unknown; visible?: unknown; focused?: unknown; conversation?: unknown };
  if (type !== 'visibility' || typeof visible !== 'boolean') return undefined;
  if (focused !== undefined && typeof focused !== 'boolean') return undefined;
  if (conversation !== undefined && conversation !== null && (typeof conversation !== 'string' || !CONVERSATION_ID.test(conversation))) return undefined;
  return { visible, focused: visible && (focused ?? true), conversation: typeof conversation === 'string' ? conversation : null };
}

const INCOGNITO_CAUSES: readonly IncognitoCause[] = ['user', 'idle', 'restart'];

/** `{"type":"conversation.incognito-closed","conversationId","cause"}` for the event of the same kind (D-136); undefined for any other. */
export function incognitoClosedFrame(event: { kind: string; payload: unknown }): { type: 'conversation.incognito-closed'; conversationId: string; cause: IncognitoCause } | undefined {
  if (event.kind !== 'conversation.incognito-closed') return undefined;
  const payload = (typeof event.payload === 'object' && event.payload !== null ? event.payload : {}) as { conversationId?: unknown; cause?: unknown };
  const cause = INCOGNITO_CAUSES.find((item) => item === payload.cause);
  if (typeof payload.conversationId !== 'string' || cause === undefined) return undefined;
  return { type: 'conversation.incognito-closed', conversationId: payload.conversationId, cause };
}

const SCREEN_PATH = '/api/browser/screen';
/** Client messages of RFB are small (SetEncodings at most 260 bytes); a dropped clipboard spans frames. */
export const SCREEN_MAX_PAYLOAD = 4096;

/**
 * The token of the screen of the browser (D-264, passo 4): only for the
 * conversation holding the browser now, never a Private or incognito one.
 */
function browserScreenRoutes(screens: BrowserScreens | undefined): Route[] {
  return [
    route('POST', SCREEN_PATH, async (request) => {
      if (screens === undefined) throw new HttpError(404, 'not found');
      const body = await readJson(request);
      onlyFields(body, ['conversationId']);
      const { conversationId } = body;
      if (typeof conversationId !== 'string' || !isUuid(conversationId)) throw new HttpError(400, 'conversationId must be a conversation id');
      const issued = await screens.issue(conversationId);
      if (issued.ok) return { body: { token: issued.token } };
      if (issued.reason === 'not-found') throw new HttpError(404, 'not found');
      if (issued.reason === 'no-browser') return { status: 409, body: { error: 'no-browser' } };
      if (issued.reason === 'too-many-screens') return { status: 409, body: { error: 'too-many-screens' } };
      return { status: 403, body: { error: issued.reason } };
    }),
    // Whether the conversation holds the browser now: the bar of the chat above the composer.
    // With `screen` (the token of an open screen, D-264 passo 5): whether that screen drives.
    route('GET', SCREEN_PATH, async (_request, url) => {
      if (screens === undefined) throw new HttpError(404, 'not found');
      const conversationId = url.searchParams.get('conversationId');
      if (conversationId === null || !isUuid(conversationId)) throw new HttpError(400, 'conversationId must be a conversation id');
      const screen = url.searchParams.get('screen') ?? undefined;
      const status = await screens.status(conversationId, screen);
      if (status === null) throw new HttpError(404, 'not found');
      return { body: status };
    }),
    // «Chiudi» in the chat: the browser of that conversation closes after the action under way.
    route('POST', '/api/browser/close', async (request) => {
      if (screens === undefined) throw new HttpError(404, 'not found');
      const body = await readJson(request);
      onlyFields(body, ['conversationId']);
      const { conversationId } = body;
      if (typeof conversationId !== 'string' || !isUuid(conversationId)) throw new HttpError(400, 'conversationId must be a conversation id');
      const closed = await screens.closeByUser(conversationId);
      if (closed === 'not-found') throw new HttpError(404, 'not found');
      if (closed === 'no-browser') return { status: 409, body: { error: 'no-browser' } };
      return { body: { closed: true } };
    }),
    // «Prendi il controllo» and «Restituisci ad Arianna» (D-264, passo 5). `take` names the screen by its
    // token; 202 while Arianna ends the action under way (the chat reads the status until it is its own).
    route('POST', '/api/browser/control', async (request) => {
      if (screens === undefined) throw new HttpError(404, 'not found');
      const body = await readJson(request);
      onlyFields(body, ['conversationId', 'action', 'screen']);
      const { conversationId, action, screen } = body;
      if (typeof conversationId !== 'string' || !isUuid(conversationId)) throw new HttpError(400, 'conversationId must be a conversation id');
      if (action === 'return') {
        if (screen !== undefined) throw new HttpError(400, 'return takes no screen');
        const returned = await screens.giveBack(conversationId);
        if (returned === 'not-found') throw new HttpError(404, 'not found');
        if (returned === 'not-driving') return { status: 409, body: { error: 'not-driving' } };
        return { body: { control: 'agent' } };
      }
      if (action !== 'take') throw new HttpError(400, 'action must be take or return');
      if (typeof screen !== 'string' || screen.length > 64) throw new HttpError(400, 'screen must be the token of an open screen');
      const taken = await screens.take(conversationId, screen);
      if (!taken.ok) {
        if (taken.reason === 'not-found') throw new HttpError(404, 'not found');
        return { status: 409, body: { error: taken.reason } };
      }
      if (taken.waiting) {
        taken.done.catch(() => undefined);
        return { status: 202, body: { waiting: true } };
      }
      if (!(await taken.done.catch(() => false))) return { status: 409, body: { error: 'no-browser' } };
      return { body: { control: 'you' } };
    }),
  ];
}

export async function startApiServer(options: ApiServerOptions): Promise<ApiServer> {
  const { sql, live } = options;
  const table = routes(sql, {
    projects: options.projects ?? (() => []),
    models: options.models ?? (() => []),
    defaultModel: options.defaultModel ?? (() => undefined),
    agents: options.agents ?? (() => []),
    financeAgents: options.financeAgents ?? (() => []),
    characters: options.characters,
    voice: options.voice,
    calls: options.calls,
    pusher: options.pusher ?? (() => undefined),
    settings: options.settings,
    local: options.local,
    capture: options.capture,
    modelEvals: options.modelEvals,
    advisorData: options.advisorData,
    changes: options.changes,
    approvedProjects: options.approvedProjects ?? (() => []),
    projectContainers: options.projectContainers ?? (() => []),
    cards: options.cards,
    clients: options.clients,
    knowledge: options.knowledge,
    rulesDraft: options.rulesDraft,
    dashboardSuggest: options.dashboardSuggest,
    dashboardChart: options.dashboardChart,
    rulesExport: options.rulesExport,
    noteRelease: options.noteRelease,
    installation: options.installation,
    readiness: options.readiness,
    onError: options.onError ?? (() => undefined),
    directAgents: options.directAgents,
    offInterlocutors: options.offInterlocutors,
    chatCharacters: options.chatCharacters,
    chatFolderGone: options.chatFolderGone,
    trialRefusal: options.trialRefusal,
    services: options.services,
    leaveRule: options.leaveRule,
    stopChat: options.stopChat,
    stopCard: options.stopCard,
    mentionable: options.mentionable,
    planAssignees: options.planAssignees,
    incognito: options.incognito,
    erase: options.erase,
    attachments: options.attachments,
    designCatalog: options.designCatalog,
    skillsCatalog: options.skillsCatalog,
    routines: options.routines,
  });
  table.push(...devRoutes(sql, options.devProgress, options.onError ?? (() => undefined)));
  table.push(...profileRoutes(sql));
  table.push(...attachmentRoutes(sql, options.attachments));
  // The service worker asks what an empty push was about (I-1); null when nothing recent.
  table.push(route('GET', '/api/notifications/latest', () => Promise.resolve({ body: { notice: options.notices?.latest() ?? null } })));
  // A trial notice (I-1): the same way as a real one, to every open page, with no conversation;
  // asked by a click, so neither [notifications] nor the quiet hours hold it back. No push.
  table.push(
    route('POST', '/api/notifications/test', async (request) => {
      const body = await readJson(request);
      onlyFields(body, ['kind']);
      const kind = body.kind;
      if (kind !== 'reply' && kind !== 'approval' && kind !== 'failure') throw new HttpError(400, 'kind must be reply, approval or failure');
      const helper = helpers.size > 0;
      return { body: { sent: kind, pages: broadcastNotice({ kind, conversationId: null, helper }, true), helpers: noticeToHelpers({ kind, conversationId: null }) } };
    }),
  );
  // Whether the helper of the Mac is connected (D-128): the page then leaves the notifications of the system to it.
  table.push(route('GET', '/api/notifications/helper', () => Promise.resolve({ body: { connected: helpers.size > 0 } })));
  // A page on this Mac says which push address is its own (D-128): while the helper is connected, notices skip it.
  // In memory: the page says it again at every connection of the live feed.
  table.push(
    route('POST', '/api/notifications/this-mac', async (request) => {
      const body = await readJson(request);
      onlyFields(body, ['endpoint']);
      const { endpoint } = body;
      if (typeof endpoint !== 'string' || !isPushEndpoint(endpoint)) throw new HttpError(400, 'endpoint must be a push address');
      if (!macEndpoints.has(endpoint) && macEndpoints.size >= MAX_MAC_ENDPOINTS) {
        const oldest = macEndpoints.values().next().value;
        if (oldest !== undefined) macEndpoints.delete(oldest);
      }
      macEndpoints.add(endpoint);
      return { body: { ok: true } };
    }),
  );
  table.push(...changelogRoutes(options.changelog));
  table.push(...userAgentRoutes(options.userAgents, options.safetyReports, options.roleTranslations));
  table.push(...participantRoutes(sql, options.participantAgent ?? (() => undefined)));
  table.push(...spriteRoutes(options.sprites));
  table.push(...imReportRoutes(options.imReports, options.projectContainers ?? (() => [])));
  // The "Modelli" page (I-3): one list, read only. /api/models stays the selector of a conversation.
  table.push(
    route('GET', '/api/models/overview', async () => {
      if (options.modelsOverview === undefined) throw new HttpError(404, 'not found');
      return { body: await options.modelsOverview() };
    }),
  );
  table.push(...huggingFaceRoutes(options.huggingface));
  table.push(...omlxReleaseRoutes(options.omlxReleases));
  table.push(...modelActionRoutes(options.modelActions));
  table.push(
    route('POST', '/api/models/reload/dismiss', async (request) => {
      onlyFields(await readJson(request), []);
      if (options.modelReload === undefined) throw new HttpError(404, 'not found');
      options.modelReload.dismiss();
      return { body: { ok: true } };
    }),
  );
  table.push(...designCatalogRoutes(options.designCatalog));
  table.push(...exampleRoutes(options.styleExamples, options.skillTranslations));
  table.push(...seriesLinesRoutes(options.seriesLines));
  table.push(...skillsCatalogRoutes(options.skillsCatalog, options.safetyReports));
  table.push(...agentsCatalogRoutes(options.agentsCatalog, options.safetyReports, options.roleTranslations));
  table.push(...godRoutes(options.god));
  table.push(...studioRoutes(sql, options.approvedProjects ?? (() => []), options.studioPptx));
  table.push(...browserScreenRoutes(options.browserScreens));
  const sockets = new Set<WebSocket>();
  /** The pages that last said they are in view (I-1). */
  const visible = new Set<WebSocket>();
  /** The pages also in front (D-128), with the conversation each has open: the helper is silent only for that one. */
  const focused = new Map<WebSocket, string | null>();
  /** The conversation each page said it has open, in view or not (D-136). */
  const openOn = new Map<WebSocket, string>();
  /** To every open page; how many it reached. */
  function broadcastNotice(notice: Notice & { kind: NoticeKind; helper?: boolean }, trial = false): number {
    const frame = JSON.stringify({
      type: 'notice',
      kind: notice.kind,
      conversationId: notice.conversationId,
      ...(trial ? { trial: true } : {}),
      ...(notice.helper === true ? { helper: true } : {}),
    });
    let reached = 0;
    for (const ws of sockets) {
      if (ws.readyState !== ws.OPEN || ws.bufferedAmount > MAX_BUFFERED_BYTES) continue;
      ws.send(frame);
      reached += 1;
    }
    return reached;
  }
  /**
   * The native helpers of the Mac (D-128): events sent by the server, one
   * per notice, kind and conversation id only. Same Host and Origin checks as
   * every request; the header says it is the helper, which an EventSource of
   * a page cannot send, so no page counts as one by mistake.
   */
  const helpers = new Set<ServerResponse>();
  /** The push addresses of the browsers on this Mac (D-128). */
  const macEndpoints = new Set<string>();
  function openHelperStream(request: IncomingMessage, response: ServerResponse, headers: Record<string, string>): void {
    if (request.headers['x-arianna-helper'] !== '1') {
      sendJson(response, 400, { error: 'only the helper of the Mac reads this stream' }, headers);
      return;
    }
    if (helpers.size >= MAX_HELPERS) {
      sendJson(response, 429, { error: 'too many helpers' }, headers);
      return;
    }
    response.writeHead(200, { ...headers, 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
    response.write(': arianna\n\n');
    helpers.add(response);
    // A comment now and then: a dead connection shows up, and nothing in between closes an idle one.
    const beat = setInterval(() => response.write(': beat\n\n'), HELPER_BEAT_MS);
    response.on('close', () => {
      clearInterval(beat);
      helpers.delete(response);
    });
  }
  /** To every helper; how many it reached. */
  function noticeToHelpers(notice: Notice & { kind: NoticeKind }): number {
    const frame = `event: notice\ndata: ${JSON.stringify({ kind: notice.kind, conversationId: notice.conversationId })}\n\n`;
    let reached = 0;
    for (const response of helpers) {
      if (response.writableLength > MAX_BUFFERED_BYTES) continue;
      response.write(frame);
      reached += 1;
    }
    return reached;
  }
  let hosts = allowedHosts(options.host, options.port);

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const host = request.headers.host?.toLowerCase() ?? '';
    const headers = securityHeaders(host);
    const check = checkRequest(
      { method: request.method ?? 'GET', host: request.headers.host, origin: request.headers.origin, contentType: request.headers['content-type'] },
      hosts,
    );
    if (!check.ok) {
      sendJson(response, check.status, { error: check.reason }, headers);
      return;
    }
    const url = new URL(request.url ?? '/', `http://${host}`);
    if (request.method === 'GET' && url.pathname === '/api/notifications/stream') {
      openHelperStream(request, response, headers);
      return;
    }
    try {
      if (url.pathname.startsWith('/api/')) {
        const matches = table.map((candidate) => ({ candidate, match: candidate.pattern.exec(url.pathname) })).filter(({ match }) => match !== null);
        if (matches.length === 0) throw new HttpError(404, 'not found');
        const found = matches.find(({ candidate }) => candidate.method === request.method);
        if (found === undefined) throw new HttpError(405, 'method not allowed');
        const params: Params = {};
        found.candidate.keys.forEach((key, index) => {
          params[key] = found.match?.[index + 1] ?? '';
        });
        const result = await found.candidate.handler(request, url, params);
        if ('lines' in result) {
          await sendLines(response, result.lines, headers);
        } else if ('raw' in result) {
          response.writeHead(200, { ...headers, ...result.headers, 'content-type': result.type, 'content-length': result.raw.length, 'cache-control': result.noStore === true ? 'no-store' : 'no-cache' });
          response.end(result.raw);
        } else if (result.status === 204) {
          response.writeHead(204, { ...headers, 'cache-control': 'no-store' });
          response.end();
        } else {
          sendJson(response, result.status ?? 200, result.body, headers);
        }
        return;
      }
      if ((request.method === 'GET' || request.method === 'HEAD') && options.staticDir !== undefined) {
        const file = await staticFile(options.staticDir, url.pathname);
        if (file !== undefined) {
          response.writeHead(200, { ...headers, 'content-type': file.type, 'content-length': file.body.length, 'cache-control': 'no-cache' });
          response.end(request.method === 'HEAD' ? undefined : file.body);
          return;
        }
      }
      throw new HttpError(404, 'not found');
    } catch (error) {
      const known = errorStatus(error);
      if (known === undefined) options.onError?.(error);
      if (response.headersSent) {
        response.destroy();
        return;
      }
      // The rest of an oversized body is not read: close instead of draining it.
      const close: Record<string, string> = known?.status === 413 ? { connection: 'close' } : {};
      sendJson(response, known?.status ?? 500, { error: known?.message ?? 'internal error' }, { ...headers, ...close });
    }
  }

  const server: Server = createServer({ requestTimeout: 30_000, headersTimeout: 10_000 }, (request, response) => {
    void handle(request, response);
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  // The screen of the browser (D-264, passo 4): RFB from the page, small messages only.
  const screenWss = new WebSocketServer({ noServer: true, maxPayload: SCREEN_MAX_PAYLOAD });
  server.on('upgrade', (request: IncomingMessage, socket, head) => {
    socket.on('error', () => {
      socket.destroy();
    });
    const url = new URL(request.url ?? '/', 'http://upgrade');
    const check = checkRequest(
      { method: 'GET', host: request.headers.host, origin: request.headers.origin, contentType: undefined, upgrade: true },
      hosts,
    );
    if (url.pathname === SCREEN_PATH) {
      const screens = options.browserScreens;
      const token = url.searchParams.get('t') ?? '';
      if (screens === undefined || !check.ok || !screens.valid(token)) {
        socket.end(`HTTP/1.1 ${screens === undefined ? '404 Not Found' : '403 Forbidden'}\r\nConnection: close\r\n\r\n`);
        return;
      }
      screenWss.handleUpgrade(request, socket, head, (ws) => {
        screens.attach(token, ws);
      });
      return;
    }
    if (url.pathname !== '/api/ws' || !check.ok) {
      socket.end(`HTTP/1.1 ${url.pathname === '/api/ws' ? '403 Forbidden' : '404 Not Found'}\r\nConnection: close\r\n\r\n`);
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      void connect(ws, url.searchParams.get('after') ?? undefined);
    });
  });

  async function connect(ws: WebSocket, after: string | undefined): Promise<void> {
    sockets.add(ws);
    // An oversized or malformed frame is reported here; without a listener it would stop the process.
    ws.on('error', () => {
      ws.terminate();
    });
    let alive = true;
    ws.on('pong', () => {
      alive = true;
    });
    const ping = setInterval(() => {
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, PING_MS);
    // Nothing is accepted from the client but whether the page is in view
    // (I-1): actions go through HTTP.
    ws.on('message', (data: RawData, isBinary: boolean) => {
      const shown = isBinary || !Buffer.isBuffer(data) ? undefined : visibilityOf(data.toString('utf8'));
      if (shown === undefined) {
        ws.close(1008, 'read-only socket');
        return;
      }
      if (shown.visible) visible.add(ws);
      else visible.delete(ws);
      if (shown.focused) focused.set(ws, shown.conversation);
      else focused.delete(ws);
      if (shown.conversation !== null) openOn.set(ws, shown.conversation);
      else openOn.delete(ws);
    });
    let stop: (() => void) | undefined;
    ws.on('close', () => {
      clearInterval(ping);
      sockets.delete(ws);
      visible.delete(ws);
      focused.delete(ws);
      openOn.delete(ws);
      stop?.();
    });
    const send = (message: LiveMessage | { type: 'ready' }): void => {
      if (ws.readyState !== ws.OPEN) return;
      if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
        ws.close(1013, 'too far behind');
        return;
      }
      ws.send(JSON.stringify(message));
      // The closing of an incognito conversation (D-136), also from the backlog after a restart: its own frame for the chat.
      const closed = message.type === 'event' ? incognitoClosedFrame(message.event) : undefined;
      if (closed !== undefined) ws.send(JSON.stringify(closed));
    };
    try {
      stop = await live.subscribe({ send }, after);
      if (ws.readyState !== ws.OPEN) stop();
      // The backlog is out: from here on everything is live.
      else send({ type: 'ready' });
    } catch (error) {
      options.onError?.(error);
      ws.close(1011, 'internal error');
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  hosts = allowedHosts(options.host, port);

  return {
    port,
    clients: () => sockets.size,
    visiblePages: () => visible.size,
    readingPages: (conversationId) => [...focused.values()].filter((open) => open === conversationId).length,
    broadcast(notice) {
      broadcastNotice(notice);
    },
    helpers: () => helpers.size,
    macEndpoints: () => macEndpoints,
    notifyHelpers: (notice) => noticeToHelpers(notice),
    pagesOn: (conversationId) => [...openOn.values()].filter((open) => open === conversationId).length,
    incognitoClosing(conversationId, inSeconds) {
      const frame = JSON.stringify({ type: 'conversation.incognito-closing', conversationId, inSeconds });
      for (const ws of sockets) {
        if (ws.readyState !== ws.OPEN || ws.bufferedAmount > MAX_BUFFERED_BYTES) continue;
        ws.send(frame);
      }
    },
    async close() {
      for (const response of helpers) response.end();
      for (const ws of sockets) ws.terminate();
      wss.close();
      screenWss.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => { resolve(); }));
    },
  };
}
