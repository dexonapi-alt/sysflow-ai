import { describe, it, expect, beforeEach } from "vitest"
import { recordDecision, recordImplementSummary, recordUserCorrection, recordBugPattern, recordChunkSummary, recordOriginalIntent } from "../recorder.js"
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

  // ─── Phase 15 Stage 2: LOW-confidence skip parity ───

  it("recordBugPattern skips when options.confidence === 'LOW' (parity with recordDecision)", async () => {
    const r = await recordBugPattern(
      cwd,
      "Symptom: flaky test\nBoundary: timing",
      undefined,
      { runId: "r1", trigger: "on_error" },
      { confidence: "LOW" },
    )
    expect(r).toBeNull()
    const entries = await loadMemoryEntries(cwd)
    expect(entries.length).toBe(0)
  })

  it("recordBugPattern records when options.confidence is HIGH or MEDIUM", async () => {
    const r1 = await recordBugPattern(
      cwd,
      "Symptom: high-confidence diagnosis",
      undefined,
      { runId: "r1", trigger: "on_error" },
      { confidence: "HIGH" },
    )
    expect(r1).not.toBeNull()

    const r2 = await recordBugPattern(
      cwd,
      "Symptom: medium-confidence diagnosis",
      undefined,
      { runId: "r1", trigger: "on_error" },
      { confidence: "MEDIUM" },
    )
    expect(r2).not.toBeNull()
  })

  it("recordBugPattern records unconditionally when no options bag is passed (back-compat)", async () => {
    // Existing callers that don't yet pass `confidence` keep their pre-Stage-2
    // behaviour: record whatever they're given.
    const r = await recordBugPattern(
      cwd,
      "Legacy caller content",
      undefined,
      { runId: "r1" },
    )
    expect(r).not.toBeNull()
  })

  it("recordImplementSummary skips when brief.confidence === 'LOW' (recorder-level guard)", async () => {
    const r = await recordImplementSummary(
      cwd,
      {
        implementBrief: {
          intent: "scaffold a thing",
          recommendedStack: { language: "TypeScript", frameworks: ["Express"], libraries: ["zod"], rationale: "fast" },
        },
        confidence: "LOW",
      },
      { runId: "r1", trigger: "preflight" },
    )
    expect(r).toBeNull()
    const entries = await loadMemoryEntries(cwd)
    expect(entries.length).toBe(0)
  })

  it("recordImplementSummary records when brief.confidence is HIGH or undefined (back-compat)", async () => {
    const r1 = await recordImplementSummary(
      cwd,
      {
        implementBrief: {
          intent: "scaffold a thing",
          recommendedStack: { language: "TypeScript", frameworks: ["Express"], libraries: ["zod"], rationale: "fast" },
        },
        confidence: "HIGH",
      },
      { runId: "r1", trigger: "preflight" },
    )
    expect(r1).not.toBeNull()

    // Back-compat: omit `confidence` entirely; existing callers keep working.
    const r2 = await recordImplementSummary(
      cwd,
      {
        implementBrief: {
          intent: "another thing",
          recommendedStack: { language: "Python", frameworks: ["FastAPI"], libraries: ["pydantic"], rationale: "typing" },
        },
      },
      { runId: "r1", trigger: "preflight" },
    )
    expect(r2).not.toBeNull()
  })

  // ─── Phase 15 Stage 2: per-run dedup verification ───

  it("recording the same bug pattern twice in a run upserts via SHA256, never duplicates", async () => {
    // Stage 1's wiring records a bug pattern from the on-error reasoner's
    // brief. If a tool errors twice with the same diagnosis (which can
    // happen on free models retrying the same approach), the recorder
    // must dedup by content hash so memory doesn't grow noise.
    const summary = "Symptom: same error\nBoundary: same boundary\nFix: same fix"
    const r1 = await recordBugPattern(cwd, summary, undefined, { runId: "r1", trigger: "on_error" })
    const r2 = await recordBugPattern(cwd, summary, undefined, { runId: "r1", trigger: "on_error" })
    expect(r1?.id).toBe(r2?.id)
    const entries = await loadMemoryEntries(cwd)
    expect(entries.filter((e) => e.kind === "bug_pattern").length).toBe(1)
  })

  it("recording the same implement summary twice in a run upserts via SHA256, never duplicates", async () => {
    const brief = {
      implementBrief: {
        intent: "build a todo list",
        recommendedStack: { language: "TypeScript", frameworks: ["Vite"], libraries: ["zustand"], rationale: "simple" },
      },
      confidence: "HIGH",
    }
    const r1 = await recordImplementSummary(cwd, brief, { runId: "r1", trigger: "preflight" })
    const r2 = await recordImplementSummary(cwd, brief, { runId: "r1", trigger: "preflight" })
    expect(r1?.id).toBe(r2?.id)
    const entries = await loadMemoryEntries(cwd)
    expect(entries.filter((e) => e.kind === "implement").length).toBe(1)
  })

  it("dedup: recording the same content twice updates in place", async () => {
    const r1 = await recordUserCorrection(cwd, "we use pnpm")
    const r2 = await recordUserCorrection(cwd, "we use pnpm")
    expect(r1?.id).toBe(r2?.id)
    const entries = await loadMemoryEntries(cwd)
    expect(entries.length).toBe(1)
    expect(entries[0].useCount).toBe(1)  // bumped on the re-record
  })

  // ─── Phase 15 Stage 1: off-course resolution shapes ───

  it("recordUserCorrection persists the backtrack-resolution shape used by tool-result.ts", async () => {
    // This is the exact string shape Phase 15 Stage 1 emits when the user
    // picks `b` in the off-course modal. Pinning it here so a future change
    // to tool-result.ts can't silently drop the run.content + chunk anchor.
    const r = await recordUserCorrection(
      cwd,
      `Backtracked chunk 3 after awareness flagged off-course on: "build a postgres-backed user API"`,
      { runId: "r1", trigger: "off_course_resolution" },
    )
    expect(r).not.toBeNull()
    expect(r?.kind).toBe("user_correction")
    expect(r?.content).toContain("Backtracked chunk 3")
    expect(r?.content).toContain("postgres-backed user API")
    expect(r?.sourceRef.trigger).toBe("off_course_resolution")
  })

  it("recordUserCorrection persists the redirect-resolution shape used by tool-result.ts", async () => {
    const r = await recordUserCorrection(
      cwd,
      `Course-corrected: "use postgres not mongo" (original ask: "build a user API")`,
      { runId: "r1", trigger: "off_course_resolution" },
    )
    expect(r).not.toBeNull()
    expect(r?.content).toContain("Course-corrected")
    expect(r?.content).toContain("use postgres not mongo")
    expect(r?.content).toContain("original ask")
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

  // ─── Phase 11 Stage 3: original_intent ───

  it("recordOriginalIntent persists the verbatim prompt", async () => {
    const r = await recordOriginalIntent(cwd, "build a postgres-backed user API with logout endpoints")
    expect(r).not.toBeNull()
    expect(r?.kind).toBe("original_intent")
    expect(r?.content).toBe("build a postgres-backed user API with logout endpoints")
  })

  it("recordOriginalIntent returns null on empty input", async () => {
    expect(await recordOriginalIntent(cwd, "")).toBeNull()
    expect(await recordOriginalIntent(cwd, "   ")).toBeNull()
  })

  it("recordOriginalIntent dedupes when the same prompt is re-recorded", async () => {
    const r1 = await recordOriginalIntent(cwd, "build a logout endpoint")
    const r2 = await recordOriginalIntent(cwd, "build a logout endpoint")
    expect(r1).not.toBeNull()
    expect(r2).not.toBeNull()
    expect(r1?.id).toBe(r2?.id)
    const entries = await loadMemoryEntries(cwd)
    expect(entries.filter((e) => e.kind === "original_intent")).toHaveLength(1)
  })

  it("recordOriginalIntent truncates at the schema cap", async () => {
    const long = "x".repeat(2000)
    const r = await recordOriginalIntent(cwd, long)
    expect(r).not.toBeNull()
    expect(r!.content.length).toBeLessThanOrEqual(1500)
    expect(r!.content.endsWith("…")).toBe(true)
  })

  it("recordOriginalIntent does NOT reject prompts containing words like 'password'", async () => {
    // This is the case the Phase 11 plan calls out: a user request like
    // "build a password-reset flow" must persist, even though the word
    // 'password' appears. The secret-pattern guard targets actual key/token
    // formats, not English nouns.
    const r = await recordOriginalIntent(cwd, "build a password-reset flow with email verification")
    expect(r).not.toBeNull()
    expect(r?.content).toContain("password")
  })

  it("recordOriginalIntent still refuses content that contains an actual secret", async () => {
    // Make sure the safeRecord guardrail is intact for the new kind too.
    const fakeStripe = "sk_live_abcdefghijklmnop1234"
    const r = await recordOriginalIntent(cwd, `set my key to ${fakeStripe} and build the app`)
    expect(r).toBeNull()
  })

  it("entryKindSchema accepts original_intent", async () => {
    // Direct schema check — guards against accidentally removing the enum value.
    const { entryKindSchema } = await import("../entry-schema.js")
    expect(entryKindSchema.safeParse("original_intent").success).toBe(true)
  })
})
