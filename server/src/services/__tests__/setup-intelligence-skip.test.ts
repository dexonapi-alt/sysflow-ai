/**
 * Plan `2026-05-15-agent-runtime-fixes-and-project-init-reasoning.md` Stage 1.
 *
 * Tests for the per-run config-verification skip list. The project-init
 * reasoner populates this for empty/small repos so the action-planner's
 * web-search hijack doesn't fire on configs the agent is AUTHORING.
 */

import { describe, it, expect, beforeEach } from "vitest"
import {
  detectConfigFile,
  setConfigSkipList,
  isConfigSkipped,
  clearConfigSkipList,
  clearRunSearches,
} from "../setup-intelligence.js"

const RUN_ID = "test-run-skip-1"

beforeEach(() => {
  clearRunSearches(RUN_ID)
  clearConfigSkipList(RUN_ID)
})

describe("setConfigSkipList / isConfigSkipped", () => {
  it("returns false when no skip list has been set", () => {
    expect(isConfigSkipped(RUN_ID, "tsconfig.json")).toBe(false)
  })

  it("returns true for exact filename match (lower-case)", () => {
    setConfigSkipList(RUN_ID, ["tsconfig.json"])
    expect(isConfigSkipped(RUN_ID, "tsconfig.json")).toBe(true)
  })

  it("returns true for nested path matching by suffix", () => {
    setConfigSkipList(RUN_ID, ["tsconfig.json"])
    expect(isConfigSkipped(RUN_ID, "src/tsconfig.json")).toBe(true)
    expect(isConfigSkipped(RUN_ID, "packages/app/tsconfig.json")).toBe(true)
  })

  it("returns true for Windows-style backslash paths", () => {
    setConfigSkipList(RUN_ID, ["tsconfig.json"])
    expect(isConfigSkipped(RUN_ID, "src\\tsconfig.json")).toBe(true)
  })

  it("case-insensitive match for the skipped entry", () => {
    setConfigSkipList(RUN_ID, ["TSConfig.JSON"])
    expect(isConfigSkipped(RUN_ID, "tsconfig.json")).toBe(true)
  })

  it("returns false for unrelated paths", () => {
    setConfigSkipList(RUN_ID, ["tsconfig.json"])
    expect(isConfigSkipped(RUN_ID, "package.json")).toBe(false)
    expect(isConfigSkipped(RUN_ID, "tsconfig.example.json")).toBe(false)
  })

  it("clearConfigSkipList drops the entries for the run", () => {
    setConfigSkipList(RUN_ID, ["tsconfig.json"])
    clearConfigSkipList(RUN_ID)
    expect(isConfigSkipped(RUN_ID, "tsconfig.json")).toBe(false)
  })

  it("clearRunSearches also drops the skip list (one cleanup path)", () => {
    setConfigSkipList(RUN_ID, ["tsconfig.json"])
    clearRunSearches(RUN_ID)
    expect(isConfigSkipped(RUN_ID, "tsconfig.json")).toBe(false)
  })

  it("isolates skip lists across runs", () => {
    setConfigSkipList("run-a", ["tsconfig.json"])
    setConfigSkipList("run-b", [".eslintrc.json"])
    expect(isConfigSkipped("run-a", "tsconfig.json")).toBe(true)
    expect(isConfigSkipped("run-b", "tsconfig.json")).toBe(false)
    expect(isConfigSkipped("run-a", ".eslintrc.json")).toBe(false)
    expect(isConfigSkipped("run-b", ".eslintrc.json")).toBe(true)
    clearConfigSkipList("run-a")
    clearConfigSkipList("run-b")
  })
})

describe("detectConfigFile honours skip list when runId is passed", () => {
  it("returns the config info when no skip list is set", () => {
    const out = detectConfigFile("tsconfig.json")
    expect(out).not.toBeNull()
    expect(out!.framework).toBe("typescript")
  })

  it("returns null when the file is on the run's skip list", () => {
    setConfigSkipList(RUN_ID, ["tsconfig.json"])
    expect(detectConfigFile("tsconfig.json", RUN_ID)).toBeNull()
  })

  it("returns null for nested skipped path", () => {
    setConfigSkipList(RUN_ID, ["tsconfig.json"])
    expect(detectConfigFile("src/tsconfig.json", RUN_ID)).toBeNull()
  })

  it("returns the config info when runId is provided but file is NOT on skip list", () => {
    setConfigSkipList(RUN_ID, [".eslintrc.json"])
    const out = detectConfigFile("tsconfig.json", RUN_ID)
    expect(out).not.toBeNull()
    expect(out!.framework).toBe("typescript")
  })

  it("backward-compatible: no runId means no skip checking (legacy callers)", () => {
    setConfigSkipList(RUN_ID, ["tsconfig.json"])
    const out = detectConfigFile("tsconfig.json")
    expect(out).not.toBeNull()
  })

  it("detects vite.config / .eslintrc / postcss.config / tailwind.config and respects their skip entries", () => {
    setConfigSkipList(RUN_ID, ["vite.config.ts", ".eslintrc.json", "postcss.config.js", "tailwind.config.js"])
    expect(detectConfigFile("vite.config.ts", RUN_ID)).toBeNull()
    expect(detectConfigFile(".eslintrc.json", RUN_ID)).toBeNull()
    expect(detectConfigFile("postcss.config.js", RUN_ID)).toBeNull()
    expect(detectConfigFile("tailwind.config.js", RUN_ID)).toBeNull()
  })
})

// ─── Stage 4 follow-up of agent-code-correctness plan: expected-artifacts per-run state ───

import {
  setExpectedArtifacts,
  getExpectedArtifacts,
  clearExpectedArtifacts,
} from "../setup-intelligence.js"

describe("setExpectedArtifacts / getExpectedArtifacts", () => {
  const RUN = "test-expected-artifacts-1"
  beforeEach(() => { clearExpectedArtifacts(RUN) })

  it("returns undefined when no list has been set (signals fallback path)", () => {
    expect(getExpectedArtifacts(RUN)).toBeUndefined()
  })

  it("stores + retrieves the list verbatim", () => {
    setExpectedArtifacts(RUN, ["db_schema", "tests"])
    expect(getExpectedArtifacts(RUN)).toEqual(["db_schema", "tests"])
  })

  it("empty array is a meaningful 'LLM decided no artifacts' signal (not undefined)", () => {
    setExpectedArtifacts(RUN, [])
    expect(getExpectedArtifacts(RUN)).toEqual([])
    // Distinct from undefined (no LLM verdict).
    expect(getExpectedArtifacts("never-set")).toBeUndefined()
  })

  it("overwrites on repeated set", () => {
    setExpectedArtifacts(RUN, ["db_schema"])
    setExpectedArtifacts(RUN, ["tests"])
    expect(getExpectedArtifacts(RUN)).toEqual(["tests"])
  })

  it("clearExpectedArtifacts drops the list", () => {
    setExpectedArtifacts(RUN, ["db_schema"])
    clearExpectedArtifacts(RUN)
    expect(getExpectedArtifacts(RUN)).toBeUndefined()
  })

  it("clearRunSearches also drops the list (terminal cleanup path)", () => {
    setExpectedArtifacts(RUN, ["db_schema"])
    clearRunSearches(RUN)
    expect(getExpectedArtifacts(RUN)).toBeUndefined()
  })

  it("isolates per-run (run A's list doesn't bleed into run B)", () => {
    setExpectedArtifacts("run-a", ["db_schema"])
    setExpectedArtifacts("run-b", ["tests"])
    expect(getExpectedArtifacts("run-a")).toEqual(["db_schema"])
    expect(getExpectedArtifacts("run-b")).toEqual(["tests"])
    clearExpectedArtifacts("run-a")
    clearExpectedArtifacts("run-b")
  })

  it("clones the input array (mutating after set doesn't affect storage)", () => {
    const original = ["db_schema"]
    setExpectedArtifacts(RUN, original)
    original.push("tests")
    expect(getExpectedArtifacts(RUN)).toEqual(["db_schema"])
  })

  it("noops on empty runId (defensive)", () => {
    setExpectedArtifacts("", ["db_schema"])
    expect(getExpectedArtifacts("")).toBeUndefined()
  })
})
