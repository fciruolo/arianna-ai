-- The style and the skills of a Designer card (D-163, request of the user of
-- 2026-10-10). See docs/DATA-MODEL.md. Object names are never schema-qualified.
--
-- tasks.design_style: the slug of a style of the Open Design catalog (D-160),
-- or null. tasks.design_skills: skills of the general catalog (D-161) as
-- `owner/repo/slug`, at most 10. Chosen from a menu of the adopted catalogs in
-- the web chat, only on a card (no conversation). They are names of public
-- text: they do not change the card's label. A style or skill that is no
-- longer in the catalog stays written: the card runs without it and says so.

ALTER TABLE tasks ADD COLUMN design_style text
  CHECK (design_style IS NULL OR design_style ~ '^[a-z0-9][a-z0-9-]{0,63}$');
ALTER TABLE tasks ADD COLUMN design_skills text[] NOT NULL DEFAULT '{}'
  CHECK (
    cardinality(design_skills) <= 10
    AND array_position(design_skills, NULL) IS NULL
    AND (cardinality(design_skills) = 0
      OR array_to_string(design_skills, ' ') ~ '^[a-z0-9][a-z0-9-]{0,38}/[a-z0-9._-]{1,100}/[a-z0-9][a-z0-9-]{0,63}( [a-z0-9][a-z0-9-]{0,38}/[a-z0-9._-]{1,100}/[a-z0-9][a-z0-9-]{0,63})*$')
  );
ALTER TABLE tasks ADD CONSTRAINT tasks_design_only_cards
  CHECK ((design_style IS NULL AND cardinality(design_skills) = 0) OR conversation_id IS NULL);
