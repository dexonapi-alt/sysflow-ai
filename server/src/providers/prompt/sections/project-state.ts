/**
 * Plan `2026-05-15-agent-runtime-fixes-and-project-init-reasoning.md` Stage 1.
 *
 * Project-state prompt section. Renders the project-init reasoner's
 * verdict as a `═══ PROJECT STATE ═══` block in the system prompt so
 * the agent's FIRST move knows whether the repo is empty (scaffold
 * from scratch) or large-existing (investigate before changes).
 *
 * Non-cacheable — depends on the per-run brief, which is constant
 * within a run but differs across runs.
 *
 * The fields are read from the project-init brief produced by
 * `runProjectInitChain` in `user-message.ts`. Untyped in the context
 * to avoid an import cycle with the reasoning module — the renderer
 * does its own field validation.
 */

export interface ProjectStateCtx {
  projectInitBrief?: unknown
}

interface ProjectInitBriefShape {
  repoState: "empty" | "small" | "existing-small" | "existing-large"
  fileCount: number
  keyMarkers: string[]
  investigationPlan: string[]
  confidence: "HIGH" | "MEDIUM" | "LOW"
}

function isBrief(v: unknown): v is ProjectInitBriefShape {
  if (!v || typeof v !== "object") return false
  const b = v as Record<string, unknown>
  return (
    typeof b.repoState === "string" &&
    ["empty", "small", "existing-small", "existing-large"].includes(b.repoState as string) &&
    typeof b.fileCount === "number" &&
    Array.isArray(b.investigationPlan) &&
    typeof b.confidence === "string"
  )
}

const REPO_STATE_GUIDANCE: Record<ProjectInitBriefShape["repoState"], string> = {
  "empty":
    "EMPTY repo — the user is asking for a fresh scaffold. There is no existing code to read or verify. " +
    "Do NOT demand to see configs that don't exist yet. Do NOT web-search 'tsconfig.json configuration <year>' " +
    "or similar for files you are AUTHORING. Best-practice defaults are correct. " +
    "Skip investigation reads of non-existent files; head straight to scaffolding.",
  "small":
    "SMALL repo — a handful of entries but no package manifest yet. Could be a stub or a one-off. " +
    "Read the README + any obvious config before assuming the user wants a fresh scaffold. " +
    "If the prompt is greenfield, treat as a fresh-scaffold start.",
  "existing-small":
    "EXISTING SMALL project — has a package manifest and a modest source tree. " +
    "READ THE MANIFEST + the relevant source files BEFORE editing. " +
    "Do not introduce stack changes (new framework, new build tool) without surfacing them as a question.",
  "existing-large":
    "EXISTING LARGE project — has a manifest and ≥ 50 source files (or a monorepo). " +
    "MANDATORY: READ THE MANIFEST + entrypoint + grep for the feature area before any write. " +
    "If the user's prompt looks greenfield, the user almost certainly wants to ADD to this project, " +
    "NOT replace it — confirm with a `_user_response` ask before scaffolding anew.",
}

export function getProjectStateSection(ctx: ProjectStateCtx): string | null {
  if (!isBrief(ctx.projectInitBrief)) return null
  const brief = ctx.projectInitBrief

  const lines: string[] = []
  lines.push("═══ PROJECT STATE (classified before this turn) ═══")
  lines.push(`repoState: ${brief.repoState}  ·  fileCount: ${brief.fileCount}  ·  confidence: ${brief.confidence}`)
  if (brief.keyMarkers.length > 0) {
    lines.push(`keyMarkers: ${brief.keyMarkers.slice(0, 12).join(", ")}`)
  }
  lines.push("")
  lines.push(REPO_STATE_GUIDANCE[brief.repoState])
  lines.push("")
  if (brief.investigationPlan.length > 0) {
    lines.push("INVESTIGATION PLAN (run these FIRST, BEFORE any write):")
    brief.investigationPlan.slice(0, 8).forEach((cmd, i) => {
      lines.push(`  ${i + 1}. ${cmd}`)
    })
    lines.push("")
  }
  lines.push("═══ END PROJECT STATE ═══")
  return lines.join("\n")
}
