/**
 * <ReasoningPeek> — Phase 14 Stage 4: surfaces what a Flash reasoning
 * call concluded, instead of leaving the user staring at "thinking…"
 * until the result lands silently.
 *
 * Renders a small block above the spinner whenever the reducer's
 * `reasoningBrief` slot is populated:
 *
 *   ✦ Reasoning(implement)
 *     → build a postgres-backed user API
 *     → stack: TypeScript + Fastify + Drizzle
 *
 * Each pipeline kind (implement / bug / summary / decision /
 * divergence / chunk_plan / chunk_reflect / simple) produces 1-3
 * relevant summary lines via the pure `formatBriefSummary(brief)`
 * helper exported below. Unknown / partial briefs fall through to a
 * generic single-line `→ confidence: HIGH` row so the peek is never
 * blank.
 *
 * Stays mounted until the next `clear` event (new prompt). A future
 * sub-stage can add ctrl+o expand / auto-collapse after N seconds —
 * Stage 4 keeps the peek always-visible-until-next-prompt for clarity.
 *
 * Motion-disabled: the marker glyph renders steady muted-accent (no
 * Pulse). The summary lines are static text either way.
 */

import * as React from "react"
import { Box, Text } from "ink"
import { palette } from "../theme.js"
import { Pulse } from "../animation/primitives/index.js"
import type { ReasoningBriefState } from "../hooks/useAgentEvents.js"

interface Props {
  brief: ReasoningBriefState
}

export interface BriefSummary {
  /** Human-readable pipeline name shown in the header (`Reasoning(implement)`). */
  pipelineLabel: string
  /** 1-3 short lines surfaced under the header. */
  lines: string[]
}

/**
 * Pure: extract the most-relevant 1-3 lines from a reasoning envelope.
 * The envelope shape comes from `server/src/reasoning/reasoning-schema.ts`
 * but we keep this loose-typed because the renderer reads only the
 * fields it knows about — adding a new pipeline server-side never
 * breaks the renderer; it just falls through to the generic case.
 *
 * 2026-05-15 update — plain-prose preference:
 *   When the brief envelope carries `reasoningChain[]` (the
 *   senior-engineer paragraphs `runIterativeChain` produces in
 *   `task-reasoner.ts`), surface those AS the peek body. The
 *   structured fields (`bugBrief.symptom`, `implementBrief.intent`,
 *   etc.) stay on the schema for downstream code (divergence detector
 *   reads `bugBrief.suspectedBoundary`, etc.) but are no longer the
 *   user-facing surface. Why: a user-reported bug showed Flash
 *   filling `bugBrief.symptom` with non-symptom text (`"User
 *   requested to build a Node.js Express PostgreSQL backend..."`)
 *   on a mis-routed prompt — the actual reasoning chain was already
 *   in `reasoningChain[]` but invisible. See
 *   `gotchas.md: ## ReasoningPeek surfaced structured-field text
 *   instead of plain-prose reasoning chain`.
 *
 *   Falls back to structured-field rendering when `reasoningChain`
 *   is empty or missing — pipelines that don't yet produce a chain
 *   (chunk_plan, chunk_reflect, divergence verdict) keep their
 *   current peek shape.
 *
 * Exported so the contract is testable without rendering Ink.
 */
export function formatBriefSummary(kind: string, briefData: Record<string, unknown> | undefined): BriefSummary {
  const data = briefData ?? {}

  // ─── Plain-prose preference (2026-05-15) ───────────────────────
  // Drain `reasoningChain` first. When the LLM ran an iterative
  // paragraph chain (preflight / future intent classifier / any
  // future deliberative pipeline), the paragraphs land here.
  const chain = Array.isArray(data.reasoningChain) ? (data.reasoningChain as unknown[]) : []
  const paragraphs = chain
    .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
    .map((p) => p.trim())
  if (paragraphs.length > 0) {
    return formatPlainReasoningChain(kind, paragraphs)
  }

  // ─── Fallback: structured-field rendering ───────────────────────
  // Pipelines without a chain (chunk_plan, chunk_reflect, divergence
  // verdict, or legacy briefs from before iterative reasoning landed)
  // keep their existing pure-structured rendering.
  const lines: string[] = []

  // Implement pipeline — the most common preflight outcome.
  if (kind === "implement") {
    const ib = (data.implementBrief as Record<string, unknown> | undefined) ?? {}
    if (typeof ib.intent === "string") lines.push(`→ ${truncate(ib.intent, 80)}`)
    const stack = ib.recommendedStack as Record<string, unknown> | undefined
    if (stack) {
      const language = typeof stack.language === "string" ? stack.language : ""
      const fws = Array.isArray(stack.frameworks) ? (stack.frameworks as string[]) : []
      const libs = Array.isArray(stack.libraries) ? (stack.libraries as string[]) : []
      const composed = [language, ...fws, ...libs].filter(Boolean).slice(0, 5).join(" + ")
      if (composed) lines.push(`→ stack: ${composed}`)
    }
    // Stage 3 of command-first-investigation: surface the planned
    // investigation commands so the user sees what the agent's about to
    // run before any writes happen. Compact mono list — first 3 commands.
    appendInvestigationLines(lines, ib.investigationPlan)
    return { pipelineLabel: "Reasoning(implement)", lines: lines.length > 0 ? lines : [confidenceLine(data)] }
  }

  // Bug pipeline — on-error reasoner output.
  if (kind === "bug") {
    const bb = (data.bugBrief as Record<string, unknown> | undefined) ?? {}
    if (typeof bb.symptom === "string") lines.push(`→ symptom: ${truncate(bb.symptom, 80)}`)
    if (typeof bb.suspectedBoundary === "string") lines.push(`→ boundary: ${bb.suspectedBoundary}`)
    const fix = bb.proposedFix as Record<string, unknown> | undefined
    if (fix && typeof fix.description === "string") lines.push(`→ fix: ${truncate(fix.description, 70)}`)
    appendInvestigationLines(lines, bb.investigationPlan)
    return { pipelineLabel: "Reasoning(bug)", lines: lines.length > 0 ? lines : [confidenceLine(data)] }
  }

  // Decision pipeline — self-invoked `reason` tool output.
  if (kind === "decision") {
    const db = (data.decisionBrief as Record<string, unknown> | undefined) ?? {}
    if (typeof db.recommendation === "string") lines.push(`→ ${truncate(db.recommendation, 80)}`)
    if (typeof db.proceedHint === "string") lines.push(`→ ${truncate(db.proceedHint, 80)}`)
    return { pipelineLabel: "Reasoning(decision)", lines: lines.length > 0 ? lines : [confidenceLine(data)] }
  }

  // Summary pipeline — on-completion summariser.
  if (kind === "summary") {
    const sb = (data.summaryBrief as Record<string, unknown> | undefined) ?? {}
    const clusters = Array.isArray(sb.clusters) ? (sb.clusters as Array<{ heading?: string }>) : []
    if (clusters.length > 0) {
      const heads = clusters.map((c) => c.heading).filter((h): h is string => typeof h === "string").slice(0, 3)
      if (heads.length > 0) lines.push(`→ clusters: ${heads.join(" · ")}`)
    }
    return { pipelineLabel: "Reasoning(summary)", lines: lines.length > 0 ? lines : [confidenceLine(data)] }
  }

  // Phase 11 divergence verdict.
  if (kind === "divergence") {
    const dv = (data.divergenceVerdictBrief as Record<string, unknown> | undefined) ?? {}
    if (typeof dv.onTrack === "boolean") lines.push(`→ on track: ${dv.onTrack ? "yes" : "no"}`)
    if (typeof dv.score === "number") lines.push(`→ score: ${dv.score}/100`)
    const mismatches = Array.isArray(dv.mismatches) ? (dv.mismatches as string[]) : []
    if (mismatches.length > 0) lines.push(`→ ${truncate(mismatches[0], 80)}`)
    return { pipelineLabel: "Reasoning(divergence)", lines: lines.length > 0 ? lines : [confidenceLine(data)] }
  }

  // Phase 16 Stage 3: chained implement_elaborate brief — surfaced from
  // the response's `reasoningElaborationBrief` field. The free-tier
  // second look's whole point is to make WHY visible, so we render it
  // with a bit more space than the chunk briefs do.
  if (kind === "implement_elaborate") {
    const eb = (data.implementElaborationBrief as Record<string, unknown> | undefined) ?? data
    if (typeof eb.whyThisApproach === "string") lines.push(`→ ${truncate(eb.whyThisApproach, 90)}`)
    if (typeof eb.confidence === "string") lines.push(`→ re-scored confidence: ${eb.confidence}`)
    const preconds = Array.isArray(eb.preconditions) ? (eb.preconditions as string[]) : []
    if (preconds.length > 0) lines.push(`→ preconditions: ${preconds.slice(0, 2).join(" · ")}`)
    return { pipelineLabel: "Reasoning(elaborate)", lines: lines.length > 0 ? lines : [confidenceLine(data)] }
  }

  // Phase 10 chunk plan / reflect — short summaries because these fire
  // every chunk and we don't want the peek to dominate the screen.
  if (kind === "chunk_plan") {
    const cp = (data.chunkPlanBrief as Record<string, unknown> | undefined) ?? {}
    if (typeof cp.nextAction === "string") lines.push(`→ ${truncate(cp.nextAction, 80)}`)
    return { pipelineLabel: "Reasoning(chunk plan)", lines }
  }
  if (kind === "chunk_reflect") {
    const cr = (data.chunkReflectionBrief as Record<string, unknown> | undefined) ?? {}
    if (typeof cr.coherent === "boolean") lines.push(`→ coherent: ${cr.coherent ? "yes" : "no"}`)
    if (typeof cr.nextFocus === "string" && cr.nextFocus.length > 0) lines.push(`→ ${truncate(cr.nextFocus, 80)}`)
    return { pipelineLabel: "Reasoning(chunk reflect)", lines }
  }

  // simple / unknown — generic confidence line.
  return { pipelineLabel: `Reasoning(${kind})`, lines: [confidenceLine(data)] }
}

/**
 * Plain-prose render path. Shows up to MAX_PARAGRAPH_LINES paragraphs,
 * each truncated to MAX_PARAGRAPH_CHARS so the peek stays compact.
 * If the chain has more paragraphs, a tail line surfaces the count
 * (`→ (+N more paragraphs)`) so the user knows the LLM iterated
 * further than what's visible.
 *
 * Exported for tests; pure.
 */
const MAX_PARAGRAPH_LINES = 3
const MAX_PARAGRAPH_CHARS = 180

export function formatPlainReasoningChain(kind: string, paragraphs: string[]): BriefSummary {
  const visible = paragraphs.slice(0, MAX_PARAGRAPH_LINES)
  const lines = visible.map((p) => `→ ${truncate(p, MAX_PARAGRAPH_CHARS)}`)
  const hidden = paragraphs.length - visible.length
  if (hidden > 0) {
    lines.push(`→ (+${hidden} more paragraph${hidden === 1 ? "" : "s"})`)
  }
  return { pipelineLabel: pipelineLabelFor(kind), lines }
}

/**
 * Canonical mapping from pipeline `kind` to the human label rendered
 * in the peek header. Centralised so the chain-render path and the
 * structured-field path use the exact same labels.
 */
export function pipelineLabelFor(kind: string): string {
  switch (kind) {
    case "implement": return "Reasoning(implement)"
    case "bug": return "Reasoning(bug)"
    case "decision": return "Reasoning(decision)"
    case "summary": return "Reasoning(summary)"
    case "divergence": return "Reasoning(divergence)"
    case "implement_elaborate": return "Reasoning(elaborate)"
    case "chunk_plan": return "Reasoning(chunk plan)"
    case "chunk_reflect": return "Reasoning(chunk reflect)"
    default: return `Reasoning(${kind})`
  }
}

function confidenceLine(data: Record<string, unknown>): string {
  const c = typeof data.confidence === "string" ? data.confidence : "?"
  const d = typeof data.decision === "string" ? data.decision : "?"
  return `→ confidence: ${c} · decision: ${d}`
}

/**
 * Stage 3 + 4 of command-first-investigation: surface the reasoner's
 * suggested starting commands in the peek so the user sees what the
 * agent's about to investigate before any writes happen.
 *
 * Defensive: skips when the plan is missing / empty / malformed.
 * Renders up to 3 commands as `→ investigate: <cmd1> · <cmd2> · <cmd3>`
 * (compact to fit the peek's 1-3 line budget).
 */
function appendInvestigationLines(lines: string[], plan: unknown): void {
  if (!Array.isArray(plan) || plan.length === 0) return
  const commands = (plan as Array<Record<string, unknown>>)
    .map((e) => typeof e.command === "string" ? e.command.trim() : "")
    .filter((c) => c.length > 0)
    .slice(0, 3)
  if (commands.length === 0) return
  const more = (plan as unknown[]).length > 3 ? ` +${(plan as unknown[]).length - 3}` : ""
  lines.push(`→ investigate: ${truncate(commands.join(" · "), 80)}${more}`)
}

function truncate(s: string, max: number): string {
  if (typeof s !== "string") return ""
  if (s.length <= max) return s
  return s.slice(0, Math.max(0, max - 1)) + "…"
}

export function ReasoningPeek({ brief }: Props): React.ReactElement {
  const summary = formatBriefSummary(brief.kind, brief.briefData)
  return (
    <Box flexDirection="column" marginLeft={2} marginTop={1}>
      <Box>
        {/* The marker pulses once on mount of a new brief (keyed to brief.key
            so a fresh emission re-fires) then settles muted. */}
        <Pulse flash={palette.accent} settle={palette.muted} triggerKey={brief.key}>✦</Pulse>
        <Text> </Text>
        <Text color={palette.bright} bold>{summary.pipelineLabel}</Text>
      </Box>
      {summary.lines.map((line, i) => (
        <Box key={i} marginLeft={2}>
          <Text color={palette.muted}>{line}</Text>
        </Box>
      ))}
    </Box>
  )
}
