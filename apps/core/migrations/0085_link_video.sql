-- Videos of YouTube summarized in Pensieri (D-273, tappa A): «Riassumi il
-- video», approved by the user for one video, sends its normalized address
-- (`https://www.youtube.com/watch?v=<id>`) through the gateway with a consent
-- of its own (`link-video`), as the links of D-154: L2 allowed only towards
-- this target, the address never written (only its sha256 and length), no
-- summary, no row in label_changes. What leaves after it goes through the
-- proxy of the core to a closed list of hosts of YouTube and Google, for the
-- time of that one job. See docs/DATA-MODEL.md and docs/PRIVACY-POLICY-SPEC.md.
-- Object names are never schema-qualified.

ALTER TABLE gateway_log DROP CONSTRAINT gateway_log_link_fields;
ALTER TABLE gateway_log ADD CONSTRAINT gateway_log_link_fields CHECK (
  target_kind <> 'link' OR (target IN ('link-list', 'link-click', 'link-video') AND locality = 'cloud' AND summary IS NULL AND (decision = 'block' OR rule = 'link'))
);

-- No new grant: arianna_app inserts into gateway_log since 0007.
