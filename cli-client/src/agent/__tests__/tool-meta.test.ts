import { describe, it, expect } from "vitest"
import { partitionToolCalls, batchHasSiblingAborter, getToolMeta, groupForParallelExecution } from "../tool-meta.js"

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

describe("groupForParallelExecution", () => {
  it("two edits to the same file are grouped together (will run serially)", () => {
    const groups = groupForParallelExecution([
      { id: "1", tool: "edit_file", args: { path: "src/a.ts", search: "x", replace: "y" } },
      { id: "2", tool: "edit_file", args: { path: "src/a.ts", search: "p", replace: "q" } },
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].map((t) => t.id)).toEqual(["1", "2"])
  })

  it("edits to different files end up in separate groups (will run in parallel)", () => {
    const groups = groupForParallelExecution([
      { id: "1", tool: "edit_file", args: { path: "src/a.ts" } },
      { id: "2", tool: "edit_file", args: { path: "src/b.ts" } },
    ])
    expect(groups).toHaveLength(2)
  })

  it("write_file and edit_file to the same path collapse into one group", () => {
    const groups = groupForParallelExecution([
      { id: "1", tool: "write_file", args: { path: "src/a.ts", content: "..." } },
      { id: "2", tool: "edit_file", args: { path: "src/a.ts", search: "x", replace: "y" } },
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].map((t) => t.id)).toEqual(["1", "2"])
  })

  it("read_file calls don't get path-grouped (still parallel)", () => {
    const groups = groupForParallelExecution([
      { id: "1", tool: "read_file", args: { path: "a" } },
      { id: "2", tool: "read_file", args: { path: "a" } },
    ])
    expect(groups).toHaveLength(2)
  })

  it("mixed batch: same-path edits grouped, others standalone", () => {
    const groups = groupForParallelExecution([
      { id: "1", tool: "read_file", args: { path: "x" } },
      { id: "2", tool: "edit_file", args: { path: "src/a.ts" } },
      { id: "3", tool: "edit_file", args: { path: "src/b.ts" } },
      { id: "4", tool: "edit_file", args: { path: "src/a.ts" } },
    ])
    // 1 read (standalone), 2+4 grouped (a.ts), 3 standalone (b.ts)
    const groupSizes = groups.map((g) => g.length).sort()
    expect(groupSizes).toEqual([1, 1, 2])
    const sameFileGroup = groups.find((g) => g.length === 2)!
    expect(sameFileGroup.map((t) => t.id)).toEqual(["2", "4"])
  })
})

describe("getToolMeta", () => {
  it("read tools default to allow", () => {
    expect(getToolMeta("read_file").defaultPermission).toBe("allow")
    expect(getToolMeta("list_directory").defaultPermission).toBe("allow")
  })
  it("authoring tools default to allow (write/edit/mkdir)", () => {
    expect(getToolMeta("write_file").defaultPermission).toBe("allow")
    expect(getToolMeta("edit_file").defaultPermission).toBe("allow")
    expect(getToolMeta("create_directory").defaultPermission).toBe("allow")
  })
  it("destructive + shell tools still default to ask", () => {
    expect(getToolMeta("delete_file").defaultPermission).toBe("ask")
    expect(getToolMeta("move_file").defaultPermission).toBe("ask")
    expect(getToolMeta("run_command").defaultPermission).toBe("ask")
  })
  it("unknown tool falls back to safe defaults", () => {
    const m = getToolMeta("nonexistent")
    expect(m.isConcurrencySafe).toBe(false)
    expect(m.defaultPermission).toBe("ask")
  })
})
