-- The cardwall, tappa C3 (I-13, D-159). See docs/DATA-MODEL.md.
-- Object names are never schema-qualified.
--
-- approvals of kind `plan`: Arianna proposes cards with their dependencies
-- (`task.plan`); the detail holds the proposed cards, at the label of what
-- the step had read. Approved, the core creates them in the transaction of
-- the decision. Only the web chat shows the detail, so only there is it decided.
--
-- approvals of kind `executor`: before a card of an agent with
-- `executor_choice: ask` starts, the user chooses where it runs among the
-- options the core allowed (`detail.options`). The choice is written with the
-- decision, in `choice`, and frozen with it (approvals_guard: a decided
-- approval never changes).

ALTER TABLE approvals DROP CONSTRAINT approvals_kind_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_kind_check
  CHECK (kind IN ('action', 'declassify', 'budget', 'setting', 'workspace', 'commitment', 'plan', 'executor'));

ALTER TABLE approvals ADD CONSTRAINT approvals_plan_fields
  CHECK (kind <> 'plan' OR (action = 'task.plan' AND task_id IS NOT NULL));
ALTER TABLE approvals ADD CONSTRAINT approvals_executor_fields
  CHECK (kind <> 'executor' OR (action = 'card.executor' AND task_id IS NOT NULL));
ALTER TABLE approvals ADD CONSTRAINT approvals_plan_executor_via_web
  CHECK (kind NOT IN ('plan', 'executor') OR decided_via IS NULL OR decided_via = 'web');

-- The executor the user chose: only on an approved approval of kind executor, and always there.
ALTER TABLE approvals ADD COLUMN choice text CHECK (choice IN ('claude', 'codex', 'local'));
ALTER TABLE approvals ADD CONSTRAINT approvals_choice
  CHECK ((choice IS NOT NULL) = (kind = 'executor' AND state = 'approved'));
