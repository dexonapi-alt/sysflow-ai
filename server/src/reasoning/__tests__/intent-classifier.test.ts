import { describe, it, expect } from "vitest"
import { classifyIntent } from "../intent-classifier.js"

describe("classifyIntent", () => {
  it("'list files in src' → simple", () => {
    expect(classifyIntent("list files in src")).toBe("simple")
  })

  it("'show me what's in package.json' → simple", () => {
    expect(classifyIntent("show me the package.json content")).toBe("simple")
  })

  it("'continue' → simple", () => {
    expect(classifyIntent("continue")).toBe("simple")
  })

  it("error keywords → bug", () => {
    expect(classifyIntent("fix the typeerror in foo.ts")).toBe("bug")
    expect(classifyIntent("the build is broken")).toBe("bug")
    expect(classifyIntent("ENOENT after I renamed the dir")).toBe("bug")
    expect(classifyIntent("not working after deploy")).toBe("bug")
  })

  it("'why is X failing' → bug", () => {
    expect(classifyIntent("why does this test keep failing intermittently")).toBe("bug")
  })

  it("explain/summarise/tldr → summary", () => {
    expect(classifyIntent("explain this codebase")).toBe("summary")
    expect(classifyIntent("summarise what changed on this branch")).toBe("summary")
    expect(classifyIntent("tldr the readme")).toBe("summary")
    expect(classifyIntent("what does the action-planner service do")).toBe("summary")
  })

  it("default → implement", () => {
    expect(classifyIntent("create a stripe integration")).toBe("implement")
    expect(classifyIntent("add a button to the navbar")).toBe("implement")
    expect(classifyIntent("dockerise this app")).toBe("implement")
  })

  it("empty input → simple", () => {
    expect(classifyIntent("")).toBe("simple")
    expect(classifyIntent("   ")).toBe("simple")
  })

  it("bug keywords beat summary keywords", () => {
    // Both 'explain' and 'error' are present — bug wins per specificity order.
    expect(classifyIntent("explain why this throws an error")).toBe("bug")
  })

  it("stack trace shape → bug", () => {
    expect(classifyIntent("foo.ts:12 TypeError: Cannot read property")).toBe("bug")
  })

  it("'what's on/in this repo' → summary (read, don't implement)", () => {
    expect(classifyIntent("what's on this repo?")).toBe("summary")
    expect(classifyIntent("whats in this project")).toBe("summary")
    expect(classifyIntent("what is in the src folder")).toBe("summary")
    expect(classifyIntent("what is inside this repo")).toBe("summary")
  })

  it("'tell me about / show me what' → summary", () => {
    expect(classifyIntent("tell me about the auth flow")).toBe("summary")
    expect(classifyIntent("show me what the test suite covers")).toBe("summary")
  })

  it("'give me a tour' → summary", () => {
    expect(classifyIntent("give me a tour of the codebase")).toBe("summary")
  })
})
