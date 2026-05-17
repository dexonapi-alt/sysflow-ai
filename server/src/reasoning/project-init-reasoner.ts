/**
 * Plan `2026-05-15-agent-runtime-fixes-and-project-init-reasoning.md` Stage 1.
 *
 * Iterative-paragraph project-initialisation reasoner.
 * `runProjectInitChain(payload, callBackend?)` fires the
 * `project_init` pipeline (1-3 iterations, LLM owns the `done` flag)
 * and returns a `ProjectInitBrief` with:
 *
 *   - `paragraphs[]`              — senior-engineer prose chain
 *   - `repoState`                 — empty / small / existing-small / existing-large
 *   - `fileCount`                 — count from the directory tree
 *   - `keyMarkers`                — recognised manifests / folders
 *   - `investigationPlan[]`       — concrete commands the agent should run FIRST
 *   - `skipConfigVerificationFor` — config files the action-planner should NOT
 *                                   hijack (only populated when scaffolding from
 *                                   scratch, where the file is being authored
 *                                   rather than verified against current docs)
 *   - `confidence` + `iterations` + `committedVia` for telemetry
 *
 * Same self-directing-depth pattern as `runErrorReasoningChain`. Cap
 * at 3 iterations — repo shape is usually unambiguous after one pass.
 */

import { z } from "zod"
import { callReasonerBackend } from "./backends/index.js"
import { pickReasonerBackend, type ReasonerBackend } from "../services/free-tier-policy.js"
import { getPipelineSystemPrompt } from "./pipelines/index.js"

/**
 * Stage 4 follow-up of agent-code-correctness plan: completion
 * artifact kinds the model can declare as expected. The completion
 * gate enforces these on `kind: "completed"` responses — when the
 * model committed `expectedArtifacts: ["db_schema"]` but no schema
 * file exists on disk, completion is blocked with a directive to
 * create one. Replaces hardcoded keyword matching with LLM judgment.
 *
 *   - "db_schema"      → SQL schema / migration file (postgres,
 *                        mysql, sqlite, mongo, etc.)
 *   - "prisma_schema"  → prisma/schema.prisma
 *   - "tests"          → at least one *.test.{ts,js} / *.spec.{ts,js}
 *
 * Empty array means the LLM decided the prompt doesn't imply any
 * required artifacts (CLI tool, automation script, web UI without
 * DB, etc.) — gate skips.
 */
export const ARTIFACT_KINDS = ["db_schema", "prisma_schema", "tests"] as const
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number]

export const projectInitStepSchema = z.object({
  paragraph: z.string().min(1).max(1200),
  done: z.boolean(),
  repoState: z.enum(["empty", "small", "existing-small", "existing-large"]).nullable(),
  fileCount: z.number().int().nonnegative().nullable(),
  keyMarkers: z.array(z.string().min(1).max(120)).max(20).default([]),
  investigationPlan: z.array(z.string().min(1).max(300)).max(8).default([]),
  skipConfigVerificationFor: z.array(z.string().min(1).max(120)).max(20).default([]),
  expectedArtifacts: z.array(z.enum(ARTIFACT_KINDS)).max(8).default([]),
  confidence: z.enum(["HIGH", "MEDIUM", "LOW"]).nullable(),
  supersedes: z.number().int().min(0).nullable().optional(),
})
export type ProjectInitStep = z.infer<typeof projectInitStepSchema>

export interface ProjectInitBrief {
  paragraphs: string[]
  repoState: "empty" | "small" | "existing-small" | "existing-large"
  fileCount: number
  keyMarkers: string[]
  investigationPlan: string[]
  skipConfigVerificationFor: string[]
  expectedArtifacts: ArtifactKind[]
  confidence: "HIGH" | "MEDIUM" | "LOW"
  iterations: number
  committedVia: "done_flag" | "step_cap"
}

export const MAX_PROJECT_INIT_ITERATIONS = 3

export interface ProjectInitPayload {
  /** Flat list of directory entries (name + type) as the user sent
   *  them. The reasoner sees this verbatim in its user turn. */
  directoryTree: Array<{ name: string; type: "file" | "directory" }>
  /** The verbatim user prompt. The reasoner uses it for the
   *  intent-vs-shape fit check. */
  userMessage: string
  platform?: string
  model?: string | null
  flagOverride?: string
  maxOutputTokens?: number
  maxIterations?: number
}

export type ProjectInitLlmCall = (args: {
  backend: ReasonerBackend
  systemInstruction: string
  userTurn: string
  maxOutputTokens: number
}) => Promise<string>

/** Parse one iteration's raw JSON. Returns null on malformed. */
export function parseProjectInitStep(raw: string): ProjectInitStep | null {
  const stripped = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim()
  try {
    const obj = JSON.parse(stripped) as Record<string, unknown>
    const parsed = projectInitStepSchema.safeParse(obj)
    if (!parsed.success) return null
    return parsed.data
  } catch {
    return null
  }
}

const TREE_PREVIEW_CAP = 200
const TREE_CHAR_CAP = 4000

/** Render the directory tree into a compact text representation for
 *  the user turn. Caps at TREE_PREVIEW_CAP entries to keep the prompt
 *  bounded; truncates the rendered string at TREE_CHAR_CAP. Pure. */
export function renderDirectoryTreeForReasoner(tree: Array<{ name: string; type: "file" | "directory" }>): string {
  if (tree.length === 0) return "(empty — no entries)"
  const sorted = [...tree].sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  const shown = sorted.slice(0, TREE_PREVIEW_CAP)
  const lines = shown.map((e) => `${e.type === "directory" ? "📁" : "📄"} ${e.name}`)
  if (sorted.length > TREE_PREVIEW_CAP) {
    lines.push(`… ${sorted.length - TREE_PREVIEW_CAP} more entries omitted`)
  }
  const joined = lines.join("\n")
  if (joined.length <= TREE_CHAR_CAP) return joined
  return joined.slice(0, TREE_CHAR_CAP - 20) + "\n… (truncated)"
}

/** Build the user turn for one iteration. Pure; exported for tests. */
export function buildProjectInitUserTurn(payload: ProjectInitPayload, paragraphs: string[], stepIndex: number, maxSteps: number): string {
  const parts: string[] = []
  parts.push(`ITERATION ${stepIndex + 1} of up to ${maxSteps}`)
  parts.push("")
  parts.push(`USER PROMPT:`)
  parts.push(payload.userMessage.slice(0, 2000))
  parts.push("")
  parts.push(`PLATFORM: ${payload.platform ?? "unknown"}`)
  parts.push("")
  parts.push(`DIRECTORY TREE (${payload.directoryTree.length} entries):`)
  parts.push(renderDirectoryTreeForReasoner(payload.directoryTree))
  parts.push("")

  if (paragraphs.length === 0) {
    parts.push("This is the FIRST iteration. Read the tree carefully — counts and key markers (package.json, src/, .git/) matter more than guessing. Apply the rubric. Commit with `done: true` unless the shape is genuinely ambiguous (e.g. a stub with no manifest could be a fresh start or a one-off scripts folder).")
  } else {
    parts.push("PRIOR PARAGRAPHS (oldest first):")
    paragraphs.forEach((p, i) => parts.push(`[${i}] ${p}`))
    parts.push("")
    parts.push("This is a follow-up iteration. Address the question your prior paragraph raised. Commit with `done: true` unless this pass surfaces another genuine question. Use `supersedes: N` if you need to revise a prior paragraph instead of stacking contradictions.")
  }
  parts.push("")
  parts.push("Output ONLY the JSON object. No markdown fences. No prose outside the JSON.")
  return parts.join("\n")
}

/**
 * LLM iterative paragraph chain for project-init reasoning. Returns
 * `null` only when no usable brief emerged (no reasoner backend / every
 * iteration unparseable / chain ran to cap with no repoState). The
 * caller treats `null` as signal to fall back to the agent's
 * pre-Stage-1 behaviour (action-planner config hijack still fires).
 */
export async function runProjectInitChain(
  payload: ProjectInitPayload,
  callBackend: ProjectInitLlmCall = defaultLlmCall,
): Promise<ProjectInitBrief | null> {
  const backend = pickReasonerBackend({
    model: payload.model ?? null,
    flagOverride: payload.flagOverride ?? "auto",
  })
  if (!backend) return null

  const systemInstruction = getPipelineSystemPrompt("project_init")
  const maxOutputTokens = payload.maxOutputTokens ?? 1200
  const maxIterations = Math.max(1, Math.min(payload.maxIterations ?? MAX_PROJECT_INIT_ITERATIONS, MAX_PROJECT_INIT_ITERATIONS))

  const paragraphs: string[] = []
  let lastRepoState: "empty" | "small" | "existing-small" | "existing-large" | null = null
  let lastFileCount: number | null = null
  let lastKeyMarkers: string[] = []
  let lastInvestigationPlan: string[] = []
  let lastSkipConfigVerificationFor: string[] = []
  let lastExpectedArtifacts: ArtifactKind[] = []
  let lastConfidence: "HIGH" | "MEDIUM" | "LOW" | null = null
  let committedViaDoneFlag = false
  let iterations = 0

  for (let i = 0; i < maxIterations; i++) {
    iterations = i + 1
    const userTurn = buildProjectInitUserTurn(payload, paragraphs, i, maxIterations)
    let raw: string
    try {
      raw = await callBackend({ backend, systemInstruction, userTurn, maxOutputTokens })
    } catch (err) {
      console.warn(`[project-init-reasoner] iteration ${iterations} failed: ${(err as Error).message}`)
      break
    }
    const step = parseProjectInitStep(raw)
    if (!step) {
      console.warn(`[project-init-reasoner] iteration ${iterations} unparseable; stopping with ${paragraphs.length} paragraph(s)`)
      break
    }

    if (step.supersedes != null && step.supersedes >= 0 && step.supersedes < paragraphs.length) {
      paragraphs[step.supersedes] = step.paragraph
    } else {
      paragraphs.push(step.paragraph)
    }
    if (step.repoState) lastRepoState = step.repoState
    if (step.fileCount != null) lastFileCount = step.fileCount
    if (step.keyMarkers && step.keyMarkers.length > 0) lastKeyMarkers = step.keyMarkers
    if (step.investigationPlan && step.investigationPlan.length > 0) lastInvestigationPlan = step.investigationPlan
    if (step.skipConfigVerificationFor && step.skipConfigVerificationFor.length > 0) lastSkipConfigVerificationFor = step.skipConfigVerificationFor
    if (step.expectedArtifacts && step.expectedArtifacts.length > 0) lastExpectedArtifacts = step.expectedArtifacts
    if (step.confidence) lastConfidence = step.confidence

    if (step.done) {
      committedViaDoneFlag = true
      break
    }
  }

  if (!lastRepoState) return null

  return {
    paragraphs,
    repoState: lastRepoState,
    fileCount: lastFileCount ?? payload.directoryTree.length,
    keyMarkers: lastKeyMarkers,
    investigationPlan: lastInvestigationPlan,
    skipConfigVerificationFor: lastSkipConfigVerificationFor,
    expectedArtifacts: lastExpectedArtifacts,
    confidence: lastConfidence ?? "LOW",
    iterations,
    committedVia: committedViaDoneFlag ? "done_flag" : "step_cap",
  }
}

async function defaultLlmCall(args: { backend: ReasonerBackend; systemInstruction: string; userTurn: string; maxOutputTokens: number }): Promise<string> {
  return callReasonerBackend(args.backend, {
    payload: {
      trigger: "preflight",
      userMessage: args.userTurn,
      model: "project-init-reasoner",
    },
    kind: "project_init",
    userTurnOverride: args.userTurn,
    defaultUserTurn: args.userTurn,
    maxOutputTokens: args.maxOutputTokens,
    systemInstruction: args.systemInstruction,
  })
}
