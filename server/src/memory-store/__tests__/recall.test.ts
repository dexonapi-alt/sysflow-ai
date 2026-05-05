import { describe, it, expect, beforeEach } from "vitest"
import { recallForReasoning, _CONFIG } from "../recall.js"
import { saveMemoryEntries, _resetCache, _setupTempCwd } from "../store.js"
import { makeEntry, type MemoryEntry } from "../entry-schema.js"

describe("recallForReasoning", () => {
  let cwd: string
  beforeEach(async () => {
    cwd = await _setupTempCwd()
    _resetCache()
  })

  it("returns empty when no memory file", async () => {
    const r = await recallForReasoning({ cwd, userMessage: "build a thing" })
    expect(r.entries).toEqual([])
  })

  it("returns active entries up to MAX_RECALL_ENTRIES", async () => {
    const entries: MemoryEntry[] = Array.from({ length: 20 }, (_, i) =>
      makeEntry({ kind: "decision", content: `decision number ${i}` })
    )
    await saveMemoryEntries(cwd, entries)
    _resetCache()
    const r = await recallForReasoning({ cwd, userMessage: "anything" })
    expect(r.entries.length).toBe(_CONFIG.MAX_RECALL_ENTRIES)
  })

  it("filters by kind when specified", async () => {
    const decisions = [
      makeEntry({ kind: "decision", content: "use Drizzle" }),
      makeEntry({ kind: "decision", content: "use Hono" }),
    ]
    const correction = makeEntry({ kind: "user_correction", content: "we use Bun" })
    await saveMemoryEntries(cwd, [...decisions, correction])
    _resetCache()
    const r = await recallForReasoning({ cwd, userMessage: "anything", kind: "decision" })
    expect(r.entries.length).toBe(2)
    expect(r.entries.every((e) => e.kind === "decision")).toBe(true)
  })

  it("user_correction beats other entries for the same overlap (bonus)", async () => {
    const decision = { ...makeEntry({ kind: "decision", content: "drizzle is good" }), useCount: 0 }
    const correction = { ...makeEntry({ kind: "user_correction", content: "we use bun" }), useCount: 0 }
    await saveMemoryEntries(cwd, [decision, correction])
    _resetCache()
    // Neither overlaps the user message; user_correction bonus should put it first.
    const r = await recallForReasoning({ cwd, userMessage: "totally unrelated prompt" })
    expect(r.entries[0].kind).toBe("user_correction")
  })

  it("token-overlap boosts relevance", async () => {
    const irrelevant = makeEntry({ kind: "decision", content: "we use Postgres for the database" })
    const relevant = makeEntry({ kind: "decision", content: "we use Drizzle ORM with the spreadsheet integration" })
    await saveMemoryEntries(cwd, [irrelevant, relevant])
    _resetCache()
    const r = await recallForReasoning({ cwd, userMessage: "build a spreadsheet integration script" })
    // Relevant entry should be ranked higher even though both have the same useCount.
    expect(r.entries[0].id).toBe(relevant.id)
  })

  it("excludes stale + contradicted entries from active set", async () => {
    const fresh = makeEntry({ kind: "decision", content: "fresh" })
    const stale = { ...makeEntry({ kind: "decision", content: "old" }, Date.now() - 100 * 86_400_000), useCount: 0 }
    const contradicted = { ...makeEntry({ kind: "decision", content: "wrong" }), status: "contradicted" as const }
    await saveMemoryEntries(cwd, [fresh, stale, contradicted])
    _resetCache()
    const r = await recallForReasoning({ cwd, userMessage: "anything" })
    expect(r.entries.length).toBe(1)
    expect(r.entries[0].id).toBe(fresh.id)
    expect(r.staleCount).toBe(1)
    expect(r.contradictedCount).toBe(1)
  })

  it("respects custom maxEntries", async () => {
    await saveMemoryEntries(cwd, [
      makeEntry({ kind: "decision", content: "a" }),
      makeEntry({ kind: "decision", content: "b" }),
      makeEntry({ kind: "decision", content: "c" }),
    ])
    _resetCache()
    const r = await recallForReasoning({ cwd, userMessage: "x", maxEntries: 2 })
    expect(r.entries.length).toBe(2)
  })
})
