-- The saved private values of the user in the agent's browser and in
-- web.fetch (D-283): instead of the second scanner, the address of a page
-- and a typed text are compared with the clients and contacts the user saved;
-- one found waits for the card «Apri / No». An approval of kind `browser`,
-- action `browser.private`: for each value its reference, its kind and the
-- name of its client (never the value: no other key is allowed), the tool,
-- the step, and optionally the browser it was asked for (when it opened) and
-- the site the value would go to, at L2 (it names a client). See docs/DATA-MODEL.md and docs/PRIVACY-POLICY-SPEC.md.
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
          -- 1 to 20 values; the length only of an array (the order of the AND is not guaranteed).
          AND CASE WHEN jsonb_typeof(detail -> 'values') = 'array' THEN jsonb_array_length(detail -> 'values') BETWEEN 1 AND 20 ELSE false END
          -- Each value an object with only ref, kind and client, all strings: a value itself never enters here.
          AND NOT jsonb_path_exists(detail, '$.values[*] ? (@.type() != "object")')
          AND NOT jsonb_path_exists(detail, '$.values[*].keyvalue() ? (@.key != "ref" && @.key != "kind" && @.key != "client")')
          AND NOT jsonb_path_exists(detail, '$.values[*] ? (!exists(@.ref ? (@.type() == "string")) || !exists(@.kind ? (@.type() == "string")) || !exists(@.client ? (@.type() == "string")))')
          AND coalesce(jsonb_typeof(detail -> 'tool') = 'string', false)
          AND coalesce(jsonb_typeof(detail -> 'step') = 'number', false)
          -- The browser the card is for (when it opened), and the site the value would go to: optional.
          AND coalesce(jsonb_typeof(detail -> 'browser') = 'number', detail -> 'browser' IS NULL)
          AND coalesce(jsonb_typeof(detail -> 'site') = 'string', detail -> 'site' IS NULL))
    )
    AND action IN ('browser.click', 'browser.send', 'browser.private')
    AND (action <> 'browser.click' OR label <= 'L1')
  ));
