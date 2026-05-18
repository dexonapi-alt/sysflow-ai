/**
 * Stage 2 of plan `2026-05-18-ui-ux-polish-and-action-aware-spinner.md`.
 *
 * Pure tests for the spinner label formatter. The user-reported
 * pattern: the spinner verb cycle ran on a timer regardless of what
 * the agent was doing — mid-write it still showed "polishing…" or
 * "weighing options…". After Stage 2 the spinner reads the actual
 * action ("writing src/index.ts", "running npm install") whenever a
 * tool card is in-flight; verb cycle stays as the idle fallback.
 */

import { describe, it, expect } from "vitest"
import {
  formatToolForSpinner,
  formatRunningCardsForSpinner,
} from "../spinner-label-format.js"
import { _resolveSpinnerLabelForTests } from "../components/AgentStream.js"

describe("formatToolForSpinner — per-tool labels", () => {
  it("read_file with path: 'reading <path>'", () => {
    expect(formatToolForSpinner("read_file", { path: "src/index.ts" })).toBe("reading src/index.ts")
  })

  it("read_file without path: 'reading'", () => {
    expect(formatToolForSpinner("read_file", undefined)).toBe("reading")
    expect(formatToolForSpinner("read_file", {})).toBe("reading")
  })

  it("batch_read with N paths: 'reading N files' (singular/plural)", () => {
    expect(formatToolForSpinner("batch_read", { paths: ["a.ts"] })).toBe("reading 1 file")
    expect(formatToolForSpinner("batch_read", { paths: ["a.ts", "b.ts", "c.ts"] })).toBe("reading 3 files")
    expect(formatToolForSpinner("batch_read", {})).toBe("reading")
  })

  it("write_file with path: 'writing <path>'", () => {
    expect(formatToolForSpinner("write_file", { path: "package.json" })).toBe("writing package.json")
  })

  it("batch_write with N files: 'writing N files'", () => {
    expect(formatToolForSpinner("batch_write", { files: [{ path: "a.ts" }, { path: "b.ts" }] })).toBe("writing 2 files")
    expect(formatToolForSpinner("batch_write", { files: [{ path: "a.ts" }] })).toBe("writing 1 file")
  })

  it("edit_file: 'editing <path>'", () => {
    expect(formatToolForSpinner("edit_file", { path: "src/db.ts" })).toBe("editing src/db.ts")
  })

  it("delete_file: 'deleting <path>'", () => {
    expect(formatToolForSpinner("delete_file", { path: "scratch.txt" })).toBe("deleting scratch.txt")
  })

  it("move_file with both from + to: 'moving <from> → <to>'", () => {
    expect(formatToolForSpinner("move_file", { from: "old.ts", to: "new.ts" })).toBe("moving old.ts → new.ts")
  })

  it("create_directory: 'creating <path>' or 'creating directory'", () => {
    expect(formatToolForSpinner("create_directory", { path: "src/routes" })).toBe("creating src/routes")
    expect(formatToolForSpinner("create_directory", {})).toBe("creating directory")
  })

  it("list_directory: 'listing <path>'", () => {
    expect(formatToolForSpinner("list_directory", { path: "src/" })).toBe("listing src/")
  })

  it("file_exists: 'checking <path>'", () => {
    expect(formatToolForSpinner("file_exists", { path: "tsconfig.json" })).toBe("checking tsconfig.json")
  })

  it("run_command: 'running <cmd>' (truncated at 40 chars)", () => {
    expect(formatToolForSpinner("run_command", { command: "npm install" })).toBe("running npm install")
    const long = "npm install express pg dotenv cors helmet morgan winston debug bcrypt"
    const out = formatToolForSpinner("run_command", { command: long })
    expect(out.startsWith("running ")).toBe(true)
    expect(out.length).toBeLessThanOrEqual(40 + "running ".length)
    expect(out.endsWith("…")).toBe(true)
  })

  it("search_code: 'searching for \"<pattern>\"'", () => {
    expect(formatToolForSpinner("search_code", { pattern: "express" })).toBe(`searching for "express"`)
  })

  it("search_files: 'searching files for \"<query>\"'", () => {
    expect(formatToolForSpinner("search_files", { query: "*.ts" })).toBe(`searching files for "*.ts"`)
  })

  it("web_search: 'searching the web for \"<query>\"' (truncated at 30 chars)", () => {
    expect(formatToolForSpinner("web_search", { query: "fastify auth" })).toBe(`searching the web for "fastify auth"`)
    const long = "fastify cors middleware bearer token auth tutorial 2026"
    const out = formatToolForSpinner("web_search", { query: long })
    expect(out.includes("…")).toBe(true)
  })

  it("reason: 'thinking through it' (matches verb-cycle vocabulary for smooth transition)", () => {
    expect(formatToolForSpinner("reason", {})).toBe("thinking through it")
  })

  it("check_jobs: 'checking jobs'", () => {
    expect(formatToolForSpinner("check_jobs", {})).toBe("checking jobs")
  })

  it("unknown tool: falls back to the tool name verbatim", () => {
    expect(formatToolForSpinner("made_up_tool", { path: "x" })).toBe("made_up_tool")
  })

  it("non-string args are defensively handled (no throw, fall back to bare verb)", () => {
    expect(formatToolForSpinner("read_file", { path: 42 as unknown as string })).toBe("reading")
    expect(formatToolForSpinner("write_file", { path: null as unknown as string })).toBe("writing")
  })
})

describe("formatRunningCardsForSpinner — multi-card aggregation", () => {
  it("returns null when no cards are running", () => {
    expect(formatRunningCardsForSpinner([])).toBeNull()
    expect(formatRunningCardsForSpinner([{ tool: "write_file", status: "success" }])).toBeNull()
  })

  it("single running card: routes to formatToolForSpinner", () => {
    expect(
      formatRunningCardsForSpinner([
        { tool: "write_file", args: { path: "src/index.ts" }, status: "running" },
      ]),
    ).toBe("writing src/index.ts")
  })

  it("N running cards all same file-tool: 'writing N files'", () => {
    const cards = [
      { tool: "write_file", args: { path: "a.ts" }, status: "running" },
      { tool: "write_file", args: { path: "b.ts" }, status: "running" },
      { tool: "write_file", args: { path: "c.ts" }, status: "running" },
    ]
    expect(formatRunningCardsForSpinner(cards)).toBe("writing 3 files")
  })

  it("N running cards mixed tools: 'running N tools' (generic count)", () => {
    const cards = [
      { tool: "write_file", args: { path: "a.ts" }, status: "running" },
      { tool: "edit_file", args: { path: "b.ts" }, status: "running" },
      { tool: "create_directory", args: { path: "src" }, status: "running" },
    ]
    expect(formatRunningCardsForSpinner(cards)).toBe("running 3 tools")
  })

  it("ignores settled cards in the count (only `running` cards aggregate)", () => {
    const cards = [
      { tool: "write_file", args: { path: "a.ts" }, status: "success" }, // settled, ignored
      { tool: "write_file", args: { path: "b.ts" }, status: "running" },
      { tool: "write_file", args: { path: "c.ts" }, status: "error" }, // settled, ignored
    ]
    expect(formatRunningCardsForSpinner(cards)).toBe("writing b.ts")
  })

  it("2 running run_command cards: 'running 2 actions' (non-file aggregate)", () => {
    const cards = [
      { tool: "run_command", args: { command: "npm install" }, status: "running" },
      { tool: "run_command", args: { command: "git status" }, status: "running" },
    ]
    expect(formatRunningCardsForSpinner(cards)).toBe("running 2 actions")
  })
})

describe("resolveSpinnerLabel — priority composition in AgentStream", () => {
  it("returns the explicit phase label when no tool card is running", () => {
    expect(_resolveSpinnerLabelForTests([], "retrying after rate limit…")).toBe("retrying after rate limit…")
  })

  it("returns the empty string when no tool card AND no explicit text", () => {
    expect(_resolveSpinnerLabelForTests([], "")).toBe("")
  })

  it("running card overrides the explicit text (which is usually generic at that point)", () => {
    expect(
      _resolveSpinnerLabelForTests(
        [{ tool: "write_file", args: { path: "src/index.ts" }, status: "running" }],
        "thinking…",
      ),
    ).toBe("writing src/index.ts")
  })

  it("running card overrides 'executing N tools…' generic placeholder", () => {
    expect(
      _resolveSpinnerLabelForTests(
        [
          { tool: "read_file", args: { path: "a.ts" }, status: "running" },
          { tool: "read_file", args: { path: "b.ts" }, status: "running" },
        ],
        "executing 2 tools...",
      ),
    ).toBe("reading 2 files")
  })

  it("falls through to explicit text when all cards have settled", () => {
    expect(
      _resolveSpinnerLabelForTests(
        [
          { tool: "write_file", args: { path: "a.ts" }, status: "success" },
          { tool: "write_file", args: { path: "b.ts" }, status: "success" },
        ],
        "retrying…",
      ),
    ).toBe("retrying…")
  })
})
