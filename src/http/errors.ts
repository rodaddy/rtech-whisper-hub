import type { Context } from "hono";

/** HTTP status for every error code the API returns. */
export const STATUS = {
  invalid_request: 400,
  folder_not_found: 400,
  unauthorized: 401,
  not_found: 404,
  folder_name_taken: 409,
  snippet_trigger_taken: 409,
  note_version_conflict: 409,
  stamp_budget_exceeded: 503,
} as const;

export type ErrorCode = keyof typeof STATUS;

/** Contract error envelope: `{ error: { message }, code, data? }`. */
export function fail<C extends ErrorCode>(
  c: Context,
  status: (typeof STATUS)[C],
  code: C,
  message: string,
  data?: unknown,
) {
  return c.json(
    { error: { message }, code, ...(data === undefined ? {} : { data }) },
    status,
  );
}
