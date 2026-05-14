import { describe, it, expect } from "vitest"
import { isSafeReadOnlyCommand } from "../safe-commands.js"

/**
 * Stage 2 of command-first-investigation: regex-based allowlist for
 * read-only investigation commands.
 *
 * Conservative-by-design tests: confirm the canonical investigation set
 * auto-approves AND confirm common destructive / chained / sub-shelled
 * patterns are rejected.
 */

describe("isSafeReadOnlyCommand — safe leading commands", () => {
  it("approves Unix file/text inspection commands", () => {
    expect(isSafeReadOnlyCommand("ls")).toBe(true)
    expect(isSafeReadOnlyCommand("ls -la")).toBe(true)
    expect(isSafeReadOnlyCommand("find . -name '*.ts'")).toBe(true)
    expect(isSafeReadOnlyCommand("grep -r foo src/")).toBe(true)
    expect(isSafeReadOnlyCommand("rg foo")).toBe(true)
    expect(isSafeReadOnlyCommand("cat package.json")).toBe(true)
    expect(isSafeReadOnlyCommand("head -20 README.md")).toBe(true)
    expect(isSafeReadOnlyCommand("tail -50 server.log")).toBe(true)
    expect(isSafeReadOnlyCommand("wc -l src/index.ts")).toBe(true)
    expect(isSafeReadOnlyCommand("tree -L 2")).toBe(true)
  })

  it("approves environment / process info commands", () => {
    expect(isSafeReadOnlyCommand("which node")).toBe(true)
    expect(isSafeReadOnlyCommand("whoami")).toBe(true)
    expect(isSafeReadOnlyCommand("pwd")).toBe(true)
    expect(isSafeReadOnlyCommand("hostname")).toBe(true)
    expect(isSafeReadOnlyCommand("uname -a")).toBe(true)
  })

  it("approves echo / jq inert utilities", () => {
    expect(isSafeReadOnlyCommand("echo hello")).toBe(true)
    expect(isSafeReadOnlyCommand("jq .name package.json")).toBe(true)
  })

  it("approves Windows CMD dir", () => {
    expect(isSafeReadOnlyCommand("dir")).toBe(true)
    expect(isSafeReadOnlyCommand("dir /b")).toBe(true)
  })
})

describe("isSafeReadOnlyCommand — git subcommand whitelist", () => {
  it("approves the read-only git subcommands", () => {
    expect(isSafeReadOnlyCommand("git status")).toBe(true)
    expect(isSafeReadOnlyCommand("git status --short")).toBe(true)
    expect(isSafeReadOnlyCommand("git log -10 --oneline")).toBe(true)
    expect(isSafeReadOnlyCommand("git diff")).toBe(true)
    expect(isSafeReadOnlyCommand("git diff HEAD~1")).toBe(true)
    expect(isSafeReadOnlyCommand("git show abc123")).toBe(true)
    expect(isSafeReadOnlyCommand("git blame src/foo.ts")).toBe(true)
    expect(isSafeReadOnlyCommand("git ls-files")).toBe(true)
    expect(isSafeReadOnlyCommand("git rev-parse HEAD")).toBe(true)
  })

  it("rejects git subcommands that can write (commit / push / reset / checkout / merge / rebase)", () => {
    expect(isSafeReadOnlyCommand("git commit -m foo")).toBe(false)
    expect(isSafeReadOnlyCommand("git push origin main")).toBe(false)
    expect(isSafeReadOnlyCommand("git reset --hard HEAD")).toBe(false)
    expect(isSafeReadOnlyCommand("git checkout main")).toBe(false)
    expect(isSafeReadOnlyCommand("git merge feature")).toBe(false)
    expect(isSafeReadOnlyCommand("git rebase main")).toBe(false)
    expect(isSafeReadOnlyCommand("git add .")).toBe(false)
  })

  it("rejects ambiguous git subcommands (branch / remote / config) — those have writeable forms", () => {
    // Even bare `git branch` is rejected conservatively because `git branch foo` writes.
    expect(isSafeReadOnlyCommand("git branch")).toBe(false)
    expect(isSafeReadOnlyCommand("git remote -v")).toBe(false)
    expect(isSafeReadOnlyCommand("git config user.email")).toBe(false)
  })
})

describe("isSafeReadOnlyCommand — npm / cargo / pip subcommand whitelist", () => {
  it("approves read-only npm-family subcommands", () => {
    expect(isSafeReadOnlyCommand("npm list")).toBe(true)
    expect(isSafeReadOnlyCommand("npm ls")).toBe(true)
    expect(isSafeReadOnlyCommand("npm outdated")).toBe(true)
    expect(isSafeReadOnlyCommand("npm view react")).toBe(true)
    expect(isSafeReadOnlyCommand("pnpm list")).toBe(true)
    expect(isSafeReadOnlyCommand("yarn list")).toBe(true)
  })

  it("rejects npm install and friends (writes node_modules)", () => {
    expect(isSafeReadOnlyCommand("npm install")).toBe(false)
    expect(isSafeReadOnlyCommand("npm i react")).toBe(false)
    expect(isSafeReadOnlyCommand("npm uninstall foo")).toBe(false)
    expect(isSafeReadOnlyCommand("npm run dev")).toBe(false)
    expect(isSafeReadOnlyCommand("npm run build")).toBe(false)
    expect(isSafeReadOnlyCommand("pnpm install")).toBe(false)
    expect(isSafeReadOnlyCommand("yarn add foo")).toBe(false)
  })

  it("approves read-only cargo / pip subcommands", () => {
    expect(isSafeReadOnlyCommand("cargo metadata")).toBe(true)
    expect(isSafeReadOnlyCommand("cargo tree")).toBe(true)
    expect(isSafeReadOnlyCommand("pip list")).toBe(true)
    expect(isSafeReadOnlyCommand("pip show requests")).toBe(true)
  })

  it("rejects cargo / pip mutators", () => {
    expect(isSafeReadOnlyCommand("cargo build")).toBe(false)
    expect(isSafeReadOnlyCommand("cargo install foo")).toBe(false)
    expect(isSafeReadOnlyCommand("pip install requests")).toBe(false)
  })
})

describe("isSafeReadOnlyCommand — version queries only", () => {
  it("approves version flags on runtime commands", () => {
    expect(isSafeReadOnlyCommand("node --version")).toBe(true)
    expect(isSafeReadOnlyCommand("node -v")).toBe(true)
    expect(isSafeReadOnlyCommand("python --version")).toBe(true)
    expect(isSafeReadOnlyCommand("python -V")).toBe(true)
    expect(isSafeReadOnlyCommand("python3 --version")).toBe(true)
    expect(isSafeReadOnlyCommand("ruby --version")).toBe(true)
    expect(isSafeReadOnlyCommand("go version")).toBe(false) // requires --version, not "version"
  })

  it("rejects runtime commands without the version flag (could execute arbitrary code)", () => {
    expect(isSafeReadOnlyCommand("node script.js")).toBe(false)
    expect(isSafeReadOnlyCommand("node -e 'console.log(1)'")).toBe(false)
    expect(isSafeReadOnlyCommand("python script.py")).toBe(false)
    expect(isSafeReadOnlyCommand("python -c 'import os'")).toBe(false)
  })
})

describe("isSafeReadOnlyCommand — PowerShell cmdlets (case-insensitive)", () => {
  it("approves canonical PowerShell read-only cmdlets", () => {
    expect(isSafeReadOnlyCommand("Get-ChildItem")).toBe(true)
    expect(isSafeReadOnlyCommand("get-childitem -Force")).toBe(true)
    expect(isSafeReadOnlyCommand("Get-Content package.json")).toBe(true)
    expect(isSafeReadOnlyCommand("Select-String -Path src -Pattern foo")).toBe(true)
    expect(isSafeReadOnlyCommand("Test-Path package.json")).toBe(true)
    expect(isSafeReadOnlyCommand("Get-Command node")).toBe(true)
    expect(isSafeReadOnlyCommand("Get-Location")).toBe(true)
  })

  it("rejects PowerShell write/destructive cmdlets", () => {
    expect(isSafeReadOnlyCommand("Remove-Item file.txt")).toBe(false)
    expect(isSafeReadOnlyCommand("Move-Item old new")).toBe(false)
    expect(isSafeReadOnlyCommand("Copy-Item a b")).toBe(false)
    expect(isSafeReadOnlyCommand("New-Item -ItemType File foo")).toBe(false)
    expect(isSafeReadOnlyCommand("Set-Content file.txt 'new'")).toBe(false)
    expect(isSafeReadOnlyCommand("Out-File foo.txt")).toBe(false)
    expect(isSafeReadOnlyCommand("Add-Content log.txt 'line'")).toBe(false)
  })
})

describe("isSafeReadOnlyCommand — destructive direct commands", () => {
  it("rejects file deletion / move / copy primitives", () => {
    expect(isSafeReadOnlyCommand("rm file.txt")).toBe(false)
    expect(isSafeReadOnlyCommand("rm -rf node_modules")).toBe(false)
    expect(isSafeReadOnlyCommand("mv a b")).toBe(false)
    expect(isSafeReadOnlyCommand("cp -r src dist")).toBe(false)
    expect(isSafeReadOnlyCommand("del file.txt")).toBe(false)
  })

  it("rejects sudo / chmod / network downloads", () => {
    expect(isSafeReadOnlyCommand("sudo apt install foo")).toBe(false)
    expect(isSafeReadOnlyCommand("chmod 777 file")).toBe(false)
    expect(isSafeReadOnlyCommand("curl -o foo.tar.gz https://...")).toBe(false)
    expect(isSafeReadOnlyCommand("wget https://...")).toBe(false)
  })
})

describe("isSafeReadOnlyCommand — shell chaining / pipes / redirects rejected", () => {
  it("rejects && chained commands (even when each piece is safe)", () => {
    expect(isSafeReadOnlyCommand("ls && pwd")).toBe(false)
    expect(isSafeReadOnlyCommand("git status && ls")).toBe(false)
  })

  it("rejects || chained commands", () => {
    expect(isSafeReadOnlyCommand("ls || echo nothing")).toBe(false)
  })

  it("rejects ; chained commands", () => {
    expect(isSafeReadOnlyCommand("ls; pwd")).toBe(false)
  })

  it("rejects pipes (even pipe-to-safe-command, conservative)", () => {
    expect(isSafeReadOnlyCommand("grep -r foo src/ | head -20")).toBe(false)
    expect(isSafeReadOnlyCommand("ls | wc -l")).toBe(false)
    expect(isSafeReadOnlyCommand("cat package.json | jq .name")).toBe(false)
  })

  it("rejects redirections", () => {
    expect(isSafeReadOnlyCommand("ls > out.txt")).toBe(false)
    expect(isSafeReadOnlyCommand("cat foo.txt > bar.txt")).toBe(false)
    expect(isSafeReadOnlyCommand("ls >> log.txt")).toBe(false)
    expect(isSafeReadOnlyCommand("cat < input.txt")).toBe(false)
  })

  it("rejects sub-shell command substitution", () => {
    expect(isSafeReadOnlyCommand("echo $(ls)")).toBe(false)
    expect(isSafeReadOnlyCommand("echo `whoami`")).toBe(false)
    expect(isSafeReadOnlyCommand("ls $(pwd)")).toBe(false)
  })
})

describe("isSafeReadOnlyCommand — defensive edge cases", () => {
  it("rejects empty / non-string inputs", () => {
    expect(isSafeReadOnlyCommand("")).toBe(false)
    expect(isSafeReadOnlyCommand("   ")).toBe(false)
    expect(isSafeReadOnlyCommand(null as unknown)).toBe(false)
    expect(isSafeReadOnlyCommand(undefined as unknown)).toBe(false)
    expect(isSafeReadOnlyCommand(42 as unknown)).toBe(false)
  })

  it("rejects unknown leading commands (whitelist is closed)", () => {
    expect(isSafeReadOnlyCommand("unknown-tool")).toBe(false)
    expect(isSafeReadOnlyCommand("docker ps")).toBe(false)
    expect(isSafeReadOnlyCommand("kubectl get pods")).toBe(false)
    expect(isSafeReadOnlyCommand("aws s3 ls")).toBe(false)
  })

  it("handles extra whitespace gracefully", () => {
    expect(isSafeReadOnlyCommand("  ls -la  ")).toBe(true)
    expect(isSafeReadOnlyCommand("  git status  ")).toBe(true)
  })

  it("rejects commands that contain forbidden chars even inside quotes (conservative)", () => {
    // The matcher doesn't parse quotes — `grep '>' foo` looks like a redirect
    // and is rejected. Acceptable: user gets one ask prompt instead of risking
    // a real redirect slipping through.
    expect(isSafeReadOnlyCommand("grep '>' foo")).toBe(false)
  })
})
