-- The saved private values of the user in the agent's browser and in
-- web.fetch (D-283): instead of the second scanner, the address of a page
-- and a typed text are compared with the clients and contacts the user saved;
-- one found waits for the card «Apri / No». An approval of kind `browser`,
-- action `browser.private`: for each value its reference, its kind and the
-- name of its client (never the value), the tool and the step, at L2 (it
-- names a client). See docs/DATA-MODEL.md and docs/PRIVACY-POLICY-SPEC.md.
-- Object names are never schema-qualified.
--
-- No new grant: arianna_app inserts and updates approvals at table level since 0007.

ALTER TABLE approvals DROP CONSTRAINT approvals_browser_fields;
ALTER TABLE approvals ADD CONSTRAINT approvals_browser_fields
  CHECK (kind <> 'browser' OR (
    task_id IS NOT NULL AND (
      coalesce(detail -> 'purged' = 'true'::jsonb, false)
      OR (action = 'browser.click' AND label <= 'L1'
          AND coalesce(jsonb_typeof(detail -> 'url') = 'string', false)
          AND coalesce(jsonb_typeof(detail -> 'site') = 'string', false)
          AND coalesce(jsonb_typeof(detail -> 'step') = 'number', false))
      OR (action = 'browser.send' AND label = 'L2'
          AND coalesce(jsonb_typeof(detail -> 'site') = 'string', false)
          AND coalesce(jsonb_typeof(detail -> 'element') = 'string', false)
          AND coalesce(jsonb_typeof(detail -> 'step') = 'number', false))
      OR (action = 'browser.private' AND label = 'L2'
          AND coalesce(jsonb_typeof(detail -> 'values') = 'array', false)
          AND coalesce(jsonb_array_length(detail -> 'values') BETWEEN 1 AND 20, false)
          AND coalesce(jsonb_typeof(detail -> 'tool') = 'string', false)
          AND coalesce(jsonb_typeof(detail -> 'step') = 'number', false))
    )
    AND action IN ('browser.click', 'browser.send', 'browser.private')
    AND (action <> 'browser.click' OR label <= 'L1')
  ));
