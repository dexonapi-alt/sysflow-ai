/**
 * Context budget service.
 *
 * Three pure capabilities:
 *   1. estimateTokens()          — rough token count for a string or object
 *   2. applyToolResultBudget()   — per-tool size cap on a tool result
 *   3. microcompactGeminiHistory() — rewrite a Gemini chat history so older
 *      compactable tool results become "[Old <tool> result cleared]"
 *
 * Plus one decision helper:
 *   4. shouldBlockOnTokens()     — pre-API guard against oversized payloads
 *
 * No I/O, no provider calls, no module-level mutable state.
 */

// ─── Token estimation ───

const CHARS_PER_TOKEN = 4

export function estimateTokens(input: unknown): number {
  if (input == null) return 0
  if (typeof input === "string") return Math.ceil(input.length / CHARS_PER_TOKEN)
  if (typeof input === "number" || typeof input === "boolean") {
    return Math.ceil(String(input).length / CHARS_PER_TOKEN)
  }
  try {
    return Math.ceil(JSON.stringify(input).length / CHARS_PER_TOKEN)
  } catch {
    return 0
  }
}

// ─── Per-model context window ───

/** Effective context window per model (in tokens). Conservative — accounts for output reservation. */
export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "gemini-pro": 1_000_000,
  "gemini-flash": 1_000_000,
  "claude-sonnet": 200_000,
  "claude-opus": 200_000,
  "openrouter-auto": 128_000,
  "mistral-small": 32_000,
  "llama-70b": 128_000,
  "swe": 200_000,
}

/** Tokens reserved as a safety margin for output + non-deterministic tokeniser drift. */
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000

/** Extra 10% safety margin on top of the buffer (rough estimator gets it wrong sometimes). */
const SAFETY_MARGIN = 0.10

export function getEffectiveContextWindow(model: string): number {
  return MODEL_CONTEXT_WINDOWS[model] ?? 128_000
}

export function shouldBlockOnTokens(estimatedTokens: number, model: string): boolean {
  const window = getEffectiveContextWindow(model)
  const limit = window - AUTOCOMPACT_BUFFER_TOKENS - Math.floor(window * SAFETY_MARGIN)
  return estimatedTokens > limit
}

// ─── Per-tool result size caps ───

/** Hard cap on the JSON-serialised size of a tool result, in characters. */
export const TOOL_RESULT_MAX_CHARS: Record<string, number> = {
  read_file: 50_000,
  batch_read: 80_000,
  search_code: 20_000,
  search_files: 15_000,
  list_directory: 15_000,
  run_command: 30_000,
  edit_file: 100_000,
  write_file: 5_000,
  web_search: 10_000,
  delete_file: 2_000,
  move_file: 2_000,
  create_directory: 2_000,
  file_exists: 1_000,
}

const DEFAULT_TOOL_RESULT_MAX_CHARS = 30_000

/**
 * Clamp the JSON-serialised size of a tool result. If a result is too large, replace
 * its largest string field with a truncation marker. Returns a new object — never
 * mutates the input.
 */
export function applyToolResultBudget(tool: string, result: Record<string, unknown>): Record<string, unknown> {
  const max = TOOL_RESULT_MAX_CHARS[tool] ?? DEFAULT_TOOL_RESULT_MAX_CHARS
  const serialised = safeStringify(result)
  if (serialised.length <= max) return result

  // Find the largest string field and truncate it
  const copy: Record<string, unknown> = { ...result }
  let largestKey: string | null = null
  let largestLen = 0
  for (const [k, v] of Object.entries(copy)) {
    if (typeof v === "string" && v.length > largestLen) {
      largestKey = k
      largestLen = v.length
    }
  }

  if (largestKey) {
    const original = copy[largestKey] as string
    const overage = serialised.length - max
    // Trim the largest string by overage + a margin so we land safely under max
    const newLen = Math.max(0, original.length - overage - 200)
    copy[largestKey] = original.slice(0, newLen) +
      `\n\n[Truncated by tool-result budget. Original ${original.length} chars, kept ${newLen}.]`
    copy._truncated = true
    copy._original_size = original.length
    return copy
  }

  // No string field large enough — fall back to a generic marker
  return {
    _truncated: true,
    _original_size: serialised.length,
    _note: `Tool result for ${tool} exceeded ${max} chars and was discarded by the budget.`,
  }
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? ""
  } catch {
    return ""
  }
}

// ─── Microcompact for Gemini chat history ───

/**
 * Tools whose results are safely compactable — re-reading is cheap, and the model
 * rarely needs the full payload from many turns ago.
 */
const COMPACTABLE_TOOLS = new Set([
  "read_file",
  "batch_read",
  "list_directory",
  "search_code",
  "search_files",
  "run_command",
  "web_search",
  "edit_file",
  "write_file",
])

/** Default: keep the most recent N compactable results; clear everything older. */
const DEFAULT_KEEP_LAST_N = 5

/**
 * Gemini "user" turns from `chat.getHistory()` look like:
 *   { role: "user", parts: [{ text: "Tool result:\n{...JSON...}" }] }
 *
 * We compact in place by rewriting `parts[0].text` for older tool-result turns.
 * Initial user-task messages and "Tool results (parallel):" turns are detected
 * by their leading marker and rewritten to a one-line stub.
 *
 * Returns a new history array; never mutates the input.
 */
export interface GeminiContent {
  role: string
  parts: Array<{ text?: string }>
}

export function microcompactGeminiHistory(
  history: GeminiContent[],
  keepLastN: number = DEFAULT_KEEP_LAST_N,
): GeminiContent[] {
  // Find user turns whose first part starts with "Tool result:" / "Tool results (parallel):"
  const toolResultIndices: number[] = []
  for (let i = 0; i < history.length; i++) {
    const turn = history[i]
    if (turn.role !== "user") continue
    const text = turn.parts?.[0]?.text ?? ""
    if (text.startsWith("Tool result:") || text.startsWith("Tool results (parallel):")) {
      toolResultIndices.push(i)
    }
  }

  // Keep the last N — compact the rest
  const toCompact = new Set(toolResultIndices.slice(0, Math.max(0, toolResultIndices.length - keepLastN)))
  if (toCompact.size === 0) return history

  return history.map((turn, i) => {
    if (!toCompact.has(i)) return turn
    const text = turn.parts?.[0]?.text ?? ""
    const toolName = extractCompactedToolName(text)
    if (toolName && !COMPACTABLE_TOOLS.has(toolName)) return turn
    return {
      ...turn,
      parts: [{ text: `[Old ${toolName ?? "tool"} result cleared by microcompact]` }],
    }
  })
}

function extractCompactedToolName(text: string): string | null {
  // Match: Tool result:\n{"tool":"read_file",...}
  const single = text.match(/"tool"\s*:\s*"([a-z_]+)"/)
  if (single) return single[1]
  // Match: Tool results (parallel):\n[id] read_file: {...}
  const batch = text.match(/^\[[^\]]+\]\s+([a-z_]+):/m)
  if (batch) return batch[1]
  return null
}
