import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
  emitAgent,
  isInkActive,
  onAgent,
  redirectConsoleToInk,
  restoreConsole,
  shouldRenderInlineForLegacy,
  type AgentEvent,
} from "../events.js"

describe("isInkActive", () => {
  const originalInk = process.env.SYS_INK
  const originalLegacy = process.env.SYS_LEGACY

  beforeEach(() => {
    delete process.env.SYS_INK
    delete process.env.SYS_LEGACY
  })

  afterEach(() => {
    if (originalInk === undefined) delete process.env.SYS_INK
    else process.env.SYS_INK = originalInk
    if (originalLegacy === undefined) delete process.env.SYS_LEGACY
    else process.env.SYS_LEGACY = originalLegacy
  })

  it("defaults to true (Ink mode is the default after Phase 13)", () => {
    expect(isInkActive()).toBe(true)
  })

  it("returns false when SYS_INK=0", () => {
    process.env.SYS_INK = "0"
    expect(isInkActive()).toBe(false)
  })

  it("returns false when SYS_LEGACY=1", () => {
    process.env.SYS_LEGACY = "1"
    expect(isInkActive()).toBe(false)
  })

  it("returns true when SYS_INK is unset and SYS_LEGACY is unset (default)", () => {
    expect(isInkActive()).toBe(true)
  })

  it("backwards-compat: SYS_INK=1 still produces true (was the old opt-in)", () => {
    process.env.SYS_INK = "1"
    expect(isInkActive()).toBe(true)
  })
})

describe("shouldRenderInlineForLegacy (Phase 14 Stage 1)", () => {
  const originalInk = process.env.SYS_INK
  const originalLegacy = process.env.SYS_LEGACY

  beforeEach(() => {
    delete process.env.SYS_INK
    delete process.env.SYS_LEGACY
  })

  afterEach(() => {
    if (originalInk === undefined) delete process.env.SYS_INK
    else process.env.SYS_INK = originalInk
    if (originalLegacy === undefined) delete process.env.SYS_LEGACY
    else process.env.SYS_LEGACY = originalLegacy
  })

  it("returns false in default Ink mode (the legacy console box would double-render)", () => {
    expect(shouldRenderInlineForLegacy()).toBe(false)
  })

  it("returns true when SYS_INK=0", () => {
    process.env.SYS_INK = "0"
    expect(shouldRenderInlineForLegacy()).toBe(true)
  })

  it("returns true when SYS_LEGACY=1", () => {
    process.env.SYS_LEGACY = "1"
    expect(shouldRenderInlineForLegacy()).toBe(true)
  })

  it("is the strict inverse of isInkActive() — never the same value", () => {
    expect(shouldRenderInlineForLegacy()).toBe(!isInkActive())
    process.env.SYS_INK = "0"
    expect(shouldRenderInlineForLegacy()).toBe(!isInkActive())
    delete process.env.SYS_INK
    process.env.SYS_LEGACY = "1"
    expect(shouldRenderInlineForLegacy()).toBe(!isInkActive())
  })
})

describe("redirectConsoleToInk / restoreConsole", () => {
  // Capture every event the bus emits while the redirect is active so we
  // can assert without rendering Ink.
  let captured: AgentEvent[] = []
  let unsubscribe: () => void

  beforeEach(() => {
    captured = []
    unsubscribe = onAgent((event) => captured.push(event))
  })

  afterEach(() => {
    unsubscribe()
    restoreConsole() // ensure no leak between tests
  })

  it("routes console.log to a `log` event with level=info", () => {
    redirectConsoleToInk()
    console.log("hello world")
    restoreConsole()
    const log = captured.find((e) => e.type === "log")
    expect(log).toBeDefined()
    expect(log).toMatchObject({ type: "log", level: "info", text: "hello world" })
  })

  it("routes console.warn to level=warning", () => {
    redirectConsoleToInk()
    console.warn("careful")
    restoreConsole()
    const warn = captured.find((e) => e.type === "log" && e.level === "warning")
    expect(warn).toMatchObject({ level: "warning", text: "careful" })
  })

  it("routes console.error to level=error", () => {
    redirectConsoleToInk()
    console.error("boom")
    restoreConsole()
    const err = captured.find((e) => e.type === "log" && e.level === "error")
    expect(err).toMatchObject({ level: "error", text: "boom" })
  })

  it("strips ANSI escape sequences before emitting", () => {
    redirectConsoleToInk()
    console.log("\x1b[31mred text\x1b[0m and plain")
    restoreConsole()
    const log = captured.find((e) => e.type === "log")
    expect(log).toMatchObject({ text: "red text and plain" })
  })

  it("joins multiple args with spaces", () => {
    redirectConsoleToInk()
    console.log("a", "b", "c")
    restoreConsole()
    const log = captured.find((e) => e.type === "log")
    expect(log).toMatchObject({ text: "a b c" })
  })

  it("stringifies non-string args via JSON", () => {
    redirectConsoleToInk()
    console.log("count:", { n: 3 })
    restoreConsole()
    const log = captured.find((e) => e.type === "log")
    expect(log!.type).toBe("log")
    expect((log as { text: string }).text).toContain('"n":3')
  })

  it("Error instances surface their stack (or message)", () => {
    redirectConsoleToInk()
    console.error(new Error("oops"))
    restoreConsole()
    const err = captured.find((e) => e.type === "log" && e.level === "error")
    expect((err as { text: string }).text).toContain("oops")
  })

  it("restoreConsole undoes the patch — subsequent console.log goes nowhere on the bus", () => {
    redirectConsoleToInk()
    restoreConsole()
    captured = []
    // Spy on stdout via the original method — we can't observe it directly
    // here but we CAN observe that no new bus events arrived.
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    console.log("after restore")
    spy.mockRestore()
    expect(captured.find((e) => e.type === "log" && (e as { text: string }).text === "after restore")).toBeUndefined()
  })

  it("redirectConsoleToInk is idempotent (calling twice doesn't double-patch)", () => {
    redirectConsoleToInk()
    redirectConsoleToInk()
    console.log("once")
    restoreConsole()
    const logs = captured.filter((e) => e.type === "log" && (e as { text: string }).text === "once")
    expect(logs).toHaveLength(1)
  })

  it("emitAgent still works alongside redirected console — both reach the bus", () => {
    redirectConsoleToInk()
    console.log("from console")
    emitAgent({ type: "spinner", text: "thinking" })
    restoreConsole()
    expect(captured.some((e) => e.type === "log")).toBe(true)
    expect(captured.some((e) => e.type === "spinner")).toBe(true)
  })
})
