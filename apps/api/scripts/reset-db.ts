/**
 * Rebuilds a database: schema, then seed. Run with `pnpm db:reset`.
 * DESTRUCTIVE — seed.sql truncates every table. Targets whatever DATABASE_URL points at,
 * so the same script sets up roster, roster_test and roster_load.
 */
import { sql } from '../src/db';
import { env } from '../src/env';

for (const file of ['schema.sql', 'seed.sql']) {
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

console.log(`seeded ${new URL(env.databaseUrl).pathname.slice(1)}`, counts);

await sql.end();
