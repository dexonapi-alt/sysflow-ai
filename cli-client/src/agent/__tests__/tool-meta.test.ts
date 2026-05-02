import { describe, it, expect } from "vitest"
import { partitionToolCalls, batchHasSiblingAborter, getToolMeta } from "../tool-meta.js"

describe("partitionToolCalls", () => {
  it("puts read tools in parallel, run_command in serial", () => {
    const tools = [
      { id: "1", tool: "read_file", args: { path: "a" } },
      { id: "2", tool: "read_file", args: { path: "b" } },
      { id: "3", tool: "run_command", args: { command: "ls" } },
    ]
    const { parallel, serial } = partitionToolCalls(tools)
    expect(parallel.map((t) => t.id)).toEqual(["1", "2"])
    expect(serial.map((t) => t.id)).toEqual(["3"])
  })

  it("keeps move_file and delete_file in serial group", () => {
    const tools = [
      { id: "1", tool: "move_file", args: { from: "a", to: "b" } },
      { id: "2", tool: "delete_file", args: { path: "c" } },
    ]
    const { parallel, serial } = partitionToolCalls(tools)
    expect(parallel).toEqual([])
    expect(serial.map((t) => t.id)).toEqual(["1", "2"])
  })

  it("preserves order within each group", () => {
    const tools = [
      { id: "a", tool: "read_file", args: { path: "1" } },
      { id: "b", tool: "run_command", args: { command: "x" } },
      { id: "c", tool: "read_file", args: { path: "2" } },
      { id: "d", tool: "run_command", args: { command: "y" } },
    ]
    const { parallel, serial } = partitionToolCalls(tools)
    expect(parallel.map((t) => t.id)).toEqual(["a", "c"])
    expect(serial.map((t) => t.id)).toEqual(["b", "d"])
  })
})

describe("batchHasSiblingAborter", () => {
  it("is true when batch contains run_command", () => {
    expect(batchHasSiblingAborter([
      { id: "1", tool: "read_file", args: {} },
      { id: "2", tool: "run_command", args: {} },
    ])).toBe(true)
  })
  it("is false for read-only batches", () => {
    expect(batchHasSiblingAborter([
      { id: "1", tool: "read_file", args: {} },
      { id: "2", tool: "search_code", args: {} },
    ])).toBe(false)
  })
})

describe("getToolMeta", () => {
  it("read tools default to allow", () => {
    expect(getToolMeta("read_file").defaultPermission).toBe("allow")
    expect(getToolMeta("list_directory").defaultPermission).toBe("allow")
  })
  it("write tools default to ask", () => {
    expect(getToolMeta("write_file").defaultPermission).toBe("ask")
    expect(getToolMeta("delete_file").defaultPermission).toBe("ask")
  })
  it("unknown tool falls back to safe defaults", () => {
    const m = getToolMeta("nonexistent")
    expect(m.isConcurrencySafe).toBe(false)
    expect(m.defaultPermission).toBe("ask")
  })
})
