import { describe, it, expect, beforeEach } from "vitest"
import {
  seedLedgerFromBuildPlan,
  applyLedgerUpdates,
  getLedger,
  clearLedger,
  _resetLedgersForTests,
} from "../task-ledger.js"
import { getTaskLedgerSection } from "../../providers/prompt/sections/task-ledger.js"

/**
 * Stage 2 of free-tier quality enforcement: per-run task ledger seed +
 * apply + render. Pins behaviour without invoking the full reasoning
 * loop.
 */

beforeEach(() => _resetLedgersForTests())

describe("seedLedgerFromBuildPlan", () => {
  it("creates one entry per buildPlan step with pending status", () => {
    seedLedgerFromBuildPlan("run-1", [
      { step: "Scaffold project structure", deliverable: "package.json + tsconfig" },
      { step: "Wire game logic into App.tsx", deliverable: "src/App.tsx" },
      { step: "Add score tracking" },
    ])
    const entries = getLedger("run-1")
    expect(entries).toHaveLength(3)
    expect(entries[0].label).toBe("Scaffold project structure")
    expect(entries[0].deliverable).toBe("package.json + tsconfig")
    expect(entries[0].status).toBe("pending")
    expect(entries[2].deliverable).toBeUndefined()
  })

  it("generates stable ids that include the step index", () => {
    seedLedgerFromBuildPlan("run-1", [
      { step: "Scaffold" },
      { step: "Scaffold" }, // identical text — id must still distinguish via index
    ])
    const entries = getLedger("run-1")
    expect(entries[0].id).not.toBe(entries[1].id)
    expect(entries[0].id).toMatch(/^s0-/)
    expect(entries[1].id).toMatch(/^s1-/)
  })

  it("does nothing on empty / missing buildPlan", () => {
    seedLedgerFromBuildPlan("run-1", [])
    expect(getLedger("run-1")).toEqual([])
    seedLedgerFromBuildPlan("run-1", null as unknown as never)
    expect(getLedger("run-1")).toEqual([])
  })

  it("filters entries with empty / non-string step labels", () => {
    seedLedgerFromBuildPlan("run-1", [
      { step: "OK step" },
      { step: "" },
      { step: "   " },
      { step: 42 as unknown as string },
    ])
    expect(getLedger("run-1")).toHaveLength(1)
  })

  it("caps at 12 entries (reasonable upper bound for buildPlan)", () => {
    const huge = Array.from({ length: 20 }, (_, i) => ({ step: `step ${i}` }))
    seedLedgerFromBuildPlan("run-1", huge)
    expect(getLedger("run-1")).toHaveLength(12)
  })

  it("replaces an existing ledger when re-seeded (covers /continue with fresh preflight)", () => {
    seedLedgerFromBuildPlan("run-1", [{ step: "Old" }])
    seedLedgerFromBuildPlan("run-1", [{ step: "New" }])
    const entries = getLedger("run-1")
    expect(entries).toHaveLength(1)
    expect(entries[0].label).toBe("New")
  })
})

describe("applyLedgerUpdates", () => {
  it("advances a status from pending → in_progress", () => {
    seedLedgerFromBuildPlan("run-1", [{ step: "Wire routes" }])
    const id = getLedger("run-1")[0].id
    applyLedgerUpdates("run-1", [{ id, status: "in_progress" }])
    expect(getLedger("run-1")[0].status).toBe("in_progress")
  })

  it("advances from in_progress → done with evidence file paths", () => {
    seedLedgerFromBuildPlan("run-1", [{ step: "Scaffold" }])
    const id = getLedger("run-1")[0].id
    applyLedgerUpdates("run-1", [
      { id, status: "done", evidence: ["package.json", "vite.config.ts"] },
    ])
    const entry = getLedger("run-1")[0]
    expect(entry.status).toBe("done")
    expect(entry.evidence).toEqual(["package.json", "vite.config.ts"])
  })

  it("drops updates for unknown ids (reflector hallucination guard)", () => {
    seedLedgerFromBuildPlan("run-1", [{ step: "Real step" }])
    const realId = getLedger("run-1")[0].id
    applyLedgerUpdates("run-1", [
      { id: "fake-id-that-doesnt-exist", status: "done" },
      { id: realId, status: "in_progress" },
    ])
    expect(getLedger("run-1")[0].status).toBe("in_progress")
  })

  it("drops updates with invalid status values", () => {
    seedLedgerFromBuildPlan("run-1", [{ step: "Step" }])
    const id = getLedger("run-1")[0].id
    applyLedgerUpdates("run-1", [
      { id, status: "bogus" as unknown as "done" },
    ])
    expect(getLedger("run-1")[0].status).toBe("pending")
  })

  it("filters non-string evidence entries", () => {
    seedLedgerFromBuildPlan("run-1", [{ step: "Step" }])
    const id = getLedger("run-1")[0].id
    applyLedgerUpdates("run-1", [
      { id, status: "done", evidence: ["ok.ts", "", null as unknown as string, "another.ts"] },
    ])
    expect(getLedger("run-1")[0].evidence).toEqual(["ok.ts", "another.ts"])
  })

  it("is a no-op when there's no ledger for this runId", () => {
    expect(() => applyLedgerUpdates("nonexistent-run", [{ id: "x", status: "done" }])).not.toThrow()
  })
})

describe("clearLedger / isolation", () => {
  it("clearLedger removes only the targeted run's ledger", () => {
    seedLedgerFromBuildPlan("run-A", [{ step: "A1" }])
    seedLedgerFromBuildPlan("run-B", [{ step: "B1" }])
    clearLedger("run-A")
    expect(getLedger("run-A")).toEqual([])
    expect(getLedger("run-B")).toHaveLength(1)
  })

  it("getLedger returns a defensive copy (caller can't mutate internal state)", () => {
    seedLedgerFromBuildPlan("run-1", [{ step: "Step" }])
    const snapshot = getLedger("run-1")
    snapshot[0].status = "done"
    // Internal state remains pending.
    expect(getLedger("run-1")[0].status).toBe("pending")
  })
})

describe("getTaskLedgerSection — render", () => {
  it("returns null when the ledger is empty / undefined", () => {
    expect(getTaskLedgerSection({})).toBeNull()
    expect(getTaskLedgerSection({ taskLedger: [] })).toBeNull()
  })

  it("renders checkboxes per status", () => {
    const out = getTaskLedgerSection({
      taskLedger: [
        { id: "s0-a", label: "Scaffold", deliverable: "package.json", status: "done", evidence: ["package.json"] },
        { id: "s1-b", label: "Wire routes", status: "in_progress" },
        { id: "s2-c", label: "Add tests", status: "pending" },
      ],
    })
    expect(out).not.toBeNull()
    expect(out!).toContain("TASK LEDGER")
    expect(out!).toContain("[✓] Scaffold → package.json")
    expect(out!).toContain("[~] Wire routes")
    expect(out!).toContain("[ ] Add tests")
    expect(out!).toContain("evidence: package.json")
    expect(out!).toContain("1 pending · 1 in progress")
  })

  it("shows the 'all done' footer when nothing is pending", () => {
    const out = getTaskLedgerSection({
      taskLedger: [
        { id: "s0", label: "A", status: "done" },
        { id: "s1", label: "B", status: "done" },
      ],
    })
    expect(out!).toContain("All ledger items are done")
    expect(out!).toContain("verify with the user")
  })

  it("caps evidence display at 3 paths with +N hint", () => {
    const out = getTaskLedgerSection({
      taskLedger: [
        {
          id: "s0", label: "X", status: "done",
          evidence: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"],
        },
      ],
    })
    expect(out!).toContain("evidence: a.ts, b.ts, c.ts (+2 more)")
  })
})
