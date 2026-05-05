import { describe, it, expect, beforeEach } from "vitest"
import fs from "node:fs/promises"
import { loadMemoryEntries, saveMemoryEntries, upsertEntry, deleteEntry, memoryPathFor, _resetCache, _setupTempCwd } from "../store.js"
import { makeEntry } from "../entry-schema.js"

describe("memory-store store", () => {
  let cwd: string

  beforeEach(async () => {
    cwd = await _setupTempCwd()
    _resetCache()
  })

  it("load returns empty array when no file exists", async () => {
    const entries = await loadMemoryEntries(cwd)
    expect(entries).toEqual([])
  })

  it("save then load roundtrips", async () => {
    const e = makeEntry({ kind: "decision", content: "use Drizzle" })
    await saveMemoryEntries(cwd, [e])
    _resetCache()
    const loaded = await loadMemoryEntries(cwd)
    expect(loaded.length).toBe(1)
    expect(loaded[0].id).toBe(e.id)
    expect(loaded[0].content).toBe("use Drizzle")
  })

  it("upsertEntry inserts a new entry", async () => {
    const r = await upsertEntry(cwd, { kind: "decision", content: "use Drizzle" })
    expect(r.useCount).toBe(0)
    const loaded = await loadMemoryEntries(cwd)
    expect(loaded.length).toBe(1)
    expect(loaded[0].id).toBe(r.id)
  })

  it("upsertEntry on the same content dedupes by id and bumps useCount", async () => {
    const r1 = await upsertEntry(cwd, { kind: "decision", content: "use Drizzle" })
    expect(r1.useCount).toBe(0)
    const r2 = await upsertEntry(cwd, { kind: "decision", content: "use Drizzle" })
    expect(r2.id).toBe(r1.id)
    expect(r2.useCount).toBe(1)
    const loaded = await loadMemoryEntries(cwd)
    expect(loaded.length).toBe(1)
  })

  it("user_correction re-record revives a contradicted entry", async () => {
    const r1 = await upsertEntry(cwd, { kind: "user_correction", content: "we use Bun" })
    // Simulate contradiction.
    const corrupted = { ...r1, status: "contradicted" as const, contradictionCount: 2 }
    await saveMemoryEntries(cwd, [corrupted])
    _resetCache()
    const r2 = await upsertEntry(cwd, { kind: "user_correction", content: "we use Bun" })
    expect(r2.status).toBe("active")
  })

  it("deleteEntry removes by id and returns true", async () => {
    const r = await upsertEntry(cwd, { kind: "decision", content: "x" })
    const ok = await deleteEntry(cwd, r.id)
    expect(ok).toBe(true)
    const loaded = await loadMemoryEntries(cwd)
    expect(loaded.length).toBe(0)
  })

  it("deleteEntry returns false when id is unknown", async () => {
    const ok = await deleteEntry(cwd, "doesnotexist")
    expect(ok).toBe(false)
  })

  it("mtime cache: reading the same file twice without external mod returns cached", async () => {
    const e = makeEntry({ kind: "decision", content: "cached" })
    await saveMemoryEntries(cwd, [e])
    const a = await loadMemoryEntries(cwd)
    // External mod NOT performed; expect the second load to come from the cache.
    const b = await loadMemoryEntries(cwd)
    expect(b).toBe(a)  // identity — cache returns the same array reference
  })

  it("mtime cache invalidates when the file is rewritten externally", async () => {
    const e = makeEntry({ kind: "decision", content: "first" })
    await saveMemoryEntries(cwd, [e])
    await loadMemoryEntries(cwd)
    // External rewrite with new content.
    await new Promise((r) => setTimeout(r, 10))
    const e2 = makeEntry({ kind: "decision", content: "second" })
    await fs.writeFile(memoryPathFor(cwd), `# Sysflow Auto-Memory\n\n## ${e2.id} · decision\n<!--frontmatter\ncreatedAt: ${e2.createdAt}\nlastConfirmedAt: ${e2.lastConfirmedAt}\nlastUsedAt: ${e2.lastUsedAt}\nstatus: active\nuseCount: 0\ncontradictionCount: 0\nfrontmatter-->\n\nsecond\n`, "utf8")
    const loaded = await loadMemoryEntries(cwd)
    expect(loaded.length).toBe(1)
    expect(loaded[0].content).toBe("second")
  })

  it("loadMemoryEntries with falsy cwd returns []", async () => {
    expect(await loadMemoryEntries(null)).toEqual([])
    expect(await loadMemoryEntries(undefined)).toEqual([])
    expect(await loadMemoryEntries("")).toEqual([])
  })
})
