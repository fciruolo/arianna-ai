-- Links downloaded and summarized (D-154, request of the user of 2026-10-10):
-- the address of a link saved by the user goes to its own site through the
-- gateway, with a target of its own (`link`). The address comes from a note of
-- kb/inbox, L2 by default: it may leave as L2 only towards this target, only
-- with the consent of the user (`link-list`: the site is in the list of
-- arianna.toml; `link-click`: "Scarica e riassumi"), and its row never holds a
-- summary. The address itself is never written: only its sha256, as for every
-- other row. See docs/DATA-MODEL.md and docs/PRIVACY-POLICY-SPEC.md.
-- Object names are never schema-qualified.

ALTER TABLE gateway_log DROP CONSTRAINT gateway_log_target_kind_check;
ALTER TABLE gateway_log ADD CONSTRAINT gateway_log_target_kind_check CHECK (target_kind IN ('executor', 'channel', 'web', 'link'));

ALTER TABLE gateway_log ADD CONSTRAINT gateway_log_link_fields CHECK (
  target_kind <> 'link' OR (target IN ('link-list', 'link-click') AND locality = 'cloud' AND summary IS NULL AND (decision = 'block' OR rule = 'link'))
);

-- A cloud exit above L1 only for the address of a link, never L3 (gateway_log_no_secret_out).
ALTER TABLE gateway_log DROP CONSTRAINT gateway_log_cloud_up_to_l1;
ALTER TABLE gateway_log ADD CONSTRAINT gateway_log_cloud_up_to_l1 CHECK (decision = 'block' OR locality = 'local' OR label <= 'L1' OR target_kind = 'link');
