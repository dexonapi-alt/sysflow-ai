/**
 * Plan `2026-05-15-forced-error-reasoning-and-recovery.md` Stage 5.
 *
 * Tests for the error_pattern memory module: format / parse round-trip,
 * record write + dedupe, recall scoring + filtering.
 */

import { describe, it, expect, beforeEach } from "vitest"
import {
  recordErrorPattern,
  recallErrorPatterns,
  formatErrorPatternContent,
  parseErrorPatternContent,
  formatRecallForReasoner,
  type ErrorPatternFields,
} from "../error-pattern.js"
import { loadMemoryEntries, _resetCache, _setupTempCwd, saveMemoryEntries } from "../store.js"
import { makeEntry, type MemoryEntry } from "../entry-schema.js"

const baseFields: ErrorPatternFields = {
  errorClass: "command_not_found",
  platform: "win32",
  failedCommand: "ls -R",
  workingCommand: "dir /s",
  errorSignature: "'ls' is not recognized as an internal or external command",
}

describe("formatErrorPatternContent / parseErrorPatternContent", () => {
  it("round-trips a well-formed entry", () => {
    const content = formatErrorPatternContent(baseFields)
    const parsed = parseErrorPatternContent(content)
    expect(parsed).toEqual(baseFields)
  })

  it("includes the labelled lines in the expected order", () => {
    const content = formatErrorPatternContent(baseFields)
    const lines = content.split("\n")
    expect(lines[0]).toBe("Error pattern: command_not_found on win32")
    expect(lines[1]).toBe("Failed: ls -R")
    expect(lines[2]).toBe("Worked: dir /s")
    expect(lines[3].startsWith("Signature: ")).toBe(true)
  })

  it("truncates over-long fields without breaking the parser", () => {
    const longSig = "x".repeat(1000)
    const content = formatErrorPatternContent({ ...baseFields, errorSignature: longSig })
    const parsed = parseErrorPatternContent(content)
    expect(parsed).not.toBeNull()
    expect(parsed!.errorSignature.length).toBeLessThan(longSig.length)
    expect(parsed!.errorSignature.endsWith("…")).toBe(true)
  })

  it("returns null when the header line is missing", () => {
    const malformed = "Failed: x\nWorked: y\nSignature: z"
    expect(parseErrorPatternContent(malformed)).toBeNull()
  })

  it("returns null when a labelled line is missing", () => {
    const missingFailed = "Error pattern: foo on linux\nWorked: y\nSignature: z"
    expect(parseErrorPatternContent(missingFailed)).toBeNull()
  })

  it("handles CRLF line endings", () => {
    const content = formatErrorPatternContent(baseFields).replace(/\n/g, "\r\n")
    const parsed = parseErrorPatternContent(content)
    expect(parsed).toEqual(baseFields)
  })
})

describe("recordErrorPattern", () => {
  let cwd: string
  beforeEach(async () => {
    cwd = await _setupTempCwd()
    _resetCache()
  })

  it("writes a new entry to .sysflow-memory.md", async () => {
    const entry = await recordErrorPattern({ ...baseFields, cwd, runId: "r1" })
    expect(entry).not.toBeNull()
    expect(entry!.kind).toBe("error_pattern")
    expect(entry!.content).toContain("ls -R")
    expect(entry!.content).toContain("dir /s")
    const all = await loadMemoryEntries(cwd)
    expect(all.find((e) => e.kind === "error_pattern")).toBeDefined()
  })

  it("returns null when cwd is empty", async () => {
    const entry = await recordErrorPattern({ ...baseFields, cwd: "" })
    expect(entry).toBeNull()
  })

  it("returns null when failedCommand is empty", async () => {
    const entry = await recordErrorPattern({ ...baseFields, failedCommand: "", cwd })
    expect(entry).toBeNull()
  })

  it("returns null when workingCommand is empty", async () => {
    const entry = await recordErrorPattern({ ...baseFields, workingCommand: "", cwd })
    expect(entry).toBeNull()
  })

  it("returns null when errorSignature is empty", async () => {
    const entry = await recordErrorPattern({ ...baseFields, errorSignature: "", cwd })
    expect(entry).toBeNull()
  })

  it("returns null when failedCommand equals workingCommand (no recovery)", async () => {
    const entry = await recordErrorPattern({ ...baseFields, workingCommand: "ls -R", cwd })
    expect(entry).toBeNull()
  })

  it("refuses to persist content that looks like a secret", async () => {
    const entry = await recordErrorPattern({
      ...baseFields,
      workingCommand: "curl -H 'Authorization: Bearer ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' https://x",
      cwd,
    })
    expect(entry).toBeNull()
  })

  it("dedupes re-recording the same error+platform+command tuple", async () => {
    const first = await recordErrorPattern({ ...baseFields, cwd, runId: "r1" })
    _resetCache()
    const second = await recordErrorPattern({ ...baseFields, cwd, runId: "r2" })
    expect(first!.id).toBe(second!.id)
    _resetCache()
    const all = await loadMemoryEntries(cwd)
    expect(all.filter((e) => e.kind === "error_pattern").length).toBe(1)
    expect(second!.useCount).toBe(first!.useCount + 1)
  })

  it("writes distinct entries when platform differs", async () => {
    await recordErrorPattern({ ...baseFields, cwd })
    _resetCache()
    await recordErrorPattern({ ...baseFields, platform: "linux", workingCommand: "ls -R", failedCommand: "ls --foo", cwd })
    _resetCache()
    const all = await loadMemoryEntries(cwd)
    expect(all.filter((e) => e.kind === "error_pattern").length).toBe(2)
  })
})

describe("recallErrorPatterns", () => {
  let cwd: string
  beforeEach(async () => {
    cwd = await _setupTempCwd()
    _resetCache()
  })

  it("returns empty when no entries", async () => {
    const matches = await recallErrorPatterns({ cwd, errorSignature: "anything", platform: "win32" })
    expect(matches).toEqual([])
  })

  it("returns empty when only non-error_pattern entries exist", async () => {
    const entries: MemoryEntry[] = [
      makeEntry({ kind: "decision", content: "use Drizzle" }),
      makeEntry({ kind: "user_correction", content: "we use Bun" }),
    ]
    await saveMemoryEntries(cwd, entries)
    _resetCache()
    const matches = await recallErrorPatterns({ cwd, errorSignature: "ls is not recognized", platform: "win32" })
    expect(matches).toEqual([])
  })

  it("filters out entries whose platform does not match", async () => {
    await recordErrorPattern({ ...baseFields, platform: "linux", cwd })
    _resetCache()
    const matches = await recallErrorPatterns({
      cwd,
      errorSignature: "'ls' is not recognized as an internal or external command",
      platform: "win32",
    })
    expect(matches).toEqual([])
  })

  it("returns matching entry when platform + signature overlap", async () => {
    await recordErrorPattern({ ...baseFields, cwd })
    _resetCache()
    const matches = await recallErrorPatterns({
      cwd,
      errorSignature: "'ls' is not recognized as an internal or external command",
      platform: "win32",
    })
    expect(matches.length).toBe(1)
    expect(matches[0].fields.workingCommand).toBe("dir /s")
  })

  it("returns no matches when signature has zero token overlap", async () => {
    await recordErrorPattern({ ...baseFields, cwd })
    _resetCache()
    const matches = await recallErrorPatterns({
      cwd,
      errorSignature: "completely unrelated nonsense xyzzy quux",
      platform: "win32",
    })
    expect(matches).toEqual([])
  })

  it("orders results by overlap score (best match first)", async () => {
    await recordErrorPattern({
      ...baseFields,
      failedCommand: "ls",
      workingCommand: "dir",
      errorSignature: "'ls' is not recognized as an internal or external command",
      cwd,
    })
    _resetCache()
    await recordErrorPattern({
      ...baseFields,
      failedCommand: "npm install",
      workingCommand: "yarn install",
      errorSignature: "command failed with exit code 1",
      cwd,
    })
    _resetCache()
    const matches = await recallErrorPatterns({
      cwd,
      errorSignature: "'ls' is not recognized as an internal or external command",
      platform: "win32",
    })
    expect(matches.length).toBeGreaterThanOrEqual(1)
    expect(matches[0].fields.failedCommand).toBe("ls")
  })

  it("caps to maxEntries", async () => {
    for (let i = 0; i < 5; i++) {
      await recordErrorPattern({
        ...baseFields,
        failedCommand: `cmd-${i}`,
        workingCommand: `fix-${i}`,
        errorSignature: `'ls' is not recognized variant ${i} of the same error`,
        cwd,
      })
      _resetCache()
    }
    const matches = await recallErrorPatterns({
      cwd,
      errorSignature: "'ls' is not recognized as an internal or external command",
      platform: "win32",
      maxEntries: 2,
    })
    expect(matches.length).toBe(2)
  })

  it("returns empty when errorSignature is empty", async () => {
    await recordErrorPattern({ ...baseFields, cwd })
    _resetCache()
    const matches = await recallErrorPatterns({ cwd, errorSignature: "", platform: "win32" })
    expect(matches).toEqual([])
  })
})

describe("formatRecallForReasoner", () => {
  it("returns null on empty matches", () => {
    expect(formatRecallForReasoner([])).toBeNull()
  })

  it("formats a single match with the expected sections", () => {
    const entry = makeEntry({ kind: "error_pattern", content: formatErrorPatternContent(baseFields) })
    const out = formatRecallForReasoner([{ entry: { ...entry, _validationNotes: [] } as never, fields: baseFields, score: 10 }])
    expect(out).not.toBeNull()
    expect(out!).toContain("1 prior recovered-from error pattern")
    expect(out!).toContain("Failed: ls -R")
    expect(out!).toContain("Worked: dir /s")
    expect(out!).toContain("Confirm or revise")
  })

  it("formats multiple matches with plural framing", () => {
    const entry = makeEntry({ kind: "error_pattern", content: formatErrorPatternContent(baseFields) })
    const out = formatRecallForReasoner([
      { entry: { ...entry, _validationNotes: [] } as never, fields: baseFields, score: 10 },
      { entry: { ...entry, _validationNotes: [] } as never, fields: { ...baseFields, failedCommand: "cat foo", workingCommand: "Get-Content foo" }, score: 5 },
    ])
    expect(out).not.toBeNull()
    expect(out!).toContain("2 prior recovered-from error patterns")
    expect(out!).toContain("Get-Content foo")
  })
})
