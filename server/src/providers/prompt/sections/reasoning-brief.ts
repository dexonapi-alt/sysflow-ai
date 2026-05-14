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
  /** Phase 16 Stage 3: chained `implement_elaborate` brief. Rendered as
   *  a DEEPER REASONING sub-block under the implement brief when
   *  present. */
  reasoningElaborationBrief?: ReasoningBrief
}

export function getReasoningBriefSection(ctx: ReasoningBriefCtx): string | null {
  const brief = ctx.reasoningBrief
  if (!brief || brief.pipeline === "simple") return null

  const lines: string[] = []
  lines.push("═══ REASONING BRIEF (planning agent's pre-flight analysis) ═══")
  lines.push(`pipeline: ${brief.pipeline}  ·  confidence: ${brief.confidence}  ·  decision: ${brief.decision}`)
  lines.push("")

  // Stage C: render the reasoner's plain-prose deliberation BEFORE the
  // structured brief fields. User feedback was that the structured fields
  // alone read like a form — the THINKING block surfaces the deliberation
  // (alternatives, trade-offs, root causes, self-critique) the reasoner
  // produced so the main model sees the WHY, not just the WHAT.
  const chain = (brief.reasoningChain ?? []).filter((s) => typeof s === "string" && s.trim().length > 0)
  if (chain.length > 0) {
    lines.push("═══ THINKING (reasoner's plain-prose deliberation) ═══")
    chain.forEach((step, i) => {
      lines.push(`${i + 1}. ${step}`)
    })
    lines.push("═══ END THINKING ═══")
    lines.push("")
  }

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

  // Phase 16 Stage 3: render the chained-elaboration brief as a sub-block
  // under the implement brief when present. The elaboration's confidence
  // can DOWNGRADE the preflight's — if it's LOW, the model should treat
  // the surface brief as tentative and verify before committing.
  const elab = ctx.reasoningElaborationBrief
  if (
    brief.pipeline === "implement"
    && elab
    && elab.pipeline === "implement_elaborate"
    && elab.implementElaborationBrief
  ) {
    const eb = elab.implementElaborationBrief
    lines.push("")
    lines.push(`DEEPER REASONING (re-scored confidence: ${eb.confidence}):`)
    lines.push(`  WHY THIS APPROACH: ${eb.whyThisApproach}`)
    if (eb.whyNotAlternative.length > 0) {
      lines.push("  ALTERNATIVES REJECTED:")
      eb.whyNotAlternative.forEach((a) => lines.push(`    - ${a}`))
    }
    if (eb.preconditions.length > 0) {
      lines.push("  PRECONDITIONS (verify before committing):")
      eb.preconditions.forEach((p) => lines.push(`    - ${p}`))
    }
  }

  lines.push("")
  // Stage C: confidence-aware framing. HIGH-confidence briefs bind the
  // model strongly; MEDIUM gives a deviation escape hatch; LOW stays
  // advisory but the THINKING block above still renders so the model
  // benefits from the reasoner's deliberation even when the structured
  // recommendation is tentative.
  lines.push(getDirectiveTrailer(brief.confidence))
  return lines.join("\n")
}

/**
 * Stage C: confidence-keyed trailer. Replaces the old soft *"Trust this
 * brief unless tool results contradict it"* with a strength gradient.
 *
 * - HIGH  → directive: model must follow unless a tool result proves
 *   a step impossible. Deviation requires surfacing the conflict.
 * - MEDIUM → directive but with a tool-result escape hatch.
 * - LOW   → advisory only — the THINKING block (rendered above) is
 *   what the model should lean on; the structured fields are tentative.
 *
 * Exported for unit tests.
 */
export function getDirectiveTrailer(confidence: "HIGH" | "MEDIUM" | "LOW"): string {
  if (confidence === "HIGH") {
    return [
      "═══ DIRECTIVE (HIGH confidence) ═══",
      "YOU MUST FOLLOW THIS PLAN. The reasoner classified this at HIGH confidence after deliberating across the THINKING chain above.",
      "Deviate ONLY when a concrete tool result proves a step is impossible. When deviating, surface the conflict in `reasoning` before acting — do not silently substitute.",
      "Ask the user when ASSUMED items cannot be derived from project context.",
    ].join("\n")
  }
  if (confidence === "MEDIUM") {
    return [
      "═══ DIRECTIVE (MEDIUM confidence) ═══",
      "FOLLOW THIS PLAN. The reasoner deliberated through the THINKING chain above and arrived here.",
      "Deviate only if tool results contradict a step. When unsure between the brief and your instinct, prefer the brief — it has had more deliberation than your in-the-moment judgement.",
      "Ask the user when ASSUMED items cannot be derived from project context.",
    ].join("\n")
  }
  // LOW
  return [
    "═══ ADVISORY (LOW confidence) ═══",
    "This brief is TENTATIVE — the reasoner's confidence is LOW. Lean on the THINKING block above for guidance, not the structured fields.",
    "Verify each step with a tool call (read, list, run_command) before committing. Ask the user for the missing context first if the ambiguity is load-bearing.",
  ].join("\n")
}
