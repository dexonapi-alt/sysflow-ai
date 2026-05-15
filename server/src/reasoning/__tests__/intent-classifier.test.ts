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

  it("continuation phrasings → simple (handler swaps for the previous prompt)", () => {
    expect(classifyIntent("continue")).toBe("simple")
    expect(classifyIntent("continue the task")).toBe("simple")
    expect(classifyIntent("continue the previous task")).toBe("simple")
    expect(classifyIntent("keep going")).toBe("simple")
    expect(classifyIntent("carry on")).toBe("simple")
    expect(classifyIntent("proceed")).toBe("simple")
    expect(classifyIntent("finish it")).toBe("simple")
    expect(classifyIntent("finish up")).toBe("simple")
    expect(classifyIntent("resume")).toBe("simple")
    expect(classifyIntent("go ahead")).toBe("simple")
    expect(classifyIntent("continue the build.")).toBe("simple")
  })

  it("'continue' followed by an actual task description → implement (not bare continuation)", () => {
    expect(classifyIntent("continue and add a logout endpoint")).toBe("implement")
    expect(classifyIntent("continue with payment integration")).toBe("implement")
  })

  // ─── Regression: build prompts mentioning error-class words inside
  // ─── the feature list must classify as implement, not bug ───

  describe("implement-anchor overrides bug-keyword false positives", () => {
    it("'build … with error handling …' → implement (regression for the POS-app prompt)", () => {
      // The verbatim user-reported case (2026-05-15). Before the
      // implement-anchor override, `\berror\b` inside "error handling"
      // routed this to the bug pipeline.
      const prompt = `build a Node.js Express PostgreSQL backend for a simple POS system using Prisma ORM and JWT authentication. Include CRUD APIs for products, customers, and orders. Orders should support multiple order items linked to products with quantity and subtotal calculation. Add user registration/login, protected routes, validation middleware, error handling, pagination, search, and Docker Compose for PostgreSQL.`
      expect(classifyIntent(prompt)).toBe("implement")
    })

    it("compound feature-list terms don't trip the bug check", () => {
      expect(classifyIntent("build a service with error handling and validation")).toBe("implement")
      expect(classifyIntent("create an API with proper error logging")).toBe("implement")
      expect(classifyIntent("implement a worker that handles errors gracefully")).toBe("implement")
      expect(classifyIntent("scaffold a backend with exception middleware")).toBe("implement")
      expect(classifyIntent("set up a CI pipeline that fails fast on lint errors")).toBe("implement")
    })

    it("'add error handling to X' is a feature add, not a bug fix", () => {
      expect(classifyIntent("add error handling to the auth service")).toBe("implement")
      expect(classifyIntent("add proper error pages to the frontend")).toBe("implement")
    })

    it("build/create/make/add lead all qualify for the anchor", () => {
      expect(classifyIntent("build a postgres-backed API with error recovery")).toBe("implement")
      expect(classifyIntent("create the worker module with error capture")).toBe("implement")
      expect(classifyIntent("make a logger that tracks every error")).toBe("implement")
      expect(classifyIntent("add a webhook handler with retry-on-error logic")).toBe("implement")
      expect(classifyIntent("scaffold a Next.js app with error boundaries")).toBe("implement")
      expect(classifyIntent("write a function to enumerate error codes")).toBe("implement")
      expect(classifyIntent("design a schema for the error_events table")).toBe("implement")
    })

    it("anchor allows article + 'me' between verb and noun", () => {
      expect(classifyIntent("build me a stripe integration")).toBe("implement")
      expect(classifyIntent("build me the auth service")).toBe("implement")
      expect(classifyIntent("create the controller layer")).toBe("implement")
    })

    it("bare implement verbs (no noun) don't trigger the anchor", () => {
      // "build" alone, "build." — no content to build. Fall through to
      // the default `implement` classifier (still correct outcome, but
      // via the default path, not the anchor).
      expect(classifyIntent("build")).toBe("implement")
      expect(classifyIntent("build.")).toBe("implement")
    })
  })

  // ─── Confirm the anchor does NOT swallow legitimate bug reports ───

  describe("bug-report prompts still classify as bug (anchor doesn't swallow them)", () => {
    it("bug-leading verbs ('fix', 'debug', 'why is X failing') aren't in the anchor", () => {
      expect(classifyIntent("fix the broken auth flow with error handling")).toBe("bug")
      expect(classifyIntent("debug why the user creation throws an error")).toBe("bug")
      expect(classifyIntent("the build keeps failing with a typeerror")).toBe("bug")
    })

    it("stack-trace prompts still classify as bug", () => {
      expect(classifyIntent("foo.ts:42 TypeError: Cannot read property 'x' of undefined")).toBe("bug")
      expect(classifyIntent("ENOENT after I added the new error middleware")).toBe("bug")
    })

    it("'explain why X throws an error' is still bug (summary keyword present, bug check wins)", () => {
      // Existing test from before the anchor; re-asserted to guard against
      // the anchor accidentally rewriting this path.
      expect(classifyIntent("explain why this throws an error")).toBe("bug")
    })
  })
})
