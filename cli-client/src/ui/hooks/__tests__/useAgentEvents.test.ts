import { describe, it, expect, beforeEach } from "vitest"
import { reduceAgentEvent, _resetIdsForTests, type AgentEventState } from "../useAgentEvents.js"

const initial: AgentEventState = { log: [], spinnerText: null, toolCards: [], awareness: null, chunk: null, assistantMessage: null, reasoningBrief: null, runStartedAt: null, runIntent: null, infraError: null }

beforeEach(() => _resetIdsForTests())

// Stage 4 of plan 2026-05-18-ui-ux-polish-and-action-aware-spinner.md (audit issue #1).
describe("reduceAgentEvent — infra_error event", () => {
  it("sets the infraError slot from a well-formed event", () => {
    const after = reduceAgentEvent(initial, {
      type: "infra_error",
      title: "SYSFLOW INFRASTRUCTURE ERROR",
      message: "OpenRouter returned 402: insufficient credits",
      hint: "Top up at openrouter.ai/credits and re-run.",
    })
    expect(after.infraError).toEqual({
      title: "SYSFLOW INFRASTRUCTURE ERROR",
      message: "OpenRouter returned 402: insufficient credits",
      hint: "Top up at openrouter.ai/credits and re-run.",
    })
  })

  it("normalises a missing hint to null (JSON-safe)", () => {
    const after = reduceAgentEvent(initial, {
      type: "infra_error",
      title: "X",
      message: "Y",
    })
    expect(after.infraError).toEqual({ title: "X", message: "Y", hint: null })
  })

  it("ignores events with an empty title (defensive)", () => {
    const after = reduceAgentEvent(initial, {
      type: "infra_error",
      title: "",
      message: "still no banner",
    })
    expect(after.infraError).toBeNull()
  })

  it("clear wipes the infraError slot (fresh prompt)", () => {
    const withBanner = reduceAgentEvent(initial, {
      type: "infra_error",
      title: "X",
      message: "Y",
    })
    expect(withBanner.infraError).not.toBeNull()
    const cleared = reduceAgentEvent(withBanner, { type: "clear" })
    expect(cleared.infraError).toBeNull()
  })
})

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

  // ─── Phase 16-fixup (Bug 5): run-level timer survives chunks ───

  it("runStartedAt is null on initial state", () => {
    expect(initial.runStartedAt).toBeNull()
  })

  it("runStartedAt is set on the first spinner event of a fresh run", () => {
    const before = Date.now()
    const after = reduceAgentEvent(initial, { type: "spinner", text: "thinking" })
    const t = after.runStartedAt
    expect(t).not.toBeNull()
    expect(t!).toBeGreaterThanOrEqual(before)
    expect(t!).toBeLessThanOrEqual(Date.now())
  })

  it("runStartedAt is preserved across spinner_stop → spinner restart (between chunks)", async () => {
    // First spinner stamps the start time.
    const a = reduceAgentEvent(initial, { type: "spinner", text: "first" })
    const stamped = a.runStartedAt
    expect(stamped).not.toBeNull()
    // Sleep just enough for a second spinner event to have a later Date.now()
    // value if the reducer were resetting it.
    await new Promise((resolve) => setTimeout(resolve, 5))
    // Spinner stops between chunks (spinner_stop) — runStartedAt must persist.
    const b = reduceAgentEvent(a, { type: "spinner_stop" })
    expect(b.runStartedAt).toBe(stamped)
    // New spinner for the next chunk — same run, same start time.
    const c = reduceAgentEvent(b, { type: "spinner", text: "second" })
    expect(c.runStartedAt).toBe(stamped)
  })

  it("complete clears runStartedAt (run is over; elapsed should stop)", () => {
    const a = reduceAgentEvent(initial, { type: "spinner", text: "x" })
    expect(a.runStartedAt).not.toBeNull()
    const b = reduceAgentEvent(a, { type: "complete" })
    expect(b.runStartedAt).toBeNull()
  })

  it("clear wipes runStartedAt along with everything else (new prompt = new run)", () => {
    const a = reduceAgentEvent(initial, { type: "spinner", text: "x" })
    expect(a.runStartedAt).not.toBeNull()
    const b = reduceAgentEvent(a, { type: "clear" })
    expect(b.runStartedAt).toBeNull()
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

describe("reduceAgentEvent — assistant_message (Phase 12 Stage 6)", () => {
  it("sets the assistant message with key=1 from null", () => {
    const after = reduceAgentEvent(initial, { type: "assistant_message", text: "Done — wrote 3 files." })
    expect(after.assistantMessage).toEqual({ text: "Done — wrote 3 files.", key: 1 })
  })

  it("increments key on a second emission so Typewriter re-mounts", () => {
    let s = reduceAgentEvent(initial, { type: "assistant_message", text: "first" })
    expect(s.assistantMessage?.key).toBe(1)
    s = reduceAgentEvent(s, { type: "assistant_message", text: "second" })
    expect(s.assistantMessage?.key).toBe(2)
    expect(s.assistantMessage?.text).toBe("second")
  })

  it("increments key even when text repeats (defensive against duplicate emissions)", () => {
    let s = reduceAgentEvent(initial, { type: "assistant_message", text: "same" })
    s = reduceAgentEvent(s, { type: "assistant_message", text: "same" })
    expect(s.assistantMessage?.key).toBe(2)
  })

  it("ignores empty-string text (no Typewriter for nothing)", () => {
    const s = reduceAgentEvent(initial, { type: "assistant_message", text: "" })
    expect(s.assistantMessage).toBeNull()
  })

  it("ignores non-string text (defensive type guard)", () => {
    // @ts-expect-error — intentional bad payload to assert the runtime guard
    const s = reduceAgentEvent(initial, { type: "assistant_message", text: 42 })
    expect(s.assistantMessage).toBeNull()
  })

  it("clear wipes the assistant message", () => {
    let s = reduceAgentEvent(initial, { type: "assistant_message", text: "hi" })
    expect(s.assistantMessage).not.toBeNull()
    s = reduceAgentEvent(s, { type: "clear" })
    expect(s.assistantMessage).toBeNull()
  })
})

describe("reduceAgentEvent — reasoning_brief (Phase 14 Stage 4)", () => {
  it("sets the brief from null with key=1", () => {
    const after = reduceAgentEvent(initial, {
      type: "reasoning_brief",
      kind: "implement",
      briefData: { confidence: "HIGH" },
    })
    expect(after.reasoningBrief).toMatchObject({
      kind: "implement",
      briefData: { confidence: "HIGH" },
      key: 1,
    })
  })

  it("ignores empty / non-string kind defensively", () => {
    expect(reduceAgentEvent(initial, { type: "reasoning_brief", kind: "" }).reasoningBrief).toBeNull()
    // @ts-expect-error — intentional bad payload
    expect(reduceAgentEvent(initial, { type: "reasoning_brief", kind: 42 }).reasoningBrief).toBeNull()
  })

  it("increments key on each new brief (so the Pulse re-fires)", () => {
    let s = reduceAgentEvent(initial, { type: "reasoning_brief", kind: "implement" })
    expect(s.reasoningBrief?.key).toBe(1)
    s = reduceAgentEvent(s, { type: "reasoning_brief", kind: "bug" })
    expect(s.reasoningBrief?.key).toBe(2)
    expect(s.reasoningBrief?.kind).toBe("bug")
  })

  it("clear wipes the brief", () => {
    let s = reduceAgentEvent(initial, { type: "reasoning_brief", kind: "implement" })
    expect(s.reasoningBrief).not.toBeNull()
    s = reduceAgentEvent(s, { type: "clear" })
    expect(s.reasoningBrief).toBeNull()
  })

  it("preserves briefData across emissions (most-recent wins)", () => {
    let s = reduceAgentEvent(initial, { type: "reasoning_brief", kind: "implement", briefData: { confidence: "HIGH" } })
    s = reduceAgentEvent(s, { type: "reasoning_brief", kind: "implement", briefData: { confidence: "LOW" } })
    expect(s.reasoningBrief?.briefData).toEqual({ confidence: "LOW" })
  })
})

// ─── Phase 19: intent_classified reducer slot ───

describe("reduceAgentEvent — intent_classified (Phase 19)", () => {
  it("runIntent is null on initial state", () => {
    expect(initial.runIntent).toBeNull()
  })

  it("sets runIntent for each known intent value", () => {
    for (const intent of ["simple", "summary", "bug", "implement"] as const) {
      const s = reduceAgentEvent(initial, { type: "intent_classified", intent })
      expect(s.runIntent).toBe(intent)
    }
  })

  it("ignores unknown intent values (defensive against malformed payloads)", () => {
    // @ts-expect-error — deliberately passing an out-of-enum value
    const s = reduceAgentEvent(initial, { type: "intent_classified", intent: "garbage" })
    expect(s.runIntent).toBeNull()
  })

  it("most-recent wins when multiple events arrive on the same run", () => {
    let s = reduceAgentEvent(initial, { type: "intent_classified", intent: "simple" })
    expect(s.runIntent).toBe("simple")
    s = reduceAgentEvent(s, { type: "intent_classified", intent: "implement" })
    expect(s.runIntent).toBe("implement")
  })

  it("runIntent survives across spinner / tool / brief events", () => {
    let s = reduceAgentEvent(initial, { type: "intent_classified", intent: "implement" })
    s = reduceAgentEvent(s, { type: "spinner", text: "thinking" })
    s = reduceAgentEvent(s, { type: "tool_start", id: "t1", tool: "read_file", label: "Read(foo.ts)" })
    s = reduceAgentEvent(s, { type: "chunk_plan", chunkIndex: 1, nextAction: "write models" })
    s = reduceAgentEvent(s, { type: "reasoning_brief", kind: "implement" })
    expect(s.runIntent).toBe("implement")
  })

  it("clear wipes runIntent", () => {
    let s = reduceAgentEvent(initial, { type: "intent_classified", intent: "implement" })
    expect(s.runIntent).toBe("implement")
    s = reduceAgentEvent(s, { type: "clear" })
    expect(s.runIntent).toBeNull()
  })

  it("complete does NOT wipe runIntent (terminal exit still wants the badge state)", () => {
    let s = reduceAgentEvent(initial, { type: "intent_classified", intent: "implement" })
    s = reduceAgentEvent(s, { type: "complete" })
    // Reducer leaves runIntent alone on complete — it's the *next prompt's*
    // `clear` that drops it. Lets a post-completion render still see the
    // intent if anything reads it during the final repaint.
    expect(s.runIntent).toBe("implement")
  })
})
