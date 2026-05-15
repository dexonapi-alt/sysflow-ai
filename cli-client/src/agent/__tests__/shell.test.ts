/**
 * Shell-invocation helper tests. Both platform branches are
 * unit-testable because `getShellInvocation` accepts an optional
 * `platform` override.
 *
 * Why this matters: the Windows-shell fix routes commands through
 * `powershell.exe` instead of `cmd.exe` so the LLM's bash-form
 * commands (`ls`, `cat`, `grep`, `head`, `tail`, `find`, `wc`) work
 * via PowerShell's aliases. cmd.exe rejects all of those with the
 * canonical *"'ls' is not recognized as an internal or external
 * command"* error.
 */

import { describe, it, expect } from "vitest"
import { getShellInvocation } from "../shell.js"

describe("getShellInvocation — Windows", () => {
  it("returns powershell.exe with -NoProfile -Command flags", () => {
    const out = getShellInvocation("ls -R", "win32")
    expect(out.shell).toBe("powershell.exe")
    expect(out.args[0]).toBe("-NoProfile")
    expect(out.args[1]).toBe("-Command")
  })

  it("appends ; exit $LASTEXITCODE so native exit codes propagate (cmd.exe parity)", () => {
    // PowerShell 5.1's `-Command` swallows native exit codes by
    // default — cmd.exe doesn't. We restore parity by appending the
    // explicit exit suffix.
    const out = getShellInvocation("node script.cjs 7", "win32")
    expect(out.args[2]).toBe("node script.cjs 7 ; exit $LASTEXITCODE")
  })

  it("passes the command verbatim into the prefix — no quoting / escaping", () => {
    // PowerShell handles internal quoting; caller's responsibility.
    const cmd = `Get-ChildItem -Path '.' | Where-Object { $_.Name -match 'foo' }`
    const out = getShellInvocation(cmd, "win32")
    expect(out.args[2]).toBe(`${cmd} ; exit $LASTEXITCODE`)
  })

  it("works for the user-reported failure case (ls -R on Windows)", () => {
    // Pre-fix, this command spawned via `cmd.exe /c ls -R` and got
    // the canonical "'ls' is not recognized" error. Post-fix it
    // routes through PowerShell where ls is an alias for Get-ChildItem.
    const out = getShellInvocation("ls -R", "win32")
    expect(out.shell).toBe("powershell.exe")
    expect(out.args[2]).toContain("ls -R")
  })

  it("works for common bash forms the LLM emits", () => {
    for (const cmd of ["ls", "ls -la", "cat package.json", "grep -r 'foo' src/", "head -20 README.md", "find . -name '*.ts'"]) {
      const out = getShellInvocation(cmd, "win32")
      expect(out.shell).toBe("powershell.exe")
      expect(out.args[2]).toContain(cmd)
    }
  })
})

describe("getShellInvocation — Unix", () => {
  it("returns /bin/sh -c <command> on linux", () => {
    const out = getShellInvocation("ls -R", "linux")
    expect(out.shell).toBe("/bin/sh")
    expect(out.args).toEqual(["-c", "ls -R"])
  })

  it("returns /bin/sh -c <command> on darwin (macOS)", () => {
    const out = getShellInvocation("grep foo src/", "darwin")
    expect(out.shell).toBe("/bin/sh")
    expect(out.args).toEqual(["-c", "grep foo src/"])
  })

  it("returns /bin/sh -c <command> on other unix-class platforms", () => {
    const out = getShellInvocation("ls", "freebsd")
    expect(out.shell).toBe("/bin/sh")
    expect(out.args[0]).toBe("-c")
  })
})

describe("getShellInvocation — default platform", () => {
  it("defaults to process.platform when not overridden", () => {
    // Whatever the current platform actually is, the call should
    // succeed. Just verify the shape is sane.
    const out = getShellInvocation("ls")
    expect(typeof out.shell).toBe("string")
    expect(out.shell.length).toBeGreaterThan(0)
    expect(Array.isArray(out.args)).toBe(true)
    expect(out.args.length).toBeGreaterThanOrEqual(2)
    // Last arg includes the command (verbatim on Unix, with the exit
    // suffix on Windows). Both shapes have the command substring.
    expect(out.args[out.args.length - 1]).toContain("ls")
  })
})
