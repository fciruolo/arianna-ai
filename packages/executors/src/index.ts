export { localEndpoint, localEndpointUrl, LocalEndpointError, type LocalEndpoint } from './local/endpoint.ts';
export {
  createLocalModel,
  LocalModelError,
  type ChatMessage,
  type ChatRequest,
  type ChatResult,
  type LocalModel,
  type LocalModelErrorKind,
  type LocalModelOptions,
} from './local/model.ts';
export {
  Watchdog,
  type RestartReason,
  type WatchdogEvent,
  type WatchdogOptions,
  type WatchdogState,
} from './local/watchdog.ts';
export {
  prepareWorkspace,
  removeWorkspace,
  scanWorkspace,
  WorkspaceError,
  WORKTREES_DIR,
  type PreparedWorkspace,
  type PrepareOptions,
  type WorkspaceOptions,
} from './workspace.ts';
