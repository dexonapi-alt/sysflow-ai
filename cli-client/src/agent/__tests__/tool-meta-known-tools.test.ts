/**
 * Plan `2026-05-16-server-hardening-and-error-source-distinction.md` Stage 1.
 *
 * Tests for the canonical KNOWN_TOOL_NAMES set + isKnownTool validator.
 * The executor uses these to reject null / empty / hallucinated tool
 * names BEFORE dispatch, so the server never sees a row with a
 * NULL `tool` (which would crash the DB insert with a constraint
 * violation that surfaces as a raw 500 to the user).
 */

import { describe, it, expect } from "vitest"
import { KNOWN_TOOL_NAMES, isKnownTool, TOOL_META } from "../tool-meta.js"

describe("KNOWN_TOOL_NAMES — derived from TOOL_META registry", () => {
  it("contains every key from TOOL_META", () => {
    for (const tool of Object.keys(TOOL_META)) {
      expect(KNOWN_TOOL_NAMES.has(tool)).toBe(true)
    }
  })

  it("contains the canonical core tools", () => {
    const core = ["read_file", "write_file", "edit_file", "list_directory", "search_files", "run_command", "web_search", "reason", "check_jobs"]
    for (const tool of core) {
      expect(KNOWN_TOOL_NAMES.has(tool)).toBe(true)
    }
  })

  it("does NOT contain unknown / hallucinated tool names", () => {
    expect(KNOWN_TOOL_NAMES.has("magic_tool")).toBe(false)
    expect(KNOWN_TOOL_NAMES.has("eval_python")).toBe(false)
    expect(KNOWN_TOOL_NAMES.has("rm_rf")).toBe(false)
    expect(KNOWN_TOOL_NAMES.has("")).toBe(false)
  })
})

describe("isKnownTool", () => {
  it("returns true for known tools", () => {
    expect(isKnownTool("read_file")).toBe(true)
    expect(isKnownTool("run_command")).toBe(true)
    expect(isKnownTool("web_search")).toBe(true)
  })

  it("returns false for null", () => {
    expect(isKnownTool(null)).toBe(false)
  })

  it("returns false for undefined", () => {
    expect(isKnownTool(undefined)).toBe(false)
  })

  it("returns false for empty string", () => {
    expect(isKnownTool("")).toBe(false)
  })

  it("returns false for whitespace-only string", () => {
    // Whitespace-only doesn't match any TOOL_META key.
    expect(isKnownTool("   ")).toBe(false)
  })

  it("returns false for unknown tool name", () => {
    expect(isKnownTool("definitely_not_a_real_tool")).toBe(false)
  })

  it("returns false for non-string values (defensive)", () => {
    expect(isKnownTool(42)).toBe(false)
    expect(isKnownTool({})).toBe(false)
    expect(isKnownTool([])).toBe(false)
    expect(isKnownTool(true)).toBe(false)
  })

  it("is case-sensitive (rejects WRITE_FILE)", () => {
    expect(isKnownTool("WRITE_FILE")).toBe(false)
    expect(isKnownTool("Read_File")).toBe(false)
  })
})
