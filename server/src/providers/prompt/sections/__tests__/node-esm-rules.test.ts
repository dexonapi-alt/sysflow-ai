/**
 * Plan `2026-05-16-agent-code-correctness-and-completion-artifacts.md` Stage 1.
 *
 * Tests for the Node-ESM + TypeScript import rules section. Each
 * rule in the section maps to a real runtime failure the user
 * reported. The tests pin the canonical phrasing so a future refactor
 * doesn't drift the section away from the failures it documents.
 */

import { describe, it, expect } from "vitest"
import { getNodeEsmRulesSection, shouldRenderNodeEsmRules } from "../node-esm-rules.js"
import { buildSystemPrompt } from "../../build.js"

describe("getNodeEsmRulesSection — content + key examples", () => {
  it("renders the canonical header + footer markers", () => {
    const section = getNodeEsmRulesSection()
    expect(section).toContain("═══ NODE-ESM + TYPESCRIPT IMPORT RULES ═══")
    expect(section).toContain("═══ END NODE-ESM + TYPESCRIPT IMPORT RULES ═══")
  })

  it("rule 1: extension on relative imports — covers the user's ERR_MODULE_NOT_FOUND repro", () => {
    const section = getNodeEsmRulesSection()
    expect(section).toContain("RELATIVE IMPORTS REQUIRE THE FILE EXTENSION")
    // The wrong vs right examples must show the .ts extension difference.
    expect(section).toContain(`import pool from './config/db'`)
    expect(section).toContain(`import pool from './config/db.ts'`)
    expect(section).toContain("ERR_MODULE_NOT_FOUND")
  })

  it("rule 2: import type for type-only CJS imports — covers NextFunction + ValidationChain repros", () => {
    const section = getNodeEsmRulesSection()
    expect(section).toContain("`import type` FOR TYPE-ONLY IMPORTS FROM CJS PACKAGES")
    expect(section).toContain("import { Request, Response, NextFunction }")
    expect(section).toContain("import type { Request, Response, NextFunction }")
    expect(section).toContain("ValidationChain")
    expect(section).toContain("CommonJS module")
  })

  it("rule 3: default vs named exports — covers the errorHandler repro", () => {
    const section = getNodeEsmRulesSection()
    expect(section).toContain("DEFAULT vs NAMED EXPORTS")
    expect(section).toContain("./middleware/errorHandler.ts")
    expect(section).toContain("export const errorHandler")
    expect(section).toContain("does not provide an export named 'default'")
  })

  it("rule 4: bare-package imports require declared deps", () => {
    const section = getNodeEsmRulesSection()
    expect(section).toContain("BARE-PACKAGE IMPORTS REQUIRE THE DEP IN package.json")
    expect(section).toContain("Add \"express\" to package.json dependencies")
  })

  it("rule 5: forward-reference rule — producers before consumers", () => {
    const section = getNodeEsmRulesSection()
    expect(section).toContain("FORWARD-REFERENCE RULE")
    expect(section).toContain("PRODUCERS BEFORE CONSUMERS")
    expect(section).toContain("ReferenceError: authRoutes is not defined")
  })

  it("includes the verification hint linking to import-sanitizer warnings", () => {
    const section = getNodeEsmRulesSection()
    expect(section).toContain("VERIFICATION HINT")
    expect(section).toContain("import-sanitizer")
    expect(section).toContain("MANDATORY")
  })

  it("section is non-trivial in length (substantive content, not a stub)", () => {
    const section = getNodeEsmRulesSection()
    expect(section).not.toBeNull()
    // Five rules + examples + verification hint should produce a meaningful section.
    expect(section!.length).toBeGreaterThan(1500)
  })

  it("uses concrete code examples (wrong then right), not abstract prose", () => {
    const section = getNodeEsmRulesSection()
    expect(section).not.toBeNull()
    // The "Wrong: ... Right:" pattern appears for each rule with real syntax.
    const wrongCount = (section!.match(/Wrong:/g) || []).length
    const rightCount = (section!.match(/Right:/g) || []).length
    expect(wrongCount).toBeGreaterThanOrEqual(3)
    expect(rightCount).toBeGreaterThanOrEqual(3)
  })
})

describe("buildSystemPrompt — node-esm-rules section threaded through", () => {
  it("section appears in the full prompt with default ctx", () => {
    const built = buildSystemPrompt({})
    expect(built.full).toContain("═══ NODE-ESM + TYPESCRIPT IMPORT RULES ═══")
  })

  it("section lands in the cacheable portion (stable across runs)", () => {
    const built = buildSystemPrompt({})
    expect(built.cacheable).toContain("═══ NODE-ESM + TYPESCRIPT IMPORT RULES ═══")
  })

  it("section appears exactly once (no duplicate from refactors)", () => {
    const built = buildSystemPrompt({})
    const occurrences = (built.full.match(/═══ NODE-ESM \+ TYPESCRIPT IMPORT RULES ═══/g) || []).length
    expect(occurrences).toBe(1)
  })

  it("section sits BETWEEN task_guidelines and output_efficiency by priority", () => {
    const built = buildSystemPrompt({})
    // task-guidelines uses "═══ RULES ═══" as its marker; output-efficiency
    // uses "═══ OUTPUT EFFICIENCY ═══". Verify our new section sits between.
    const rulesIdx = built.full.indexOf("═══ RULES ═══")
    const nodeEsmIdx = built.full.indexOf("═══ NODE-ESM + TYPESCRIPT IMPORT RULES")
    const outputEffIdx = built.full.indexOf("═══ OUTPUT EFFICIENCY")
    expect(rulesIdx).toBeGreaterThan(-1)
    expect(nodeEsmIdx).toBeGreaterThan(rulesIdx)
    expect(outputEffIdx).toBeGreaterThan(nodeEsmIdx)
  })
})

// ─── Language gating (follow-up to Stage 1: avoid wasting tokens on non-Node repos) ───

describe("shouldRenderNodeEsmRules — language gate", () => {
  it("returns true when no project-init brief is present (defensive default)", () => {
    expect(shouldRenderNodeEsmRules({})).toBe(true)
    expect(shouldRenderNodeEsmRules({ projectInitBrief: undefined })).toBe(true)
  })

  it("returns true when project-init brief is not an object (malformed)", () => {
    expect(shouldRenderNodeEsmRules({ projectInitBrief: null })).toBe(true)
    expect(shouldRenderNodeEsmRules({ projectInitBrief: "string" })).toBe(true)
  })

  it("returns true for empty repos (stack not yet determined)", () => {
    expect(shouldRenderNodeEsmRules({
      projectInitBrief: { repoState: "empty", keyMarkers: [] },
    })).toBe(true)
  })

  it("returns true for small repos (stack not yet determined)", () => {
    expect(shouldRenderNodeEsmRules({
      projectInitBrief: { repoState: "small", keyMarkers: ["README.md"] },
    })).toBe(true)
  })

  it("returns true for existing-small with package.json", () => {
    expect(shouldRenderNodeEsmRules({
      projectInitBrief: { repoState: "existing-small", keyMarkers: ["package.json", "src/"] },
    })).toBe(true)
  })

  it("returns true for existing-large with tsconfig.json", () => {
    expect(shouldRenderNodeEsmRules({
      projectInitBrief: { repoState: "existing-large", keyMarkers: ["tsconfig.json", "src/", "tests/"] },
    })).toBe(true)
  })

  it("returns true when keyMarkers include node_modules", () => {
    expect(shouldRenderNodeEsmRules({
      projectInitBrief: { repoState: "existing-large", keyMarkers: ["node_modules", "src/"] },
    })).toBe(true)
  })

  it("returns true when keyMarkers include a .ts file", () => {
    expect(shouldRenderNodeEsmRules({
      projectInitBrief: { repoState: "existing-small", keyMarkers: ["index.ts"] },
    })).toBe(true)
  })

  it("returns true when keyMarkers include a .js / .mjs / .cjs file", () => {
    expect(shouldRenderNodeEsmRules({
      projectInitBrief: { repoState: "existing-small", keyMarkers: ["server.js"] },
    })).toBe(true)
    expect(shouldRenderNodeEsmRules({
      projectInitBrief: { repoState: "existing-small", keyMarkers: ["main.mjs"] },
    })).toBe(true)
  })

  it("returns FALSE for existing Python project (pyproject.toml + no Node markers)", () => {
    expect(shouldRenderNodeEsmRules({
      projectInitBrief: { repoState: "existing-small", keyMarkers: ["pyproject.toml", "src/", "tests/"] },
    })).toBe(false)
  })

  it("returns FALSE for existing Rust project (Cargo.toml)", () => {
    expect(shouldRenderNodeEsmRules({
      projectInitBrief: { repoState: "existing-large", keyMarkers: ["Cargo.toml", "src/", "target/"] },
    })).toBe(false)
  })

  it("returns FALSE for existing Go project (go.mod)", () => {
    expect(shouldRenderNodeEsmRules({
      projectInitBrief: { repoState: "existing-small", keyMarkers: ["go.mod", "go.sum", "main.go"] },
    })).toBe(false)
  })

  it("src/ alone doesn't qualify (Python uses it too)", () => {
    // src/ is the ONLY marker; no package.json / tsconfig.json / etc.
    expect(shouldRenderNodeEsmRules({
      projectInitBrief: { repoState: "existing-small", keyMarkers: ["src/"] },
    })).toBe(false)
  })

  it("ignores non-string entries in keyMarkers (defensive)", () => {
    expect(shouldRenderNodeEsmRules({
      projectInitBrief: { repoState: "existing-small", keyMarkers: [42, null, "package.json"] },
    })).toBe(true)
  })
})

describe("getNodeEsmRulesSection — returns null when gated off", () => {
  it("returns null on existing Python project", () => {
    const out = getNodeEsmRulesSection({
      projectInitBrief: { repoState: "existing-small", keyMarkers: ["pyproject.toml"] },
    })
    expect(out).toBeNull()
  })

  it("returns the section on Node project", () => {
    const out = getNodeEsmRulesSection({
      projectInitBrief: { repoState: "existing-small", keyMarkers: ["package.json"] },
    })
    expect(out).not.toBeNull()
    expect(out).toContain("═══ NODE-ESM + TYPESCRIPT IMPORT RULES ═══")
  })

  it("returns the section when no brief (default rendering preserved)", () => {
    const out = getNodeEsmRulesSection()
    expect(out).not.toBeNull()
  })
})

describe("buildSystemPrompt — section drops when language gate says skip", () => {
  it("section is ABSENT from full prompt for an existing Python project", () => {
    const built = buildSystemPrompt({
      projectInitBrief: { repoState: "existing-small", keyMarkers: ["pyproject.toml", "src/"] },
    })
    expect(built.full).not.toContain("═══ NODE-ESM + TYPESCRIPT IMPORT RULES ═══")
  })

  it("section is PRESENT for an existing Node project", () => {
    const built = buildSystemPrompt({
      projectInitBrief: { repoState: "existing-small", keyMarkers: ["package.json", "src/"] },
    })
    expect(built.full).toContain("═══ NODE-ESM + TYPESCRIPT IMPORT RULES ═══")
  })

  it("section is PRESENT for empty repo (stack not yet known)", () => {
    const built = buildSystemPrompt({
      projectInitBrief: { repoState: "empty", keyMarkers: [] },
    })
    expect(built.full).toContain("═══ NODE-ESM + TYPESCRIPT IMPORT RULES ═══")
  })
})
