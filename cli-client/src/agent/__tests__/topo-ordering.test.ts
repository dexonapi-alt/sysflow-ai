/**
 * Stage 2 of `2026-05-16-accountability-and-parallel-execution-sequencing.md`.
 *
 * Pure tests for producer-before-consumer topological ordering of
 * write_file calls within a single batch. Closes the bug where
 * `src/index.ts` (consumer) wrote in the same parallel batch as
 * `src/routes/auth.ts` (producer); the import-sanitizer saw the
 * unresolved reference and silently stripped it.
 */

import { describe, it, expect } from "vitest"
import {
  extractRelativeImports,
  resolveRelativeImport,
  findBatchMatchForImport,
  topoOrderParallelWrites,
  buildImportCycleResult,
  type ToolCallEntry,
} from "../tool-meta.js"

function writeTool(id: string, path: string, content: string): ToolCallEntry {
  return { id, tool: "write_file", args: { path, content } }
}

function nonWriteTool(id: string, tool: string, args: Record<string, unknown> = {}): ToolCallEntry {
  return { id, tool, args }
}

describe("extractRelativeImports — regex parser", () => {
  it("extracts a default import", () => {
    expect(extractRelativeImports(`import App from "./App"`)).toEqual(["./App"])
  })

  it("extracts named imports + namespace imports", () => {
    const src = `import { auth, db } from "./lib"\nimport * as utils from "../utils"\n`
    expect(extractRelativeImports(src)).toEqual(["./lib", "../utils"])
  })

  it("extracts side-effect imports", () => {
    expect(extractRelativeImports(`import "./styles.css"`)).toEqual(["./styles.css"])
  })

  it("extracts re-exports (export ... from)", () => {
    expect(extractRelativeImports(`export { foo } from "./foo"\nexport * from "../bar"\n`)).toEqual(["./foo", "../bar"])
  })

  it("ignores non-relative imports (packages, scoped, absolute)", () => {
    const src = `import react from "react"\nimport { x } from "@scope/pkg"\nimport y from "node:fs"\n`
    expect(extractRelativeImports(src)).toEqual([])
  })

  it("returns empty array for empty / undefined content", () => {
    expect(extractRelativeImports("")).toEqual([])
  })

  it("handles single + double quotes", () => {
    expect(extractRelativeImports(`import x from './x'\nimport y from "./y"`)).toEqual(["./x", "./y"])
  })

  it("does NOT mis-match dynamic import() calls (conservative)", () => {
    // Dynamic imports COULD be detected but the regex is anchored on
    // the static-import / export-from forms; dynamic imports skip.
    expect(extractRelativeImports(`const m = await import("./dyn")`)).toEqual([])
  })
})

describe("resolveRelativeImport — path resolution", () => {
  it("resolves a sibling import via ./", () => {
    expect(resolveRelativeImport("src/index.ts", "./App")).toBe("src/App")
  })

  it("resolves a nested import", () => {
    expect(resolveRelativeImport("src/index.ts", "./routes/auth")).toBe("src/routes/auth")
  })

  it("resolves a parent-directory import via ../", () => {
    expect(resolveRelativeImport("src/lib/db.ts", "../config")).toBe("src/config")
  })

  it("resolves multi-level ../", () => {
    expect(resolveRelativeImport("src/lib/inner/x.ts", "../../config")).toBe("src/config")
  })

  it("collapses ./././ sequences cleanly", () => {
    expect(resolveRelativeImport("src/x.ts", "././y")).toBe("src/y")
  })

  it("handles a top-level file (no parent dir)", () => {
    expect(resolveRelativeImport("index.ts", "./config")).toBe("config")
  })
})

describe("findBatchMatchForImport — extension expansion", () => {
  it("matches an exact path (no expansion needed)", () => {
    expect(findBatchMatchForImport("src/x.ts", ["src/x.ts"])).toBe("src/x.ts")
  })

  it("expands to .ts when the import is extensionless", () => {
    expect(findBatchMatchForImport("src/x", ["src/x.ts"])).toBe("src/x.ts")
  })

  it("tries .tsx / .js / .jsx / .mjs / .cjs in order", () => {
    expect(findBatchMatchForImport("src/x", ["src/x.tsx"])).toBe("src/x.tsx")
    expect(findBatchMatchForImport("src/x", ["src/x.js"])).toBe("src/x.js")
    expect(findBatchMatchForImport("src/x", ["src/x.jsx"])).toBe("src/x.jsx")
    expect(findBatchMatchForImport("src/x", ["src/x.mjs"])).toBe("src/x.mjs")
    expect(findBatchMatchForImport("src/x", ["src/x.cjs"])).toBe("src/x.cjs")
  })

  it("falls back to directory /index.ext", () => {
    expect(findBatchMatchForImport("src/routes", ["src/routes/index.ts"])).toBe("src/routes/index.ts")
  })

  it("prefers exact > extension > index", () => {
    // Exact wins when present.
    expect(findBatchMatchForImport("src/x.ts", ["src/x.ts", "src/x.tsx"])).toBe("src/x.ts")
  })

  it("returns null when no candidate matches", () => {
    expect(findBatchMatchForImport("src/missing", ["src/other.ts"])).toBeNull()
  })
})

describe("topoOrderParallelWrites — no edges", () => {
  it("does NOT reorder when there are no relative imports", () => {
    const tools = [
      writeTool("a", "src/a.ts", `export const a = 1`),
      writeTool("b", "src/b.ts", `export const b = 2`),
    ]
    const out = topoOrderParallelWrites(tools)
    expect(out.reordered).toBe(false)
    expect(out.cycle).toBeNull()
    // Default grouping: one group per write (parallel).
    expect(out.groups.length).toBe(2)
  })

  it("does not reorder when imports don't match any batch sibling", () => {
    const tools = [
      writeTool("a", "src/a.ts", `import react from "react"\nexport const a = 1`),
      writeTool("b", "src/b.ts", `import { c } from "./missing"`),
    ]
    const out = topoOrderParallelWrites(tools)
    expect(out.reordered).toBe(false)
    expect(out.cycle).toBeNull()
  })

  it("returns groupForParallelExecution layout for non-write tools", () => {
    const tools = [
      nonWriteTool("d1", "create_directory", { path: "src" }),
      nonWriteTool("d2", "create_directory", { path: "src/routes" }),
    ]
    const out = topoOrderParallelWrites(tools)
    expect(out.reordered).toBe(false)
    // Two groups (each create_directory in its own group).
    expect(out.groups.length).toBe(2)
  })

  it("returns the original layout when only one write is in the batch", () => {
    const tools = [
      writeTool("a", "src/a.ts", `import "./b"`),
      nonWriteTool("d1", "create_directory", { path: "src" }),
    ]
    const out = topoOrderParallelWrites(tools)
    expect(out.reordered).toBe(false)
  })
})

describe("topoOrderParallelWrites — has edges (the load-bearing case)", () => {
  it("collapses producer + consumer into one serial group, producer first (user-repro)", () => {
    const tools = [
      writeTool("idx", "src/index.ts", `import { auth } from "./routes/auth"\nexport default auth`),
      writeTool("auth", "src/routes/auth.ts", `export const auth = "x"`),
    ]
    const out = topoOrderParallelWrites(tools)
    expect(out.reordered).toBe(true)
    expect(out.cycle).toBeNull()
    // Find the serial group containing the writes.
    const writeGroup = out.groups.find((g) => g.length > 1)
    expect(writeGroup).toBeDefined()
    expect(writeGroup!.map((tc) => tc.id)).toEqual(["auth", "idx"])
  })

  it("orders a linear chain A → B → C with A first", () => {
    const tools = [
      writeTool("a", "src/a.ts", `import { b } from "./b"`),
      writeTool("b", "src/b.ts", `import { c } from "./c"`),
      writeTool("c", "src/c.ts", `export const c = 1`),
    ]
    const out = topoOrderParallelWrites(tools)
    expect(out.reordered).toBe(true)
    const writeGroup = out.groups.find((g) => g.length === 3)
    expect(writeGroup).toBeDefined()
    expect(writeGroup!.map((tc) => tc.id)).toEqual(["c", "b", "a"])
  })

  it("handles a diamond dependency (A imports B + C; D imports A)", () => {
    const tools = [
      writeTool("a", "src/a.ts", `import "./b"\nimport "./c"`),
      writeTool("b", "src/b.ts", `export const b = 1`),
      writeTool("c", "src/c.ts", `export const c = 1`),
      writeTool("d", "src/d.ts", `import "./a"`),
    ]
    const out = topoOrderParallelWrites(tools)
    expect(out.reordered).toBe(true)
    const writeGroup = out.groups.find((g) => g.length === 4)!
    const order = writeGroup.map((tc) => tc.id)
    // B and C come before A; A comes before D.
    expect(order.indexOf("b")).toBeLessThan(order.indexOf("a"))
    expect(order.indexOf("c")).toBeLessThan(order.indexOf("a"))
    expect(order.indexOf("a")).toBeLessThan(order.indexOf("d"))
  })

  it("keeps non-write tools (create_directory) in their own parallel groups", () => {
    const tools = [
      nonWriteTool("dir", "create_directory", { path: "src" }),
      writeTool("a", "src/a.ts", `import "./b"`),
      writeTool("b", "src/b.ts", `export const b = 1`),
    ]
    const out = topoOrderParallelWrites(tools)
    expect(out.reordered).toBe(true)
    // 2 groups: [create_directory], [b, a].
    expect(out.groups.length).toBe(2)
    const dirGroup = out.groups.find((g) => g[0].tool === "create_directory")
    expect(dirGroup).toBeDefined()
    expect(dirGroup!.length).toBe(1)
  })
})

describe("topoOrderParallelWrites — cycle detection", () => {
  it("detects a 2-node cycle (A ↔ B)", () => {
    const tools = [
      writeTool("a", "src/a.ts", `import "./b"`),
      writeTool("b", "src/b.ts", `import "./a"`),
    ]
    const out = topoOrderParallelWrites(tools)
    expect(out.cycle).not.toBeNull()
    expect(out.cycle!.length).toBeGreaterThan(0)
    expect(out.cycle!.some((p) => p === "src/a.ts" || p === "src/b.ts")).toBe(true)
  })

  it("EXCLUDES cycle members from returned groups (executor synthesises failures separately)", () => {
    const tools = [
      writeTool("a", "src/a.ts", `import "./b"`),
      writeTool("b", "src/b.ts", `import "./a"`),
      writeTool("c", "src/c.ts", `export const c = 1`),
    ]
    const out = topoOrderParallelWrites(tools)
    expect(out.cycle).not.toBeNull()
    // c should still be in the groups; a + b should not.
    const remaining = out.groups.flat().map((tc) => tc.args.path as string)
    expect(remaining).toContain("src/c.ts")
    expect(remaining).not.toContain("src/a.ts")
    expect(remaining).not.toContain("src/b.ts")
  })

  it("detects a 3-node cycle (A → B → C → A)", () => {
    const tools = [
      writeTool("a", "src/a.ts", `import "./b"`),
      writeTool("b", "src/b.ts", `import "./c"`),
      writeTool("c", "src/c.ts", `import "./a"`),
    ]
    const out = topoOrderParallelWrites(tools)
    expect(out.cycle).not.toBeNull()
  })
})

describe("buildImportCycleResult — synthetic failure shape", () => {
  it("returns success:false + _errorCategory:'import_cycle' + path + cycle list", () => {
    const r = buildImportCycleResult("src/a.ts", ["src/a.ts", "src/b.ts", "src/a.ts"])
    expect(r.success).toBe(false)
    expect(r._errorCategory).toBe("import_cycle")
    expect(r.path).toBe("src/a.ts")
    expect(Array.isArray(r.cycle)).toBe(true)
  })

  it("includes the cycle nodes in the error message", () => {
    const r = buildImportCycleResult("src/a.ts", ["src/a.ts", "src/b.ts", "src/a.ts"])
    const msg = r.error as string
    expect(msg).toContain("src/a.ts")
    expect(msg).toContain("src/b.ts")
  })

  it("instructs the agent on how to break the cycle", () => {
    const msg = (buildImportCycleResult("src/a.ts", ["src/a.ts", "src/b.ts"]).error as string).toLowerCase()
    expect(msg).toContain("break the cycle")
  })

  it("JSON-serialises cleanly", () => {
    const r = buildImportCycleResult("src/a.ts", ["src/a.ts", "src/b.ts"])
    const round = JSON.parse(JSON.stringify(r))
    expect(round.success).toBe(false)
    expect(round._errorCategory).toBe("import_cycle")
  })
})
