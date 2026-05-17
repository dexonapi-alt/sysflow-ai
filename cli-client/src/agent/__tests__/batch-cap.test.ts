/**
 * Stage 1 of `2026-05-16-accountability-and-parallel-execution-sequencing.md`.
 *
 * Pure tests for the parallel-batch-cap helpers in `tool-meta.ts`.
 * The cap enforces per-turn accountability: when the agent emits more
 * than `cap` tool calls in a single response, only the first `cap`
 * execute; the rest are deferred with a synthetic failure result so
 * the agent's next turn sees the deferral + the executed batch's real
 * outcomes + can reason about what to re-issue.
 */

import { describe, it, expect } from "vitest"
import {
  applyBatchCap,
  resolveBatchCap,
  buildBatchCapDeferralResult,
  BATCH_CAP_DEFAULT,
  BATCH_CAP_EXISTING_LARGE,
  type ToolCallEntry,
  type RepoState,
} from "../tool-meta.js"

function tc(id: string, tool = "write_file", args: Record<string, unknown> = {}): ToolCallEntry {
  return { id, tool, args }
}

describe("resolveBatchCap — repoState-aware cap selection", () => {
  it("defaults to 3 when repoState is null (project-init didn't fire)", () => {
    expect(resolveBatchCap(null)).toBe(3)
    expect(resolveBatchCap(null)).toBe(BATCH_CAP_DEFAULT)
  })

  it("uses default 3 for empty / small / existing-small", () => {
    const states: RepoState[] = ["empty", "small", "existing-small"]
    for (const s of states) {
      expect(resolveBatchCap(s)).toBe(BATCH_CAP_DEFAULT)
    }
  })

  it("relaxes to 5 for existing-large repos (wide edits more likely legitimate)", () => {
    expect(resolveBatchCap("existing-large")).toBe(BATCH_CAP_EXISTING_LARGE)
    expect(resolveBatchCap("existing-large")).toBe(5)
  })
})

describe("applyBatchCap — split behaviour", () => {
  it("returns the whole batch as executed when length <= cap", () => {
    const tools = [tc("a"), tc("b"), tc("c")]
    const out = applyBatchCap(tools, 3)
    expect(out.executed).toHaveLength(3)
    expect(out.deferred).toEqual([])
  })

  it("returns the whole batch when length is well under cap", () => {
    const tools = [tc("a")]
    const out = applyBatchCap(tools, 3)
    expect(out.executed).toEqual([{ id: "a", tool: "write_file", args: {} }])
    expect(out.deferred).toEqual([])
  })

  it("splits oversized batches into executed + deferred (user-repro: 11 tools)", () => {
    const tools = Array.from({ length: 11 }, (_, i) => tc(`t-${i}`))
    const out = applyBatchCap(tools, 3)
    expect(out.executed).toHaveLength(3)
    expect(out.deferred).toHaveLength(8)
    expect(out.executed[0].id).toBe("t-0")
    expect(out.executed[2].id).toBe("t-2")
    expect(out.deferred[0].id).toBe("t-3")
    expect(out.deferred[7].id).toBe("t-10")
  })

  it("preserves order — executed = head, deferred = tail", () => {
    const tools = [tc("first"), tc("second"), tc("third"), tc("fourth"), tc("fifth")]
    const out = applyBatchCap(tools, 2)
    expect(out.executed.map((t) => t.id)).toEqual(["first", "second"])
    expect(out.deferred.map((t) => t.id)).toEqual(["third", "fourth", "fifth"])
  })

  it("handles cap=0 by returning the whole batch as executed (defensive — no cap)", () => {
    const tools = [tc("a"), tc("b")]
    const out = applyBatchCap(tools, 0)
    expect(out.executed).toEqual(tools)
    expect(out.deferred).toEqual([])
  })

  it("handles negative cap by returning the whole batch as executed (defensive)", () => {
    const out = applyBatchCap([tc("a"), tc("b")], -1)
    expect(out.deferred).toEqual([])
  })

  it("handles empty batch", () => {
    const out = applyBatchCap([], 3)
    expect(out.executed).toEqual([])
    expect(out.deferred).toEqual([])
  })

  it("returns NEW arrays — caller can mutate executed/deferred without affecting input", () => {
    const tools = [tc("a"), tc("b"), tc("c")]
    const out = applyBatchCap(tools, 1)
    // Mutating output should not affect the original tools array.
    out.executed.push(tc("injected"))
    expect(tools).toHaveLength(3)
  })
})

describe("buildBatchCapDeferralResult — synthetic failure shape", () => {
  it("produces a success:false result tagged batch_cap_enforced", () => {
    const r = buildBatchCapDeferralResult("write_file", 11, 3)
    expect(r.success).toBe(false)
    expect(r._errorCategory).toBe("batch_cap_enforced")
    expect(r._deferred).toBe(true)
  })

  it("includes the deferred tool name + batch size + cap in the error message", () => {
    const r = buildBatchCapDeferralResult("edit_file", 8, 3)
    const msg = r.error as string
    expect(msg).toContain("8")
    expect(msg).toContain("3")
    expect(msg).toContain("edit_file")
  })

  it("instructs the agent to read executed results before re-issuing", () => {
    const r = buildBatchCapDeferralResult("write_file", 11, 3)
    const msg = (r.error as string).toLowerCase()
    expect(msg).toContain("read")
    expect(msg).toContain("re-emit")
  })

  it("JSON-serialises cleanly (wire-format contract)", () => {
    const r = buildBatchCapDeferralResult("write_file", 5, 3)
    const round = JSON.parse(JSON.stringify(r))
    expect(round.success).toBe(false)
    expect(round._deferred).toBe(true)
    expect(round._errorCategory).toBe("batch_cap_enforced")
  })
})

describe("end-to-end — user-reported 11-tool repro", () => {
  it("on a fresh scaffold (repoState=empty), 11 tools split as 3 executed + 8 deferred", () => {
    const cap = resolveBatchCap("empty")
    const tools = Array.from({ length: 11 }, (_, i) => tc(`tool-${i}`))
    const out = applyBatchCap(tools, cap)
    expect(cap).toBe(3)
    expect(out.executed).toHaveLength(3)
    expect(out.deferred).toHaveLength(8)
  })

  it("on existing-large, 11 tools split as 5 executed + 6 deferred (relaxed cap)", () => {
    const cap = resolveBatchCap("existing-large")
    const tools = Array.from({ length: 11 }, (_, i) => tc(`tool-${i}`))
    const out = applyBatchCap(tools, cap)
    expect(cap).toBe(5)
    expect(out.executed).toHaveLength(5)
    expect(out.deferred).toHaveLength(6)
  })

  it("3-tool batches pass through unchanged regardless of repoState", () => {
    const tools = [tc("a"), tc("b"), tc("c")]
    for (const state of ["empty", "small", "existing-large"] as RepoState[]) {
      const cap = resolveBatchCap(state)
      const out = applyBatchCap(tools, cap)
      expect(out.deferred).toEqual([])
    }
  })
})
