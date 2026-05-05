/**
 * Renders reasoning briefs in the CLI. Four shapes (implement / bug /
 * summary / decision) — each with a small box at the top of the agent's
 * output so the user sees WHY before the agent acts.
 */

import { colors, BOX } from "./render.js"

interface MissingContextItem {
  field: string
  whyCritical: string
  suggestedQuestion: string
  exampleValue?: string
}

interface BriefShape {
  pipeline: string
  confidence?: string
  decision?: string
  missingContext?: MissingContextItem[]
  implementBrief?: {
    intent?: string
    recommendedStack?: { language?: string; frameworks?: string[]; libraries?: string[]; rationale?: string }
    consistencyNotes?: string[]
    edgeCases?: string[]
  }
  bugBrief?: {
    symptom?: string
    suspectedBoundary?: string
    hypotheses?: Array<{ hypothesis?: string; probability?: string }>
    proposedFix?: { description?: string; scope?: string }
  }
  summaryBrief?: { audienceLevel?: string }
  decisionBrief?: {
    recommendation?: string
    alternatives?: Array<{ option?: string; fitScore?: string }>
    proceedHint?: string
  }
}

const WIDTH = 56

function pad(label: string): string {
  const inner = ` ${label} `
  const dashCount = Math.max(0, WIDTH - inner.length - 2)
  return colors.accentDim(BOX.tl + BOX.h) + colors.accent.bold(inner) + colors.accentDim(BOX.h.repeat(dashCount) + BOX.tr)
}

function bottom(): string {
  return colors.accentDim(BOX.bl + BOX.h.repeat(WIDTH) + BOX.br)
}

function row(text: string): string {
  return colors.accentDim(BOX.v) + " " + text
}

function confidenceColor(conf: string | undefined): (s: string) => string {
  if (conf === "HIGH") return colors.success
  if (conf === "MEDIUM") return colors.warning
  if (conf === "LOW") return colors.error
  return colors.muted
}

export function renderReasoningBrief(brief: unknown): void {
  if (!brief || typeof brief !== "object") return
  const b = brief as BriefShape
  if (!b.pipeline || b.pipeline === "simple") return

  const cConf = confidenceColor(b.confidence)
  console.log("")
  console.log("  " + pad(`REASONING (${b.pipeline})`))
  console.log("  " + row(colors.muted("confidence: ") + cConf(b.confidence || "?") + colors.muted("  ·  decision: ") + colors.bright(b.decision || "?")))

  switch (b.pipeline) {
    case "implement": renderImplement(b); break
    case "bug":       renderBug(b); break
    case "summary":   renderSummary(b); break
    case "decision":  renderDecision(b); break
  }

  // Show missing-context regardless of pipeline.
  if (b.missingContext && b.missingContext.length > 0) {
    console.log("  " + row(colors.warning("ASKING:")))
    for (const m of b.missingContext) {
      console.log("  " + row(colors.muted("  · ") + colors.bright(m.field) + colors.muted(` — ${m.whyCritical}`)))
    }
  }

  console.log("  " + bottom())
  console.log("")
}

function renderImplement(b: BriefShape): void {
  const ib = b.implementBrief
  if (!ib) return
  if (ib.intent) console.log("  " + row(colors.muted("intent: ") + colors.bright(truncate(ib.intent, 50))))
  if (ib.recommendedStack) {
    const stack = [
      ib.recommendedStack.language,
      ...(ib.recommendedStack.frameworks ?? []),
      ...(ib.recommendedStack.libraries ?? []),
    ].filter(Boolean).join(" + ")
    if (stack) console.log("  " + row(colors.muted("stack:  ") + colors.success(truncate(stack, 50))))
    if (ib.recommendedStack.rationale) {
      console.log("  " + row(colors.muted("why:    ") + colors.muted(truncate(ib.recommendedStack.rationale, 50))))
    }
  }
  if (ib.consistencyNotes && ib.consistencyNotes.length > 0) {
    console.log("  " + row(colors.muted("notes:")))
    for (const n of ib.consistencyNotes.slice(0, 2)) {
      console.log("  " + row(colors.muted("  · ") + colors.muted(truncate(n, 48))))
    }
  }
}

function renderBug(b: BriefShape): void {
  const bb = b.bugBrief
  if (!bb) return
  if (bb.symptom) console.log("  " + row(colors.muted("symptom: ") + colors.bright(truncate(bb.symptom, 48))))
  if (bb.suspectedBoundary) console.log("  " + row(colors.muted("boundary: ") + colors.warning(bb.suspectedBoundary)))
  if (bb.hypotheses && bb.hypotheses.length > 0) {
    console.log("  " + row(colors.muted("hypotheses:")))
    for (const h of bb.hypotheses.slice(0, 3)) {
      const conf = confidenceColor(h.probability)
      console.log("  " + row(`  ${conf("[" + (h.probability ?? "?") + "]")} ` + colors.muted(truncate(h.hypothesis ?? "", 44))))
    }
  }
  if (bb.proposedFix?.description) {
    console.log("  " + row(colors.muted("fix:    ") + colors.success(`(${bb.proposedFix.scope ?? "?"}) `) + colors.muted(truncate(bb.proposedFix.description, 40))))
  }
}

function renderSummary(b: BriefShape): void {
  const sb = b.summaryBrief
  if (!sb) return
  if (sb.audienceLevel) console.log("  " + row(colors.muted("audience: ") + colors.bright(sb.audienceLevel)))
  console.log("  " + row(colors.muted("summary content rendered as the run's final message")))
}

export function renderDecisionBrief(brief: unknown, label?: string): void {
  if (!brief || typeof brief !== "object") return
  const b = brief as BriefShape
  if (b.pipeline !== "decision" || !b.decisionBrief) return
  const db = b.decisionBrief
  const cConf = confidenceColor(b.confidence)
  const recBlock = `${colors.muted("→ ")}${colors.success(db.recommendation ?? "?")} ${cConf("(" + (b.confidence ?? "?") + ")")}`
  const headerLabel = label ? `reason · ${label}` : "reason"
  console.log("    " + colors.accentDim(BOX.tl + BOX.h.repeat(2)) + " " + colors.accent(headerLabel) + " " + colors.muted(recBlock))
  if (db.alternatives && db.alternatives.length > 1) {
    for (const a of db.alternatives.slice(1, 4)) {
      const score = confidenceColor(a.fitScore)
      console.log("    " + colors.accentDim(BOX.v) + colors.muted(`  ${score("[" + (a.fitScore ?? "?") + "]")} ${a.option ?? "?"}`))
    }
  }
  if (db.proceedHint) {
    console.log("    " + colors.accentDim(BOX.bl + BOX.h.repeat(2)) + " " + colors.muted(truncate(db.proceedHint, 60)))
  }
}

function renderDecision(b: BriefShape): void {
  // The full decision-pipeline brief uses the same compact renderer the
  // agent's reason-tool result uses, so we delegate.
  renderDecisionBrief(b, "preflight")
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1) + "…"
}
