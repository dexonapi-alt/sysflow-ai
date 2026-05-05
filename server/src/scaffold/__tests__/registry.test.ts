import { describe, it, expect } from "vitest"
import { SCAFFOLDER_REGISTRY, findScaffoldersByTerms, resolveCommand, getInstallCommand, getScaffolder } from "../registry.js"

describe("scaffold registry", () => {
  it("every entry has a non-empty command and matchTerms", () => {
    for (const entry of SCAFFOLDER_REGISTRY) {
      expect(entry.command.length).toBeGreaterThan(0)
      expect(entry.matchTerms.length).toBeGreaterThan(0)
      expect(entry.displayName.length).toBeGreaterThan(0)
    }
  })

  it("every command contains the {name} placeholder", () => {
    for (const entry of SCAFFOLDER_REGISTRY) {
      expect(entry.command).toContain("{name}")
    }
  })

  it("matchTerms are all lower-case and trimmed", () => {
    for (const entry of SCAFFOLDER_REGISTRY) {
      for (const term of entry.matchTerms) {
        expect(term).toBe(term.toLowerCase())
        expect(term).toBe(term.trim())
      }
    }
  })

  it("postScaffoldInstall is one of the known values", () => {
    const valid = new Set(["npm", "pnpm", "yarn", "bun", "pip", "composer", "bundle", "none"])
    for (const entry of SCAFFOLDER_REGISTRY) {
      expect(valid.has(entry.postScaffoldInstall)).toBe(true)
    }
  })

  it("getScaffolder returns the entry for known stackKey", () => {
    const entry = getScaffolder("react-vite")
    expect(entry).not.toBeNull()
    expect(entry?.displayName).toMatch(/React/)
  })

  it("getScaffolder returns null for unknown stackKey", () => {
    expect(getScaffolder("not-real" as never)).toBeNull()
  })

  it("findScaffoldersByTerms matches react", () => {
    const matches = findScaffoldersByTerms(["react"])
    expect(matches.some((m) => m.stackKey === "react-vite")).toBe(true)
  })

  it("findScaffoldersByTerms matches multiple stacks", () => {
    const matches = findScaffoldersByTerms(["nextjs", "react"])
    const keys = matches.map((m) => m.stackKey)
    expect(keys).toContain("nextjs")
    expect(keys).toContain("react-vite")
  })

  it("findScaffoldersByTerms is case-insensitive on input", () => {
    const matches = findScaffoldersByTerms(["NEXT.JS"])
    expect(matches.some((m) => m.stackKey === "nextjs")).toBe(true)
  })

  it("findScaffoldersByTerms returns empty on no match", () => {
    const matches = findScaffoldersByTerms(["express", "fastapi", "discord.js"])
    expect(matches).toEqual([])
  })

  it("findScaffoldersByTerms deduplicates per entry", () => {
    const matches = findScaffoldersByTerms(["react", "vite"])
    const reactCount = matches.filter((m) => m.stackKey === "react-vite").length
    expect(reactCount).toBe(1)
  })

  it("resolveCommand swaps {name}", () => {
    const entry = getScaffolder("react-vite")!
    const cmd = resolveCommand(entry, "todo-list")
    expect(cmd).toContain("todo-list")
    expect(cmd).not.toContain("{name}")
  })

  it("getInstallCommand returns cd-prefixed command for npm", () => {
    const entry = getScaffolder("react-vite")!
    const install = getInstallCommand(entry, "todo-list")
    expect(install).toBe("cd todo-list && npm install")
  })

  it("getInstallCommand returns null when composer (already installed)", () => {
    const entry = getScaffolder("laravel")!
    const install = getInstallCommand(entry, "site")
    expect(install).toBeNull()
  })
})
