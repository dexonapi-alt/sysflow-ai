/**
 * Plan `2026-05-16-agent-code-correctness-and-completion-artifacts.md` Stage 2.
 *
 * Tests for the import-sanitizer loud-feedback helpers. The cli's
 * `sanitizeImports` surfaces `_strippedImports` on each tool result
 * when imports were stripped; `collectStrippedImports` aggregates
 * them across a batch and `buildImportStrippedInject` renders the
 * `═══ IMPORTS STRIPPED ═══` block that the handler injects via
 * `actionPlanner.injectContext`.
 */

import { describe, it, expect } from "vitest"
import { collectStrippedImports, buildImportStrippedInject, type StrippedFileEntry } from "../import-stripped-inject.js"

describe("collectStrippedImports", () => {
  it("returns empty list when no result has _strippedImports", () => {
    const out = collectStrippedImports([
      { tool: "write_file", result: { path: "src/x.ts", success: true } },
      { tool: "edit_file", result: { path: "src/y.ts", success: true } },
    ])
    expect(out).toEqual([])
  })

  it("collects strips from a single write_file result", () => {
    const out = collectStrippedImports([
      {
        tool: "write_file",
        result: {
          path: "src/index.ts",
          success: true,
          _strippedImports: ["./routes/auth", "./middleware/errorHandler"],
        },
      },
    ])
    expect(out).toEqual([
      { path: "src/index.ts", imports: ["./routes/auth", "./middleware/errorHandler"] },
    ])
  })

  it("collects from multiple files in a batch", () => {
    const out = collectStrippedImports([
      { tool: "write_file", result: { path: "a.ts", _strippedImports: ["./x"] } },
      { tool: "write_file", result: { path: "b.ts", _strippedImports: ["./y", "./z"] } },
      { tool: "write_file", result: { path: "c.ts", success: true } },  // no strips
    ])
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual({ path: "a.ts", imports: ["./x"] })
    expect(out[1]).toEqual({ path: "b.ts", imports: ["./y", "./z"] })
  })

  it("filters out non-string entries from _strippedImports (defensive)", () => {
    const out = collectStrippedImports([
      {
        tool: "write_file",
        result: { path: "a.ts", _strippedImports: ["./x", null, 42, "./y", ""] as unknown[] },
      },
    ])
    expect(out[0].imports).toEqual(["./x", "./y"])
  })

  it("skips results where _strippedImports is present but empty", () => {
    const out = collectStrippedImports([
      { tool: "write_file", result: { path: "a.ts", _strippedImports: [] } },
    ])
    expect(out).toEqual([])
  })

  it("falls back to '(unknown path)' when path is missing", () => {
    const out = collectStrippedImports([
      { tool: "write_file", result: { _strippedImports: ["./x"] } },
    ])
    expect(out[0].path).toBe("(unknown path)")
  })

  it("ignores non-array _strippedImports values (defensive)", () => {
    const out = collectStrippedImports([
      { tool: "write_file", result: { path: "a.ts", _strippedImports: "./x" as unknown as string[] } },
    ])
    expect(out).toEqual([])
  })

  it("tolerates undefined / null result objects defensively", () => {
    const out = collectStrippedImports([
      { tool: "write_file", result: {} as Record<string, unknown> },
    ])
    expect(out).toEqual([])
  })
})

describe("buildImportStrippedInject", () => {
  it("returns empty string when no strips (caller should skip injecting)", () => {
    expect(buildImportStrippedInject([])).toBe("")
  })

  it("renders the canonical header + footer markers", () => {
    const out = buildImportStrippedInject([
      { path: "src/index.ts", imports: ["./routes/auth"] },
    ])
    expect(out).toContain("═══ IMPORTS STRIPPED — YOU REFERENCED FILES THAT DON'T EXIST ═══")
    expect(out).toContain("═══ END IMPORTS STRIPPED ═══")
  })

  it("uses singular 'the file' for one file, plural for many", () => {
    const single = buildImportStrippedInject([{ path: "a.ts", imports: ["./x"] }])
    expect(single).toContain("In the file you just wrote")

    const multi = buildImportStrippedInject([
      { path: "a.ts", imports: ["./x"] },
      { path: "b.ts", imports: ["./y"] },
    ])
    expect(multi).toContain("In 2 files you just wrote")
  })

  it("uses singular 'import' for one strip, plural for many", () => {
    const one = buildImportStrippedInject([{ path: "a.ts", imports: ["./x"] }])
    expect(one).toContain("1 import referenced")

    const three = buildImportStrippedInject([{ path: "a.ts", imports: ["./x", "./y", "./z"] }])
    expect(three).toContain("3 imports referenced")
  })

  it("lists each file with its stripped imports indented", () => {
    const out = buildImportStrippedInject([
      { path: "src/index.ts", imports: ["./routes/auth", "./middleware/errorHandler"] },
    ])
    expect(out).toContain("src/index.ts:")
    expect(out).toContain(`    - "./routes/auth" (file does not exist)`)
    expect(out).toContain(`    - "./middleware/errorHandler" (file does not exist)`)
  })

  it("caps per-file list at 8 imports with '... and N more' tail", () => {
    const imports = Array.from({ length: 12 }, (_, i) => `./mod${i}`)
    const out = buildImportStrippedInject([{ path: "src/big.ts", imports }])
    // First 8 should appear
    expect(out).toContain(`"./mod0"`)
    expect(out).toContain(`"./mod7"`)
    // 9th should NOT appear in the bullet list
    expect(out).not.toContain(`"./mod8"`)
    // Tail should mention the rest
    expect(out).toContain("… and 4 more")
  })

  it("includes the 'REQUIRED for your next turn' recovery instructions", () => {
    const out = buildImportStrippedInject([{ path: "a.ts", imports: ["./x"] }])
    expect(out).toContain("REQUIRED for your next turn")
    expect(out).toContain("CREATE the missing files")
    expect(out).toContain("remove the usages")
    expect(out).toContain("Do NOT proceed past this")
  })
})
