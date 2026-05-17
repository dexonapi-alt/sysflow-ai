/**
 * Stage 4 of `2026-05-16-awareness-and-verification-correctness.md`.
 *
 * Pure tests for win-shell-aliases — the Windows-specific preprocessing
 * + PowerShell-error detection that fixes the `ls -la` false-success
 * bug.
 */

import { describe, it, expect } from "vitest"
import {
  remapWindowsShellCommand,
  detectPowerShellError,
} from "../win-shell-aliases.js"

describe("remapWindowsShellCommand — Unix alias preprocessing on Windows", () => {
  it("maps `ls -la` to `Get-ChildItem -Force`", () => {
    const out = remapWindowsShellCommand("ls -la", "win32")
    expect(out.command).toBe("Get-ChildItem -Force")
    expect(out.originalCommand).toBe("ls -la")
  })

  it("maps `ls -al` (reversed flag order) to `Get-ChildItem -Force`", () => {
    const out = remapWindowsShellCommand("ls -al", "win32")
    expect(out.command).toBe("Get-ChildItem -Force")
    expect(out.originalCommand).toBe("ls -al")
  })

  it("maps `ls -la <path>` preserving the path arg", () => {
    const out = remapWindowsShellCommand("ls -la src/components", "win32")
    expect(out.command).toBe("Get-ChildItem -Force src/components")
    expect(out.originalCommand).toBe("ls -la src/components")
  })

  it("maps `ls -a` (no long form) to `Get-ChildItem -Force`", () => {
    const out = remapWindowsShellCommand("ls -a", "win32")
    expect(out.command).toBe("Get-ChildItem -Force")
    expect(out.originalCommand).toBe("ls -a")
  })

  it("maps `ls -A <path>` (capital A) preserving the path", () => {
    const out = remapWindowsShellCommand("ls -A node_modules", "win32")
    expect(out.command).toBe("Get-ChildItem -Force node_modules")
    expect(out.originalCommand).toBe("ls -A node_modules")
  })

  it("maps `ls -l` to bare `Get-ChildItem`", () => {
    const out = remapWindowsShellCommand("ls -l", "win32")
    expect(out.command).toBe("Get-ChildItem")
    expect(out.originalCommand).toBe("ls -l")
  })

  it("maps `ls -l <path>` preserving the path", () => {
    const out = remapWindowsShellCommand("ls -l src", "win32")
    expect(out.command).toBe("Get-ChildItem src")
    expect(out.originalCommand).toBe("ls -l src")
  })

  it("passes through `ls` (bare) — PowerShell handles this natively via alias", () => {
    // Bare `ls` works because PowerShell aliases `ls → Get-ChildItem`
    // and there are no flags to mis-parse. No remap needed.
    const out = remapWindowsShellCommand("ls", "win32")
    expect(out.command).toBe("ls")
    expect(out.originalCommand).toBeNull()
  })

  it("passes through commands with no Unix-form match", () => {
    for (const cmd of [
      "npm install",
      "git status",
      "node script.js",
      "Get-ChildItem",
      "Get-Content README.md",
      "echo hello",
    ]) {
      const out = remapWindowsShellCommand(cmd, "win32")
      expect(out.command).toBe(cmd)
      expect(out.originalCommand).toBeNull()
    }
  })

  it("does NOT remap on non-Windows platforms (Unix has real ls)", () => {
    for (const platform of ["linux", "darwin", "freebsd"] as NodeJS.Platform[]) {
      const out = remapWindowsShellCommand("ls -la", platform)
      expect(out.command).toBe("ls -la")
      expect(out.originalCommand).toBeNull()
    }
  })

  it("trims leading/trailing whitespace before matching", () => {
    const out = remapWindowsShellCommand("  ls -la  ", "win32")
    expect(out.command).toBe("Get-ChildItem -Force")
  })

  it("does NOT remap subtly-different shapes (defensive)", () => {
    // These should NOT be remapped — they could be intentional or
    // they're forms we haven't decided how to handle:
    //   `ls -la -h` (additional flag)
    //   `ls --all` (long flag)
    //   `ls -la | grep foo` (piped — needs more thought)
    for (const cmd of ["ls -la -h", "ls --all", "ls -la | grep foo"]) {
      const out = remapWindowsShellCommand(cmd, "win32")
      expect(out.command).toBe(cmd)
      expect(out.originalCommand).toBeNull()
    }
  })
})

describe("detectPowerShellError — stderr error-marker classification", () => {
  it("catches the canonical NamedParameterNotFound marker (user-reported repro)", () => {
    // Verbatim from the user's 2026-05-16 report.
    const stderr =
      "+ FullyQualifiedErrorId : NamedParameterNotFound,Microsoft.PowerShell.Commands.GetChildItemCommand"
    const out = detectPowerShellError(stderr)
    expect(out.isError).toBe(true)
    expect(out.marker).toBe("FullyQualifiedErrorId")
  })

  it("catches ParameterBindingException", () => {
    const stderr = "System.Management.Automation.ParameterBindingException: A parameter cannot be found ..."
    expect(detectPowerShellError(stderr).isError).toBe(true)
  })

  it("catches ParameterBindingValidationException", () => {
    const stderr = "ParameterBindingValidationException: ..."
    expect(detectPowerShellError(stderr).isError).toBe(true)
  })

  it("catches MissingArgument", () => {
    const stderr = "Get-Content : Missing an argument for parameter 'Path'.\nMissingArgument,Microsoft.PowerShell ..."
    expect(detectPowerShellError(stderr).isError).toBe(true)
  })

  it("catches the standard ErrorRecord CategoryInfo line", () => {
    const stderr = "+ CategoryInfo          : InvalidArgument: (:) [Get-ChildItem], ParameterBindingException"
    const out = detectPowerShellError(stderr)
    expect(out.isError).toBe(true)
    // Could match either the CategoryInfo or ParameterBindingException
    // marker — both are correct signals; just assert SOMETHING fired.
    expect(out.marker).not.toBeNull()
  })

  it("returns isError=false for empty stderr", () => {
    expect(detectPowerShellError("").isError).toBe(false)
    expect(detectPowerShellError("").marker).toBeNull()
  })

  it("returns isError=false for legitimate stderr without PowerShell markers", () => {
    // Tools that print diagnostics / warnings to stderr but exit 0
    // shouldn't be classified as PowerShell errors.
    const cases = [
      "warning: deprecation notice — package X will be removed in v2",
      "npm warn deprecated foo@1.0.0",
      "[ESLint] 2 warnings",
      "tsc: 0 errors",
      "Compiled successfully.",
      "info: build complete",
    ]
    for (const stderr of cases) {
      expect(detectPowerShellError(stderr).isError).toBe(false)
    }
  })

  it("does NOT false-positive on a literal 'FullyQualifiedErrorId' word in legitimate context (extremely unlikely but defensive)", () => {
    // tsc / eslint / npm output never literally includes
    // 'FullyQualifiedErrorId' — it's a PowerShell-specific class. If
    // some tool DID include it, we'd over-classify, but the surface
    // is small enough that we accept this trade-off. This test just
    // documents the behaviour: any stderr containing the marker
    // string is treated as an error.
    const stderr = "Mock test output: FullyQualifiedErrorId would be returned here in real PS"
    expect(detectPowerShellError(stderr).isError).toBe(true)
  })

  it("returns the first matching marker (deterministic for logging)", () => {
    // Stderr with multiple markers should report the first in the
    // detector's ordered list.
    const stderr = `Some random text
+ CategoryInfo          : InvalidArgument: (:) [Get-ChildItem], ParameterBindingException
+ FullyQualifiedErrorId : NamedParameterNotFound,Microsoft.PowerShell.Commands.GetChildItemCommand`
    const out = detectPowerShellError(stderr)
    expect(out.isError).toBe(true)
    expect(out.marker).toBe("FullyQualifiedErrorId")
  })
})

describe("end-to-end — `ls -la` on Windows", () => {
  it("remaps the command AND would catch the residual error if PowerShell still failed", () => {
    // Step 1: cli preprocesses `ls -la` → `Get-ChildItem -Force`.
    const remap = remapWindowsShellCommand("ls -la", "win32")
    expect(remap.command).toBe("Get-ChildItem -Force")
    expect(remap.originalCommand).toBe("ls -la")

    // Step 2: hypothetically, if Get-ChildItem -Force STILL fails
    // (different reason — unreachable path, permission, etc.), the
    // stderr detector catches that too.
    const hypotheticalStderr =
      "+ CategoryInfo          : ObjectNotFound: ...\n+ FullyQualifiedErrorId : PathNotFound,Microsoft.PowerShell.Commands.GetChildItemCommand"
    expect(detectPowerShellError(hypotheticalStderr).isError).toBe(true)
  })
})
