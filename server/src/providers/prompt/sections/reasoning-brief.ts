/**
 * Reasoning brief prompt section. Non-cacheable — depends on the per-request
 * brief produced by the reasoning module.
 *
 * Renders a different subsection per pipeline. Always includes an "ASSUMED:" /
 * "FROM USER:" framing so the agent doesn't re-ask for things already known.
 */

import type { ReasoningBrief } from "../../../reasoning/reasoning-schema.js"

export interface ReasoningBriefCtx {
  reasoningBrief?: ReasoningBrief
}

export function getReasoningBriefSection(ctx: ReasoningBriefCtx): string | null {
  const brief = ctx.reasoningBrief
  if (!brief || brief.pipeline === "simple") return null

  const lines: string[] = []
  lines.push("═══ REASONING BRIEF (planning agent's pre-flight analysis) ═══")
  lines.push(`pipeline: ${brief.pipeline}  ·  confidence: ${brief.confidence}  ·  decision: ${brief.decision}`)
  lines.push("")

  if (brief.missingContext.length > 0) {
    lines.push("ASSUMED (not yet provided by user — proceed only if you can derive these from project context):")
    for (const m of brief.missingContext) {
      lines.push(`  - ${m.field}: ${m.whyCritical}`)
    }
    lines.push("")
  }

  switch (brief.pipeline) {
    case "implement": {
      const b = brief.implementBrief!
      lines.push(`INTENT: ${b.intent}`)
      lines.push(`STACK: ${b.recommendedStack.language}` +
        (b.recommendedStack.frameworks.length ? ` + ${b.recommendedStack.frameworks.join(" + ")}` : "") +
        (b.recommendedStack.libraries.length ? ` + ${b.recommendedStack.libraries.join(" + ")}` : ""))
      lines.push(`WHY: ${b.recommendedStack.rationale}`)
      lines.push(`ARCHITECTURE: ${b.architectureSketch}`)
      if (b.buildPlan.length > 0) {
        lines.push("BUILD PLAN:")
        b.buildPlan.forEach((s, i) => lines.push(`  ${i + 1}. ${s.step} → ${s.deliverable}`))
      }
      if (b.consistencyNotes.length > 0) {
        lines.push("CONSISTENCY NOTES (DO NOT FORGET):")
        b.consistencyNotes.forEach((n) => lines.push(`  - ${n}`))
      }
      if (b.edgeCases.length > 0) {
        lines.push("EDGE CASES TO HANDLE:")
        b.edgeCases.forEach((e) => lines.push(`  - ${e}`))
      }
      break
    }
    case "bug": {
      const b = brief.bugBrief!
      lines.push(`SYMPTOM: ${b.symptom}`)
      lines.push(`BOUNDARY: ${b.suspectedBoundary}`)
      if (b.hypotheses.length > 0) {
        lines.push("HYPOTHESES (ranked):")
        b.hypotheses.forEach((h, i) => lines.push(`  ${i + 1}. [${h.probability}] ${h.hypothesis}`))
        lines.push("  → Test the top hypothesis first; the invalidatingTest tells you when to give up on it.")
      }
      if (b.rootCauseGuess) lines.push(`ROOT CAUSE GUESS: ${b.rootCauseGuess}`)
      lines.push(`PROPOSED FIX (${b.proposedFix.scope}): ${b.proposedFix.description}`)
      if (b.sideEffects.length > 0) {
        lines.push("SIDE EFFECTS TO WATCH:")
        b.sideEffects.forEach((s) => lines.push(`  - ${s}`))
      }
      break
    }
    case "summary": {
      // Summary brief content goes directly to the user; the agent prompt
      // doesn't need the full clusters, just a heads-up that the summary was
      // refined.
      const b = brief.summaryBrief!
      lines.push(`AUDIENCE: ${b.audienceLevel}`)
      lines.push(`KEY FACTS (${b.keyFacts.length}); CLUSTERS (${b.clusters.length}); WHAT MATTERS (${b.whatMatters.length})`)
      lines.push("Summary content has been refined for the user. Use it verbatim if invoked at on-completion.")
      break
    }
    case "decision": {
      const b = brief.decisionBrief!
      lines.push(`RECOMMENDATION: ${b.recommendation}`)
      lines.push("ALTERNATIVES:")
      b.alternatives.forEach((a) => lines.push(`  - [${a.fitScore}] ${a.option}: ${a.prosCons}`))
      if (b.riskNotes.length > 0) {
        lines.push("RISK NOTES:")
        b.riskNotes.forEach((r) => lines.push(`  - ${r}`))
      }
      lines.push(`PROCEED: ${b.proceedHint}`)
      break
    }
  }

  lines.push("")
  lines.push("Trust this brief unless tool results contradict it. Ask the user when ASSUMED items can't be derived.")
  return lines.join("\n")
}
