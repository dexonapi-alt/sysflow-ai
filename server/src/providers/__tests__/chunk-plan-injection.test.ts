import { describe, it, expect } from "vitest"
import { renderChunkPlanSection } from "../base-provider.js"

describe("renderChunkPlanSection", () => {
  it("returns empty string when no brief", () => {
    expect(renderChunkPlanSection(undefined)).toBe("")
    expect(renderChunkPlanSection(null)).toBe("")
  })

  it("returns empty string for non-object briefs", () => {
    expect(renderChunkPlanSection("string")).toBe("")
    expect(renderChunkPlanSection(42)).toBe("")
  })

  it("returns empty string when files is missing or empty", () => {
    expect(renderChunkPlanSection({})).toBe("")
    expect(renderChunkPlanSection({ nextAction: "x", files: [] })).toBe("")
  })

  it("renders the planner's file list", () => {
    const out = renderChunkPlanSection({
      nextAction: "write models",
      files: ["src/models/User.js", "src/models/Product.js"],
      rationale: "models before routes",
      dependencies: ["src/db.js"],
      expectedSizeBin: "small",
      isFinalChunk: false,
    })
    expect(out).toContain("CHUNK PLAN (HONOUR EXACTLY)")
    expect(out).toContain("action: write models")
    expect(out).toContain("files (2):")
    expect(out).toContain("- src/models/User.js")
    expect(out).toContain("- src/models/Product.js")
    expect(out).toContain("rationale: models before routes")
    expect(out).toContain("reads from prior chunks: src/db.js")
    expect(out).toContain("size budget: small")
    expect(out).toContain("END CHUNK PLAN")
  })

  it("flags the final chunk", () => {
    const out = renderChunkPlanSection({
      nextAction: "polish",
      files: ["README.md"],
      rationale: "wrap up",
      dependencies: [],
      expectedSizeBin: "tiny",
      isFinalChunk: true,
    })
    expect(out).toContain("THIS IS THE FINAL CHUNK")
    expect(out).toContain("emit kind: completed")
  })

  it("omits rationale + dependencies when not provided", () => {
    const out = renderChunkPlanSection({
      nextAction: "write",
      files: ["a.js"],
      expectedSizeBin: "tiny",
      isFinalChunk: false,
    })
    expect(out).not.toContain("rationale:")
    expect(out).not.toContain("reads from prior chunks:")
    expect(out).toContain("- a.js")
  })

  it("output is multi-line and ends with the END marker", () => {
    const out = renderChunkPlanSection({
      nextAction: "write models",
      files: ["a.js"],
      rationale: "x",
      dependencies: [],
      expectedSizeBin: "tiny",
      isFinalChunk: false,
    })
    const lines = out.split("\n")
    expect(lines[lines.length - 1]).toContain("END CHUNK PLAN")
  })
})
