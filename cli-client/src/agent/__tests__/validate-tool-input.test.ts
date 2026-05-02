import { describe, it, expect } from "vitest"
import { validateToolInput } from "../validate-tool-input.js"

describe("validateToolInput", () => {
  it("accepts a valid read_file payload", () => {
    const r = validateToolInput("read_file", { path: "src/index.ts" })
    expect(r.ok).toBe(true)
  })

  it("rejects read_file with missing path", () => {
    const r = validateToolInput("read_file", {})
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.tool).toBe("read_file")
      expect(r.error.field).toBe("path")
      expect(r.error.expected).toMatch(/path: string/)
      expect(r.error.hint).toMatch(/INVALID ARGUMENTS for read_file/)
    }
  })

  it("rejects read_file with extra unknown fields (strict)", () => {
    const r = validateToolInput("read_file", { path: "x", garbage: 1 })
    expect(r.ok).toBe(false)
  })

  it("accepts edit_file in search/replace shape", () => {
    const r = validateToolInput("edit_file", { path: "x", search: "foo", replace: "bar" })
    expect(r.ok).toBe(true)
  })

  it("accepts edit_file in line-edit shape", () => {
    const r = validateToolInput("edit_file", { path: "x", line_start: 1, line_end: 2, content: "" })
    expect(r.ok).toBe(true)
  })

  it("accepts edit_file in insert shape", () => {
    const r = validateToolInput("edit_file", { path: "x", insert_at: 5, content: "y" })
    expect(r.ok).toBe(true)
  })

  it("accepts edit_file in patch shape", () => {
    const r = validateToolInput("edit_file", { path: "x", patch: "y" })
    expect(r.ok).toBe(true)
  })

  it("rejects edit_file with no edit fields", () => {
    const r = validateToolInput("edit_file", { path: "x" })
    expect(r.ok).toBe(false)
  })

  it("requires query OR glob on search_files", () => {
    expect(validateToolInput("search_files", {}).ok).toBe(false)
    expect(validateToolInput("search_files", { query: "abc" }).ok).toBe(true)
    expect(validateToolInput("search_files", { glob: "**/*.ts" }).ok).toBe(true)
  })

  it("requires non-empty paths array on batch_read", () => {
    expect(validateToolInput("batch_read", { paths: [] }).ok).toBe(false)
    expect(validateToolInput("batch_read", { paths: ["a"] }).ok).toBe(true)
  })

  it("flags unknown tool by name", () => {
    const r = validateToolInput("does_not_exist", {})
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.field).toBe("(tool)")
      expect(r.error.hint).toMatch(/has no schema/)
    }
  })
})
