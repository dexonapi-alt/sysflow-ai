/**
 * Setup Intelligence — ensures the AI uses CURRENT framework knowledge
 * instead of hallucinating outdated configurations.
 *
 * Two modes:
 *
 * 1. ERROR RECOVERY — When the user pastes an error, extract the core issue
 *    and build a web_search query to get the current fix. The AI's first
 *    action is overridden to web_search before it can hallucinate a wrong fix.
 *
 * 2. CONFIG VERIFICATION — When the AI writes framework config files
 *    (postcss.config, tailwind.config, vite.config, etc.), check if a
 *    web search was done for that framework's setup in this run. If not,
 *    force a web_search first so the AI gets current documentation.
 *
 * This is a PROGRAMMATIC SYSTEM, not a prompt hack. It stays current
 * because it always searches the web for the latest information.
 */

import type { NormalizedResponse, ToolCall } from "../types.js"

// ─── Error Detection ───

interface DetectedError {
  searchQuery: string
  errorType: string
  briefContext: string
}

interface ErrorPattern {
  pattern: RegExp
  type: string
  buildQuery: (match: RegExpMatchArray, fullPrompt: string) => string
  briefContext: string
}

const ERROR_PATTERNS: ErrorPattern[] = [
  {
    pattern: /Cannot find module ['"]([^'"]+)['"]/i,
    type: "missing-module",
    buildQuery: (m) => `${m[1]} install setup guide ${new Date().getFullYear()}`,
    briefContext: "Module not found — search for current installation instructions."
  },
  {
    pattern: /PostCSS plugin.*moved.*separate package/i,
    type: "postcss-migration",
    buildQuery: () => `tailwindcss postcss setup guide ${new Date().getFullYear()}`,
    briefContext: "PostCSS plugin structure changed — search for current Tailwind + PostCSS setup."
  },
  {
    pattern: /(tailwindcss|tailwind)\s+directly\s+as\s+a\s+PostCSS\s+plugin/i,
    type: "tailwind-postcss-v4",
    buildQuery: () => `tailwindcss v4 postcss configuration setup ${new Date().getFullYear()}`,
    briefContext: "Tailwind CSS PostCSS plugin has changed — need current setup instructions."
  },
  {
    pattern: /ERESOLVE.*could not resolve/i,
    type: "dependency-conflict",
    buildQuery: (_m, prompt) => {
      const pkgMatch = prompt.match(/(?:resolving|dependency):\s*(\S+)/i)
      return pkgMatch
        ? `${pkgMatch[1]} peer dependency conflict fix ${new Date().getFullYear()}`
        : `npm ERESOLVE peer dependency conflict fix ${new Date().getFullYear()}`
    },
    briefContext: "Dependency version conflict — search for compatible versions."
  },
  {
    pattern: /Module not found:\s*(?:Error:\s*)?Can't resolve ['"]([^'"]+)['"]/i,
    type: "webpack-resolve",
    buildQuery: (m) => `${m[1]} install configure ${new Date().getFullYear()}`,
    briefContext: "Webpack/bundler can't resolve module — search for installation instructions."
  },
  {
    pattern: /(?:SyntaxError|Error):\s*(?:Cannot use import|Unexpected token 'export')/i,
    type: "esm-cjs-conflict",
    buildQuery: (_m, prompt) => {
      const pkgMatch = prompt.match(/(\S+\.(?:js|mjs|cjs))/)
      return `ESM CommonJS configuration ${pkgMatch?.[1] || ""} fix ${new Date().getFullYear()}`
    },
    briefContext: "ESM/CommonJS incompatibility — search for current module configuration."
  },
  {
    pattern: /(?:not a function|is not a constructor|does not provide an export named)/i,
    type: "api-change",
    buildQuery: (_m, prompt) => {
      const fnMatch = prompt.match(/['"]?(\w+)['"]?\s+is not/i) || prompt.match(/(\w+)\s+does not/i)
      return fnMatch
        ? `${fnMatch[1]} API change migration guide ${new Date().getFullYear()}`
        : `JavaScript API breaking change fix ${new Date().getFullYear()}`
    },
    briefContext: "API may have changed in a newer version — search for current usage."
  },
  {
    pattern: /deprecated.*(?:use|replace|instead|moved)/i,
    type: "deprecation",
    buildQuery: (_m, prompt) => {
      const depMatch = prompt.match(/['"]?(\S+)['"]?\s+(?:is|has been)\s+deprecated/i)
      return depMatch
        ? `${depMatch[1]} deprecated replacement ${new Date().getFullYear()}`
        : `deprecated API replacement guide ${new Date().getFullYear()}`
    },
    briefContext: "Feature has been deprecated — search for the current replacement."
  },
  {
    pattern: /vite.*(?:error|failed|cannot)/i,
    type: "vite-error",
    buildQuery: (_m, prompt) => {
      const coreError = prompt.match(/(?:Error|error):\s*(.{20,80}?)(?:\n|$)/)?.[1] || "configuration error"
      return `vite ${coreError.trim()} fix ${new Date().getFullYear()}`
    },
    briefContext: "Vite build/dev error — search for current fix."
  },
  {
    pattern: /next(?:js)?.*(?:error|failed|cannot)/i,
    type: "nextjs-error",
    buildQuery: (_m, prompt) => {
      const coreError = prompt.match(/(?:Error|error):\s*(.{20,80}?)(?:\n|$)/)?.[1] || "configuration error"
      return `nextjs ${coreError.trim()} fix ${new Date().getFullYear()}`
    },
    briefContext: "Next.js error — search for current fix."
  },
]

/**
 * Detect error patterns in user prompts and generate a web search query.
 */
export function detectErrorForSearch(prompt: string): DetectedError | null {
  for (const ep of ERROR_PATTERNS) {
    const match = prompt.match(ep.pattern)
    if (match) {
      return {
        searchQuery: ep.buildQuery(match, prompt),
        errorType: ep.type,
        briefContext: ep.briefContext
      }
    }
  }
  return null
}

// ─── Config File Detection ───

interface ConfigFileInfo {
  framework: string
  searchQuery: string
}

const CONFIG_FILE_PATTERNS: Array<{ pattern: RegExp; framework: string; searchQuery: string }> = [
  { pattern: /postcss\.config/i, framework: "postcss", searchQuery: "postcss configuration with tailwindcss setup" },
  { pattern: /tailwind\.config/i, framework: "tailwind", searchQuery: "tailwindcss configuration setup" },
  { pattern: /vite\.config/i, framework: "vite", searchQuery: "vite configuration setup" },
  { pattern: /next\.config/i, framework: "nextjs", searchQuery: "next.js configuration" },
  { pattern: /tsconfig/i, framework: "typescript", searchQuery: "tsconfig.json configuration" },
  { pattern: /\.eslintrc|eslint\.config/i, framework: "eslint", searchQuery: "eslint configuration setup" },
  { pattern: /prisma\/schema/i, framework: "prisma", searchQuery: "prisma schema configuration" },
]

/**
 * Check if a file path is a framework config file that needs verified setup.
 *
 * When `runId` is provided AND the project-init brief flagged this path
 * as a fresh-scaffold authored config (via `setConfigSkipList`), this
 * returns `null` — the action-planner's web-search hijack should not
 * fire on greenfield scaffolds (Stage 1 of agent-runtime-fixes plan).
 */
export function detectConfigFile(filePath: string, runId?: string): ConfigFileInfo | null {
  if (runId && isConfigSkipped(runId, filePath)) return null
  for (const cf of CONFIG_FILE_PATTERNS) {
    if (cf.pattern.test(filePath)) {
      return {
        framework: cf.framework,
        searchQuery: `${cf.searchQuery} ${new Date().getFullYear()}`
      }
    }
  }
  return null
}

// ─── Run-level Search Tracking ───

const runSearches = new Map<string, Set<string>>()

export function hasSearchedForFramework(runId: string, framework: string): boolean {
  return runSearches.get(runId)?.has(framework) ?? false
}

export function markFrameworkSearched(runId: string, framework: string): void {
  if (!runSearches.has(runId)) runSearches.set(runId, new Set())
  runSearches.get(runId)!.add(framework)
}

export function clearRunSearches(runId: string): void {
  runSearches.delete(runId)
  configSkipList.delete(runId)
  expectedArtifactsByRun.delete(runId)
}

// ─── Stage 1 of agent-runtime-fixes plan ───
// Per-run skip list populated by `runProjectInitChain` when the
// project-init brief commits with `repoState: "empty" | "small"` and
// HIGH/MEDIUM confidence. Stores filename patterns (e.g. "tsconfig.json",
// ".eslintrc.json") that the action-planner's config-search hijack
// should NOT fire for. The override is correct behaviour for existing
// projects (verify against current docs) but wrong for fresh scaffolds
// (file is being authored — best-practice defaults are fine).
const configSkipList = new Map<string, Set<string>>()

export function setConfigSkipList(runId: string, paths: string[]): void {
  if (!runId) return
  configSkipList.set(runId, new Set(paths.map((p) => p.toLowerCase())))
}

export function isConfigSkipped(runId: string, filePath: string): boolean {
  const skip = configSkipList.get(runId)
  if (!skip || skip.size === 0) return false
  const lower = filePath.toLowerCase()
  // Match by exact filename OR by suffix (handles "src/tsconfig.json" vs "tsconfig.json")
  for (const entry of skip) {
    if (lower === entry || lower.endsWith("/" + entry) || lower.endsWith("\\" + entry)) return true
  }
  return false
}

export function clearConfigSkipList(runId: string): void {
  configSkipList.delete(runId)
}

// ─── Stage 4 follow-up of agent-code-correctness plan: LLM-driven artifact list ───
//
// The project-init reasoner commits an `expectedArtifacts` array
// (e.g., `["db_schema", "tests"]`) when the prompt unambiguously
// requires those artifacts. The completion gate reads this per-run
// state instead of using hardcoded keyword matching. Empty / unset =
// LLM decided no artifacts required → gate skips.

const expectedArtifactsByRun = new Map<string, string[]>()

export function setExpectedArtifacts(runId: string, artifacts: string[]): void {
  if (!runId) return
  expectedArtifactsByRun.set(runId, [...artifacts])
}

export function getExpectedArtifacts(runId: string): string[] | undefined {
  return expectedArtifactsByRun.get(runId)
}

export function clearExpectedArtifacts(runId: string): void {
  expectedArtifactsByRun.delete(runId)
}

// ─── Stage 3 of accountability-and-parallel-execution-sequencing plan ───
//
// Per-run repoState store. The project-init reasoner classifies the
// repository as "empty" | "small" | "existing-small" | "existing-large"
// on the initial user_message turn. Stage 3's read-after-write inject
// (in tool-result.ts) needs to know this classification on later
// tool_result turns to gate the inject to fresh scaffolds only.

const repoStateByRun = new Map<string, string>()

export function setRepoState(runId: string, repoState: string): void {
  if (!runId || !repoState) return
  repoStateByRun.set(runId, repoState)
}

export function getRepoState(runId: string): string | undefined {
  return repoStateByRun.get(runId)
}

export function clearRepoState(runId: string): void {
  repoStateByRun.delete(runId)
}

// ─── Response Overrides ───

/**
 * Override the AI's first response to do a web search for the error.
 * Called from user-message handler when an error is detected in the prompt.
 */
export function buildErrorSearchOverride(error: DetectedError): NormalizedResponse {
  return {
    kind: "needs_tool",
    tool: "web_search",
    args: { query: error.searchQuery },
    content: error.briefContext,
    reasoning: `User reported an error. Searching the web for the current fix before attempting any changes.`,
    usage: { inputTokens: 0, outputTokens: 0 }
  }
}

/**
 * Override a config file write to do a web search first.
 * Called from action planner when a config file write is detected without prior search.
 * Returns { override, pendingContext } — the caller should set planner pendingContext.
 */
export function buildConfigSearchOverride(
  runId: string,
  config: ConfigFileInfo,
  originalResponse: NormalizedResponse
): { override: NormalizedResponse; pendingContext: string } {
  markFrameworkSearched(runId, config.framework)

  const override: NormalizedResponse = {
    kind: "needs_tool",
    tool: "web_search",
    args: { query: config.searchQuery },
    content: `Searching for current ${config.framework} setup documentation before writing config file.`,
    reasoning: `Need to verify current ${config.framework} configuration before writing files — framework APIs change frequently.`,
    usage: originalResponse.usage
  }

  const pendingContext = `[SETUP-INTELLIGENCE] You searched for current ${config.framework} setup docs. ` +
    `Use the search results above to write the CORRECT, UP-TO-DATE configuration. ` +
    `Do NOT fall back to old/memorized configuration patterns — use ONLY what the search results show as current. ` +
    `Now proceed to write the config file(s) based on the search results.`

  return { override, pendingContext }
}

/**
 * Check parallel tool calls for config files that need web search verification.
 * Returns the config info if a search should be done first, null if all clear.
 */
export function checkToolsForConfigFiles(runId: string, tools: ToolCall[]): ConfigFileInfo | null {
  for (const tc of tools) {
    if (tc.tool !== "write_file" && tc.tool !== "edit_file") continue
    const filePath = (tc.args?.path as string) || ""
    const config = detectConfigFile(filePath, runId)
    if (config && !hasSearchedForFramework(runId, config.framework)) {
      return config
    }
  }
  return null
}
