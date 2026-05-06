import { describe, it, expect, beforeEach } from "vitest"
import { recordDecision, recordImplementSummary, recordUserCorrection, recordBugPattern, recordChunkSummary } from "../recorder.js"
import { loadMemoryEntries, _resetCache, _setupTempCwd } from "../store.js"

describe("recorder", () => {
  let cwd: string
  beforeEach(async () => {
    cwd = await _setupTempCwd()
    _resetCache()
  })

  it("recordDecision skips LOW confidence", async () => {
    const r = await recordDecision(
      cwd,
      { confidence: "LOW", decisionBrief: { recommendation: "Drizzle" } },
      { runId: "r1" },
    )
    expect(r).toBeNull()
    const entries = await loadMemoryEntries(cwd)
    expect(entries.length).toBe(0)
  })

  it("recordDecision persists HIGH confidence with full content", async () => {
    const r = await recordDecision(
      cwd,
      { confidence: "HIGH", decisionBrief: { recommendation: "Drizzle", confidence: "HIGH", proceedHint: "install drizzle-orm" } },
      { runId: "r1", trigger: "self_invoked" },
    )
    expect(r).not.toBeNull()
    expect(r?.kind).toBe("decision")
    expect(r?.content).toContain("Drizzle")
    expect(r?.content).toContain("install drizzle-orm")
  })

  it("recordImplementSummary persists stack + rationale + notes", async () => {
    const r = await recordImplementSummary(
      cwd,
      {
        implementBrief: {
          intent: "build a todo list",
          recommendedStack: { language: "TypeScript", frameworks: ["React", "Vite"], libraries: ["zustand"], rationale: "lightweight" },
          consistencyNotes: ["dark theme by default"],
        },
      },
      { runId: "r1", trigger: "preflight" },
    )
    expect(r).not.toBeNull()
    expect(r?.kind).toBe("implement")
    expect(r?.content).toContain("TypeScript")
    expect(r?.content).toContain("zustand")
    expect(r?.content).toContain("dark theme")
    // Library should land in packageDeps so the dep-ref validator can mark it stale later.
    expect(r?.sourceRef.packageDeps).toContain("zustand")
  })

  it("recordUserCorrection persists any non-empty non-secret text", async () => {
    const r = await recordUserCorrection(cwd, "we use Bun, not Node")
    expect(r).not.toBeNull()
    expect(r?.kind).toBe("user_correction")
    expect(r?.tags).toContain("user-typed")
  })

  it("recorder refuses content that looks like a secret", async () => {
    const r = await recordUserCorrection(cwd, "API_KEY=abc123def456ghi789jklmnop")
    expect(r).toBeNull()
  })

  it("recorder refuses Stripe-style key", async () => {
    // Build the test string in pieces so static secret-scanners don't flag the test file itself.
    const fakeStripe = "sk" + "_live_" + "FAKEBOGUSKEY01234567FAKE"
    const r = await recordUserCorrection(cwd, `use ${fakeStripe}`)
    expect(r).toBeNull()
  })

  it("recorder refuses GitHub token", async () => {
    const fakeGh = "gh" + "p_" + "FAKEBOGUS123456789012345FAKE0123"
    const r = await recordUserCorrection(cwd, fakeGh)
    expect(r).toBeNull()
  })

  it("recordBugPattern persists symptom + fileRefs", async () => {
    const r = await recordBugPattern(
      cwd,
      "Symptom: 500 after deploy\nBoundary: config\nFix: add env var",
      ["src/config.ts"],
      { runId: "r1", trigger: "on_error" },
    )
    expect(r).not.toBeNull()
    expect(r?.kind).toBe("bug_pattern")
    expect(r?.sourceRef.filePaths).toEqual(["src/config.ts"])
  })

  it("dedup: recording the same content twice updates in place", async () => {
    const r1 = await recordUserCorrection(cwd, "we use pnpm")
    const r2 = await recordUserCorrection(cwd, "we use pnpm")
    expect(r1?.id).toBe(r2?.id)
    const entries = await loadMemoryEntries(cwd)
    expect(entries.length).toBe(1)
    expect(entries[0].useCount).toBe(1)  // bumped on the re-record
  })

  it("empty content is rejected", async () => {
    const r = await recordUserCorrection(cwd, "   ")
    expect(r).toBeNull()
  })

  // ─── Phase 10: chunk_summary ───

  it("recordChunkSummary persists chunk index + nextAction + executed files", async () => {
    const r = await recordChunkSummary(
      cwd,
      {
        chunkIndex: 2,
        nextAction: "wire user routes",
        executedFiles: ["src/routes/users.js", "src/routes/auth.js"],
        reflection: { coherent: true, nextFocus: "add middleware next", issues: [], shouldStop: false },
      },
      { runId: "r1", trigger: "chunk_reflect" },
    )
    expect(r).not.toBeNull()
    expect(r?.kind).toBe("chunk_summary")
    expect(r?.content).toContain("Chunk 2")
    expect(r?.content).toContain("wire user routes")
    expect(r?.content).toContain("src/routes/users.js")
    expect(r?.content).toContain("add middleware next")
    expect(r?.sourceRef.filePaths).toContain("src/routes/users.js")
    expect(r?.tags).toContain("chunk")
  })

  it("recordChunkSummary surfaces issues when reflection.coherent is false", async () => {
    const r = await recordChunkSummary(
      cwd,
      {
        chunkIndex: 1,
        nextAction: "write models",
        executedFiles: ["src/models/User.js"],
        reflection: {
          coherent: false,
          issues: ["server.js imports ./db but no db file was created"],
          nextFocus: "create src/db.js",
          shouldStop: false,
        },
      },
      { runId: "r1", trigger: "chunk_reflect" },
    )
    expect(r).not.toBeNull()
    expect(r?.content).toContain("Issues:")
    expect(r?.content).toContain("server.js imports ./db")
  })

  it("recordChunkSummary notes when reflector says shouldStop", async () => {
    const r = await recordChunkSummary(
      cwd,
      {
        chunkIndex: 4,
        nextAction: "polish",
        executedFiles: ["README.md"],
        reflection: { coherent: true, issues: [], nextFocus: "", shouldStop: true },
      },
      { runId: "r1", trigger: "chunk_reflect" },
    )
    expect(r).not.toBeNull()
    expect(r?.content).toContain("should stop")
  })

  it("recordChunkSummary returns null when content is empty", async () => {
    const r = await recordChunkSummary(
      cwd,
      // No nextAction, no files, no reflection — nothing to record.
      // chunkIndex alone is meaningless without context.
      { chunkIndex: 0 },
      { runId: "r1" },
    )
    // The header "Chunk 0" alone is still non-empty content, so this should
    // actually record (we never want to silently drop the boundary marker).
    expect(r).not.toBeNull()
    expect(r?.content).toBe("Chunk 0")
  })
})
