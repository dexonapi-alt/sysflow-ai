/**
 * Structured tool-error classifier.
 *
 * Replaces ad-hoc string-pattern matching with a typed taxonomy + a hint
 * lookup so every error the AI sees comes with a concrete recovery
 * suggestion.
 *
 * Pure functions. The classifier inspects the tool name + the error
 * string from the local executor; the hint is a one-paragraph
 * instruction targeted at the model on what to do next.
 */

export type ToolErrorCategory =
  | "validation"
  | "permission"
  | "file_not_found"
  | "file_too_large"
  | "timeout"
  | "command_failed"
  | "command_not_found"
  | "network"
  | "auth"
  | "unknown"

export interface ClassifiedToolError {
  category: ToolErrorCategory
  hint: string
}

export function classifyToolError(tool: string, error: string): ClassifiedToolError {
  const e = (error || "").toLowerCase()

  if (e.includes("enoent") || e.includes("no such file") || e.includes("cannot find") || e.includes("does not exist")) {
    return { category: "file_not_found", hint: hintForFileNotFound(tool) }
  }
  if (e.includes("eacces") || e.includes("permission denied") || e.includes("eperm")) {
    return { category: "permission", hint: hintForPermission(tool) }
  }
  if (e.includes("etimedout") || e.includes("timed out") || e.includes("timeout")) {
    return { category: "timeout", hint: hintForTimeout(tool) }
  }
  if (e.includes("could not determine executable") || e.includes("not recognized") || e.includes("command not found") || e.includes("is not the name of a cmdlet")) {
    return { category: "command_not_found", hint: hintForCommandNotFound() }
  }
  if (e.includes("efbig") || e.includes("file too large") || e.includes("exceeds") && tool === "read_file") {
    return { category: "file_too_large", hint: hintForFileTooLarge() }
  }
  if (e.includes("econnrefused") || e.includes("econnreset") || e.includes("etimedout") || e.includes("network") || e.includes("dns") || e.includes("eai_again")) {
    return { category: "network", hint: "Network error reaching the resource. Retry the operation, or skip if the resource is non-critical." }
  }
  if (e.includes("401") || e.includes("403") || e.includes("unauthorized") || e.includes("forbidden") || e.includes("api key") || e.includes("api_key")) {
    return { category: "auth", hint: "Authentication failure. Check the relevant API key in .env (GEMINI_API_KEY / OPENROUTER_API_KEY). Do not retry this exact call." }
  }
  if (e.includes("invalid args") || e.includes("required") || e.includes("validation") || e.includes("schema")) {
    return { category: "validation", hint: hintForValidation(tool) }
  }
  if (tool === "run_command") {
    return { category: "command_failed", hint: hintForCommandFailed() }
  }

  return { category: "unknown", hint: "An unexpected error occurred. Try a different approach (read related files, search for the symbol, or break the task into smaller steps)." }
}

function hintForFileNotFound(tool: string): string {
  if (tool === "list_directory" || tool === "read_file" || tool === "batch_read") {
    return "⚠️ FILE NOT FOUND: This file/directory does NOT exist. It was likely deleted or never created. Do NOT retry the same path. Either CREATE it with write_file/create_directory, or use search_files / list_directory on the parent to find the actual location."
  }
  if (tool === "run_command") {
    return "⚠️ FILE NOT FOUND: The directory in this command does not exist. If you need to cd into a project folder, you must scaffold/create it first. Do NOT assume previous-session directories still exist."
  }
  return "⚠️ FILE NOT FOUND: Path doesn't exist. Use search_files to find the real location, or create it with write_file."
}

function hintForPermission(_tool: string): string {
  return "⚠️ PERMISSION DENIED: Cannot access this path. Skip this action or work around it (write to a different location, ask the user for the right path)."
}

function hintForTimeout(tool: string): string {
  if (tool === "run_command") {
    return "⚠️ TIMEOUT: The command exceeded the 30s tool timeout. Either it's a long-running server (skip — the user runs it manually) or a heavy install (defer to your completion summary). Do NOT retry."
  }
  if (tool === "web_search") {
    return "⚠️ TIMEOUT: Web search timed out. Try a shorter query or skip the search and proceed with what you know."
  }
  return "⚠️ TIMEOUT: Operation took too long. Try a smaller scope or skip and continue."
}

function hintForCommandNotFound(): string {
  return "⚠️ COMMAND NOT FOUND: The command/package does not exist or has no executable. The command may be outdated (e.g., 'tailwindcss init' was removed in v4). Skip this command and create the needed files manually with write_file."
}

function hintForFileTooLarge(): string {
  return "⚠️ FILE TOO LARGE: This file exceeds the read budget. Use read_file with offset/limit to read it in chunks, or summarise it via search_code instead of reading the whole thing."
}

function hintForValidation(tool: string): string {
  return `⚠️ INVALID ARGUMENTS for ${tool}: Re-check the tool's required fields. Every tool needs "path" except web_search/run_command. For edit_file, you must include either { search, replace } or { line_start, line_end, content } or { insert_at, content } or { patch }.`
}

function hintForCommandFailed(): string {
  return "⚠️ COMMAND FAILED: The shell command exited non-zero. Read the stderr to understand why. Common causes: missing dependency (run npm install? — defer to user), wrong cwd (check it matches the scaffold dir), syntax error in args (double-check escaping)."
}
