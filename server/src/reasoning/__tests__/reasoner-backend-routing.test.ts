/**
 * Stage D of model-lock-and-portable-reasoning plan: pickReasonerBackend
 * routing matrix.
 *
 * Pure unit tests over `pickReasonerBackend` — no fetch, no provider
 * SDK, no env mutation. Each test passes an explicit `env` snapshot so
 * cases stay isolated.
 *
 * Matrix exercised:
 *   - Each main-model family (claude-* / gemini-* / openrouter-auto /
 *     llama / mistral / swe / unknown) against every combination of
 *     {GEMINI, ANTHROPIC, OPENROUTER} keys present / absent
 *   - `reasoning.backend` flag override honours / falls back to null
 *     when its key is missing
 *   - `"auto"` flag value defers to model-driven pick
 */

import { describe, it, expect } from "vitest"
import { pickReasonerBackend, type ReasonerBackend } from "../../services/free-tier-policy.js"

const env = {
  none: {},
  geminiOnly: { GEMINI_API_KEY: "g" },
  anthropicOnly: { ANTHROPIC_API_KEY: "a" },
  openrouterOnly: { OPENROUTER_API_KEY: "o" },
  geminiAndAnthropic: { GEMINI_API_KEY: "g", ANTHROPIC_API_KEY: "a" },
  all: { GEMINI_API_KEY: "g", ANTHROPIC_API_KEY: "a", OPENROUTER_API_KEY: "o" },
} as const

function pick(model: string | null, flagOverride: string, e: NodeJS.ProcessEnv): ReasonerBackend | null {
  return pickReasonerBackend({ model, flagOverride, env: e })
}

describe("pickReasonerBackend — flag override honoured when key present", () => {
  it("honours `gemini` when GEMINI_API_KEY set", () => {
    expect(pick("claude-sonnet", "gemini", env.geminiAndAnthropic)).toBe("gemini")
  })

  it("honours `anthropic` when ANTHROPIC_API_KEY set", () => {
    expect(pick("gemini-flash", "anthropic", env.geminiAndAnthropic)).toBe("anthropic")
  })

  it("honours `openrouter` when OPENROUTER_API_KEY set", () => {
    expect(pick("claude-sonnet", "openrouter", env.all)).toBe("openrouter")
  })

  it("returns null when the pinned backend's key is absent", () => {
    expect(pick("claude-sonnet", "anthropic", env.geminiOnly)).toBe(null)
    expect(pick("claude-sonnet", "gemini", env.anthropicOnly)).toBe(null)
    expect(pick("claude-sonnet", "openrouter", env.anthropicOnly)).toBe(null)
  })

  it("treats unrecognised flag values as `auto`", () => {
    expect(pick("claude-sonnet", "garbage-value", env.all)).toBe("anthropic")
  })
})

describe("pickReasonerBackend — auto selection (claude-*)", () => {
  it("prefers anthropic when ANTHROPIC_API_KEY set", () => {
    expect(pick("claude-sonnet", "auto", env.all)).toBe("anthropic")
    expect(pick("claude-opus", "auto", env.anthropicOnly)).toBe("anthropic")
  })

  it("falls back to gemini when anthropic key absent but gemini present", () => {
    expect(pick("claude-sonnet", "auto", env.geminiOnly)).toBe("gemini")
  })

  it("falls back to openrouter when both anthropic and gemini absent", () => {
    expect(pick("claude-sonnet", "auto", env.openrouterOnly)).toBe("openrouter")
  })

  it("returns null when no keys are configured", () => {
    expect(pick("claude-sonnet", "auto", env.none)).toBe(null)
  })
})

describe("pickReasonerBackend — auto selection (gemini-* / swe)", () => {
  it("prefers direct gemini when GEMINI_API_KEY set", () => {
    expect(pick("gemini-flash", "auto", env.all)).toBe("gemini")
    expect(pick("gemini-pro", "auto", env.geminiOnly)).toBe("gemini")
    expect(pick("swe", "auto", env.all)).toBe("gemini")
  })

  it("falls back to openrouter when gemini key absent", () => {
    expect(pick("gemini-flash", "auto", env.openrouterOnly)).toBe("openrouter")
  })

  it("falls back to anthropic only when neither gemini nor openrouter available", () => {
    expect(pick("gemini-flash", "auto", env.anthropicOnly)).toBe("anthropic")
  })
})

describe("pickReasonerBackend — auto selection (openrouter-routed / free-tier)", () => {
  it("prefers gemini for openrouter-auto when available (parity with historical path)", () => {
    expect(pick("openrouter-auto", "auto", env.all)).toBe("gemini")
    expect(pick("openrouter-auto", "auto", env.geminiOnly)).toBe("gemini")
  })

  it("falls back to openrouter for openrouter-auto when gemini key absent", () => {
    expect(pick("openrouter-auto", "auto", env.openrouterOnly)).toBe("openrouter")
  })

  it("treats llama / mistral / gemini-flash-or as openrouter-routed", () => {
    expect(pick("meta-llama/llama-3.1-405b", "auto", env.openrouterOnly)).toBe("openrouter")
    expect(pick("mistralai/mistral-large", "auto", env.openrouterOnly)).toBe("openrouter")
    expect(pick("gemini-flash-or", "auto", env.openrouterOnly)).toBe("openrouter")
  })

  it("falls back to anthropic for openrouter-routed when neither gemini nor openrouter available", () => {
    expect(pick("openrouter-auto", "auto", env.anthropicOnly)).toBe("anthropic")
  })

  it("returns null when no keys are configured", () => {
    expect(pick("openrouter-auto", "auto", env.none)).toBe(null)
  })
})

describe("pickReasonerBackend — auto selection (unknown model / empty / null)", () => {
  it("prefers gemini as historical default for unknown model", () => {
    expect(pick("some-future-model", "auto", env.all)).toBe("gemini")
  })

  it("walks anthropic → openrouter when gemini absent", () => {
    expect(pick("unknown", "auto", env.anthropicOnly)).toBe("anthropic")
    expect(pick("unknown", "auto", env.openrouterOnly)).toBe("openrouter")
  })

  it("handles null / empty / undefined model gracefully", () => {
    expect(pick(null, "auto", env.geminiOnly)).toBe("gemini")
    expect(pick("", "auto", env.anthropicOnly)).toBe("anthropic")
    expect(pick(null, "auto", env.none)).toBe(null)
  })
})

describe("pickReasonerBackend — case insensitivity + whitespace tolerance", () => {
  it("matches model regardless of case", () => {
    expect(pick("Claude-Sonnet", "auto", env.anthropicOnly)).toBe("anthropic")
    expect(pick("GEMINI-flash", "auto", env.geminiOnly)).toBe("gemini")
  })

  it("treats flag override case-insensitively", () => {
    expect(pick("claude-sonnet", "ANTHROPIC", env.anthropicOnly)).toBe("anthropic")
    expect(pick("claude-sonnet", "Gemini", env.geminiOnly)).toBe("gemini")
  })
})
