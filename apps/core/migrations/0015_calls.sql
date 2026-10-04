-- Calls over the internet (D-066): the web chat talks to apps/voice with
-- WebRTC. See docs/DATA-MODEL.md. Object names are never schema-qualified.

-- ---------------------------------------------------------------------------
-- calls: one row per call, without text. What was said is in messages
-- (channel 'voice'), with the label of the conversation; here only who
-- called, when, how it ended and how many delegations it made. A call the
-- user starts is 'in'; one Arianna starts is 'out', with the reason that
-- allowed it under the rules of [voice.outgoing]. A scheduled call waits in
-- 'scheduled' until its time.
-- ---------------------------------------------------------------------------

CREATE TABLE calls (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations (id),
  direction       text NOT NULL CHECK (direction IN ('in', 'out')),
  -- Why Arianna calls (D-066, choice 8): a task waiting for the user, a task the
  -- user asked to hear about, a call the user scheduled.
  reason          text CHECK (reason IN ('waiting', 'task-done', 'scheduled')),
  task_id         uuid REFERENCES tasks (id),
  status          text NOT NULL CHECK (status IN ('scheduled', 'ringing', 'connecting', 'active', 'ended', 'missed', 'skipped', 'failed')),
  scheduled_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  answered_at     timestamptz,
  ended_at        timestamptz,
  -- A closed code, never a message.
  end_reason      text CHECK (end_reason IN (
    'hangup', 'time-limit', 'disconnected', 'voice-error', 'core-restart',
    'no-answer', 'quiet-hours', 'daily-limit', 'cancelled'
  )),
  delegations     integer NOT NULL DEFAULT 0 CHECK (delegations >= 0),
  CONSTRAINT calls_reason_only_out CHECK ((direction = 'out') = (reason IS NOT NULL)),
  CONSTRAINT calls_scheduled_has_time CHECK (status <> 'scheduled' OR scheduled_at IS NOT NULL),
  CONSTRAINT calls_end_with_time CHECK ((status IN ('ended', 'missed', 'skipped', 'failed')) = (ended_at IS NOT NULL))
);

CREATE INDEX calls_conversation_idx ON calls (conversation_id, created_at);
CREATE INDEX calls_scheduled_idx ON calls (scheduled_at) WHERE status = 'scheduled';
-- One call at a time on this machine: one user, one microphone.
CREATE UNIQUE INDEX calls_one_live ON calls ((true)) WHERE status IN ('ringing', 'connecting', 'active');

GRANT SELECT, INSERT, UPDATE ON calls TO arianna_app;
