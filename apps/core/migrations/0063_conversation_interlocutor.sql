-- «Con chi parli» (D-111, tappa B): besides Arianna (NULL) and the agents of
-- the direct chat (0029), a conversation may be born with the local model
-- (`local-chat`, a card with kb.search and kb.read only) or with Claude or
-- ChatGPT without a project (`claude`, `codex`: a plain chat on the chain of
-- D-064, no tool, an empty folder). See docs/DATA-MODEL.md. Object names are
-- never schema-qualified.
--
-- The mode follows who answers, and both never change (conversations_guard
-- freezes mode and workspace, conversations_agent_fixed of 0027 the agent):
-- the local model only in a private conversation; Claude and ChatGPT only in
-- a work one (L1), without a project (with a project the user talks with the
-- Coder); the Coder only in a work one, on a project. A private conversation
-- never has an interlocutor on the cloud, whatever the core does.

ALTER TABLE conversations ADD CONSTRAINT conversations_agent_local_chat
  CHECK (agent IS DISTINCT FROM 'local-chat' OR mode = 'private');
ALTER TABLE conversations ADD CONSTRAINT conversations_agent_cloud_chat
  CHECK (agent IS NULL OR agent NOT IN ('claude', 'codex') OR (mode = 'work' AND workspace IS NULL));
-- NOT VALID: a conversation of an older installation is not checked again, every new one is.
ALTER TABLE conversations ADD CONSTRAINT conversations_agent_coder_project
  CHECK (agent IS DISTINCT FROM 'coder' OR (mode = 'work' AND workspace IS NOT NULL)) NOT VALID;

-- The model of the plain chat with Claude: Sonnet or Opus, as in a system chat
-- (0014); Fable only with a project, behind the budget approval of the router.
-- NULL is Sonnet. The chat with ChatGPT has no model of Claude's.
ALTER TABLE conversations ADD CONSTRAINT conversations_agent_claude_model
  CHECK (agent IS DISTINCT FROM 'claude' OR model IS NULL OR model IN ('sonnet', 'opus'));
ALTER TABLE conversations ADD CONSTRAINT conversations_agent_local_model
  CHECK (agent IS DISTINCT FROM 'local-chat' OR model IS NULL);
