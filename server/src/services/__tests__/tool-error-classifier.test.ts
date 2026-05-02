import { describe, it, expect } from "vitest"
import { classifyToolError, classifyToolErrorFromResult } from "../tool-error-classifier.js"

describe("classifyToolError", () => {
  it("ENOENT → file_not_found", () => {
    expect(classifyToolError("read_file", "ENOENT: no such file").category).toBe("file_not_found")
  })
  it("EACCES → permission", () => {
    expect(classifyToolError("read_file", "EACCES: permission denied").category).toBe("permission")
  })
  it("ETIMEDOUT → timeout", () => {
    expect(classifyToolError("run_command", "Request timed out").category).toBe("timeout")
  })
  it("'command not found' → command_not_found", () => {
    expect(classifyToolError("run_command", "tailwindcss: command not found").category).toBe("command_not_found")
  })
  it("validation hint includes 'INVALID ARGUMENTS' when category is validation", () => {
    expect(classifyToolError("read_file", "validation failed: missing path").category).toBe("validation")
  })
  it("auth errors", () => {
    expect(classifyToolError("web_search", "401 Unauthorized: bad API key").category).toBe("auth")
  })
  it("network errors", () => {
    expect(classifyToolError("web_search", "ECONNREFUSED on 8.8.8.8").category).toBe("network")
  })
  it("falls through to unknown for anything else", () => {
    expect(classifyToolError("read_file", "totally novel error").category).toBe("unknown")
  })
  it("falls through to command_failed for run_command + unknown", () => {
    expect(classifyToolError("run_command", "exit 1").category).toBe("command_failed")
  })
})

describe("classifyToolErrorFromResult", () => {
  it("trusts a preset _errorCategory: validation", () => {
    const r = classifyToolErrorFromResult("read_file", { _errorCategory: "validation", error: "bad args" })
    expect(r.category).toBe("validation")
    expect(r.hint).toBe("bad args")
  })
  it("trusts a preset _errorCategory: permission", () => {
    const r = classifyToolErrorFromResult("write_file", { _errorCategory: "permission", error: "denied" })
    expect(r.category).toBe("permission")
  })
  it("falls through when no preset", () => {
    const r = classifyToolErrorFromResult("read_file", { error: "ENOENT: no such file" })
    expect(r.category).toBe("file_not_found")
  })
})
