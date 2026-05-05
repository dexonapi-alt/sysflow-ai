import { describe, it, expect } from "vitest"
import { serialiseEntries, parseEntries } from "../file-format.js"
import { makeEntry, type MemoryEntry } from "../entry-schema.js"

describe("file-format round-trip", () => {
  it("serialise then parse equals input", () => {
    const e1 = makeEntry({
      kind: "decision",
      content: "Use Drizzle ORM for Postgres setup",
      sourceRef: { runId: "r1", trigger: "self_invoked", packageDeps: ["drizzle-orm"], filePaths: ["src/db/schema.ts"] },
      tags: ["orm"],
    }, 1_700_000_000_000)
    e1.useCount = 3
    const e2 = makeEntry({
      kind: "user_correction",
      content: "We use Bun, not Node",
      sourceRef: { runId: "r2", trigger: "/remember" },
    }, 1_700_000_001_000)
    const text = serialiseEntries([e1, e2])
    const { entries, skipped } = parseEntries(text)
    expect(skipped).toBe(0)
    expect(entries.length).toBe(2)
    expect(entries[0].id).toBe(e1.id)
    expect(entries[0].content).toBe(e1.content)
    expect(entries[0].sourceRef.packageDeps).toEqual(["drizzle-orm"])
    expect(entries[0].sourceRef.filePaths).toEqual(["src/db/schema.ts"])
    expect(entries[0].tags).toEqual(["orm"])
    expect(entries[0].useCount).toBe(3)
    expect(entries[1].kind).toBe("user_correction")
  })

  it("parses an empty file as no entries", () => {
    const r = parseEntries("")
    expect(r.entries).toEqual([])
    expect(r.skipped).toBe(0)
  })

  it("preserves order across round-trip", () => {
    const inputs: MemoryEntry[] = [
      makeEntry({ kind: "decision", content: "decision one" }),
      makeEntry({ kind: "decision", content: "decision two" }),
      makeEntry({ kind: "decision", content: "decision three" }),
    ]
    const text = serialiseEntries(inputs)
    const r = parseEntries(text)
    expect(r.entries.map((e) => e.content)).toEqual(["decision one", "decision two", "decision three"])
  })

  it("skips a malformed entry but loads the valid ones", () => {
    const valid = makeEntry({ kind: "decision", content: "valid one" })
    const text = serialiseEntries([valid])
    // Inject a malformed block at the end.
    const broken = text + "\n## abcdef · decision\n<!--frontmatter\nbroken: yes\nfrontmatter-->\n\n"
    const r = parseEntries(broken)
    expect(r.entries.length).toBe(1)
    expect(r.entries[0].id).toBe(valid.id)
    // The broken block has missing required fields → skipped.
    expect(r.skipped).toBeGreaterThanOrEqual(1)
  })

  it("tolerates extra whitespace + CRLF line endings", () => {
    const e = makeEntry({ kind: "preference", content: "always strict mode" })
    const text = serialiseEntries([e]).replace(/\n/g, "\r\n") + "   \r\n\r\n"
    const r = parseEntries(text)
    expect(r.entries.length).toBe(1)
  })

  it("ignores entries missing required fields without crashing", () => {
    const r = parseEntries("# Sysflow Auto-Memory\n\n## abcdef · decision\n\nplain body no frontmatter\n")
    expect(r.entries.length).toBe(0)
  })
})
