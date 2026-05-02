/**
 * Zod input schemas for every tool the agent can call.
 *
 * Each schema is the source of truth for what the model is allowed to send.
 * `validateToolInput()` consults this map and returns either parsed args or a
 * structured ValidationError that the model receives as the next turn's
 * tool_result.
 */

import { z } from "zod"

const pathField = z.string().min(1, "path must be a non-empty string")

export const readFileSchema = z.object({
  path: pathField,
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().optional(),
}).strict()

export const batchReadSchema = z.object({
  paths: z.array(pathField).min(1, "paths must be a non-empty array"),
}).strict()

export const listDirectorySchema = z.object({
  path: pathField,
}).strict()

export const fileExistsSchema = z.object({
  path: pathField,
}).strict()

export const createDirectorySchema = z.object({
  path: pathField,
}).strict()

export const writeFileSchema = z.object({
  path: pathField,
  content: z.string({ required_error: "content is required for write_file" }),
}).strict()

/**
 * edit_file is a discriminated union of four shapes:
 *  - search/replace
 *  - line_start + (line_end optional) + content
 *  - insert_at + content
 *  - patch (full replace)
 */
export const editFileSchema = z.union([
  z.object({
    path: pathField,
    search: z.string().min(1),
    replace: z.string(),
  }).strict(),
  z.object({
    path: pathField,
    line_start: z.number().int().positive(),
    line_end: z.number().int().positive().optional(),
    content: z.string(),
  }).strict(),
  z.object({
    path: pathField,
    insert_at: z.number().int().positive(),
    content: z.string(),
  }).strict(),
  z.object({
    path: pathField,
    patch: z.string().min(1),
  }).strict(),
])

export const moveFileSchema = z.object({
  from: pathField,
  to: pathField,
}).strict()

export const deleteFileSchema = z.object({
  path: pathField,
}).strict()

export const searchCodeSchema = z.object({
  directory: pathField.optional(),
  pattern: z.string().min(1, "pattern is required for search_code"),
}).strict()

export const searchFilesSchema = z.object({
  query: z.string().min(1).optional(),
  glob: z.string().min(1).optional(),
}).strict().refine((v) => !!v.query || !!v.glob, { message: "search_files requires either query or glob" })

export const runCommandSchema = z.object({
  command: z.string().min(1, "command must be non-empty"),
  cwd: z.string().min(1).optional(),
}).strict()

export const webSearchSchema = z.object({
  query: z.string().min(1, "query is required for web_search"),
}).strict()

export const batchWriteSchema = z.object({
  files: z.array(z.object({
    path: pathField,
    content: z.string(),
  })).min(1, "files must be a non-empty array"),
}).strict()

export const TOOL_SCHEMAS: Record<string, z.ZodTypeAny> = {
  read_file: readFileSchema,
  batch_read: batchReadSchema,
  list_directory: listDirectorySchema,
  file_exists: fileExistsSchema,
  create_directory: createDirectorySchema,
  write_file: writeFileSchema,
  edit_file: editFileSchema,
  move_file: moveFileSchema,
  delete_file: deleteFileSchema,
  search_code: searchCodeSchema,
  search_files: searchFilesSchema,
  run_command: runCommandSchema,
  web_search: webSearchSchema,
  batch_write: batchWriteSchema,
}

export type ToolName = keyof typeof TOOL_SCHEMAS
