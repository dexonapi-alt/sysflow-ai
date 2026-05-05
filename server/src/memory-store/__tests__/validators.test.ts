import { describe, it, expect, beforeEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { validateFileRefs, validateDepRefs, validateAge, runAllValidators } from "../validators.js"
import { makeEntry } from "../entry-schema.js"

async function tempCwdWithFiles(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sysflow-val-"))
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel)
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, content, "utf8")
  }
  return dir
}

describe("validateFileRefs", () => {
  it("no refs → no reasons", async () => {
    const dir = await tempCwdWithFiles({})
    const e = makeEntry({ kind: "decision", content: "x" })
    expect(validateFileRefs(e, dir)).toEqual([])
  })

  it("existing file → no reasons", async () => {
    const dir = await tempCwdWithFiles({ "src/foo.ts": "ok" })
    const e = makeEntry({ kind: "decision", content: "x", sourceRef: { filePaths: ["src/foo.ts"] } })
    expect(validateFileRefs(e, dir)).toEqual([])
  })

  it("missing file → one reason", async () => {
    const dir = await tempCwdWithFiles({})
    const e = makeEntry({ kind: "decision", content: "x", sourceRef: { filePaths: ["src/missing.ts"] } })
    const reasons = validateFileRefs(e, dir)
    expect(reasons.length).toBe(1)
    expect(reasons[0]).toMatch(/file-ref missing/)
  })
})

describe("validateDepRefs", () => {
  it("no package.json → no reasons (don't penalise non-Node projects)", async () => {
    const dir = await tempCwdWithFiles({})
    const e = makeEntry({ kind: "decision", content: "x", sourceRef: { packageDeps: ["drizzle-orm"] } })
    expect(validateDepRefs(e, dir)).toEqual([])
  })

  it("dep present in dependencies → no reasons", async () => {
    const dir = await tempCwdWithFiles({
      "package.json": JSON.stringify({ dependencies: { "drizzle-orm": "^1.0.0" } }),
    })
    const e = makeEntry({ kind: "decision", content: "x", sourceRef: { packageDeps: ["drizzle-orm"] } })
    expect(validateDepRefs(e, dir)).toEqual([])
  })

  it("dep present in devDependencies → no reasons", async () => {
    const dir = await tempCwdWithFiles({
      "package.json": JSON.stringify({ devDependencies: { vitest: "^2" } }),
    })
    const e = makeEntry({ kind: "decision", content: "x", sourceRef: { packageDeps: ["vitest"] } })
    expect(validateDepRefs(e, dir)).toEqual([])
  })

  it("dep missing entirely → one reason", async () => {
    const dir = await tempCwdWithFiles({
      "package.json": JSON.stringify({ dependencies: { fastify: "^5" } }),
    })
    const e = makeEntry({ kind: "decision", content: "x", sourceRef: { packageDeps: ["drizzle-orm"] } })
    const reasons = validateDepRefs(e, dir)
    expect(reasons.length).toBe(1)
    expect(reasons[0]).toMatch(/dep-ref missing/)
  })
})

describe("validateAge", () => {
  const nowMs = 1_700_000_000_000
  const dayMs = 86_400_000

  it("recent entry → no reasons", () => {
    const e = makeEntry({ kind: "decision", content: "x" }, nowMs - 1 * dayMs)
    expect(validateAge(e, { cwd: "", nowMs }).length).toBe(0)
  })

  it("entry older than 60 days with low useCount → stale", () => {
    const e = makeEntry({ kind: "decision", content: "x" }, nowMs - 70 * dayMs)
    expect(validateAge(e, { cwd: "", nowMs }).length).toBe(1)
  })

  it("high-use entry (useCount ≥ 5) gets the 180-day leash", () => {
    const e = { ...makeEntry({ kind: "decision", content: "x" }, nowMs - 100 * dayMs), useCount: 8 }
    expect(validateAge(e, { cwd: "", nowMs }).length).toBe(0)
  })

  it("high-use entry past the 180-day leash → still stale", () => {
    const e = { ...makeEntry({ kind: "decision", content: "x" }, nowMs - 200 * dayMs), useCount: 8 }
    expect(validateAge(e, { cwd: "", nowMs }).length).toBe(1)
  })
})

describe("runAllValidators partition", () => {
  let dir: string
  beforeEach(async () => {
    dir = await tempCwdWithFiles({
      "package.json": JSON.stringify({ dependencies: { "drizzle-orm": "^1" } }),
      "src/keep.ts": "ok",
    })
  })

  it("partitions active vs stale vs contradicted", () => {
    const active = makeEntry({ kind: "decision", content: "use Drizzle", sourceRef: { filePaths: ["src/keep.ts"], packageDeps: ["drizzle-orm"] } })
    const fileGone = makeEntry({ kind: "decision", content: "old fact", sourceRef: { filePaths: ["src/missing.ts"] } })
    const oldEntry = { ...makeEntry({ kind: "decision", content: "ancient", sourceRef: {} }, Date.now() - 200 * 86_400_000), useCount: 1 }
    const contradicted = { ...makeEntry({ kind: "decision", content: "wrong" }), status: "contradicted" as const, contradictionCount: 2 }
    const r = runAllValidators([active, fileGone, oldEntry, contradicted], { cwd: dir })
    expect(r.active.length).toBe(1)
    expect(r.active[0].id).toBe(active.id)
    expect(r.stale.length).toBe(2)
    expect(r.contradicted.length).toBe(1)
    // Stale entries carry their reasons.
    const fileGoneOut = r.stale.find((e) => e.id === fileGone.id)
    expect(fileGoneOut?.staleReasons?.[0]).toMatch(/file-ref missing/)
  })

  it("a previously-stale entry stays in the stale bucket on re-validation (status wins even if reasons clear)", () => {
    const wasStale = { ...makeEntry({ kind: "decision", content: "x" }), status: "stale" as const }
    const r = runAllValidators([wasStale], { cwd: dir })
    expect(r.stale.length).toBe(1)
  })

  it("contradicted entries never re-enter active even if all refs are valid", () => {
    const c = { ...makeEntry({ kind: "decision", content: "x" }), status: "contradicted" as const, contradictionCount: 3 }
    const r = runAllValidators([c], { cwd: dir })
    expect(r.active.length).toBe(0)
    expect(r.contradicted.length).toBe(1)
  })
})
