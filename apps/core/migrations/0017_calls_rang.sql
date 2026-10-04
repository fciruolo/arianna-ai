-- The calls Arianna makes (D-066, third part, from the review). See docs/DATA-MODEL.md.
-- Object names are never schema-qualified.

-- When a call of Arianna rang: the daily maximum counts calls by this time,
-- not by when the user scheduled them (a call scheduled yesterday that rings
-- today counts today). Set once, when the row becomes 'ringing'.
ALTER TABLE calls ADD COLUMN rang_at timestamptz;
ALTER TABLE calls ADD CONSTRAINT calls_rang_only_out CHECK (rang_at IS NULL OR direction = 'out');
CREATE INDEX calls_rang_idx ON calls (rang_at) WHERE rang_at IS NOT NULL;
