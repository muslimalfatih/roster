/**
 * Preloaded by bunfig.toml. src/db.ts reads DATABASE_URL at import time, so the redirect has
 * to happen before any test module loads — tests truncate, and would wipe the demo seed.
 */
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgres://postgres@localhost:5432/roster_test';
