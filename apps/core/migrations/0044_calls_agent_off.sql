-- Calls in a direct chat (D-158): a call scheduled or "when done" in the
-- direct chat of an agent that cannot answer now (card off, executor off, a
-- mode it does not read, no local model) does not ring: it is skipped with
-- the closed code `agent-off`, as the other skips. Still a code, never a message.
-- Object names are never schema-qualified.

ALTER TABLE calls DROP CONSTRAINT calls_end_reason_check;
ALTER TABLE calls ADD CONSTRAINT calls_end_reason_check CHECK (end_reason IN (
  'hangup', 'time-limit', 'disconnected', 'voice-error', 'core-restart',
  'no-answer', 'quiet-hours', 'daily-limit', 'cancelled', 'agent-off'
));
