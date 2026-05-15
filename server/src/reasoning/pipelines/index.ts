/**
 * Pipeline dispatch — pick the right system prompt for the given pipeline name.
 * Schemas are owned by reasoning-schema.ts; this file is just routing.
 */

import { IMPLEMENT_SYSTEM_PROMPT } from "./implement-pipeline.js"
import { IMPLEMENT_ELABORATE_SYSTEM_PROMPT } from "./implement-elaborate-pipeline.js"
import { BUG_SYSTEM_PROMPT } from "./bug-pipeline.js"
import { SUMMARY_SYSTEM_PROMPT } from "./summary-pipeline.js"
import { DECISION_SYSTEM_PROMPT } from "./decision-pipeline.js"
import { CHUNK_PLAN_SYSTEM_PROMPT } from "./chunk-plan-pipeline.js"
import { CHUNK_REFLECT_SYSTEM_PROMPT } from "./chunk-reflector-pipeline.js"
import { DIVERGENCE_SYSTEM_PROMPT } from "./divergence-pipeline.js"
import { INTENT_CLASSIFICATION_SYSTEM_PROMPT } from "./intent-classification-pipeline.js"

export type PipelineKind = "implement" | "implement_elaborate" | "bug" | "summary" | "decision" | "chunk_plan" | "chunk_reflect" | "divergence" | "intent_classification"

export function getPipelineSystemPrompt(kind: PipelineKind): string {
  switch (kind) {
    case "implement":             return IMPLEMENT_SYSTEM_PROMPT
    case "implement_elaborate":   return IMPLEMENT_ELABORATE_SYSTEM_PROMPT
    case "bug":                   return BUG_SYSTEM_PROMPT
    case "summary":               return SUMMARY_SYSTEM_PROMPT
    case "decision":              return DECISION_SYSTEM_PROMPT
    case "chunk_plan":            return CHUNK_PLAN_SYSTEM_PROMPT
    case "chunk_reflect":         return CHUNK_REFLECT_SYSTEM_PROMPT
    case "divergence":            return DIVERGENCE_SYSTEM_PROMPT
    case "intent_classification": return INTENT_CLASSIFICATION_SYSTEM_PROMPT
  }
}
