import { describe, it, expect } from "vitest"
import { reasoningEnvelopeSchema } from "../reasoning-schema.js"
import { repairReasoningResponse } from "../repair.js"
import { getReasoningBriefSection, getDirectiveTrailer } from "../../providers/prompt/sections/reasoning-brief.js"
import { shouldRunIterativeRefine, shouldRunPreflightElaboration } from "../../services/free-tier-policy.js"

/**
 * Stage C of model-lock-and-portable-reasoning: deep deliberative reasoning
 * across all pipelines, all backends, all iterations. These tests pin:
 *  - reasoningChain schema field accepts up to 10 paragraph entries
 *  - repair pass defaults missing chain to [] and migrates reasoningTrace
 *  - render emits ═══ THINKING ═══ block before structured fields
 *  - render's confidence-aware directive trailer routes HIGH/MEDIUM/LOW
 *  - shouldRunIterativeRefine skips summary/elaborate/divergence; fires on others
 *  - shouldRunPreflightElaboration is no longer free-tier-only
 */

function makeImplementEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    pipeline: "implement" as const,
    confidence: "HIGH" as const,
    decision: "proceed" as const,
    missingContext: [],
    reasoningTrace: "test trace",
    implementBrief: {
      intent: "test intent",
      subcomponents: [],
      recommendedStack: { language: "ts", frameworks: [], libraries: [], rationale: "x" },
      architectureSketch: "a",
      buildPlan: [],
      edgeCases: [],
      consistencyNotes: [],
    },
    ...overrides,
  }
}

describe("Stage C — reasoningChain schema field", () => {
  it("accepts an array of paragraph strings (up to 10)", () => {
    const env = makeImplementEnvelope({
      reasoningChain: [
        "Paragraph 1: the user is asking for X with constraint Y.",
        "Paragraph 2: alternatives considered are A, B, C.",
        "Paragraph 3: trade-off — A wins because faster, accepting cost Z.",
      ],
    })
    const parsed = reasoningEnvelopeSchema.parse(env)
    expect(parsed.reasoningChain).toHaveLength(3)
    expect(parsed.reasoningChain[0]).toContain("Paragraph 1")
  })

  it("defaults to empty array when omitted (backward-compat with pre-Stage-C briefs)", () => {
    const env = makeImplementEnvelope()
    const parsed = reasoningEnvelopeSchema.parse(env)
    expect(parsed.reasoningChain).toEqual([])
  })

  it("rejects more than 10 entries", () => {
    const env = makeImplementEnvelope({
      reasoningChain: Array.from({ length: 11 }, (_, i) => `step ${i}`),
    })
    expect(() => reasoningEnvelopeSchema.parse(env)).toThrow()
  })

  it("rejects entries longer than 600 chars", () => {
    const env = makeImplementEnvelope({
      reasoningChain: ["x".repeat(601)],
    })
    expect(() => reasoningEnvelopeSchema.parse(env)).toThrow()
  })
})

describe("Stage C — repair pass defaults reasoningChain", () => {
  it("fills empty chain from a non-empty reasoningTrace (migration path for old cache hits)", () => {
    const raw: Record<string, unknown> = {
      pipeline: "implement",
      confidence: "HIGH",
      decision: "proceed",
      missingContext: [],
      reasoningTrace: "single-line legacy trace",
      // reasoningChain absent
    }
    const repaired = repairReasoningResponse(raw) as Record<string, unknown>
    expect(repaired.reasoningChain).toEqual(["single-line legacy trace"])
  })

  it("defaults to empty array when both trace and chain are missing", () => {
    const raw: Record<string, unknown> = {
      pipeline: "implement",
      confidence: "HIGH",
      decision: "proceed",
      missingContext: [],
      // reasoningTrace + reasoningChain both absent
    }
    const repaired = repairReasoningResponse(raw) as Record<string, unknown>
    expect(repaired.reasoningChain).toEqual([])
    // reasoningTrace also gets defaulted to ""
    expect(repaired.reasoningTrace).toBe("")
  })

  it("filters non-string and empty entries from a malformed chain", () => {
    const raw: Record<string, unknown> = {
      pipeline: "implement",
      confidence: "HIGH",
      decision: "proceed",
      missingContext: [],
      reasoningTrace: "ignored",
      reasoningChain: ["valid", null, "", 42, "another valid"],
    }
    const repaired = repairReasoningResponse(raw) as Record<string, unknown>
    expect(repaired.reasoningChain).toEqual(["valid", "another valid"])
  })

  it("preserves a well-formed chain unchanged (no migration when chain is already there)", () => {
    const raw: Record<string, unknown> = {
      pipeline: "implement",
      confidence: "HIGH",
      decision: "proceed",
      missingContext: [],
      reasoningTrace: "trace summary",
      reasoningChain: ["paragraph one", "paragraph two"],
    }
    const repaired = repairReasoningResponse(raw) as Record<string, unknown>
    expect(repaired.reasoningChain).toEqual(["paragraph one", "paragraph two"])
  })
})

describe("Stage C — getReasoningBriefSection renders THINKING block", () => {
  it("renders the THINKING block as plain prose paragraphs (no numbering — user feedback)", () => {
    const brief = reasoningEnvelopeSchema.parse(makeImplementEnvelope({
      reasoningChain: [
        "The user is asking for a tic-tac-toe game.",
        "Alternative stacks: vanilla JS, React, Svelte. Picking React per user mention.",
        "Self-critique: am I over-using state? For 9 cells, useState is fine.",
      ],
    }))
    const out = getReasoningBriefSection({ reasoningBrief: brief })
    expect(out).not.toBeNull()
    expect(out!).toContain("═══ THINKING")
    // Plain prose — the entries appear verbatim, no leading "1.", "2.", "3."
    expect(out!).toContain("The user is asking for a tic-tac-toe game.")
    expect(out!).toContain("Alternative stacks:")
    expect(out!).toContain("Self-critique:")
    expect(out!).not.toMatch(/^\s*1\.\s/m)
    expect(out!).not.toMatch(/^\s*2\.\s/m)
    expect(out!).not.toMatch(/^\s*3\.\s/m)
    // Paragraphs separated by blank lines so the model reads them as prose,
    // not a checklist.
    expect(out!).toContain("The user is asking for a tic-tac-toe game.\n\nAlternative stacks:")
  })

  it("omits the THINKING block when reasoningChain is empty", () => {
    const brief = reasoningEnvelopeSchema.parse(makeImplementEnvelope({
      reasoningChain: [],
    }))
    const out = getReasoningBriefSection({ reasoningBrief: brief })
    expect(out).not.toBeNull()
    expect(out!).not.toContain("═══ THINKING")
  })

  it("renders THINKING before the structured INTENT/STACK fields", () => {
    const brief = reasoningEnvelopeSchema.parse(makeImplementEnvelope({
      reasoningChain: ["First, the user wants X."],
    }))
    const out = getReasoningBriefSection({ reasoningBrief: brief })
    const thinkingIdx = out!.indexOf("THINKING")
    const intentIdx = out!.indexOf("INTENT:")
    expect(thinkingIdx).toBeGreaterThan(0)
    expect(intentIdx).toBeGreaterThan(thinkingIdx) // THINKING comes first
  })
})

describe("Stage C — getDirectiveTrailer (confidence-aware framing)", () => {
  it("HIGH confidence emits a hard MUST-FOLLOW directive", () => {
    const out = getDirectiveTrailer("HIGH")
    expect(out).toContain("YOU MUST FOLLOW")
    expect(out).toContain("HIGH confidence")
    expect(out).toContain("surface the conflict")
  })

  it("MEDIUM confidence emits a follow-with-escape-hatch directive", () => {
    const out = getDirectiveTrailer("MEDIUM")
    expect(out).toContain("FOLLOW THIS PLAN")
    expect(out).toContain("MEDIUM confidence")
    expect(out).toContain("prefer the brief")
    expect(out).not.toContain("YOU MUST FOLLOW")
  })

  it("LOW confidence stays advisory", () => {
    const out = getDirectiveTrailer("LOW")
    expect(out).toContain("ADVISORY")
    expect(out).toContain("LOW confidence")
    expect(out).toContain("TENTATIVE")
    expect(out).toContain("Verify each step with a tool call")
    expect(out).not.toContain("YOU MUST FOLLOW")
  })

  it("THINKING block still renders for LOW briefs (it's still useful even when the structured fields are tentative)", () => {
    const brief = reasoningEnvelopeSchema.parse(makeImplementEnvelope({
      confidence: "LOW",
      reasoningChain: ["I'm not sure about the stack pick — could be React or Vue."],
    }))
    const out = getReasoningBriefSection({ reasoningBrief: brief })
    expect(out!).toContain("THINKING")
    expect(out!).toContain("ADVISORY (LOW confidence)")
  })
})

describe("Stage C — shouldRunIterativeRefine gate", () => {
  it("returns false when the flag is off", () => {
    expect(shouldRunIterativeRefine({ kind: "implement", model: "claude-sonnet", flagEnabled: false })).toBe(false)
  })

  it("returns true for implement / bug / decision / chunk_plan / chunk_reflect when on", () => {
    for (const kind of ["implement", "bug", "decision", "chunk_plan", "chunk_reflect"]) {
      expect(shouldRunIterativeRefine({ kind, model: "claude-sonnet", flagEnabled: true })).toBe(true)
    }
  })

  it("returns false for summary (user-facing, second pass risks meta-summarising)", () => {
    expect(shouldRunIterativeRefine({ kind: "summary", model: "claude-sonnet", flagEnabled: true })).toBe(false)
  })

  it("returns false for implement_elaborate (it IS the second look)", () => {
    expect(shouldRunIterativeRefine({ kind: "implement_elaborate", model: "claude-sonnet", flagEnabled: true })).toBe(false)
  })

  it("returns false for divergence (Phase 16 Stage 4 already gates a second-look)", () => {
    expect(shouldRunIterativeRefine({ kind: "divergence", model: "claude-sonnet", flagEnabled: true })).toBe(false)
  })

  it("is reasoner-backend-agnostic — same gate regardless of model id", () => {
    const flagEnabled = true
    for (const model of ["claude-sonnet", "claude-opus", "gemini-flash", "openrouter-auto", "llama-70b"]) {
      expect(shouldRunIterativeRefine({ kind: "implement", model, flagEnabled })).toBe(true)
    }
  })

  it("complexity guard: skips refine for SIMPLE tasks (user feedback — don't over-think the obvious)", () => {
    expect(shouldRunIterativeRefine({
      kind: "implement",
      model: "claude-sonnet",
      flagEnabled: true,
      complexity: "simple",
    })).toBe(false)
  })

  it("complexity guard: still fires for medium and complex tasks", () => {
    expect(shouldRunIterativeRefine({
      kind: "implement",
      model: "claude-sonnet",
      flagEnabled: true,
      complexity: "medium",
    })).toBe(true)
    expect(shouldRunIterativeRefine({
      kind: "bug",
      model: "claude-sonnet",
      flagEnabled: true,
      complexity: "complex",
    })).toBe(true)
  })

  it("complexity guard: undefined / null complexity does NOT skip (additive safety — fire by default)", () => {
    expect(shouldRunIterativeRefine({
      kind: "implement",
      model: "claude-sonnet",
      flagEnabled: true,
      complexity: undefined,
    })).toBe(true)
    expect(shouldRunIterativeRefine({
      kind: "implement",
      model: "claude-sonnet",
      flagEnabled: true,
      complexity: null,
    })).toBe(true)
  })
})

describe("Stage C — shouldRunPreflightElaboration ungated from free-tier-only", () => {
  it("fires for PAID models (claude-sonnet) when complexity ≥ medium and confidence < HIGH", () => {
    expect(shouldRunPreflightElaboration({
      model: "claude-sonnet",
      complexity: "medium",
      preflightConfidence: "MEDIUM",
      flagEnabled: true,
    })).toBe(true)
  })

  it("fires for PAID models (claude-opus) on complex tasks with LOW confidence", () => {
    expect(shouldRunPreflightElaboration({
      model: "claude-opus",
      complexity: "complex",
      preflightConfidence: "LOW",
      flagEnabled: true,
    })).toBe(true)
  })

  it("still fires for free-tier models (no regression)", () => {
    expect(shouldRunPreflightElaboration({
      model: "openrouter-auto",
      complexity: "medium",
      preflightConfidence: "MEDIUM",
      flagEnabled: true,
    })).toBe(true)
  })

  it("does NOT fire when complexity is simple (cost guard)", () => {
    expect(shouldRunPreflightElaboration({
      model: "claude-sonnet",
      complexity: "simple",
      preflightConfidence: "MEDIUM",
      flagEnabled: true,
    })).toBe(false)
  })

  it("does NOT fire when confidence is HIGH (no signal to add)", () => {
    expect(shouldRunPreflightElaboration({
      model: "claude-sonnet",
      complexity: "complex",
      preflightConfidence: "HIGH",
      flagEnabled: true,
    })).toBe(false)
  })

  it("does NOT fire when the flag is off", () => {
    expect(shouldRunPreflightElaboration({
      model: "claude-sonnet",
      complexity: "medium",
      preflightConfidence: "MEDIUM",
      flagEnabled: false,
    })).toBe(false)
  })
})
