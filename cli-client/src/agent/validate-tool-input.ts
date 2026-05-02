/**
 * Centralised tool-input validation. Replaces the manual `if (!args.path)`
 * checks that used to live at the top of `executeToolLocally`.
 *
 * On failure, returns a ValidationError that the executor surfaces to the
 * model as a tool_result with `_errorCategory: 'validation'` so the model
 * gets actionable feedback instead of "Tool 'X' requires args".
 */

import { ZodError, type ZodTypeAny } from "zod"
import { TOOL_SCHEMAS } from "./tool-schemas.js"

export interface ValidationOk<T = unknown> {
  ok: true
  args: T
}

export interface ValidationFail {
  ok: false
  error: ValidationError
}

export interface ValidationError {
  tool: string
  /** First failing field path, e.g. "path" or "files[0].content". */
  field: string
  /** Zod's message for the field. */
  message: string
  /** All failing issues (so the model sees more than the first). */
  issues: Array<{ field: string; message: string }>
  /** Human-friendly summary of the schema's expected shape. */
  expected: string
  /** Hint string suitable to attach to the tool_result for the model. */
  hint: string
}

export type ValidationResult<T = unknown> = ValidationOk<T> | ValidationFail

export function validateToolInput<T = unknown>(tool: string, args: unknown): ValidationResult<T> {
  const schema: ZodTypeAny | undefined = TOOL_SCHEMAS[tool]
  if (!schema) {
    return {
      ok: false,
      error: {
        tool,
        field: "(tool)",
        message: `Unknown tool: ${tool}`,
        issues: [],
        expected: "(no schema registered)",
        hint: `Tool "${tool}" has no schema. Use one of: ${Object.keys(TOOL_SCHEMAS).join(", ")}.`,
      },
    }
  }

  const parsed = schema.safeParse(args ?? {})
  if (parsed.success) {
    return { ok: true, args: parsed.data as T }
  }

  return { ok: false, error: formatZodError(tool, parsed.error) }
}

function formatZodError(tool: string, err: ZodError): ValidationError {
  const issues = err.issues.map((i) => ({
    field: i.path.length > 0 ? i.path.join(".") : "(root)",
    message: i.message,
  }))
  const first = issues[0]
  const expected = describeExpected(tool)
  return {
    tool,
    field: first?.field ?? "(root)",
    message: first?.message ?? "invalid input",
    issues,
    expected,
    hint: `⛔ INVALID ARGUMENTS for ${tool}: ${first ? `${first.field}: ${first.message}` : "validation failed"}. Expected: ${expected}`,
  }
}

const SHAPE_DESCRIPTIONS: Record<string, string> = {
  read_file: "{ path: string, offset?: number, limit?: number }",
  batch_read: "{ paths: string[] }",
  list_directory: "{ path: string }",
  file_exists: "{ path: string }",
  create_directory: "{ path: string }",
  write_file: "{ path: string, content: string }",
  edit_file: "one of: { path, search, replace } | { path, line_start, line_end?, content } | { path, insert_at, content } | { path, patch }",
  move_file: "{ from: string, to: string }",
  delete_file: "{ path: string }",
  search_code: "{ pattern: string, directory?: string }",
  search_files: "{ query?: string, glob?: string } — at least one required",
  run_command: "{ command: string, cwd?: string }",
  web_search: "{ query: string }",
  batch_write: "{ files: Array<{ path: string, content: string }> }",
}

function describeExpected(tool: string): string {
  return SHAPE_DESCRIPTIONS[tool] ?? "(no shape known)"
}
