/**
 * Stage 4.1 of `2026-05-16-awareness-and-verification-correctness.md`.
 *
 * Asserts that `payload.clientPlatform` is threaded through every
 * provider's prompt-builder so the rendered `═══ ENVIRONMENT ═══`
 * block matches the USER's OS — NOT the server's.
 *
 * Without this fix our SaaS deployment (server on linux) told every
 * Windows user the platform was `linux` and they should reach for
 * bash commands; the model then emitted `ls -la` which PowerShell
 * rejected. Stage 4 (the cli-side remap layer) catches that
 * reactively; Stage 4.1 makes the prompt honest in the first place.
 */

import { describe, it, expect } from "vitest"
import { AnthropicProvider } from "../anthropic.js"
import { OpenRouterProvider } from "../openrouter.js"
import { getSystemPrompt } from "../base-provider.js"
import type { ProviderPayload } from "../../types.js"

function makePayload(overrides: Partial<ProviderPayload> = {}): ProviderPayload {
  return {
    model: "claude-sonnet",
    runId: "test-run-platform",
    userMessage: "build a thing",
    directoryTree: [],
    context: {},
    cwd: "/tmp/test",
    ...overrides,
  }
}

describe("getSystemPrompt — platform-aware env-info rendering", () => {
  it("renders Windows env-info + PowerShell command list when platform=win32", () => {
    const sys = getSystemPrompt({ platform: "win32" })
    expect(sys).toContain("platform: win32")
    expect(sys).toContain("PowerShell")
    expect(sys).toContain("Get-ChildItem")
    expect(sys).toContain("Select-String")
    expect(sys).toContain("Get-Content")
  })

  it("renders Linux env-info + bash command list when platform=linux", () => {
    const sys = getSystemPrompt({ platform: "linux" })
    expect(sys).toContain("platform: linux")
    expect(sys).toContain("bash")
    // Spot-check a few bash-form examples from env-info.
    expect(sys).toContain("grep")
    expect(sys).toContain("cat")
  })

  it("renders macOS env-info (bash) when platform=darwin", () => {
    const sys = getSystemPrompt({ platform: "darwin" })
    expect(sys).toContain("platform: darwin")
    expect(sys).toContain("bash")
  })

  it("falls through to process.platform when no platform is passed", () => {
    const sys = getSystemPrompt({})
    expect(sys).toContain(`platform: ${process.platform}`)
  })
})

describe("AnthropicProvider.getSystemPromptForRequest — clientPlatform threading", () => {
  it("renders PowerShell command list when payload.clientPlatform=win32 (even if server is linux)", () => {
    const provider = new AnthropicProvider()
    const payload = makePayload({ clientPlatform: "win32" })
    const sys = provider.getSystemPromptForRequest(payload)
    expect(sys).toContain("platform: win32")
    expect(sys).toContain("PowerShell")
    expect(sys).toContain("Get-ChildItem")
  })

  it("renders bash command list when payload.clientPlatform=linux", () => {
    const provider = new AnthropicProvider()
    const payload = makePayload({ clientPlatform: "linux" })
    const sys = provider.getSystemPromptForRequest(payload)
    expect(sys).toContain("platform: linux")
    expect(sys).toContain("bash")
  })

  it("falls back to process.platform when payload.clientPlatform is undefined (legacy cli)", () => {
    const provider = new AnthropicProvider()
    const payload = makePayload({})
    delete (payload as Partial<ProviderPayload>).clientPlatform
    const sys = provider.getSystemPromptForRequest(payload)
    expect(sys).toContain(`platform: ${process.platform}`)
  })

  it("does NOT include bash command examples in the Windows-payload prompt (regression — proves the threading actually flips)", () => {
    const provider = new AnthropicProvider()
    const winSys = provider.getSystemPromptForRequest(makePayload({ clientPlatform: "win32" }))
    // The bash-list line says `preferred read-only commands (bash):`
    // and the PS-list line says `preferred read-only commands (PowerShell):`.
    // Exactly one of them should appear.
    expect(winSys).toContain("preferred read-only commands (PowerShell)")
    expect(winSys).not.toContain("preferred read-only commands (bash)")
  })
})

describe("OpenRouterProvider.getSystemPromptForRequest — clientPlatform threading", () => {
  it("renders PowerShell command list when payload.clientPlatform=win32", () => {
    const provider = new OpenRouterProvider()
    const sys = provider.getSystemPromptForRequest(makePayload({ clientPlatform: "win32" }))
    expect(sys).toContain("platform: win32")
    expect(sys).toContain("PowerShell")
  })

  it("renders bash command list when payload.clientPlatform=linux", () => {
    const provider = new OpenRouterProvider()
    const sys = provider.getSystemPromptForRequest(makePayload({ clientPlatform: "linux" }))
    expect(sys).toContain("platform: linux")
    expect(sys).toContain("bash")
  })

  it("matches AnthropicProvider for the same clientPlatform (provider parity)", () => {
    const payload = makePayload({ clientPlatform: "win32" })
    const aSys = new AnthropicProvider().getSystemPromptForRequest(payload)
    const oSys = new OpenRouterProvider().getSystemPromptForRequest(payload)
    // Both providers should arrive at the same env-info shape — the
    // ENVIRONMENT block content under "preferred read-only commands"
    // should match between them.
    const extractCmdLine = (s: string) => {
      const m = s.match(/preferred read-only commands \(PowerShell\):[\s\S]+?(?=\n\n)/)
      return m ? m[0] : "MISSING"
    }
    expect(extractCmdLine(aSys)).toBe(extractCmdLine(oSys))
  })
})
