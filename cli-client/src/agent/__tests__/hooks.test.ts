import { describe, it, expect, beforeEach } from "vitest"
import { registerHook, runHooks, clearHooks } from "../hooks.js"

describe("hooks", () => {
  beforeEach(() => clearHooks())

  it("runs hooks in registration order", async () => {
    const calls: string[] = []
    registerHook("pre_tool_use", () => { calls.push("a") }, "a")
    registerHook("pre_tool_use", () => { calls.push("b") }, "b")
    registerHook("pre_tool_use", () => { calls.push("c") }, "c")
    await runHooks("pre_tool_use", { event: "pre_tool_use", tool: "x", args: {} })
    expect(calls).toEqual(["a", "b", "c"])
  })

  it("first override wins; later overrides ignored", async () => {
    registerHook("pre_tool_use", () => ({ override: "deny" }), "denier")
    registerHook("pre_tool_use", () => ({ override: "allow" }), "allower")
    const summary = await runHooks("pre_tool_use", { event: "pre_tool_use", tool: "x", args: {} })
    expect(summary.override).toBe("deny")
  })

  it("prevent flag short-circuits but later hooks still observe", async () => {
    const calls: string[] = []
    registerHook("pre_tool_use", () => { calls.push("a"); return { prevent: true } }, "preventer")
    registerHook("pre_tool_use", () => { calls.push("b") }, "observer")
    const summary = await runHooks("pre_tool_use", { event: "pre_tool_use", tool: "x", args: {} })
    expect(summary.prevent).toBe(true)
    expect(calls).toEqual(["a", "b"])
  })

  it("hook throws don't break the chain", async () => {
    const calls: string[] = []
    registerHook("post_tool_use", () => { throw new Error("boom") }, "thrower")
    registerHook("post_tool_use", () => { calls.push("after") }, "after")
    await runHooks("post_tool_use", { event: "post_tool_use", tool: "x", args: {} })
    expect(calls).toEqual(["after"])
  })

  it("notes accumulate across hooks", async () => {
    registerHook("pre_tool_use", () => ({ note: "from a" }), "a")
    registerHook("pre_tool_use", () => ({ note: "from b" }), "b")
    const summary = await runHooks("pre_tool_use", { event: "pre_tool_use", tool: "x", args: {} })
    expect(summary.notes).toEqual([
      { source: "a", note: "from a" },
      { source: "b", note: "from b" },
    ])
  })

  it("prevent only applies on pre_tool_use", async () => {
    registerHook("post_tool_use", () => ({ prevent: true }), "x")
    const summary = await runHooks("post_tool_use", { event: "post_tool_use", tool: "x", args: {} })
    expect(summary.prevent).toBe(false)
  })
})
