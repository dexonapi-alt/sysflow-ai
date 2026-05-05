/**
 * Cross-check on the reasoner's output. Two passes:
 *   1. Prune missingContext entries whose `field` substring already appears
 *      in the user's message (reasoner sometimes asks for things the user
 *      already provided).
 *   2. Override `decision` based on the pruned list:
 *      - If any HIGH-criticality item remains AND the user didn't say
 *        "just guess" / "use whatever" / "best effort" → force ask_user.
 *      - If user said "just guess" or similar → force proceed even with
 *        missing items (note them in the brief instead).
 */

import type { ReasoningBrief } from "./reasoning-schema.js"

const SKIP_ASK_PATTERNS = [
  /\bjust\s+guess\b/i,
  /\buse\s+whatever\b/i,
  /\bbest\s+effort\b/i,
  /\bbest\s+guess\b/i,
  /\byou\s+(decide|choose|pick)\b/i,
  /\bno\s+questions\b/i,
  /\bsurprise\s+me\b/i,
]

export function applyCriticalContextDetector(
  brief: ReasoningBrief,
  userMessage: string,
): ReasoningBrief {
  const userLower = (userMessage || "").toLowerCase()

  // Pass 1: prune entries the user already addressed.
  const pruned = brief.missingContext.filter((item) => {
    const fieldLower = item.field.toLowerCase()
    if (!fieldLower) return true
    // If any non-trivial token from the field name already appears in the
    // user's message, drop the question.
    const tokens = fieldLower.split(/[\s_\-./]+/).filter((t) => t.length >= 4)
    if (tokens.length === 0) return !userLower.includes(fieldLower)
    return !tokens.some((t) => userLower.includes(t))
  })

  // Pass 2: decision override.
  const userOptedOut = SKIP_ASK_PATTERNS.some((re) => re.test(userMessage))
  let decision = brief.decision
  if (userOptedOut) {
    decision = "proceed"
  } else if (pruned.length > 0) {
    // We don't currently track per-item criticality on the wire; treat any
    // remaining missing context as ask-worthy. The reasoner is responsible
    // for not over-listing.
    decision = "ask_user"
  } else if (brief.decision === "ask_user" && pruned.length === 0) {
    // Reasoner asked to ask but pruning removed everything — flip to proceed.
    decision = "proceed"
  }

  return { ...brief, missingContext: pruned, decision }
}
