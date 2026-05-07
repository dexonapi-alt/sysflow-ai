import { describe, it, expect } from "vitest"
import { verbFor, formatActionHeader, truncateTarget } from "../ActionCard.js"

describe("verbFor", () => {
  it("maps the documented tool set to Claude-style verbs", () => {
    const cases: Array<[string, string]> = [
      ["run_command", "Bash"],
      ["write_file", "Write"],
      ["edit_file", "Update"],
      ["read_file", "Read"],
      ["batch_read", "Read"],
      ["batch_write", "Write"],
      ["search_files", "Search"],
      ["search_code", "Search"],
      ["list_directory", "List"],
      ["create_directory", "Mkdir"],
      ["delete_file", "Delete"],
      ["move_file", "Move"],
      ["file_exists", "Check"],
      ["web_search", "WebSearch"],
      ["reason", "Reason"],
    ]
    for (const [tool, expected] of cases) {
      expect(verbFor(tool)).toBe(expected)
    }
  })

  it("capitalises unknown tools as a safe fallback", () => {
    expect(verbFor("custom_thing")).toBe("Custom_thing")
    expect(verbFor("ping")).toBe("Ping")
  })

  it("returns 'Tool' for empty / missing tool name", () => {
    expect(verbFor("")).toBe("Tool")
  })
})

describe("formatActionHeader", () => {
  it("renders Bash(<command>) for run_command", () => {
    expect(formatActionHeader("run_command", { command: "git status" })).toBe("Bash(git status)")
  })

  it("renders Write(<path>) for write_file using args.path", () => {
    expect(formatActionHeader("write_file", { path: "src/index.ts" })).toBe("Write(src/index.ts)")
  })

  it("renders Update(<path>) for edit_file", () => {
    expect(formatActionHeader("edit_file", { path: "src/app.ts" })).toBe("Update(src/app.ts)")
  })

  it("renders Read(<path>) for read_file falling back through path / file_path / filePath", () => {
    expect(formatActionHeader("read_file", { path: "a.ts" })).toBe("Read(a.ts)")
    expect(formatActionHeader("read_file", { file_path: "b.ts" })).toBe("Read(b.ts)")
    expect(formatActionHeader("read_file", { filePath: "c.ts" })).toBe("Read(c.ts)")
  })

  it("renders Move(<from> → <to>) for move_file", () => {
    expect(formatActionHeader("move_file", { from: "old.ts", to: "new.ts" })).toBe("Move(old.ts → new.ts)")
  })

  it("renders Search(<pattern>) for search_code", () => {
    expect(formatActionHeader("search_code", { pattern: "TODO" })).toBe("Search(TODO)")
  })

  it("renders Search(<query>) for search_files preferring query over glob", () => {
    expect(formatActionHeader("search_files", { query: "config" })).toBe("Search(config)")
    expect(formatActionHeader("search_files", { glob: "**/*.ts" })).toBe("Search(**/*.ts)")
    // query wins when both are present.
    expect(formatActionHeader("search_files", { query: "x", glob: "y" })).toBe("Search(x)")
  })

  it("renders Mkdir(<path>) for create_directory", () => {
    expect(formatActionHeader("create_directory", { path: "src/new" })).toBe("Mkdir(src/new)")
  })

  it("renders Write(<n> files) for batch_write with multiple files", () => {
    expect(formatActionHeader("batch_write", { files: [{ path: "a" }, { path: "b" }, { path: "c" }] })).toBe("Write(3 files)")
  })

  it("renders Write(<single path>) for batch_write with one file", () => {
    expect(formatActionHeader("batch_write", { files: [{ path: "only.ts" }] })).toBe("Write(only.ts)")
  })

  it("returns just the verb when target can't be extracted", () => {
    // No usable args → fall through to verb-only header.
    expect(formatActionHeader("run_command", {})).toBe("Bash")
    expect(formatActionHeader("read_file", {})).toBe("Read")
  })

  it("returns just the verb when args are missing entirely", () => {
    expect(formatActionHeader("read_file", undefined)).toBe("Read")
  })

  it("truncates long targets with an ellipsis", () => {
    const longCmd = "git log --oneline " + "x".repeat(200)
    const out = formatActionHeader("run_command", { command: longCmd })
    expect(out.length).toBeLessThan(longCmd.length + "Bash()".length)
    expect(out.endsWith("…)")).toBe(true)
  })
})

describe("truncateTarget", () => {
  it("returns the input unchanged when under the cap", () => {
    expect(truncateTarget("short", 80)).toBe("short")
  })

  it("ellipsis-caps strings over the limit", () => {
    expect(truncateTarget("x".repeat(100), 10)).toBe("xxxxxxxxx" + "…")
  })

  it("uses the default cap when no max supplied", () => {
    const big = "y".repeat(200)
    const out = truncateTarget(big)
    expect(out.length).toBeLessThan(big.length)
    expect(out.endsWith("…")).toBe(true)
  })

  it("returns empty string for non-string defensive input", () => {
    // @ts-expect-error — intentional bad payload to assert the runtime guard
    expect(truncateTarget(null)).toBe("")
    // @ts-expect-error — same
    expect(truncateTarget(undefined)).toBe("")
  })
})
