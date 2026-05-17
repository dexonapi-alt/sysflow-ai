/**
 * Plan `2026-05-16-server-hardening-and-error-source-distinction.md` Stage 1.
 *
 * Tests for the persist-path null/empty tool guard. The cli's
 * `isKnownTool` validation should catch these before they reach the
 * server, but the server-side guard is belt-and-suspenders for any
 * direct API call / test / external integration that bypasses the cli.
 *
 * The guard logs a warning and returns early WITHOUT throwing — the
 * handler's outer flow continues; this just prevents the DB constraint
 * violation that would 500 the request.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

// Mock the db connection so saveToolResult doesn't actually try to insert.
vi.mock("../../db/connection.js", () => ({
  query: vi.fn().mockResolvedValue({ rows: [] }),
}))

import { saveToolResult } from "../tool-results.js"
import { query } from "../../db/connection.js"

describe("saveToolResult — null/empty tool guard (Stage 1)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("inserts when tool is a valid non-empty string", async () => {
    await saveToolResult("run-1", "read_file", { content: "hi", success: true })
    expect(query).toHaveBeenCalledTimes(1)
    const call = (query as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(call[1][0]).toBe("run-1")
    expect(call[1][1]).toBe("read_file")
  })

  it("refuses to insert when tool is empty string", async () => {
    await saveToolResult("run-2", "", { content: "hi", success: true })
    expect(query).not.toHaveBeenCalled()
  })

  it("refuses to insert when tool is null (defensive cast)", async () => {
    await saveToolResult("run-3", null as unknown as string, { content: "hi" })
    expect(query).not.toHaveBeenCalled()
  })

  it("refuses to insert when tool is undefined (defensive cast)", async () => {
    await saveToolResult("run-4", undefined as unknown as string, { content: "hi" })
    expect(query).not.toHaveBeenCalled()
  })

  it("refuses to insert when tool is a number (wrong type)", async () => {
    await saveToolResult("run-5", 42 as unknown as string, { content: "hi" })
    expect(query).not.toHaveBeenCalled()
  })

  it("returns void (no throw) on guard activation — handler flow continues", async () => {
    await expect(saveToolResult("run-6", "", { error: "x" })).resolves.toBeUndefined()
  })
})
