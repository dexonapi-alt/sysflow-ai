/**
 * Stage 5 of free-tier-quality-enforcement: reasoner-vs-action checker tests.
 *
 * The matrix being verified is the gate logic in
 * `reasoner-action-checker.ts`:
 *   - read-intent + read-tool        → matches
 *   - read-intent + write-tool       → MISMATCH (the only case we flag)
 *   - write-intent + write-tool      → matches
 *   - write-intent + read-tool       → matches (legitimate setup)
 *   - mixed-intent + anything        → matches
 *   - empty / short reasoning + any  → matches
 */

import { describe, it, expect } from "vitest"
import {
  crossCheckReasoningAction,
  classifyToolCategory,
  pickLastReasoning,
} from "../reasoner-action-checker.js"

describe("classifyToolCategory", () => {
  it("classifies read tools", () => {
    for (const tool of ["read_file", "list_directory", "batch_read", "search_files", "search", "glob", "grep"]) {
      expect(classifyToolCategory({ tool })).toBe("read")
    }
  })

  it("classifies write tools", () => {
    for (const tool of ["write_file", "edit_file", "batch_write"]) {
      expect(classifyToolCategory({ tool })).toBe("write")
    }
  })

  it("classifies create_directory as mkdir", () => {
    expect(classifyToolCategory({ tool: "create_directory" })).toBe("mkdir")
  })

  it("classifies safe run_command as read", () => {
    expect(classifyToolCategory({ tool: "run_command", command: "ls -la", commandIsSafeReadOnly: true })).toBe("read")
  })

  it("classifies unsafe run_command as other", () => {
    expect(classifyToolCategory({ tool: "run_command", command: "npm install", commandIsSafeReadOnly: false })).toBe("other")
    expect(classifyToolCategory({ tool: "run_command", command: "npm install" })).toBe("other")
  })

  it("classifies _user_response and unmapped tools as other", () => {
    expect(classifyToolCategory({ tool: "_user_response" })).toBe("other")
    expect(classifyToolCategory({ tool: "unknown_tool" })).toBe("other")
  })

  it("classifies empty/non-string tool as other", () => {
    // @ts-expect-error — deliberately malformed input
    expect(classifyToolCategory({ tool: null })).toBe("other")
    expect(classifyToolCategory({ tool: "" })).toBe("other")
  })
})

describe("crossCheckReasoningAction — matches", () => {
  it("matches when reasoning is empty / null / undefined", () => {
    expect(crossCheckReasoningAction(null, { tool: "write_file", path: "src/x.ts" }).matches).toBe(true)
    expect(crossCheckReasoningAction(undefined, { tool: "write_file", path: "src/x.ts" }).matches).toBe(true)
    expect(crossCheckReasoningAction("", { tool: "write_file", path: "src/x.ts" }).matches).toBe(true)
  })

  it("matches when reasoning is too short to assert intent", () => {
    expect(crossCheckReasoningAction("Continue.", { tool: "write_file", path: "src/x.ts" }).matches).toBe(true)
    expect(crossCheckReasoningAction("Ok, moving on now.", { tool: "write_file", path: "src/x.ts" }).matches).toBe(true)
  })

  it("matches when neither read- nor write-intent appears", () => {
    // No vocab match — reasoning is meta / planning / context, not action.
    const reasoning = "The trade-off between centralised and distributed approaches comes down to operational overhead vs. latency."
    expect(crossCheckReasoningAction(reasoning, { tool: "write_file", path: "src/x.ts" }).matches).toBe(true)
  })

  it("matches read-intent + read-tool", () => {
    const reasoning = "I need to verify the import resolves by searching for the symbol in the source before I make any changes."
    expect(crossCheckReasoningAction(reasoning, { tool: "read_file", path: "src/foo.ts" }).matches).toBe(true)
    expect(crossCheckReasoningAction(reasoning, { tool: "run_command", command: "grep -r foo src/", commandIsSafeReadOnly: true }).matches).toBe(true)
    expect(crossCheckReasoningAction(reasoning, { tool: "batch_read", path: "src/x.ts" }).matches).toBe(true)
  })

  it("matches write-intent + write-tool", () => {
    const reasoning = "I will now create the new controller file and implement the user-fetching logic per the buildPlan."
    expect(crossCheckReasoningAction(reasoning, { tool: "write_file", path: "src/controller.ts" }).matches).toBe(true)
    expect(crossCheckReasoningAction(reasoning, { tool: "edit_file", path: "src/controller.ts" }).matches).toBe(true)
  })

  it("matches write-intent + read-tool (legitimate read-before-write)", () => {
    // The agent legitimately reads BEFORE writing — this is the
    // command-first-investigation pattern Stage 4 of the other plan
    // tries to encourage. Should not be flagged.
    const reasoning = "Before I implement the new endpoint I want to read the existing router to keep imports consistent."
    expect(crossCheckReasoningAction(reasoning, { tool: "read_file", path: "src/router.ts" }).matches).toBe(true)
  })

  it("matches when reasoning is mixed-intent (both read and write vocab present)", () => {
    const reasoning = "I'm going to verify the imports first and then write the new module exposing the helper."
    expect(crossCheckReasoningAction(reasoning, { tool: "write_file", path: "src/helper.ts" }).matches).toBe(true)
    expect(crossCheckReasoningAction(reasoning, { tool: "read_file", path: "src/router.ts" }).matches).toBe(true)
  })

  it("respects word boundaries (no false matches inside other words)", () => {
    // "dispatch" contains "patch" but isn't write-intent;
    // "reads" contains "read" but is matched by the explicit "read" word.
    // These tests just confirm the regex word-boundary behaviour isn't
    // catastrophically off — we're not trying to verify every adjacency.
    const dispatchOnly = "I plan to think about the dispatch table arrangement carefully and pick the best one."
    // No write-intent verb here (just "dispatch" + "arrangement" + "pick").
    // Should be neutral — neither intent → matches.
    expect(crossCheckReasoningAction(dispatchOnly, { tool: "write_file", path: "src/x.ts" }).matches).toBe(true)
  })
})

describe("crossCheckReasoningAction — mismatches (the one case we flag)", () => {
  it("flags read-intent + write-tool", () => {
    const reasoning = "I want to verify the import resolves by checking the source for the symbol I expect to be there."
    const out = crossCheckReasoningAction(reasoning, { tool: "write_file", path: "src/new.ts" })
    expect(out.matches).toBe(false)
    expect(out.reason).toContain("verify")
    expect(out.reason).toContain("write_file")
    expect(out.reason).toContain("src/new.ts")
  })

  it("flags read-intent + edit_file", () => {
    const reasoning = "Let me investigate why the typecheck is failing by examining the tsconfig more closely."
    const out = crossCheckReasoningAction(reasoning, { tool: "edit_file", path: "src/index.ts" })
    expect(out.matches).toBe(false)
    expect(out.reason).toMatch(/investigate|examining/)
  })

  it("flags read-intent + batch_write", () => {
    const reasoning = "I'm going to look into the existing route handlers to see what shape they expect before doing anything else."
    const out = crossCheckReasoningAction(reasoning, { tool: "batch_write", path: "src/routes/" })
    expect(out.matches).toBe(false)
  })

  it("flags read-intent + create_directory", () => {
    const reasoning = "First I want to inspect the project layout carefully so I don't duplicate an existing directory."
    const out = crossCheckReasoningAction(reasoning, { tool: "create_directory", path: "src/new-dir" })
    expect(out.matches).toBe(false)
  })

  it("does NOT flag read-intent + unsafe run_command (treated as other)", () => {
    // Unsafe run_command (e.g. npm install) is neither read nor write —
    // category "other". The checker's only mismatch rule is read-intent
    // + write/mkdir. Other commands pass through.
    const reasoning = "I want to verify the package is properly listed in the dependencies file before continuing."
    const out = crossCheckReasoningAction(reasoning, { tool: "run_command", command: "npm install lodash", commandIsSafeReadOnly: false })
    expect(out.matches).toBe(true)
  })

  it("includes the action target (path or command) in the reason", () => {
    const reasoning = "I'll verify the structure of the package by listing the entries in the dist folder first."
    const out = crossCheckReasoningAction(reasoning, { tool: "write_file", path: "dist/index.js" })
    expect(out.reason).toContain("dist/index.js")
  })

  it("falls back to '(none)' when no path / command on the action", () => {
    const reasoning = "I need to verify the imports resolve by reading through the module graph carefully."
    const out = crossCheckReasoningAction(reasoning, { tool: "write_file" })
    expect(out.matches).toBe(false)
    expect(out.reason).toContain("(none)")
  })
})

describe("detectDivergence integration — reasoning_action_mismatch", () => {
  // Lazy require so the import path tree is the same as detector tests
  // and we don't pull a `vitest.config` boundary surprise on Windows.

  it("emits reasoning_action_mismatch when lastReasoning + latestAction conflict", async () => {
    const { detectDivergence } = await import("../divergence-detector.js")
    const out = detectDivergence({
      originalPrompt: "build the feature",
      chunkHistory: [],
      filesModified: [],
      toolErrorCounts: new Map(),
      createdDirs: [],
      completionMessage: null,
      plannedChunkCount: null,
      lastReasoning: "Let me verify the import resolves by searching the source for the symbol I expect to be there.",
      latestAction: { tool: "write_file", path: "src/x.ts" },
    })
    const hits = out.filter((s) => s.category === "reasoning_action_mismatch")
    expect(hits).toHaveLength(1)
    expect(hits[0].severity).toBe("moderate")
    expect(hits[0].detail).toContain("write_file")
  })

  it("does NOT emit reasoning_action_mismatch when reasoning is missing", async () => {
    const { detectDivergence } = await import("../divergence-detector.js")
    const out = detectDivergence({
      originalPrompt: "build the feature",
      chunkHistory: [],
      filesModified: [],
      toolErrorCounts: new Map(),
      createdDirs: [],
      completionMessage: null,
      plannedChunkCount: null,
      lastReasoning: null,
      latestAction: { tool: "write_file", path: "src/x.ts" },
    })
    expect(out.find((s) => s.category === "reasoning_action_mismatch")).toBeUndefined()
  })

  it("does NOT emit reasoning_action_mismatch when latestAction is missing", async () => {
    const { detectDivergence } = await import("../divergence-detector.js")
    const out = detectDivergence({
      originalPrompt: "build the feature",
      chunkHistory: [],
      filesModified: [],
      toolErrorCounts: new Map(),
      createdDirs: [],
      completionMessage: null,
      plannedChunkCount: null,
      lastReasoning: "Let me verify the import resolves by checking the source carefully.",
      latestAction: null,
    })
    expect(out.find((s) => s.category === "reasoning_action_mismatch")).toBeUndefined()
  })

  it("does NOT emit on a legitimate pair (read-intent + read tool)", async () => {
    const { detectDivergence } = await import("../divergence-detector.js")
    const out = detectDivergence({
      originalPrompt: "build the feature",
      chunkHistory: [],
      filesModified: [],
      toolErrorCounts: new Map(),
      createdDirs: [],
      completionMessage: null,
      plannedChunkCount: null,
      lastReasoning: "Let me verify the import resolves by searching the source for the symbol.",
      latestAction: { tool: "read_file", path: "src/x.ts" },
    })
    expect(out.find((s) => s.category === "reasoning_action_mismatch")).toBeUndefined()
  })
})

describe("pickLastReasoning", () => {
  it("returns null for empty / null / undefined chains", () => {
    expect(pickLastReasoning(null)).toBe(null)
    expect(pickLastReasoning(undefined)).toBe(null)
    expect(pickLastReasoning([])).toBe(null)
  })

  it("returns the last non-empty paragraph", () => {
    expect(pickLastReasoning(["first", "second", "third"])).toBe("third")
  })

  it("skips trailing empty entries to find the last non-empty one", () => {
    expect(pickLastReasoning(["first", "second", "", "  "])).toBe("second")
  })

  it("skips non-string entries", () => {
    // @ts-expect-error — deliberately malformed
    expect(pickLastReasoning(["first", null, "second", 42])).toBe("second")
  })

  it("returns null when all entries are empty / non-string", () => {
    // @ts-expect-error — deliberately malformed
    expect(pickLastReasoning(["", "   ", null, 42])).toBe(null)
  })
})
