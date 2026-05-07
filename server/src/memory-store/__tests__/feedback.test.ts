import { describe, it, expect, beforeEach } from "vitest"
import {
  applyMemoryFeedback,
  validateConfirmation,
  validateContradiction,
  _CONFIG,
} from "../feedback.js"
import { recordDecision, recordImplementSummary } from "../recorder.js"
import { loadMemoryEntries, _resetCache, _setupTempCwd } from "../store.js"

describe("validateConfirmation — pure helper", () => {
  it("returns false on empty entry content", () => {
    expect(validateConfirmation("", "anything")).toBe(false)
  })

  it("returns false when no meaningful tokens overlap", () => {
    const entry = "Decision: Use Drizzle ORM with TypeScript and Fastify"
    const response = "I'll write the code in Python with Django."
    expect(validateConfirmation(entry, response)).toBe(false)
  })

  it("returns true when overlap meets the 0.3 threshold", () => {
    const entry = "Decision: Use Drizzle ORM with TypeScript and Fastify"
    const response = "Going with Drizzle and TypeScript — Fastify is the right pick."
    expect(validateConfirmation(entry, response)).toBe(true)
  })

  it("treats dashes as word boundaries so 'postgres-backed' matches 'postgres'", () => {
    // Entry text uses the hyphenated form; response uses the unhyphenated form.
    // Without dash-splitting tokenisation this would miss.
    const entry = "Implement: build a postgres-backed user API"
    const response = "I will use postgres for the user database."
    // entry meaningful tokens: implement, build, postgres, backed, user (5)
    // response overlap: postgres, user (2) → 2/5 = 0.4 ≥ 0.3 → true
    expect(validateConfirmation(entry, response)).toBe(true)
  })

  it("filters stopwords so they don't inflate overlap", () => {
    const entry = "this and that with the more than less"
    // After filtering: nothing — all stopwords. Token set is empty → false.
    expect(validateConfirmation(entry, "anything")).toBe(false)
  })

  it("ignores tokens shorter than 4 chars", () => {
    const entry = "API DB UI"
    // After filtering: nothing — all under 4 chars. Empty token set → false.
    expect(validateConfirmation(entry, "API DB UI everywhere")).toBe(false)
  })

  it("is case-insensitive", () => {
    const entry = "Decision: TypeScript with Fastify"
    const response = "TYPESCRIPT WITH FASTIFY"
    expect(validateConfirmation(entry, response)).toBe(true)
  })
})

describe("validateContradiction — pure helper", () => {
  it("requires explicit bracket-notation reference", () => {
    expect(validateContradiction("abc123", "I disagree with the prior decision")).toBe(false)
    expect(validateContradiction("abc123", "Wrong about [abc123] — we use Python now")).toBe(true)
  })

  it("returns false on empty inputs", () => {
    expect(validateContradiction("", "anything")).toBe(false)
    expect(validateContradiction("abc", "")).toBe(false)
  })

  it("matches exactly — partial id substrings don't count", () => {
    // The model writing `[abc12]` (truncated) should NOT honour against id `abc123`.
    expect(validateContradiction("abc123", "Wrong about [abc12] — typo")).toBe(false)
    // But the full id wrapped in brackets matches even with surrounding text.
    expect(validateContradiction("abc123", "see [abc123] — it's stale")).toBe(true)
  })
})

describe("applyMemoryFeedback — integration with the store", () => {
  let cwd: string
  beforeEach(async () => {
    cwd = await _setupTempCwd()
    _resetCache()
  })

  it("returns empty audit log on null / empty / unusable input", async () => {
    const empty = await applyMemoryFeedback(cwd, null, "anything")
    expect(empty.confirmedHonoured).toEqual([])
    expect(empty.contradictedHonoured).toEqual([])

    const undef = await applyMemoryFeedback(cwd, undefined, "anything")
    expect(undef.confirmedHonoured).toEqual([])

    const both = await applyMemoryFeedback(cwd, { confirmed: [], contradicted: [] }, "anything")
    expect(both.confirmedHonoured).toEqual([])
    expect(both.contradictedHonoured).toEqual([])

    // Empty cwd short-circuits.
    const noCwd = await applyMemoryFeedback("", { confirmed: ["x"] }, "anything")
    expect(noCwd.confirmedHonoured).toEqual([])
  })

  it("rejects unknown ids silently (logs them in *Rejected for telemetry)", async () => {
    const result = await applyMemoryFeedback(
      cwd,
      { confirmed: ["nonexistent-id"], contradicted: ["also-nonexistent"] },
      "the response text",
    )
    expect(result.confirmedHonoured).toEqual([])
    expect(result.confirmedRejected).toEqual(["nonexistent-id"])
    expect(result.contradictedHonoured).toEqual([])
    expect(result.contradictedRejected).toEqual(["also-nonexistent"])
  })

  it("honours a confirmed id when entry content overlaps the response", async () => {
    // Seed a decision entry, then submit feedback claiming it was used.
    const entry = await recordDecision(
      cwd,
      { confidence: "HIGH", decisionBrief: { recommendation: "Use Drizzle ORM with TypeScript and Fastify" } },
      { runId: "r1" },
    )
    expect(entry).not.toBeNull()
    const before = (await loadMemoryEntries(cwd))[0]
    expect(before.useCount).toBe(0)

    const result = await applyMemoryFeedback(
      cwd,
      { confirmed: [entry!.id] },
      "I went with Drizzle and TypeScript and Fastify, as discussed.",
    )
    expect(result.confirmedHonoured).toEqual([entry!.id])
    expect(result.confirmedRejected).toEqual([])

    const after = (await loadMemoryEntries(cwd))[0]
    expect(after.useCount).toBe(1)
    expect(after.lastConfirmedAt).toBeGreaterThan(before.lastConfirmedAt ?? 0)
  })

  it("rejects a confirmed id when entry content does NOT overlap the response (hallucination guard)", async () => {
    const entry = await recordDecision(
      cwd,
      { confidence: "HIGH", decisionBrief: { recommendation: "Use Drizzle ORM with TypeScript and Fastify" } },
      { runId: "r1" },
    )
    expect(entry).not.toBeNull()

    const result = await applyMemoryFeedback(
      cwd,
      { confirmed: [entry!.id] },
      "I built a Python Django REST app — completely different stack.",
    )
    expect(result.confirmedHonoured).toEqual([])
    expect(result.confirmedRejected).toEqual([entry!.id])

    // useCount must NOT have been bumped.
    const after = (await loadMemoryEntries(cwd))[0]
    expect(after.useCount).toBe(0)
  })

  it("honours a contradicted id when the response references it in brackets", async () => {
    const entry = await recordImplementSummary(
      cwd,
      {
        implementBrief: {
          intent: "build the auth service",
          recommendedStack: { language: "TypeScript", frameworks: ["Express"], libraries: ["mongoose"], rationale: "fast" },
        },
        confidence: "HIGH",
      },
      { runId: "r1", trigger: "preflight" },
    )
    expect(entry).not.toBeNull()
    const before = (await loadMemoryEntries(cwd))[0]
    expect(before.contradictionCount).toBe(0)

    const result = await applyMemoryFeedback(
      cwd,
      { contradicted: [entry!.id] },
      `Wrong about [${entry!.id}] — the project actually uses Postgres, not Mongoose.`,
    )
    expect(result.contradictedHonoured).toEqual([entry!.id])
    expect(result.contradictedRejected).toEqual([])

    const after = (await loadMemoryEntries(cwd))[0]
    expect(after.contradictionCount).toBe(1)
    expect(after.status).toBe("active") // still active after one contradiction; dies at 2.
  })

  it("rejects a contradicted id when the response does NOT reference it (hallucination guard)", async () => {
    const entry = await recordImplementSummary(
      cwd,
      {
        implementBrief: {
          intent: "build the auth service",
          recommendedStack: { language: "TypeScript", frameworks: ["Express"], libraries: ["mongoose"], rationale: "fast" },
        },
        confidence: "HIGH",
      },
      { runId: "r1", trigger: "preflight" },
    )
    expect(entry).not.toBeNull()

    const result = await applyMemoryFeedback(
      cwd,
      { contradicted: [entry!.id] },
      "We disagree with the prior choice — switching to Postgres.",  // no `[id]` reference
    )
    expect(result.contradictedHonoured).toEqual([])
    expect(result.contradictedRejected).toEqual([entry!.id])

    // contradictionCount must NOT have been bumped.
    const after = (await loadMemoryEntries(cwd))[0]
    expect(after.contradictionCount).toBe(0)
  })

  it("processes mixed feedback (some confirmed, some contradicted, some rejected) in one call", async () => {
    const e1 = await recordDecision(
      cwd,
      { confidence: "HIGH", decisionBrief: { recommendation: "Use Drizzle ORM with TypeScript and Fastify" } },
      { runId: "r1" },
    )
    const e2 = await recordImplementSummary(
      cwd,
      {
        implementBrief: {
          intent: "build auth",
          recommendedStack: { language: "TypeScript", frameworks: ["Express"], libraries: ["mongoose"], rationale: "fast" },
        },
        confidence: "HIGH",
      },
      { runId: "r1" },
    )
    expect(e1).not.toBeNull()
    expect(e2).not.toBeNull()

    const responseText = `Going with Drizzle and TypeScript and Fastify per the prior decision. Wrong about [${e2!.id}] though — Postgres now.`

    const result = await applyMemoryFeedback(
      cwd,
      {
        confirmed: [e1!.id, "phantom-id-1"],
        contradicted: [e2!.id, "phantom-id-2"],
      },
      responseText,
    )

    expect(result.confirmedHonoured).toEqual([e1!.id])
    expect(result.confirmedRejected).toEqual(["phantom-id-1"])
    expect(result.contradictedHonoured).toEqual([e2!.id])
    expect(result.contradictedRejected).toEqual(["phantom-id-2"])
  })

  it("two contradiction strikes flip the entry status to 'contradicted'", async () => {
    const entry = await recordDecision(
      cwd,
      { confidence: "HIGH", decisionBrief: { recommendation: "Use foo with bar and baz" } },
      { runId: "r1" },
    )
    expect(entry).not.toBeNull()

    // Strike 1
    await applyMemoryFeedback(cwd, { contradicted: [entry!.id] }, `Wrong about [${entry!.id}] — strike 1.`)
    let entries = await loadMemoryEntries(cwd)
    expect(entries[0].contradictionCount).toBe(1)
    expect(entries[0].status).toBe("active")

    // Strike 2 → contradicted
    await applyMemoryFeedback(cwd, { contradicted: [entry!.id] }, `Wrong about [${entry!.id}] — strike 2.`)
    entries = await loadMemoryEntries(cwd)
    expect(entries[0].contradictionCount).toBe(2)
    expect(entries[0].status).toBe("contradicted")
  })

  it("ignores non-string entries in the arrays defensively", async () => {
    // Passing a malformed payload (numbers / nulls in the arrays) shouldn't crash;
    // the helper filters non-strings before processing.
    const result = await applyMemoryFeedback(
      cwd,
      // @ts-expect-error — intentional bad shape to assert the runtime guard
      { confirmed: ["valid-id", 42, null, "another-id"], contradicted: [false, "x"] },
      "anything",
    )
    // Both ids fail (not seeded in this test), but they're treated as valid strings
    // (rejected as unknown), not crashed on.
    expect(result.confirmedRejected).toContain("valid-id")
    expect(result.confirmedRejected).toContain("another-id")
    expect(result.contradictedRejected).toContain("x")
  })
})

describe("_CONFIG sanity", () => {
  it("CONFIRM_OVERLAP_THRESHOLD is between 0 and 1 exclusive", () => {
    expect(_CONFIG.CONFIRM_OVERLAP_THRESHOLD).toBeGreaterThan(0)
    expect(_CONFIG.CONFIRM_OVERLAP_THRESHOLD).toBeLessThan(1)
  })

  it("STOPWORDS is a non-empty Set", () => {
    expect(_CONFIG.STOPWORDS instanceof Set).toBe(true)
    expect(_CONFIG.STOPWORDS.size).toBeGreaterThan(0)
  })
})
