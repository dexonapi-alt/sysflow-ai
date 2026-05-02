import { describe, it, expect } from "vitest"
import { checkPermissions, matchesGlob, primaryPath, type Rule } from "../permissions.js"

describe("matchesGlob", () => {
  it("literal text matches itself", () => {
    expect(matchesGlob("foo/bar.ts", "foo/bar.ts")).toBe(true)
  })
  it("* matches a single segment", () => {
    expect(matchesGlob("foo/bar.ts", "foo/*.ts")).toBe(true)
    expect(matchesGlob("foo/sub/bar.ts", "foo/*.ts")).toBe(false)
  })
  it("** matches across separators", () => {
    expect(matchesGlob("foo/sub/bar.ts", "foo/**/bar.ts")).toBe(true)
    expect(matchesGlob("foo/bar.ts", "foo/**/bar.ts")).toBe(true)
  })
  it("escapes regex metacharacters", () => {
    expect(matchesGlob("foo.bar+baz", "foo.bar+baz")).toBe(true)
    expect(matchesGlob("fooXbar", "foo.bar")).toBe(false)
  })
})

describe("primaryPath", () => {
  it("uses path for most tools", () => {
    expect(primaryPath("read_file", { path: "x" })).toBe("x")
  })
  it("uses from for move_file", () => {
    expect(primaryPath("move_file", { from: "a", to: "b" })).toBe("a")
  })
  it("uses command for run_command", () => {
    expect(primaryPath("run_command", { command: "npm i" })).toBe("npm i")
  })
  it("returns null when no recognised field", () => {
    expect(primaryPath("read_file", {})).toBeNull()
  })
})

describe("checkPermissions", () => {
  const rules: Rule[] = []

  it("bypass mode allows everything", () => {
    expect(checkPermissions({ tool: "run_command", args: { command: "rm -rf /" }, mode: "bypass", rules }).decision).toBe("allow")
  })

  it("plan mode allows read tools, denies writes", () => {
    expect(checkPermissions({ tool: "read_file", args: { path: "x" }, mode: "plan", rules }).decision).toBe("allow")
    expect(checkPermissions({ tool: "write_file", args: { path: "x", content: "" }, mode: "plan", rules }).decision).toBe("deny")
    expect(checkPermissions({ tool: "run_command", args: { command: "ls" }, mode: "plan", rules }).decision).toBe("deny")
  })

  it("read tools default to allow in default mode", () => {
    expect(checkPermissions({ tool: "read_file", args: { path: "x" }, mode: "default", rules }).decision).toBe("allow")
    expect(checkPermissions({ tool: "list_directory", args: { path: "." }, mode: "default", rules }).decision).toBe("allow")
  })

  it("write tools default to ask in default mode", () => {
    expect(checkPermissions({ tool: "write_file", args: { path: "x", content: "" }, mode: "default", rules }).decision).toBe("ask")
    expect(checkPermissions({ tool: "run_command", args: { command: "ls" }, mode: "default", rules }).decision).toBe("ask")
  })

  it("auto mode escalates read tools to allow", () => {
    expect(checkPermissions({ tool: "read_file", args: { path: "x" }, mode: "auto", rules }).decision).toBe("allow")
    // Write tools still ask in auto mode (user must confirm once per pattern).
    expect(checkPermissions({ tool: "write_file", args: { path: "x", content: "" }, mode: "auto", rules }).decision).toBe("ask")
  })

  it("rules override defaults; longest pattern wins", () => {
    const localRules: Rule[] = [
      { tool: "write_file", pattern: "**/*", decision: "deny" },
      { tool: "write_file", pattern: "src/scratch/**", decision: "allow" },
    ]
    expect(checkPermissions({ tool: "write_file", args: { path: "src/scratch/x.ts", content: "" }, mode: "default", rules: localRules }).decision).toBe("allow")
    expect(checkPermissions({ tool: "write_file", args: { path: "src/lib/x.ts", content: "" }, mode: "default", rules: localRules }).decision).toBe("deny")
  })

  it("wildcard tool='*' rule applies to any tool", () => {
    const localRules: Rule[] = [{ tool: "*", pattern: "node_modules/**", decision: "deny" }]
    expect(checkPermissions({ tool: "read_file", args: { path: "node_modules/foo/bar.ts" }, mode: "default", rules: localRules }).decision).toBe("deny")
  })
})
