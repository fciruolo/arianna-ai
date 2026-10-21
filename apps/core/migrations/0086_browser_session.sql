-- The agent's browser after an access made by the user (D-276, D-264 passo 5):
-- a request of the site of the access (`web-session`, rule `session`) and a
-- form the user sent while driving the browser (`web-form`, rule `form`) may
-- leave as L2, only towards that site (checked by the gateway), never L3
-- (gateway_log_no_secret_out). Their rows never hold a summary; the row of a
-- form holds the size of its body in bytes_out and the sha256 of its address
-- only: the content of a form never reaches the gateway. See
-- docs/DATA-MODEL.md and docs/PRIVACY-POLICY-SPEC.md.
-- Object names are never schema-qualified.

ALTER TABLE gateway_log DROP CONSTRAINT gateway_log_cloud_up_to_l1;
ALTER TABLE gateway_log ADD CONSTRAINT gateway_log_cloud_up_to_l1 CHECK (
  decision = 'block' OR locality = 'local' OR label <= 'L1' OR target_kind = 'link'
  OR (target_kind = 'web' AND target IN ('web-session', 'web-form') AND rule IN ('session', 'form'))
);

ALTER TABLE gateway_log ADD CONSTRAINT gateway_log_session_fields CHECK (
  (target NOT IN ('web-session', 'web-form') OR (target_kind = 'web' AND locality = 'cloud' AND summary IS NULL))
  AND (rule NOT IN ('session', 'form') OR target IN ('web-session', 'web-form'))
);
