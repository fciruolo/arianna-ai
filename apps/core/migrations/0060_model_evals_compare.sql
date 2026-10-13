-- «Confronto dei modelli» (D-199): the trials of model_evals (D-081) keep
-- their speed and a copy of the catalog entry, so that a row stays readable
-- after the model leaves the catalog or the disk. See docs/DATA-MODEL.md.
-- Object names are never schema-qualified. Still all L0: numbers, closed
-- codes and the catalog's own texts (in git), never what the model wrote.
--
-- tokens_per_second: tokens written per second from the first token of any
-- kind (reasoning included, as the counts are), over the cases
-- with a stream and the token counts of the local server; first_token_ms: the
-- mean wait for the first piece of text. Both NULL for the trials before this
-- migration and when the server sent no counts: never guessed.
-- model_*: the catalog entry when the trial was asked, written once.

ALTER TABLE model_evals ADD COLUMN tokens_per_second double precision
  CHECK (tokens_per_second > 0 AND tokens_per_second < 100000);
ALTER TABLE model_evals ADD COLUMN first_token_ms integer CHECK (first_token_ms >= 0);
ALTER TABLE model_evals ADD COLUMN model_name text
  CHECK (char_length(model_name) BETWEEN 1 AND 200 AND model_name !~ '[[:cntrl:]]');
ALTER TABLE model_evals ADD COLUMN model_provider text
  CHECK (char_length(model_provider) BETWEEN 1 AND 200 AND model_provider !~ '[[:cntrl:]]');
ALTER TABLE model_evals ADD COLUMN model_size_bytes bigint CHECK (model_size_bytes > 0);
ALTER TABLE model_evals ADD COLUMN model_quantization text CHECK (model_quantization ~ '^[A-Za-z0-9_.-]{1,24}$');
ALTER TABLE model_evals ADD COLUMN model_ram_min_gib integer CHECK (model_ram_min_gib BETWEEN 1 AND 4096);

-- The speed is measured by a finished trial only.
ALTER TABLE model_evals ADD CONSTRAINT model_evals_speed
  CHECK ((tokens_per_second IS NULL AND first_token_ms IS NULL) OR status IN ('passed', 'failed'));

-- The answer of each case in closed values only: the kind of action and the
-- name of a tool of the registry (dotted lowercase), never free text. A case
-- holds only the keys below, the numbers as numbers: no other key can carry
-- a text of the model.
ALTER TABLE model_evals ADD CONSTRAINT model_evals_case_answers CHECK (
  cases IS NULL OR (
    NOT jsonb_path_exists(cases,
      '$[*] ? ((exists(@.action) && (@.action.type() != "string" || !(@.action == "call" || @.action == "reply" || @.action == "plan" || @.action == "refuse" || @.action == "unreadable")))
            || (exists(@.tool) && (@.tool.type() != "string" || !(@.tool like_regex "^[a-z]+([.][a-z_]+)+$")))
            || (exists(@.firstMs) && @.firstMs.type() != "number")
            || (exists(@.tokens) && @.tokens.type() != "number")
            || (exists(@.genMs) && @.genMs.type() != "number"))')
    AND NOT jsonb_path_exists(cases,
      '$[*].keyvalue() ? (!(@.key == "id" || @.key == "passed" || @.key == "ms" || @.key == "error" || @.key == "action" || @.key == "tool" || @.key == "firstMs" || @.key == "tokens" || @.key == "genMs"))')
  )
);

-- As 0019, plus the copy of the catalog entry: it does not change once written.
CREATE OR REPLACE FUNCTION model_evals_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NEW.model_id IS DISTINCT FROM OLD.model_id
     OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
     OR NEW.weights_sha256 IS DISTINCT FROM OLD.weights_sha256
     OR NEW.role IS DISTINCT FROM OLD.role THEN
    RAISE EXCEPTION 'model_evals: model, role, request time and weights of trial % do not change', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.model_name IS DISTINCT FROM OLD.model_name
     OR NEW.model_provider IS DISTINCT FROM OLD.model_provider
     OR NEW.model_size_bytes IS DISTINCT FROM OLD.model_size_bytes
     OR NEW.model_quantization IS DISTINCT FROM OLD.model_quantization
     OR NEW.model_ram_min_gib IS DISTINCT FROM OLD.model_ram_min_gib THEN
    RAISE EXCEPTION 'model_evals: the catalog copy of trial % does not change', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('passed', 'failed', 'error', 'cancelled') THEN
    RAISE EXCEPTION 'model_evals: trial % is finished (%)', OLD.id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'running' AND NEW.status = 'queued' THEN
    RAISE EXCEPTION 'model_evals: trial % does not go back to the queue', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- The comparison lists the trials of a role, newest first.
CREATE INDEX model_evals_role_idx ON model_evals (role, requested_at DESC);
