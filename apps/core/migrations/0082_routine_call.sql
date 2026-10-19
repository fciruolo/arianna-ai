-- Routines with a call (D-110, tappa B; D-259): a routine delivers its report
-- in its chat, as before, and with the channel `call` Arianna also calls on the
-- voice of this Mac (D-066): the ringer rings it under [voice.outgoing], the
-- push stays "Arianna ti chiama". On the phone first the counts, written by
-- code; the titles, up to `voice_max_label` (never above Privato, L2), only
-- after a «sì». Unanswered: a note in the chat and, if the routine asks, one
-- second ring after `retry_minutes`, which keeps the quiet hours. Only the
-- local channel: Telegram and the real phone stay off (the cloud part of D-110
-- is put off). See docs/DATA-MODEL.md.
-- Object names are never schema-qualified.

-- ---------------------------------------------------------------------------
-- routines: the channel, the ceiling of what is said aloud, the second ring.
-- ---------------------------------------------------------------------------

ALTER TABLE routines DROP CONSTRAINT routines_channel_check;
ALTER TABLE routines ADD CONSTRAINT routines_channel_check CHECK (channel IN ('chat', 'call'));
-- The titles said aloud after the «sì»: up to this label; above it only counted. Never L3.
ALTER TABLE routines ADD COLUMN voice_max_label privacy_label NOT NULL DEFAULT 'L2';
ALTER TABLE routines ADD CONSTRAINT routines_voice_below_secret CHECK (voice_max_label <> 'L3');
-- NULL: no second ring (the default, D-066 choice 9); otherwise one, these minutes after a call not answered.
ALTER TABLE routines ADD COLUMN retry_minutes smallint CHECK (retry_minutes BETWEEN 5 AND 60);

-- A routine removed and a proposal stay as they were, the new fields too. A
-- trigger of its own, so that routines_guard (0079) and routines_proposal_guard
-- (0080) are not rewritten here: another migration may rewrite them for its own
-- fields, and the two would undo each other. `channel` is in both of them already.
CREATE FUNCTION routines_call_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF (NEW.voice_max_label, NEW.retry_minutes) IS NOT DISTINCT FROM (OLD.voice_max_label, OLD.retry_minutes) THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'retired' THEN
    RAISE EXCEPTION 'routines %: a routine removed stays as it was', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'proposed' AND NEW.status = 'proposed' THEN
    RAISE EXCEPTION 'routines %: a proposal stays as the user saw it', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER routines_call_guard BEFORE UPDATE ON routines FOR EACH ROW EXECUTE FUNCTION routines_call_guard();

-- ---------------------------------------------------------------------------
-- calls: the reason `routine`, with its run and the attempt (1, or 2 for the
-- second ring). Still metadata only: what is said is in messages.
-- ---------------------------------------------------------------------------

ALTER TABLE calls DROP CONSTRAINT calls_reason_check;
ALTER TABLE calls ADD CONSTRAINT calls_reason_check CHECK (reason IN ('waiting', 'task-done', 'scheduled', 'routine'));
-- calls are deleted before the runs by erase_conversation (the runs go with their routine, by cascade).
ALTER TABLE calls ADD COLUMN routine_run_id bigint REFERENCES routine_runs (id);
ALTER TABLE calls ADD COLUMN routine_attempt smallint CHECK (routine_attempt IN (1, 2));
ALTER TABLE calls ADD CONSTRAINT calls_routine_fields CHECK (
  (reason = 'routine') = (routine_run_id IS NOT NULL) AND (routine_run_id IS NULL) = (routine_attempt IS NULL)
);
-- One call per run, and at most one second ring.
CREATE UNIQUE INDEX calls_routine_once ON calls (routine_run_id, routine_attempt) WHERE routine_run_id IS NOT NULL;

-- A call of a routine that waited too long (the voice not ready, another call in progress): skipped, with a note.
ALTER TABLE calls DROP CONSTRAINT calls_end_reason_check;
ALTER TABLE calls ADD CONSTRAINT calls_end_reason_check CHECK (end_reason IN (
  'hangup', 'time-limit', 'disconnected', 'voice-error', 'core-restart',
  'no-answer', 'quiet-hours', 'daily-limit', 'cancelled', 'agent-off', 'expired'
));
