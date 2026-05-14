import { describe, it, expect, beforeEach } from "vitest"
import {
  buildCacheKey,
  getReasoningCache,
  setReasoningCache,
  resetReasoningCache,
  _setNowFn,
  _setTtlMs,
  _resetTimingHooks,
} from "../reasoning-cache.js"
import type { ReasoningBrief } from "../reasoning-schema.js"

const stubBrief = (note: string): ReasoningBrief => ({
  pipeline: "simple",
  confidence: "HIGH",
  decision: "proceed",
  missingContext: [],
  reasoningTrace: note,
  reasoningChain: [],
})

const baseKey = {
  trigger: "preflight" as const,
  userMessage: "create a thing",
  cwd: "/projects/x",
  model: "gemini-flash",
}

describe("reasoning-cache", () => {
  beforeEach(() => {
    resetReasoningCache()
    _resetTimingHooks()
  })

  it("get returns null for unset keys", () => {
    expect(getReasoningCache(baseKey)).toBeNull()
  })

  it("set then get roundtrips", () => {
    setReasoningCache(baseKey, stubBrief("v1"))
    expect(getReasoningCache(baseKey)?.reasoningTrace).toBe("v1")
  })

  it("buildCacheKey is deterministic on inputs", () => {
    const k1 = buildCacheKey(baseKey)
    const k2 = buildCacheKey({ ...baseKey })
    expect(k1).toBe(k2)
  })

  it("buildCacheKey isolates different cwds", () => {
    const k1 = buildCacheKey(baseKey)
    const k2 = buildCacheKey({ ...baseKey, cwd: "/projects/y" })
    expect(k1).not.toBe(k2)
  })

  it("buildCacheKey isolates different triggers", () => {
    const k1 = buildCacheKey(baseKey)
    const k2 = buildCacheKey({ ...baseKey, trigger: "on_error" })
    expect(k1).not.toBe(k2)
  })

  it("TTL expiry returns null", () => {
    let now = 1_000_000
    _setNowFn(() => now)
    _setTtlMs(60_000)  // 60s
    setReasoningCache(baseKey, stubBrief("ttl-test"))
    expect(getReasoningCache(baseKey)?.reasoningTrace).toBe("ttl-test")
    now += 60_001
    expect(getReasoningCache(baseKey)).toBeNull()
  })

  it("FIFO eviction at cap (using a small TTL doesn't matter — eviction is by count)", () => {
    // We can't easily change CACHE_CAP at runtime without exposing it; instead,
    // verify that eviction WORKS by hammering the cache with > 200 entries
    // and confirming the oldest one is gone.
    for (let i = 0; i < 250; i++) {
      setReasoningCache({ ...baseKey, userMessage: `msg-${i}` }, stubBrief(`v${i}`))
    }
    // The first batch should have been evicted.
    expect(getReasoningCache({ ...baseKey, userMessage: "msg-0" })).toBeNull()
    // Recent entries should still be present.
    expect(getReasoningCache({ ...baseKey, userMessage: "msg-249" })?.reasoningTrace).toBe("v249")
  })

  it("reset clears everything", () => {
    setReasoningCache(baseKey, stubBrief("v1"))
    resetReasoningCache()
    expect(getReasoningCache(baseKey)).toBeNull()
  })
})
