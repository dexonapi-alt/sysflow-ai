/**
 * Meta-rules injected into every reasoning pipeline's system prompt.
 *
 * These are the cross-cutting principles every pipeline (implement / bug /
 * summary / decision) must respect. Single source so they don't drift.
 */

export const META_RULES = `═══ REASONING META-RULES (apply to every pipeline) ═══

- NO GUESSING when context is missing. Surface the gap in missingContext.
- PREFER ASKING the user over hallucinating a value or path.
- DECOMPOSE before solving. Even one-line tasks have at least two parts (intent + side effects).
- CHOOSE MINIMAL SAFE CHANGES. The smaller the diff, the smaller the blast radius.
- KEEP REASONING EXPLICIT internally (in your structured output), but the user-facing brief should be tight and skimmable.
- CORRECTNESS > CONFIDENCE TONE. If you're unsure, say MEDIUM or LOW. Never paper over uncertainty with assertive language.
- One-shot only. You do NOT call tools. Output the JSON brief and stop.`
