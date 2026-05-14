import { describe, it, expect, vi } from "vitest"
import { runReasoningChain, type ChainStage } from "../chain.js"
import type { ReasoningBrief } from "../reasoning-schema.js"
import type { ReasoningPayload } from "../task-reasoner.js"

// Build a minimal-but-valid envelope for the stub runner.
const makeBrief = (over: Partial<ReasoningBrief> = {}): ReasoningBrief => ({
  pipeline: "simple",
  confidence: "HIGH",
  decision: "proceed",
  missingContext: [],
  reasoningTrace: "",
  reasoningChain: [],
  ...over,
})

const basePayload: ReasoningPayload = {
  trigger: "preflight",
  userMessage: "do something",
  model: "openrouter-auto",
}

describe("runReasoningChain — pure orchestrator", () => {
  it("returns finalBrief=null and empty audit on empty stages", async () => {
    const result = await runReasoningChain(basePayload, [])
    expect(result.finalBrief).toBeNull()
    expect(result.stages).toEqual([])
  })

  it("runs a single stage and threads its brief through", async () => {
    const out = makeBrief({ confidence: "MEDIUM" })
    const runner = vi.fn().mockResolvedValue(out)
    const stages: ChainStage[] = [
      { name: "stage1", buildPayload: (prior, original) => ({ ...original, userMessage: original.userMessage + " (s1)" }) },
    ]
    const result = await runReasoningChain(basePayload, stages, runner)
    expect(result.finalBrief).toBe(out)
    expect(result.stages).toEqual([{ name: "stage1", brief: out }])
    expect(runner).toHaveBeenCalledTimes(1)
    expect(runner.mock.calls[0][0].userMessage).toBe("do something (s1)")
  })

  it("threads each stage's brief into the next stage's buildPayload", async () => {
    const brief1 = makeBrief({ confidence: "MEDIUM" })
    const brief2 = makeBrief({ confidence: "HIGH" })
    const runner = vi.fn()
      .mockResolvedValueOnce(brief1)
      .mockResolvedValueOnce(brief2)

    const seenPriors: Array<ReasoningBrief | null> = []
    const stages: ChainStage[] = [
      {
        name: "first",
        buildPayload: (prior) => {
          seenPriors.push(prior)
          return { ...basePayload, userMessage: "first call" }
        },
      },
      {
        name: "second",
        buildPayload: (prior) => {
          seenPriors.push(prior)
          return { ...basePayload, userMessage: "second call" }
        },
      },
    ]
    const result = await runReasoningChain(basePayload, stages, runner)
    expect(result.finalBrief).toBe(brief2)
    expect(seenPriors).toEqual([null, brief1])
  })

  it("a stage that returns null from buildPayload is skipped, chain continues", async () => {
    const brief1 = makeBrief({ confidence: "HIGH" })
    const runner = vi.fn().mockResolvedValueOnce(brief1)

    const stages: ChainStage[] = [
      { name: "first", buildPayload: () => ({ ...basePayload, userMessage: "x" }) },
      { name: "skipped", buildPayload: () => null },
      { name: "third", buildPayload: () => null },
    ]
    const result = await runReasoningChain(basePayload, stages, runner)
    expect(result.finalBrief).toBe(brief1)
    expect(result.stages).toEqual([
      { name: "first", brief: brief1 },
      { name: "skipped", brief: null },
      { name: "third", brief: null },
    ])
    // Only the first stage actually called the runner.
    expect(runner).toHaveBeenCalledTimes(1)
  })

  it("a runner throw is logged + recorded as null; chain continues with the prior brief", async () => {
    const brief1 = makeBrief({ confidence: "MEDIUM" })
    const brief3 = makeBrief({ confidence: "HIGH" })
    const runner = vi.fn()
      .mockResolvedValueOnce(brief1)
      .mockRejectedValueOnce(new Error("flash exploded"))
      .mockResolvedValueOnce(brief3)

    const seenPriors: Array<ReasoningBrief | null> = []
    const stages: ChainStage[] = [
      { name: "ok-1", buildPayload: (p) => { seenPriors.push(p); return { ...basePayload } } },
      { name: "fails", buildPayload: (p) => { seenPriors.push(p); return { ...basePayload } } },
      { name: "ok-2", buildPayload: (p) => { seenPriors.push(p); return { ...basePayload } } },
    ]
    const result = await runReasoningChain(basePayload, stages, runner)
    expect(result.finalBrief).toBe(brief3)
    expect(result.stages.map((s) => s.brief)).toEqual([brief1, null, brief3])
    // Stage 3's prior is brief1 (the last successful brief), NOT null —
    // a failed stage doesn't poison the chain's input thread.
    expect(seenPriors).toEqual([null, brief1, brief1])
  })

  it("a buildPayload throw is logged + treated as a skip; chain continues", async () => {
    const brief1 = makeBrief()
    const runner = vi.fn().mockResolvedValueOnce(brief1)
    const stages: ChainStage[] = [
      { name: "throws", buildPayload: () => { throw new Error("buildPayload boom") } },
      { name: "ok", buildPayload: () => ({ ...basePayload }) },
    ]
    const result = await runReasoningChain(basePayload, stages, runner)
    expect(result.finalBrief).toBe(brief1)
    expect(result.stages[0]).toEqual({ name: "throws", brief: null })
    expect(result.stages[1]).toEqual({ name: "ok", brief: brief1 })
    expect(runner).toHaveBeenCalledTimes(1)
  })

  it("every stage skipped → finalBrief: null, audit reflects every skip", async () => {
    const runner = vi.fn()
    const stages: ChainStage[] = [
      { name: "a", buildPayload: () => null },
      { name: "b", buildPayload: () => null },
    ]
    const result = await runReasoningChain(basePayload, stages, runner)
    expect(result.finalBrief).toBeNull()
    expect(result.stages).toEqual([
      { name: "a", brief: null },
      { name: "b", brief: null },
    ])
    expect(runner).not.toHaveBeenCalled()
  })

  it("runReasoning returning null is recorded; chain continues with prior brief unchanged", async () => {
    const brief1 = makeBrief()
    const runner = vi.fn()
      .mockResolvedValueOnce(brief1)
      .mockResolvedValueOnce(null)  // flag-disabled, cache miss, etc.
    const seenPriors: Array<ReasoningBrief | null> = []
    const stages: ChainStage[] = [
      { name: "ok", buildPayload: (p) => { seenPriors.push(p); return { ...basePayload } } },
      { name: "null", buildPayload: (p) => { seenPriors.push(p); return { ...basePayload } } },
    ]
    const result = await runReasoningChain(basePayload, stages, runner)
    expect(result.finalBrief).toBe(brief1) // prior brief retained
    expect(result.stages[1].brief).toBeNull()
    // Stage 2 was called with brief1 as prior, even though stage 2's own brief is null.
    expect(seenPriors).toEqual([null, brief1])
  })

  it("uses production runReasoning when no runner is supplied (default arg)", async () => {
    // Smoke test the default arg: with empty stages it short-circuits before
    // touching runReasoning, so we don't need GEMINI_API_KEY for the test.
    const result = await runReasoningChain(basePayload, [])
    expect(result.finalBrief).toBeNull()
  })
})
