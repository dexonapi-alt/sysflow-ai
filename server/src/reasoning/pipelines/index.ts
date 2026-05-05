/**
 * Pipeline dispatch — pick the right system prompt for the given pipeline name.
 * Schemas are owned by reasoning-schema.ts; this file is just routing.
 */

import { IMPLEMENT_SYSTEM_PROMPT } from "./implement-pipeline.js"
import { BUG_SYSTEM_PROMPT } from "./bug-pipeline.js"
import { SUMMARY_SYSTEM_PROMPT } from "./summary-pipeline.js"
import { DECISION_SYSTEM_PROMPT } from "./decision-pipeline.js"

export type PipelineKind = "implement" | "bug" | "summary" | "decision"

export function getPipelineSystemPrompt(kind: PipelineKind): string {
  switch (kind) {
    case "implement": return IMPLEMENT_SYSTEM_PROMPT
    case "bug":       return BUG_SYSTEM_PROMPT
    case "summary":   return SUMMARY_SYSTEM_PROMPT
    case "decision":  return DECISION_SYSTEM_PROMPT
  }
}
