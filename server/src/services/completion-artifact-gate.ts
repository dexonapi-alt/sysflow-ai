/**
 * Plan `2026-05-16-agent-code-correctness-and-completion-artifacts.md` Stage 4.
 *
 * Prompt-implied completion-artifact gate. Scans the user's original
 * prompt for keywords that imply specific output artifacts (DB schema
 * for postgres prompts, migrations for prisma, tests when "tests"
 * was explicit) and verifies those artifacts ACTUALLY exist on disk
 * when the model declares completion. Blocks completion when the
 * implied artifact is missing.
 *
 * Closes the user-reported repro where the agent declared the POS
 * backend "done" with no SQL schema file even though the prompt was
 * explicitly *"build a clean and scalable Express.js POS backend"*
 * with PostgreSQL. The agent shipped a disclaimer instead:
 * *"Database schema creation is a manual step for the user."*
 *
 * Three checks, each conservative (only fires on unambiguous prompt
 * intent):
 *   1. DB schema — postgres / postgresql / pg / mysql / sqlite /
 *      mongo / mariadb → require schema.sql or migrations/.
 *   2. Prisma — explicit prisma mention → require prisma/schema.prisma.
 *   3. Tests — standalone tests / testing in the prompt → require
 *      at least one *.test.ts/js or *.spec.ts/js.
 *
 * Filename scan is fast (single glob walk capped at 1000 entries);
 * cost is bounded.
 */

import fs from "node:fs/promises"
import path from "node:path"
import { getExpectedArtifacts } from "./setup-intelligence.js"

export type ArtifactKind = "db_schema" | "prisma_schema" | "tests"

export interface ImpliedArtifact {
  kind: ArtifactKind
  /** Human-readable description of what's expected. */
  expected: string
  /** Reason the keyword fired (for the inject block). */
  trigger: string
  /** Concrete file path examples the agent could create. */
  examples: string[]
}

const FILE_SCAN_CAP = 1000
const FILE_SCAN_DEPTH = 4

/**
 * Pure: classify the user's prompt for implied artifacts. Each match
 * adds an entry to the returned list. Order: db_schema first
 * (most-reported), then prisma, then tests.
 */
export function classifyImpliedArtifacts(prompt: string): ImpliedArtifact[] {
  if (!prompt || typeof prompt !== "string") return []
  const lower = prompt.toLowerCase()
  const out: ImpliedArtifact[] = []

  // Prisma is a stricter case than generic DB — check first so we
  // attribute the requirement to the more specific framework.
  if (/\bprisma\b/.test(lower)) {
    out.push({
      kind: "prisma_schema",
      expected: "a Prisma schema file at `prisma/schema.prisma`",
      trigger: "your prompt explicitly mentioned Prisma",
      examples: ["prisma/schema.prisma"],
    })
  } else if (/\b(postgres|postgresql|pg|mysql|sqlite|mongo(?:db)?|mariadb)\b/.test(lower)) {
    // Note: matches `pg` as a whole word — won't match in unrelated
    // contexts (e.g., "page", "spring").
    out.push({
      kind: "db_schema",
      expected: "a SQL schema file (e.g. `schema.sql`) or a migration directory (e.g. `migrations/001_initial.sql`)",
      trigger: "your prompt mentioned a database (postgres / mysql / sqlite / mongo / mariadb)",
      examples: ["schema.sql", "migrations/001_initial.sql", "src/db/schema.sql"],
    })
  }

  // Tests check — only fire on STANDALONE "tests" / "testing" (the
  // noun-form). Many prompts include "test" in other contexts (e.g.,
  // "test the app by running npm run dev") which shouldn't fire.
  // Word boundary + standalone forms keep this conservative.
  if (/\b(tests?|testing|test\s+suite|unit\s+test|integration\s+test)\b/.test(lower) && !/\btest\s+(it|this|out|drive)\b/.test(lower)) {
    out.push({
      kind: "tests",
      expected: "at least one test file (e.g. `*.test.ts`, `*.test.js`, `*.spec.ts`, `*.spec.js`)",
      trigger: "your prompt mentioned tests / testing",
      examples: ["src/routes/auth.test.ts", "tests/integration.spec.ts"],
    })
  }

  return out
}

/**
 * Async: walk the cwd looking for files matching artifact patterns.
 * Capped at FILE_SCAN_CAP entries + FILE_SCAN_DEPTH to keep cost
 * bounded on large repos. Returns true when at least one match exists
 * for the given artifact kind.
 */
export async function artifactExists(cwd: string, kind: ArtifactKind): Promise<boolean> {
  const matcher = getMatcher(kind)
  return walkAndMatch(cwd, matcher)
}

function getMatcher(kind: ArtifactKind): (rel: string) => boolean {
  if (kind === "prisma_schema") {
    return (rel) => rel === "prisma/schema.prisma" || rel === "prisma\\schema.prisma" || rel.endsWith("/prisma/schema.prisma")
  }
  if (kind === "db_schema") {
    return (rel) => {
      const lower = rel.toLowerCase().replace(/\\/g, "/")
      // schema.sql / schema.prisma at any depth
      if (lower.endsWith("/schema.sql") || lower === "schema.sql") return true
      if (lower.endsWith("/schema.prisma") || lower === "schema.prisma") return true
      // any *.sql file under migrations/
      if (/(^|\/)migrations\//.test(lower) && lower.endsWith(".sql")) return true
      // any *.sql at root or src/db/
      if (lower.endsWith(".sql")) return true
      return false
    }
  }
  // tests
  return (rel) => {
    const lower = rel.toLowerCase().replace(/\\/g, "/")
    return /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/.test(lower)
  }
}

const SCAN_SKIP_DIRS = new Set([
  "node_modules", ".git", ".next", ".nuxt", "dist", "build", ".turbo",
  ".cache", "coverage", ".output", ".svelte-kit", "__pycache__", ".venv",
  "target", "sysbase",
])

async function walkAndMatch(cwd: string, matcher: (rel: string) => boolean): Promise<boolean> {
  let count = 0
  async function recur(dir: string, depth: number, prefix: string): Promise<boolean> {
    if (count >= FILE_SCAN_CAP || depth > FILE_SCAN_DEPTH) return false
    let entries: { name: string; isDirectory(): boolean; isFile(): boolean }[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return false
    }
    for (const e of entries) {
      if (count >= FILE_SCAN_CAP) return false
      const relPath = prefix ? `${prefix}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (SCAN_SKIP_DIRS.has(e.name)) continue
        if (e.name.startsWith(".") && e.name !== ".") continue  // skip other dotdirs
        const found = await recur(path.join(dir, e.name), depth + 1, relPath)
        if (found) return true
      } else if (e.isFile()) {
        count += 1
        if (matcher(relPath)) return true
      }
    }
    return false
  }
  return recur(cwd, 0, "")
}

export interface ArtifactCheckResult {
  ok: boolean
  /** Implied artifacts that fired (matched the prompt). Empty when
   *  the prompt didn't imply any. */
  expected: ImpliedArtifact[]
  /** Subset of `expected` whose artifact was NOT found on disk. The
   *  inject block reports these. */
  missing: ImpliedArtifact[]
}

/**
 * Pure: rehydrate ImpliedArtifact metadata (description / trigger /
 * examples) from a list of bare ArtifactKind values. Used when the
 * LLM-driven `expectedArtifacts` list is the source of truth instead
 * of the keyword classifier.
 */
export function impliedArtifactFromKind(kind: ArtifactKind): ImpliedArtifact {
  if (kind === "prisma_schema") {
    return {
      kind: "prisma_schema",
      expected: "a Prisma schema file at `prisma/schema.prisma`",
      trigger: "the project-init reasoner committed expectedArtifacts: ['prisma_schema']",
      examples: ["prisma/schema.prisma"],
    }
  }
  if (kind === "db_schema") {
    return {
      kind: "db_schema",
      expected: "a SQL schema file (e.g. `schema.sql`) or a migration directory (e.g. `migrations/001_initial.sql`)",
      trigger: "the project-init reasoner committed expectedArtifacts: ['db_schema']",
      examples: ["schema.sql", "migrations/001_initial.sql", "src/db/schema.sql"],
    }
  }
  return {
    kind: "tests",
    expected: "at least one test file (e.g. `*.test.ts`, `*.test.js`, `*.spec.ts`, `*.spec.js`)",
    trigger: "the project-init reasoner committed expectedArtifacts: ['tests']",
    examples: ["src/routes/auth.test.ts", "tests/integration.spec.ts"],
  }
}

/**
 * Top-level orchestrator. Two-tier:
 *
 *   1. LLM-driven (preferred): when the project-init reasoner
 *      committed `expectedArtifacts` for this run, use that list.
 *      Empty list = LLM decided no artifacts required → skip
 *      enforcement entirely (no false positives on "CLI calculator"
 *      type prompts).
 *
 *   2. Hardcoded keyword fallback: only used when project-init didn't
 *      fire (legacy / no reasoner backend / chain returned null).
 *      Conservative but blunt — kept as the safety net.
 *
 * The LLM-driven path is the design contract: the model decides
 * WHETHER each artifact is required; this gate enforces THAT
 * decision against the disk.
 */
export async function checkImpliedArtifacts(prompt: string, cwd: string, runId?: string): Promise<ArtifactCheckResult> {
  // Tier 1: LLM-driven verdict from project-init.
  if (runId) {
    const llmVerdict = getExpectedArtifacts(runId)
    if (llmVerdict !== undefined) {
      // LLM ran — trust its decision (empty array = no artifacts required).
      const expected = llmVerdict
        .filter((k): k is ArtifactKind => k === "db_schema" || k === "prisma_schema" || k === "tests")
        .map(impliedArtifactFromKind)
      if (expected.length === 0) return { ok: true, expected: [], missing: [] }
      const missing: ImpliedArtifact[] = []
      for (const a of expected) {
        const exists = await artifactExists(cwd, a.kind)
        if (!exists) missing.push(a)
      }
      return { ok: missing.length === 0, expected, missing }
    }
  }
  // Tier 2: hardcoded keyword fallback (legacy / no reasoner).
  const expected = classifyImpliedArtifacts(prompt)
  if (expected.length === 0) return { ok: true, expected: [], missing: [] }
  const missing: ImpliedArtifact[] = []
  for (const a of expected) {
    const exists = await artifactExists(cwd, a.kind)
    if (!exists) missing.push(a)
  }
  return { ok: missing.length === 0, expected, missing }
}

/**
 * Pure: render the completion-blocked inject block. Lists each
 * missing artifact with the trigger keyword + concrete file examples
 * so the agent has a clear path to fix.
 */
export function buildArtifactMissingInject(missing: ImpliedArtifact[]): string {
  if (missing.length === 0) return ""
  const lines: string[] = []
  lines.push("═══ COMPLETION BLOCKED — PROMPT-IMPLIED ARTIFACT MISSING ═══")
  lines.push("")
  lines.push(`Your declared completion was BLOCKED. The user's prompt implied ${missing.length} artifact${missing.length === 1 ? "" : "s"} that ${missing.length === 1 ? "wasn't" : "weren't"} written to disk:`)
  lines.push("")
  for (let i = 0; i < missing.length; i++) {
    const a = missing[i]
    lines.push(`  ${i + 1}. MISSING: ${a.expected}`)
    lines.push(`     WHY REQUIRED: ${a.trigger}`)
    lines.push(`     EXAMPLES YOU CAN CREATE:`)
    for (const ex of a.examples) {
      lines.push(`       - ${ex}`)
    }
    if (i < missing.length - 1) lines.push("")
  }
  lines.push("")
  lines.push("REQUIRED for your next turn:")
  lines.push("  - Create the missing artifact(s) above. Don't ship a 'this is a manual step for the user' disclaimer — when the prompt explicitly names a DB / framework / testing, the schema / migration / tests are part of the agent's job.")
  lines.push("  - Re-run completion ONLY after the file(s) exist on disk.")
  lines.push("")
  lines.push("Do NOT declare 'completed' again with these still missing. The gate will reject the response and force this loop.")
  lines.push("")
  lines.push("═══ END COMPLETION BLOCKED ═══")
  return lines.join("\n")
}
