import { describe, it, expect } from "vitest"
import { extractProjectName } from "../project-name.js"

describe("extractProjectName", () => {
  it("'create a todo list app' → 'todo-list'", () => {
    expect(extractProjectName("create a todo list app")).toBe("todo-list")
  })

  it("'build me a portfolio site' → 'portfolio-site'", () => {
    expect(extractProjectName("build me a portfolio site")).toBe("portfolio-site")
  })

  it("'build a discord bot' → 'discord-bot'", () => {
    expect(extractProjectName("build a discord bot")).toBe("discord-bot")
  })

  it("'create a react app called my-thing' → 'my-thing'", () => {
    expect(extractProjectName("create a react app called my-thing")).toBe("my-thing")
  })

  it("explicit 'named X' wins over phrase inference", () => {
    expect(extractProjectName('create something named "cool-app" with react')).toBe("cool-app")
  })

  it("falls back to cwd basename when prompt has no scaffold trigger", () => {
    expect(extractProjectName("add a button", "/projects/my-app")).toBe("my-app")
  })

  it("strips stopwords (build, make, app, project)", () => {
    expect(extractProjectName("create a project for tracking habits")).toBe("tracking-habits")
  })

  it("ultimate fallback when nothing usable", () => {
    expect(extractProjectName("xyz")).toBe("my-app")
  })

  it("handles 'set up' as scaffold trigger", () => {
    expect(extractProjectName("set up a blog with astro")).toBe("blog")
  })

  it("trims to first 4 tokens max", () => {
    const result = extractProjectName("create a todo list app for daily habit tracking")
    // After stopword removal: 'todo', 'list', 'daily', 'habit'
    expect(result.split("-").length).toBeLessThanOrEqual(4)
  })

  it("kebab-cases and lower-cases", () => {
    expect(extractProjectName("Create A Cool React APP")).toBe("cool-react")
  })

  it("handles cwd with weird chars", () => {
    expect(extractProjectName("xyz", "/Users/dev/My_Project!")).toBe("my-project-")
  })
})
