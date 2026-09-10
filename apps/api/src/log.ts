/**
 * One-line JSON logging. This is the whole logger — no library, nothing to configure.
 * Callers pass ids and outcomes only, never request bodies or payment details.
 */
type Field = string | number | boolean | null | undefined;

export function log(event: string, fields: Record<string, Field> = {}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
}
