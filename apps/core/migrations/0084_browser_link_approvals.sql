-- The browser of Arianna in a chat (D-264, passo 3): in an Internal
-- conversation a click on a link to a site outside the addresses the user
-- wrote («Clic solo nello stesso sito») does not run. The orchestrator writes
-- an approval of kind `browser` (action `browser.click`) with the address
-- and its site, decided in the web chat («Apri / No»): approved, the address
-- counts as written by the user for that conversation; the step of the task
-- reads the decision and goes on. The address is public content of a page,
-- at the label of the step that asked (L0 or L1). Events `browser.action`
-- (one per action, without addresses nor texts) are counted per task: at most
-- 20 per answer. See docs/DATA-MODEL.md.
-- Object names are never schema-qualified.

ALTER TABLE approvals DROP CONSTRAINT approvals_kind_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_kind_check
  CHECK (kind IN ('action', 'declassify', 'budget', 'setting', 'workspace', 'commitment', 'plan', 'executor', 'im', 'fact', 'routine', 'browser'));
-- The purge of the asking conversation (purge_conversation) leaves only {"purged": true}.
ALTER TABLE approvals ADD CONSTRAINT approvals_browser_fields
  CHECK (kind <> 'browser' OR (
    action = 'browser.click' AND label <= 'L1' AND task_id IS NOT NULL AND (
      coalesce(detail -> 'purged' = 'true'::jsonb, false)
      OR (coalesce(jsonb_typeof(detail -> 'url') = 'string', false)
          AND coalesce(jsonb_typeof(detail -> 'site') = 'string', false)
          AND coalesce(jsonb_typeof(detail -> 'step') = 'number', false))
    )
  ));
ALTER TABLE approvals ADD CONSTRAINT approvals_browser_via_web
  CHECK (kind <> 'browser' OR decided_via IS NULL OR decided_via = 'web');

CREATE INDEX events_browser_action_idx ON events (task_id) WHERE kind = 'browser.action';

-- No new grant: arianna_app inserts and updates approvals and appends events since 0007.
