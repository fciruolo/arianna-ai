-- pgvector (D-308): the vector type and its nearest-neighbour search, base of
-- the hybrid search of Phase 2 and of the memories of D-204. Needs the image
-- of apps/core/postgres (compose.yaml): on the plain postgres image this
-- migration fails, and nothing of it is applied. See docs/DATA-MODEL.md.
--
-- The extension belongs to the database, not to the schema of a migration,
-- so it lives in a schema of its own, `extensions`, holding nothing else:
--   * the tests apply every migration inside a throwaway schema and drop it
--     with CASCADE, which would drop an extension created there, with every
--     vector column of the other schemas;
--   * connect() puts `extensions` last in the search_path of every
--     connection (apps/core/src/db/client.ts), so migrations and queries keep
--     names unqualified: `vector(768)`, `<=>`, `vector_cosine_ops`.
-- The owner of the database creates it (pgvector is not a trusted
-- extension); the IF NOT EXISTS clauses let every test schema run this file.
-- arianna_app gets USAGE only: it uses the type, its functions and operators
-- (EXECUTE is granted to PUBLIC by the extension), and cannot create objects
-- there (pnpm arianna:doctor checks it).
CREATE SCHEMA IF NOT EXISTS extensions;
REVOKE ALL ON SCHEMA extensions FROM PUBLIC;
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;
GRANT USAGE ON SCHEMA extensions TO arianna_app;
