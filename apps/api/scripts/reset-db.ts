/**
 * Applies db/schema.sql, and by default db/seed.sql after it. Targets whatever DATABASE_URL
 * points at, so the same script sets up roster, roster_test and roster_load.
 *
 * seed.sql TRUNCATES every table, so pass --schema-only on any database with real data.
 * schema.sql alone is idempotent and safe to re-run.
 */
import { sql } from '../src/db';
import { env } from '../src/env';

const schemaOnly = process.argv.includes('--schema-only');

for (const file of schemaOnly ? ['schema.sql'] : ['schema.sql', 'seed.sql']) {
  const text = await Bun.file(new URL(`../db/${file}`, import.meta.url)).text();
  // .simple() is required: the extended protocol rejects multi-statement SQL.
  await sql.unsafe(text).simple();
  console.log(`applied db/${file}`);
}

const [counts] = await sql`
  SELECT (SELECT count(*)::int FROM parents)          AS parents,
         (SELECT count(*)::int FROM students)         AS students,
         (SELECT count(*)::int FROM classes)          AS classes,
         (SELECT count(*)::int FROM class_seats)      AS class_seats,
         (SELECT count(*)::int FROM bookings)         AS bookings,
         (SELECT count(*)::int FROM payment_attempts) AS payment_attempts`;

const db = new URL(env.databaseUrl).pathname.slice(1);
console.log(schemaOnly ? `schema applied to ${db}` : `seeded ${db}`, counts);

await sql.end();
