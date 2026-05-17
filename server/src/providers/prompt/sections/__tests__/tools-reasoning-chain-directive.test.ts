/**
 * Plan `2026-05-16-reasoning-chain-provider-parity.md` Stage 2.
 *
 * Verifies the strengthened `reasoningChain` MANDATORY directive
 * appears in the system prompt rendered for ALL three providers'
 * paths. The directive removes the "skip on trivial turns" escape
 * hatch that lets models default to singular `reasoning` (legacy
 * field) and never populate the chain. Without the chain, the cli's
 * live peek stays stuck on the FIRST brief that DID emit one.
 */

import { describe, it, expect } from "vitest"
import { buildSystemPrompt } from "../../build.js"
import { getToolsSection } from "../tools.js"

const MANDATORY_KEY = "MANDATORY: populate `reasoningChain`"
const LEGACY_NOTE = "singular `reasoning` field is LEGACY"
const PER_FILE_RULE = "one paragraph per non-trivial tool"

describe("tools section — reasoningChain MANDATORY directive", () => {
  it("renders the MANDATORY marker", () => {
    const section = getToolsSection()
    expect(section).toContain(MANDATORY_KEY)
  })

  it("calls out singular `reasoning` as legacy", () => {
    const section = getToolsSection()
    expect(section).toContain(LEGACY_NOTE)
  })

  it("instructs per-file reasoning in batched responses", () => {
    const section = getToolsSection()
    expect(section).toContain(PER_FILE_RULE)
  })

  it("explicitly removes the 'skip on trivial turns' escape hatch", () => {
    const section = getToolsSection()
    // The old language explicitly told the model it was OK to skip on
    // trivial turns. The new directive removes that.
    expect(section).not.toContain("Skip the field entirely on trivial turns")
    // The new language tells the model to emit AT LEAST one paragraph
    // even on trivial turns.
    expect(section).toContain("Even on a")
    expect(section).toContain("emit ONE")
  })

  it("warns that empty/absent chain = invisible reasoning", () => {
    const section = getToolsSection()
    expect(section).toContain("invisible reasoning")
  })
})

describe("buildSystemPrompt — directive reaches the full prompt for all provider paths", () => {
  // Gemini calls buildSystemPrompt via async buildPrompt(); Anthropic +
  // OpenRouter call buildSystemPrompt via getSystemPromptForRequest in
  // base-provider.ts. All three end up reading buildSystemPrompt(ctx).full.
  // Asserting the directive lands in the rendered string is sufficient
  // for parity.

  it("full system prompt includes the MANDATORY directive (empty ctx)", () => {
    const built = buildSystemPrompt({})
    expect(built.full).toContain(MANDATORY_KEY)
    expect(built.full).toContain(LEGACY_NOTE)
    expect(built.full).toContain(PER_FILE_RULE)
  })

  it("directive lands in the cacheable portion (stable across providers)", () => {
    // Tools section is cacheable (priority 20, cacheable: true). The
    // directive is part of it; should appear in `cacheable`.
    const built = buildSystemPrompt({})
    expect(built.cacheable).toContain(MANDATORY_KEY)
  })

  it("directive still present when prompt ctx carries a runIntent (gating doesn't strip it)", () => {
    const built = buildSystemPrompt({ runIntent: "implement", complexity: "medium", gatingEnabled: true })
    expect(built.full).toContain(MANDATORY_KEY)
  })

  it("directive still present for the legacy SHARED_SYSTEM_PROMPT path (empty ctx)", () => {
    // SHARED_SYSTEM_PROMPT = buildSystemPrompt({}).full — exported in
    // base-provider.ts. Any provider that falls back to the shared
    // string (rare; should be Anthropic / OpenRouter pre-Stage-B fix)
    // still gets the directive.
    const built = buildSystemPrompt({})
    expect(built.full.split(MANDATORY_KEY).length - 1).toBe(1)  // exactly one occurrence
  })
})
