import { describe, it, expect, beforeEach } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { discoverProjectMemory } from "../project-memory.js"

async function mkTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sysflow-pm-"))
  return dir
}

describe("discoverProjectMemory", () => {
  let cwd: string
  beforeEach(async () => {
    cwd = await mkTempDir()
  })

  it("returns empty when no memory files exist", async () => {
    const r = await discoverProjectMemory(cwd)
    expect(r.content).toBe("")
    expect(r.files).toEqual([])
  })

  it("reads .sysflow.md from cwd", async () => {
    await fs.writeFile(path.join(cwd, ".sysflow.md"), "# Project rules\nUse tabs.", "utf8")
    const r = await discoverProjectMemory(cwd)
    expect(r.content).toContain("Use tabs")
    expect(r.files.length).toBeGreaterThan(0)
  })

  it("falls back to CLAUDE.md when .sysflow.md is missing", async () => {
    await fs.writeFile(path.join(cwd, "CLAUDE.md"), "# Claude rules\nNo emojis.", "utf8")
    const r = await discoverProjectMemory(cwd)
    expect(r.content).toContain("No emojis")
  })

  it("prefers .sysflow.md over CLAUDE.md when both exist", async () => {
    await fs.writeFile(path.join(cwd, ".sysflow.md"), "PRIMARY", "utf8")
    await fs.writeFile(path.join(cwd, "CLAUDE.md"), "FALLBACK", "utf8")
    const r = await discoverProjectMemory(cwd)
    expect(r.content).toContain("PRIMARY")
    expect(r.content).not.toContain("FALLBACK")
  })

  it("returns empty when cwd is null/undefined", async () => {
    const a = await discoverProjectMemory(null)
    const b = await discoverProjectMemory(undefined)
    expect(a.content).toBe("")
    expect(b.content).toBe("")
  })

  it("includes the file's basename in the rendered content", async () => {
    await fs.writeFile(path.join(cwd, ".sysflow.md"), "rule body", "utf8")
    const r = await discoverProjectMemory(cwd)
    expect(r.content).toContain(".sysflow.md")
  })
})
