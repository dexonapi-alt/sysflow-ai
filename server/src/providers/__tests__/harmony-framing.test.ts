import { describe, it, expect } from "vitest"
import { stripHarmonyFraming } from "../base-provider.js"

describe("stripHarmonyFraming", () => {
  it("returns input unchanged when no harmony tokens", () => {
    expect(stripHarmonyFraming(`{"kind":"completed"}`)).toBe(`{"kind":"completed"}`)
    expect(stripHarmonyFraming("plain text")).toBe("plain text")
  })

  it("strips <|channel|>commentary<|message|> wrapping a tool-arg JSON", () => {
    const raw = `<|channel|>commentary<|message|>{
  "path": "server.js",
  "offset": 0,
  "limit": 400
}`
    expect(stripHarmonyFraming(raw)).toContain(`"path": "server.js"`)
    expect(stripHarmonyFraming(raw)).not.toContain("<|")
  })

  it("drops the analysis channel content", () => {
    const raw = `<|start|>assistant<|channel|>analysis<|message|>Let me think about this carefully...<|channel|>final<|message|>The answer is 42.<|return|>`
    const out = stripHarmonyFraming(raw)
    expect(out).not.toContain("Let me think")
    expect(out).toContain("The answer is 42.")
  })

  it("strips return/end/start markers", () => {
    expect(stripHarmonyFraming(`<|start|>assistant<|message|>hi<|end|>`)).toBe("hi")
    expect(stripHarmonyFraming(`hi<|return|>`)).toBe("hi")
  })

  it("strips ChatML <|im_start|> / <|im_end|>", () => {
    expect(stripHarmonyFraming(`<|im_start|>assistant\nfoo<|im_end|>`)).toBe("foo")
  })

  it("strips <|recipient|>functions.<name><|message|> framing", () => {
    const raw = `<|recipient|>functions.read_file<|message|>{"path":"x"}`
    expect(stripHarmonyFraming(raw)).toBe(`{"path":"x"}`)
  })
})
