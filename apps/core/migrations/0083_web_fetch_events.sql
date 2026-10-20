-- Pages read by Arianna with `web.fetch` (D-262, P7): one event `web.fetch`
-- per page asked, with only the site, the outcome and the conversation (the
-- whole address stays in gateway_log). The core counts them before each page:
-- at most 5 per task and 30 a day. This index keeps the daily count off the
-- whole log. See docs/DATA-MODEL.md.
-- Object names are never schema-qualified.

CREATE INDEX events_web_fetch_idx ON events (ts) WHERE kind = 'web.fetch';

-- No new grant: arianna_app appends and reads events since 0007.
