/**
 * Stage 4.1 of `2026-05-16-awareness-and-verification-correctness.md`.
 *
 * Per-run client-platform store tests.
 */

import { describe, it, expect, beforeEach } from "vitest"
import {
  setRunPlatform,
  getRunPlatform,
  resolveRunPlatform,
  clearRunPlatform,
  _resetRunPlatformStoreForTests,
} from "../run-platform-store.js"

beforeEach(() => {
  _resetRunPlatformStoreForTests()
})

describe("run-platform-store", () => {
  it("returns undefined for an unknown runId", () => {
    expect(getRunPlatform("nonexistent")).toBeUndefined()
  })

  it("stores and returns a platform set via setRunPlatform", () => {
    setRunPlatform("run-1", "win32")
    expect(getRunPlatform("run-1")).toBe("win32")
  })

  it("supports multiple concurrent runs (per-run isolation)", () => {
    setRunPlatform("run-A", "win32")
    setRunPlatform("run-B", "darwin")
    setRunPlatform("run-C", "linux")
    expect(getRunPlatform("run-A")).toBe("win32")
    expect(getRunPlatform("run-B")).toBe("darwin")
    expect(getRunPlatform("run-C")).toBe("linux")
  })

  it("clearRunPlatform removes the entry for one run only", () => {
    setRunPlatform("run-A", "win32")
    setRunPlatform("run-B", "linux")
    clearRunPlatform("run-A")
    expect(getRunPlatform("run-A")).toBeUndefined()
    expect(getRunPlatform("run-B")).toBe("linux")
  })

  it("clearRunPlatform is idempotent on unknown runs", () => {
    expect(() => clearRunPlatform("nonexistent")).not.toThrow()
  })

  it("resolveRunPlatform returns the stored platform when present", () => {
    setRunPlatform("run-1", "win32")
    expect(resolveRunPlatform("run-1")).toBe("win32")
  })

  it("resolveRunPlatform falls back to process.platform when no entry exists", () => {
    expect(resolveRunPlatform("never-set")).toBe(process.platform)
  })

  it("setRunPlatform overwrites a previously-set value for the same run", () => {
    setRunPlatform("run-1", "win32")
    setRunPlatform("run-1", "linux")
    expect(getRunPlatform("run-1")).toBe("linux")
  })

  it("post-clear resolveRunPlatform falls back to process.platform again", () => {
    setRunPlatform("run-1", "win32")
    clearRunPlatform("run-1")
    expect(resolveRunPlatform("run-1")).toBe(process.platform)
  })
})
