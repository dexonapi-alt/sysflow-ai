/**
 * Shell-invocation helper. Centralises the Windows-vs-Unix shell pick
 * so every `child_process.spawn` callsite that runs an agent-emitted
 * command goes through the same predicate.
 *
 * Windows: use PowerShell 5.1 (`powershell.exe` — bundled with every
 * Windows install since Win7). cmd.exe does NOT have `ls` / `cat` /
 * `grep` / `head` / `tail` / `wc` / `find` (as the Unix-style search)
 * — it has `dir` / `type` / `findstr` instead. The safe-command
 * allowlist + the system-prompt examples DO surface both forms, but
 * the LLM still often emits the bash form first (it's what most
 * codebases on the web use). Routing through PowerShell makes those
 * commands work because PowerShell aliases `ls → Get-ChildItem`,
 * `cat → Get-Content`, `cp → Copy-Item`, `mv → Move-Item`, etc.
 *
 * Unix: `/bin/sh -c <command>`. Same shape as today.
 *
 * Pure helper — exported so tests + future callers (e.g. a planned
 * `pwsh` upgrade for PowerShell 7+ hosts) have one place to extend.
 */

export interface ShellInvocation {
  /** Path / name of the shell binary. */
  shell: string
  /** Args to pass to the shell so it runs the command. */
  args: string[]
}

/**
 * Resolve the shell invocation for the current platform.
 *
 * The optional `platform` override is for tests so they can pin to a
 * specific target without running on that OS. Defaults to
 * `process.platform`.
 */
export function getShellInvocation(command: string, platform: NodeJS.Platform = process.platform): ShellInvocation {
  if (platform === "win32") {
    // PowerShell 5.1 is bundled with every Windows release since
    // Windows 7. `-NoProfile` skips the user's profile (faster, more
    // predictable; we don't want a sourced profile to mutate `$PATH`
    // or alias `ls` to something custom). `-Command <string>` runs
    // the supplied command.
    //
    // Why the `; exit $LASTEXITCODE` suffix:
    //
    //   PowerShell 5.1's `-Command` exits with code 0 on a "clean"
    //   run even when the inner native command (e.g. `node
    //   script.cjs 7`) exited non-zero. cmd.exe DOES propagate
    //   native exit codes; switching to PowerShell loses that for
    //   free. Appending `; exit $LASTEXITCODE` runs the command,
    //   then explicitly exits with the captured native exit code.
    //   Restores cmd.exe parity for callers that depend on exit
    //   codes (background-jobs poll status, run_command result
    //   inspection, etc).
    //
    //   Edge case: when the command never spawns a native process
    //   (e.g. a pure PowerShell expression like `Get-ChildItem`),
    //   $LASTEXITCODE is `$null` and `exit $null` exits with 0 —
    //   same shape as PS's default behaviour. So we don't break the
    //   PowerShell-native case while fixing the native-binary case.
    return {
      shell: "powershell.exe",
      args: ["-NoProfile", "-Command", `${command} ; exit $LASTEXITCODE`],
    }
  }
  // Unix-class (linux, darwin, freebsd, etc). `/bin/sh` is the
  // portable POSIX shell — same shape pre-fix.
  return { shell: "/bin/sh", args: ["-c", command] }
}
