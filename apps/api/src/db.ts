import postgres from 'postgres';
import { env } from './env';

/**
 * One pool per process. `postgres.camel` maps snake_case columns onto the camelCase names in
 * @roster/types, so rows come back already shaped like the API contract.
 */
export const sql = postgres(env.databaseUrl, {
  max: 10,
  transform: postgres.camel,
  onnotice: () => {},
});

/**
 * Two different partial unique indexes are matched by name here, and the field carrying the
 * constraint name has moved between postgres.js versions. Hence the belt and braces: getting
 * this wrong silently turns a 409 into a 500.
 */
export function isUniqueViolation(err: unknown, constraintName: string): boolean {
  const e = err as {
    code?: string;
    constraint_name?: string;
    constraint?: string;
    detail?: string;
    message?: string;
  } | null;

  if (e?.code !== '23505') return false;

  return (
    e.constraint_name === constraintName ||
    e.constraint === constraintName ||
    (e.detail ?? '').includes(constraintName) ||
    (e.message ?? '').includes(constraintName)
  );
}

/**
 * Unwrap a query into a plain array before it becomes a response body.
 *
 * postgres.js resolves to a `Result`, an Array subclass. Elysia routes subclasses through a
 * different response path that drops `set.headers`, which is where the CORS plugin writes
 * access-control-allow-origin — so every browser GET was blocked while the body looked fine.
 */
export const rows = async <T>(query: PromiseLike<readonly T[]>): Promise<T[]> => [...(await query)];
