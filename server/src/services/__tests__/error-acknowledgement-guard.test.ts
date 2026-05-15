/**
 * Plan `2026-05-15-forced-error-reasoning-and-recovery.md` Stage 4.
 *
 * Tests for the pure validator that decides whether the model's
 * response after a tool error addressed the error or silently moved
 * on. The validator's two-pass shape:
 *   - Same (tool, primaryArg) as the failure → hard fail
 *   - Reasoning text overlaps error vocab → pass
 *   - Different tool used → pass (acknowledged via action)
 *   - None of the above → soft fail
 */

import { describe, it, expect } from "vitest"
import {
  validateErrorAcknowledgement,
  buildErrorAcknowledgementRejectPrompt,
  hasMeaningfulOverlap,
  tokenise,
  primaryArg,
  type ErrorAcknowledgementContext,
} from "../error-acknowledgement-guard.js"

const baseCtx: ErrorAcknowledgementContext = {
  errorText: "'ls' is not recognized as an internal or external command",
  rootCause: "Windows cmd.exe does not have ls as a built-in",
  failedTool: "run_command",
  failedPrimaryArg: "ls -R",
}

describe("tokenise", () => {
  it("lower-cases + drops stopwords + drops short tokens", () => {
    const out = tokenise("The agent has been running with errors")
    expect(out).not.toContain("the")
    expect(out).not.toContain("has")
    expect(out).not.toContain("been")
    expect(out).toContain("agent")
    expect(out).toContain("running")
    expect(out).toContain("errors")
  })

  it("keeps dotted-path / dash / underscore tokens whole", () => {
    const out = tokenise("the foo.bar.baz file errored")
    expect(out).toContain("foo.bar.baz")
    expect(out).toContain("errored")
  })

  it("drops tokens shorter than 4 chars", () => {
    const out = tokenise("ls is a unix tool not in cmd.exe")
    expect(out).not.toContain("ls")
    expect(out).not.toContain("is")
    expect(out).toContain("unix")
    expect(out).toContain("tool")
    expect(out).toContain("cmd.exe")
  })
})

describe("primaryArg", () => {
  it("returns args.command for run_command", () => {
    expect(primaryArg("run_command", { command: "ls -R" })).toBe("ls -R")
  })

  it("returns args.path for write_file / edit_file / batch_write / read_file / create_directory", () => {
    for (const tool of ["write_file", "edit_file", "batch_write", "read_file", "create_directory"]) {
      expect(primaryArg(tool, { path: "src/foo.ts" })).toBe("src/foo.ts")
    }
  })

  it("returns undefined for tools without an identifiable primary arg", () => {
    expect(primaryArg("web_search", { query: "foo" })).toBeUndefined()
    expect(primaryArg("_user_response", { answer: "yes" })).toBeUndefined()
  })

  it("returns undefined when args is missing / null / wrong shape", () => {
    expect(primaryArg("run_command", null)).toBeUndefined()
    expect(primaryArg("run_command", undefined)).toBeUndefined()
    expect(primaryArg("run_command", {})).toBeUndefined()
    expect(primaryArg("run_command", { command: 42 as unknown as string })).toBeUndefined()
  })
})

describe("hasMeaningfulOverlap", () => {
  it("returns true when reasoning shares enough vocab with error+cause", () => {
    const result = hasMeaningfulOverlap(
      "The command failed because cmd.exe does not recognize ls. I will use Get-ChildItem instead.",
      baseCtx.errorText,
      baseCtx.rootCause,
    )
    expect(result).toBe(true)
  })

  it("returns false when reasoning is generic / off-topic", () => {
    const result = hasMeaningfulOverlap(
      "Continuing with the next step in the implementation plan as outlined earlier.",
      baseCtx.errorText,
      baseCtx.rootCause,
    )
    expect(result).toBe(false)
  })

  it("returns true (pass-through) when error vocab is too small to measure", () => {
    // Short error/cause → too few tokens for stable overlap measurement
    const result = hasMeaningfulOverlap("anything", "ls", "win")
    expect(result).toBe(true)
  })

  it("returns false when reasoning is empty", () => {
    const result = hasMeaningfulOverlap("", baseCtx.errorText, baseCtx.rootCause)
    expect(result).toBe(false)
  })
})

describe("validateErrorAcknowledgement — hard-fail on same (tool, primaryArg)", () => {
  it("fails when retrying the same run_command", () => {
    const out = validateErrorAcknowledgement({
      responseKind: "needs_tool",
      reasoningChain: ["The user wants me to list files. Trying again."],
      content: null,
      responseTool: "run_command",
      responseArgs: { command: "ls -R" },
      context: baseCtx,
    })
    expect(out.ok).toBe(false)
    expect(out.reason).toContain("same failed")
    expect(out.reason).toContain("run_command")
  })

  it("fails even if reasoning had ack text but command is the same", () => {
    const out = validateErrorAcknowledgement({
      responseKind: "needs_tool",
      reasoningChain: [
        "The cmd.exe error means ls isn't recognized. Trying again anyway.",
      ],
      content: null,
      responseTool: "run_command",
      responseArgs: { command: "ls -R" },
      context: baseCtx,
    })
    expect(out.ok).toBe(false)
  })

  it("fails when retrying the same write_file path", () => {
    const ctx = { ...baseCtx, failedTool: "write_file", failedPrimaryArg: "src/foo.ts" }
    const out = validateErrorAcknowledgement({
      responseKind: "needs_tool",
      reasoningChain: ["Retrying."],
      content: null,
      responseTool: "write_file",
      responseArgs: { path: "src/foo.ts", content: "different content" },
      context: ctx,
    })
    expect(out.ok).toBe(false)
  })

  it("passes when same tool but different primary arg", () => {
    const out = validateErrorAcknowledgement({
      responseKind: "needs_tool",
      reasoningChain: ["x"],
      content: null,
      responseTool: "run_command",
      responseArgs: { command: "dir /s" },
      context: baseCtx,
    })
    expect(out.ok).toBe(true)
  })
})

describe("validateErrorAcknowledgement — acknowledgement via reasoning text", () => {
  it("passes when reasoningChain mentions enough error vocab", () => {
    const out = validateErrorAcknowledgement({
      responseKind: "needs_tool",
      reasoningChain: [
        "The cmd.exe error means ls is not recognized as a built-in. I'll use Get-ChildItem instead — it's the PowerShell equivalent.",
      ],
      content: null,
      responseTool: "run_command",
      responseArgs: { command: "Get-ChildItem -Recurse" },
      context: baseCtx,
    })
    expect(out.ok).toBe(true)
  })

  it("passes when content (instead of reasoningChain) has the ack text", () => {
    const out = validateErrorAcknowledgement({
      responseKind: "needs_tool",
      reasoningChain: [],
      content: "The cmd.exe failure on ls means the agent needs to recognize and pivot. Using PowerShell built-in instead.",
      responseTool: "run_command",
      responseArgs: { command: "Get-ChildItem" },
      context: baseCtx,
    })
    expect(out.ok).toBe(true)
  })
})

describe("validateErrorAcknowledgement — acknowledgement via pivot", () => {
  it("passes when switching to a different tool, even without ack text", () => {
    const out = validateErrorAcknowledgement({
      responseKind: "needs_tool",
      reasoningChain: ["Trying a different angle."],
      content: null,
      responseTool: "read_file",
      responseArgs: { path: "package.json" },
      context: baseCtx,
    })
    expect(out.ok).toBe(true)
  })
})

describe("validateErrorAcknowledgement — non-tool responses pass", () => {
  it("passes on completed", () => {
    const out = validateErrorAcknowledgement({
      responseKind: "completed",
      reasoningChain: [],
      content: "Done.",
      responseTool: null,
      responseArgs: null,
      context: baseCtx,
    })
    expect(out.ok).toBe(true)
  })

  it("passes on failed", () => {
    const out = validateErrorAcknowledgement({
      responseKind: "failed",
      reasoningChain: [],
      content: null,
      responseTool: null,
      responseArgs: null,
      context: baseCtx,
    })
    expect(out.ok).toBe(true)
  })

  it("passes on waiting_for_user", () => {
    const out = validateErrorAcknowledgement({
      responseKind: "waiting_for_user",
      reasoningChain: [],
      content: "What should I do?",
      responseTool: null,
      responseArgs: null,
      context: baseCtx,
    })
    expect(out.ok).toBe(true)
  })
})

describe("validateErrorAcknowledgement — soft-fail (same tool, no ack, similar args)", () => {
  it("fails when same tool + no ack text + similar arg (different command but no engagement)", () => {
    const out = validateErrorAcknowledgement({
      responseKind: "needs_tool",
      reasoningChain: ["Moving on with the plan."],
      content: null,
      responseTool: "run_command",
      responseArgs: { command: "npm install lodash" },  // different arg
      context: baseCtx,
    })
    expect(out.ok).toBe(false)
    expect(out.reason).toContain("did not acknowledge")
  })
})

describe("buildErrorAcknowledgementRejectPrompt", () => {
  it("includes rejection count + remaining + cap", () => {
    const out = buildErrorAcknowledgementRejectPrompt(
      { ok: false, reason: "test reason" },
      baseCtx,
      2,
      3,
    )
    expect(out).toContain("rejection 2 of 3")
    expect(out).toContain("1 retry left")
  })

  it("uses singular vs plural for retry count", () => {
    const one = buildErrorAcknowledgementRejectPrompt({ ok: false }, baseCtx, 2, 3)
    expect(one).toContain("1 retry left")

    const two = buildErrorAcknowledgementRejectPrompt({ ok: false }, baseCtx, 1, 3)
    expect(two).toContain("2 retries left")
  })

  it("quotes the reasoner's root cause", () => {
    const out = buildErrorAcknowledgementRejectPrompt({ ok: false }, baseCtx, 1, 3)
    expect(out).toContain("Windows cmd.exe does not have ls")
  })

  it("includes the don't-retry-same-command directive", () => {
    const out = buildErrorAcknowledgementRejectPrompt({ ok: false }, baseCtx, 1, 3)
    const normalised = out.replace(/\s+/g, " ")
    expect(normalised).toContain("Do NOT switch topics")
    expect(normalised).toContain("Do NOT issue the same")
    expect(normalised).toContain("run_command")
  })

  it("falls back gracefully when rootCause is missing", () => {
    const out = buildErrorAcknowledgementRejectPrompt(
      { ok: false },
      { ...baseCtx, rootCause: "" },
      1,
      3,
    )
    expect(out).toContain("(no hypothesis — derive your own)")
  })

  it("renders the header + footer markers", () => {
    const out = buildErrorAcknowledgementRejectPrompt({ ok: false }, baseCtx, 1, 3)
    expect(out).toContain("═══ RESPONSE REJECTED — ACKNOWLEDGE THE ERROR ═══")
    expect(out).toContain("═══ END REJECTION ═══")
  })
})
