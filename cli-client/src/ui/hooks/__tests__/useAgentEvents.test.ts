import { describe, it, expect, beforeEach } from "vitest"
import { reduceAgentEvent, _resetIdsForTests, type AgentEventState } from "../useAgentEvents.js"

const initial: AgentEventState = { log: [], spinnerText: null, toolCards: [], awareness: null, chunk: null }

beforeEach(() => _resetIdsForTests())

describe("reduceAgentEvent — log + spinner", () => {
  it("appends log entries with auto-incrementing ids", () => {
    const after1 = reduceAgentEvent(initial, { type: "log", level: "info", text: "first" })
    const after2 = reduceAgentEvent(after1, { type: "log", level: "muted", text: "second" })
    expect(after2.log).toHaveLength(2)
    expect(after2.log[0].id).not.toBe(after2.log[1].id)
    expect(after2.log[0].text).toBe("first")
    expect(after2.log[1].text).toBe("second")
  })

  it("spinner sets spinnerText, spinner_stop clears it", () => {
    const a = reduceAgentEvent(initial, { type: "spinner", text: "thinking" })
    expect(a.spinnerText).toBe("thinking")
    const b = reduceAgentEvent(a, { type: "spinner_stop" })
    expect(b.spinnerText).toBeNull()
  })

  it("complete also clears the spinner", () => {
    const a = reduceAgentEvent(initial, { type: "spinner", text: "x" })
    const b = reduceAgentEvent(a, { type: "complete" })
    expect(b.spinnerText).toBeNull()
  })

  it("clear wipes log + spinner + tool cards", () => {
    let s: AgentEventState = initial
    s = reduceAgentEvent(s, { type: "log", level: "info", text: "x" })
    s = reduceAgentEvent(s, { type: "spinner", text: "y" })
    s = reduceAgentEvent(s, { type: "tool_start", id: "t1", tool: "write_file", label: "write_file index.js" })
    s = reduceAgentEvent(s, { type: "clear" })
    expect(s.log).toEqual([])
    expect(s.spinnerText).toBeNull()
    expect(s.toolCards).toEqual([])
  })
})

describe("reduceAgentEvent — tool cards (Phase 12 Stage 4)", () => {
  it("tool_start adds a card with status=running and the supplied metadata", () => {
    const after = reduceAgentEvent(initial, {
      type: "tool_start",
      id: "t1",
      tool: "write_file",
      label: "write_file src/index.js",
    })
    expect(after.toolCards).toHaveLength(1)
    expect(after.toolCards[0]).toMatchObject({
      id: "t1",
      tool: "write_file",
      label: "write_file src/index.js",
      status: "running",
    })
    expect(after.toolCards[0].startedAt).toBeGreaterThan(0)
  })

  it("tool_start ignores a duplicate id (no double-cards)", () => {
    const a = reduceAgentEvent(initial, { type: "tool_start", id: "t1", tool: "x", label: "x" })
    const b = reduceAgentEvent(a, { type: "tool_start", id: "t1", tool: "x", label: "x again" })
    expect(b.toolCards).toHaveLength(1)
    expect(b.toolCards[0].label).toBe("x") // first one wins, second is ignored
  })

  it("tool_end with ok=true transitions the matching card to success", () => {
    let s = reduceAgentEvent(initial, { type: "tool_start", id: "t1", tool: "x", label: "x" })
    s = reduceAgentEvent(s, { type: "tool_end", id: "t1", ok: true })
    expect(s.toolCards[0].status).toBe("success")
    expect(s.toolCards[0].error).toBeUndefined()
  })

  it("tool_end with ok=false transitions to error and stores the message", () => {
    let s = reduceAgentEvent(initial, { type: "tool_start", id: "t1", tool: "x", label: "x" })
    s = reduceAgentEvent(s, { type: "tool_end", id: "t1", ok: false, error: "ENOENT" })
    expect(s.toolCards[0].status).toBe("error")
    expect(s.toolCards[0].error).toBe("ENOENT")
  })

  it("tool_end without a matching tool_start is ignored (defensive)", () => {
    const s = reduceAgentEvent(initial, { type: "tool_end", id: "ghost", ok: true })
    expect(s.toolCards).toEqual([])
  })

  it("multiple cards accumulate in mount order", () => {
    let s = initial
    s = reduceAgentEvent(s, { type: "tool_start", id: "a", tool: "read_file", label: "read a" })
    s = reduceAgentEvent(s, { type: "tool_start", id: "b", tool: "write_file", label: "write b" })
    s = reduceAgentEvent(s, { type: "tool_start", id: "c", tool: "list_directory", label: "ls c" })
    expect(s.toolCards.map((card) => card.id)).toEqual(["a", "b", "c"])
  })

  it("transitioning one card doesn't disturb the others", () => {
    let s = initial
    s = reduceAgentEvent(s, { type: "tool_start", id: "a", tool: "x", label: "a" })
    s = reduceAgentEvent(s, { type: "tool_start", id: "b", tool: "x", label: "b" })
    s = reduceAgentEvent(s, { type: "tool_end", id: "a", ok: true })
    expect(s.toolCards[0].status).toBe("success")
    expect(s.toolCards[1].status).toBe("running")
  })
})

describe("reduceAgentEvent — awareness + chunk (Phase 12 Stage 5)", () => {
  it("awareness_update sets the snapshot from null", () => {
    const after = reduceAgentEvent(initial, {
      type: "awareness_update",
      state: "off_course",
      confidence: 55,
      lastSignal: "tool error 'edit_file' repeated 3 times",
    })
    expect(after.awareness).toMatchObject({
      state: "off_course",
      confidence: 55,
      lastSignal: "tool error 'edit_file' repeated 3 times",
    })
  })

  it("awareness_update without lastSignal stores null", () => {
    const after = reduceAgentEvent(initial, {
      type: "awareness_update",
      state: "on_track",
      confidence: 100,
    })
    expect(after.awareness?.lastSignal).toBeNull()
  })

  it("awareness_update overwrites prior snapshot (most recent wins)", () => {
    let s = reduceAgentEvent(initial, { type: "awareness_update", state: "on_track", confidence: 100 })
    s = reduceAgentEvent(s, { type: "awareness_update", state: "blocked", confidence: 25, lastSignal: "x" })
    expect(s.awareness?.state).toBe("blocked")
    expect(s.awareness?.confidence).toBe(25)
  })

  it("chunk_plan sets the chunk state from null", () => {
    const after = reduceAgentEvent(initial, {
      type: "chunk_plan",
      chunkIndex: 1,
      nextAction: "write models",
      fileCount: 3,
    })
    expect(after.chunk).toMatchObject({
      index: 1,
      nextAction: "write models",
      fileCount: 3,
    })
    expect(after.chunk?.pulseKey).toBe(1)
  })

  it("chunk_plan defaults fileCount to 0 when omitted", () => {
    const after = reduceAgentEvent(initial, {
      type: "chunk_plan",
      chunkIndex: 1,
      nextAction: "polish",
    })
    expect(after.chunk?.fileCount).toBe(0)
  })

  it("chunk_plan increments pulseKey monotonically across chunks", () => {
    let s = reduceAgentEvent(initial, { type: "chunk_plan", chunkIndex: 1, nextAction: "a" })
    expect(s.chunk?.pulseKey).toBe(1)
    s = reduceAgentEvent(s, { type: "chunk_plan", chunkIndex: 2, nextAction: "b" })
    expect(s.chunk?.pulseKey).toBe(2)
    s = reduceAgentEvent(s, { type: "chunk_plan", chunkIndex: 3, nextAction: "c" })
    expect(s.chunk?.pulseKey).toBe(3)
  })

  it("pulseKey increments even when chunkIndex repeats (defensive)", () => {
    let s = reduceAgentEvent(initial, { type: "chunk_plan", chunkIndex: 5, nextAction: "a" })
    s = reduceAgentEvent(s, { type: "chunk_plan", chunkIndex: 5, nextAction: "still a" })
    expect(s.chunk?.pulseKey).toBe(2)
  })

  it("clear wipes both awareness and chunk state", () => {
    let s = reduceAgentEvent(initial, { type: "awareness_update", state: "blocked", confidence: 25 })
    s = reduceAgentEvent(s, { type: "chunk_plan", chunkIndex: 3, nextAction: "x" })
    s = reduceAgentEvent(s, { type: "clear" })
    expect(s.awareness).toBeNull()
    expect(s.chunk).toBeNull()
  })
})
