import { describe, it, expect } from "vitest"
import { getLearnedMemorySection, renderEntryLine } from "../learned-memory.js"

describe("getLearnedMemorySection", () => {
  it("returns null when there are no learned-memory lines (no prompt overhead)", () => {
    expect(getLearnedMemorySection({})).toBeNull()
    expect(getLearnedMemorySection({ learnedMemoryLines: [] })).toBeNull()
  })

  it("renders the section with the entries when lines are present", () => {
    const out = getLearnedMemorySection({
      learnedMemoryLines: [
        "[abc123] decision: Use Drizzle ORM",
        "[def456] implement: postgres-backed user API",
      ],
    })
    expect(out).not.toBeNull()
    expect(out).toContain("LEARNED PROJECT MEMORY")
    expect(out).toContain("[abc123]")
    expect(out).toContain("[def456]")
    expect(out).toContain("Use Drizzle ORM")
  })

  it("includes the summary header when one is supplied", () => {
    const out = getLearnedMemorySection({
      learnedMemoryLines: ["[a] decision: x"],
      learnedMemorySummary: { totalConsidered: 10, staleCount: 3, contradictedCount: 1 },
    })
    // Header reads "(<rendered> of <considered>; <stale> stale, <contradicted> contradicted)"
    expect(out).toContain("(1 of 10")
    expect(out).toContain("3 stale")
    expect(out).toContain("1 contradicted")
  })

  it("Phase 15 Stage 4: includes the memoryFeedback contract block when entries are rendered", () => {
    const out = getLearnedMemorySection({
      learnedMemoryLines: ["[abc123] decision: Use Drizzle"],
    })
    expect(out).not.toBeNull()
    // The contract documents the JSON shape the model should emit.
    expect(out).toContain("memoryFeedback")
    expect(out).toContain("\"confirmed\":")
    expect(out).toContain("\"contradicted\":")
    // The contract calls out the [id] reference requirement for contradictions.
    expect(out).toContain("[id]")
  })

  it("does NOT render the memoryFeedback contract when no entries are present (no overhead)", () => {
    // The whole section returns null when lines are empty — verified above.
    // This test pins the relationship: entries → contract; no entries → no contract.
    const out = getLearnedMemorySection({ learnedMemoryLines: [] })
    expect(out).toBeNull()
  })

  it("truncates entry lines longer than the per-line cap with ellipsis", () => {
    const longContent = "a".repeat(300)
    const out = getLearnedMemorySection({
      learnedMemoryLines: [`[id1] decision: ${longContent}`],
    })
    expect(out).not.toBeNull()
    // Per-line cap is 200; the truncated entry's "a" run should appear with
    // an ellipsis and the original 300-char content should NOT appear in full.
    expect(out).toContain("…")
    expect(out).not.toContain("a".repeat(220))
  })
})

describe("renderEntryLine", () => {
  it("formats a memory entry as `[id] kind: content`", () => {
    expect(renderEntryLine({ id: "abc", kind: "decision", content: "use Drizzle" })).toBe(
      "[abc] decision: use Drizzle",
    )
  })

  it("collapses whitespace in multi-line content", () => {
    const r = renderEntryLine({ id: "x", kind: "implement", content: "Implement: X\nStack: Y\nNotes: Z" })
    expect(r).toBe("[x] implement: Implement: X Stack: Y Notes: Z")
  })

  it("trims surrounding whitespace", () => {
    expect(renderEntryLine({ id: "x", kind: "decision", content: "  trimmed  " })).toBe(
      "[x] decision: trimmed",
    )
  })
})
