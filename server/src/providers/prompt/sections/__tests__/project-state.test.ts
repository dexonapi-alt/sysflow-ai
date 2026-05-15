/**
 * Plan `2026-05-15-agent-runtime-fixes-and-project-init-reasoning.md` Stage 1.
 *
 * Tests for the project-state prompt section renderer.
 */

import { describe, it, expect } from "vitest"
import { getProjectStateSection } from "../project-state.js"

const emptyBrief = {
  paragraphs: ["Empty directory."],
  repoState: "empty",
  fileCount: 0,
  keyMarkers: [],
  investigationPlan: ["ls -la"],
  skipConfigVerificationFor: ["tsconfig.json", ".eslintrc.json"],
  confidence: "HIGH",
  iterations: 1,
  committedVia: "done_flag",
}

const largeBrief = {
  paragraphs: ["Existing large project."],
  repoState: "existing-large",
  fileCount: 87,
  keyMarkers: ["package.json", "src/", "tests/", ".git/"],
  investigationPlan: ["cat package.json", "ls src/", "grep -r 'user service' src/"],
  skipConfigVerificationFor: [],
  confidence: "HIGH",
  iterations: 1,
  committedVia: "done_flag",
}

describe("getProjectStateSection", () => {
  it("returns null when no brief is provided", () => {
    expect(getProjectStateSection({})).toBeNull()
  })

  it("returns null when brief is wrong shape", () => {
    expect(getProjectStateSection({ projectInitBrief: { foo: "bar" } })).toBeNull()
    expect(getProjectStateSection({ projectInitBrief: null })).toBeNull()
    expect(getProjectStateSection({ projectInitBrief: { repoState: "invalid" } })).toBeNull()
  })

  it("renders header + footer markers", () => {
    const out = getProjectStateSection({ projectInitBrief: emptyBrief })
    expect(out).toContain("═══ PROJECT STATE")
    expect(out).toContain("═══ END PROJECT STATE")
  })

  it("renders repoState + fileCount + confidence on the first line", () => {
    const out = getProjectStateSection({ projectInitBrief: emptyBrief })
    expect(out).toContain("repoState: empty")
    expect(out).toContain("fileCount: 0")
    expect(out).toContain("confidence: HIGH")
  })

  it("renders the empty-repo guidance for empty briefs", () => {
    const out = getProjectStateSection({ projectInitBrief: emptyBrief })
    expect(out).toContain("EMPTY repo")
    expect(out).toContain("scaffold")
    expect(out).toContain("Do NOT web-search")
  })

  it("renders the existing-large guidance for large briefs", () => {
    const out = getProjectStateSection({ projectInitBrief: largeBrief })
    expect(out).toContain("EXISTING LARGE")
    expect(out).toContain("READ THE MANIFEST")
    expect(out).toContain("confirm with a `_user_response`")
  })

  it("renders keyMarkers when present", () => {
    const out = getProjectStateSection({ projectInitBrief: largeBrief })
    expect(out).toContain("keyMarkers: package.json, src/, tests/, .git/")
  })

  it("omits keyMarkers line when empty", () => {
    const out = getProjectStateSection({ projectInitBrief: emptyBrief })
    expect(out).not.toContain("keyMarkers:")
  })

  it("renders investigation plan as a numbered list", () => {
    const out = getProjectStateSection({ projectInitBrief: largeBrief })
    expect(out).toContain("INVESTIGATION PLAN")
    expect(out).toContain("1. cat package.json")
    expect(out).toContain("2. ls src/")
    expect(out).toContain("3. grep -r 'user service' src/")
  })

  it("caps investigation plan entries at 8 to keep prompt bounded", () => {
    const brief = {
      ...largeBrief,
      investigationPlan: Array.from({ length: 20 }, (_, i) => `cmd-${i}`),
    }
    const out = getProjectStateSection({ projectInitBrief: brief })
    expect(out).toContain("8. cmd-7")
    expect(out).not.toContain("9. cmd-8")
  })

  it("caps keyMarkers at 12 entries", () => {
    const brief = {
      ...largeBrief,
      keyMarkers: Array.from({ length: 20 }, (_, i) => `marker-${i}`),
    }
    const out = getProjectStateSection({ projectInitBrief: brief })
    expect(out).toContain("marker-0")
    expect(out).toContain("marker-11")
    expect(out).not.toContain("marker-12")
  })
})
