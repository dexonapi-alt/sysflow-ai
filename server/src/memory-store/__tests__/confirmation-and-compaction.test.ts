import { describe, it, expect, beforeEach } from "vitest"
import { loadMemoryEntries, saveMemoryEntries, _resetCache, _setupTempCwd } from "../store.js"
import { noteAgreement, noteContradiction, noteAccessed, _CONFIG as TRACKER_CFG } from "../confirmation-tracker.js"
import { compactIfNeeded } from "../compaction.js"
import { makeEntry, type MemoryEntry } from "../entry-schema.js"

describe("confirmation-tracker", () => {
  let cwd: string
  beforeEach(async () => {
    cwd = await _setupTempCwd()
    _resetCache()
  })

  it("noteAgreement bumps useCount + lastConfirmedAt + lastUsedAt", async () => {
    const e = makeEntry({ kind: "decision", content: "use Drizzle" }, 1_000_000)
    await saveMemoryEntries(cwd, [e])
    _resetCache()
    await noteAgreement(cwd, e.id)
    const after = await loadMemoryEntries(cwd)
    expect(after[0].useCount).toBe(1)
    expect(after[0].lastConfirmedAt).toBeGreaterThan(1_000_000)
  })

  it("noteContradiction bumps counter; flips to contradicted at threshold", async () => {
    const e = makeEntry({ kind: "decision", content: "x" })
    await saveMemoryEntries(cwd, [e])
    _resetCache()
    await noteContradiction(cwd, e.id)
    let after = await loadMemoryEntries(cwd)
    expect(after[0].contradictionCount).toBe(1)
    expect(after[0].status).toBe("active")
    await noteContradiction(cwd, e.id)
    after = await loadMemoryEntries(cwd)
    expect(after[0].contradictionCount).toBe(TRACKER_CFG.CONTRADICTION_DEATH_THRESHOLD)
    expect(after[0].status).toBe("contradicted")
  })

  it("noteAccessed touches lastUsedAt only", async () => {
    const e = { ...makeEntry({ kind: "decision", content: "x" }, 1_000_000) }
    e.lastUsedAt = 1_000_000
    e.useCount = 0
    await saveMemoryEntries(cwd, [e])
    _resetCache()
    await noteAccessed(cwd, e.id)
    const after = await loadMemoryEntries(cwd)
    expect(after[0].lastUsedAt).toBeGreaterThan(1_000_000)
    expect(after[0].useCount).toBe(0)
  })

  it("unknown entryId is a no-op (silent skip)", async () => {
    const e = makeEntry({ kind: "decision", content: "x" })
    await saveMemoryEntries(cwd, [e])
    _resetCache()
    await noteAgreement(cwd, "doesnotexist")
    const after = await loadMemoryEntries(cwd)
    expect(after[0].useCount).toBe(0)
  })
})

describe("compaction", () => {
  let cwd: string
  beforeEach(async () => {
    cwd = await _setupTempCwd()
    _resetCache()
  })

  it("returns null when file is under cap", async () => {
    const e = makeEntry({ kind: "decision", content: "small" })
    await saveMemoryEntries(cwd, [e])
    const r = await compactIfNeeded(cwd, { maxBytes: 100_000 })
    expect(r).toBeNull()
  })

  it("returns null on empty file", async () => {
    const r = await compactIfNeeded(cwd)
    expect(r).toBeNull()
  })

  it("evicts contradicted before stale before low-use active", async () => {
    const big = "x".repeat(500)  // each entry roughly fixed size
    const contradicted = { ...makeEntry({ kind: "decision", content: "contradicted: " + big }), status: "contradicted" as const }
    const stale = { ...makeEntry({ kind: "decision", content: "stale: " + big }), status: "stale" as const }
    const lowUseActive = makeEntry({ kind: "decision", content: "low-use: " + big })
    const highUseActive = { ...makeEntry({ kind: "decision", content: "high-use: " + big }), useCount: 100 }

    await saveMemoryEntries(cwd, [contradicted, stale, lowUseActive, highUseActive])
    // Force compaction with a tiny cap so it has to drop something.
    const r = await compactIfNeeded(cwd, { maxBytes: 1500 })
    expect(r).not.toBeNull()
    const remaining = await loadMemoryEntries(cwd)
    const remainingIds = remaining.map((e) => e.id)
    // Contradicted should be evicted first.
    expect(remainingIds).not.toContain(contradicted.id)
    // High-use active should survive longest.
    expect(remainingIds).toContain(highUseActive.id)
  })

  it("never drops user_correction entries even under heavy pressure", async () => {
    const corrections: MemoryEntry[] = Array.from({ length: 5 }, (_, i) =>
      makeEntry({ kind: "user_correction", content: `correction ${i} ` + "x".repeat(500) })
    )
    await saveMemoryEntries(cwd, corrections)
    // Try to compact below the file's actual size — corrections must survive.
    await compactIfNeeded(cwd, { maxBytes: 100 })
    const after = await loadMemoryEntries(cwd)
    expect(after.length).toBe(5)
    expect(after.every((e) => e.kind === "user_correction")).toBe(true)
  })
})
