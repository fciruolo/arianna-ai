-- conversations.character_on (D-225, tappa A): the switch «Personaggio» of the
-- chat. True (the default, also for every conversation written before) lets
-- the agents of the conversation play the person of the series they wear:
-- the block of the character and the real lines drawn by the core. False:
-- neither enters any prompt of this conversation (Arianna, local and cloud
-- delegations, calls); name and look in the chat stay. Only a flag, never
-- content. See docs/DATA-MODEL.md. Object names are never schema-qualified.
--
-- No new grant: arianna_app updates conversations at table level since 0007,
-- and conversations_guard, which freezes the other columns, leaves this one
-- free. A purged conversation never changes, the switch included (the guard).

ALTER TABLE conversations ADD COLUMN character_on boolean NOT NULL DEFAULT true;
