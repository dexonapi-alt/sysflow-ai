/**
 * Plan `2026-05-16-agent-code-correctness-and-completion-artifacts.md` Stage 4.
 *
 * Tests for the prompt-implied completion-artifact gate. Pure
 * classifier + async file scanner + inject renderer.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import {
  classifyImpliedArtifacts,
  artifactExists,
  checkImpliedArtifacts,
  buildArtifactMissingInject,
  impliedArtifactFromKind,
} from "../completion-artifact-gate.js"
import { setExpectedArtifacts, clearExpectedArtifacts } from "../setup-intelligence.js"

describe("classifyImpliedArtifacts — keyword matching", () => {
  it("returns empty list for prompts without implied artifacts", () => {
    expect(classifyImpliedArtifacts("write a hello world script")).toEqual([])
    expect(classifyImpliedArtifacts("")).toEqual([])
  })

  it("fires db_schema on postgres / postgresql / mysql / sqlite / mongo / mariadb", () => {
    for (const kw of ["postgres", "postgresql", "mysql", "sqlite", "mongo", "mongodb", "mariadb"]) {
      const out = classifyImpliedArtifacts(`build me an app with ${kw}`)
      expect(out).toHaveLength(1)
      expect(out[0].kind).toBe("db_schema")
    }
  })

  it("fires db_schema on `pg` as a whole word but not in `page` / `spring`", () => {
    expect(classifyImpliedArtifacts("use pg for the database").length).toBe(1)
    expect(classifyImpliedArtifacts("build a landing page")).toEqual([])
    expect(classifyImpliedArtifacts("use spring boot")).toEqual([])
  })

  it("fires prisma_schema (not db_schema) on prisma — more specific wins", () => {
    const out = classifyImpliedArtifacts("build me a backend with prisma + postgres")
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe("prisma_schema")
    // db_schema is implicit via prisma's own schema; don't double-fire.
  })

  it("fires tests on standalone tests / testing / unit test / integration test", () => {
    for (const kw of ["tests", "testing", "unit test", "integration test", "test suite"]) {
      const out = classifyImpliedArtifacts(`build a CLI with ${kw}`)
      expect(out.some((a) => a.kind === "tests")).toBe(true)
    }
  })

  it("does NOT fire tests on verb-form 'test the app' / 'test it out'", () => {
    expect(classifyImpliedArtifacts("build it and test it").every((a) => a.kind !== "tests")).toBe(true)
    expect(classifyImpliedArtifacts("test this out").every((a) => a.kind !== "tests")).toBe(true)
  })

  it("can fire multiple kinds for one prompt", () => {
    const out = classifyImpliedArtifacts("build a PostgreSQL backend with tests")
    const kinds = out.map((a) => a.kind)
    expect(kinds).toContain("db_schema")
    expect(kinds).toContain("tests")
  })

  it("each artifact carries trigger + examples", () => {
    const out = classifyImpliedArtifacts("build with PostgreSQL")
    expect(out[0].trigger).toContain("database")
    expect(out[0].examples).toContain("schema.sql")
    expect(out[0].examples.length).toBeGreaterThan(0)
  })

  it("is case-insensitive", () => {
    expect(classifyImpliedArtifacts("BUILD WITH POSTGRES").length).toBe(1)
    expect(classifyImpliedArtifacts("Build With Prisma").length).toBe(1)
  })

  it("tolerates null / undefined / non-string defensively", () => {
    expect(classifyImpliedArtifacts(null as unknown as string)).toEqual([])
    expect(classifyImpliedArtifacts(undefined as unknown as string)).toEqual([])
    expect(classifyImpliedArtifacts(42 as unknown as string)).toEqual([])
  })
})

describe("artifactExists — file scanner", () => {
  let tmp: string
  beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sysflow-artifact-gate-")) })
  afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }) })

  it("returns false for empty cwd (no artifacts)", async () => {
    expect(await artifactExists(tmp, "db_schema")).toBe(false)
    expect(await artifactExists(tmp, "prisma_schema")).toBe(false)
    expect(await artifactExists(tmp, "tests")).toBe(false)
  })

  it("finds schema.sql at root", async () => {
    await fs.writeFile(path.join(tmp, "schema.sql"), "CREATE TABLE users();", "utf8")
    expect(await artifactExists(tmp, "db_schema")).toBe(true)
  })

  it("finds migrations/*.sql", async () => {
    await fs.mkdir(path.join(tmp, "migrations"), { recursive: true })
    await fs.writeFile(path.join(tmp, "migrations", "001_initial.sql"), "...", "utf8")
    expect(await artifactExists(tmp, "db_schema")).toBe(true)
  })

  it("finds prisma/schema.prisma for prisma kind", async () => {
    await fs.mkdir(path.join(tmp, "prisma"), { recursive: true })
    await fs.writeFile(path.join(tmp, "prisma", "schema.prisma"), "...", "utf8")
    expect(await artifactExists(tmp, "prisma_schema")).toBe(true)
  })

  it("does NOT match schema.sql for prisma kind (specific)", async () => {
    await fs.writeFile(path.join(tmp, "schema.sql"), "...", "utf8")
    expect(await artifactExists(tmp, "prisma_schema")).toBe(false)
  })

  it("finds *.test.ts / *.spec.ts for tests kind", async () => {
    await fs.mkdir(path.join(tmp, "tests"), { recursive: true })
    await fs.writeFile(path.join(tmp, "tests", "foo.test.ts"), "test", "utf8")
    expect(await artifactExists(tmp, "tests")).toBe(true)
  })

  it("finds *.spec.js (alternative test naming)", async () => {
    await fs.writeFile(path.join(tmp, "auth.spec.js"), "test", "utf8")
    expect(await artifactExists(tmp, "tests")).toBe(true)
  })

  it("skips node_modules + dist + .git", async () => {
    // schema.sql nested INSIDE node_modules shouldn't count
    await fs.mkdir(path.join(tmp, "node_modules", "pkg"), { recursive: true })
    await fs.writeFile(path.join(tmp, "node_modules", "pkg", "schema.sql"), "...", "utf8")
    expect(await artifactExists(tmp, "db_schema")).toBe(false)
  })

  it("returns false for non-existent cwd defensively", async () => {
    expect(await artifactExists(path.join(tmp, "does-not-exist"), "db_schema")).toBe(false)
  })
})

describe("checkImpliedArtifacts — integration", () => {
  let tmp: string
  beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sysflow-artifact-int-")) })
  afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }) })

  it("ok=true when prompt implies nothing", async () => {
    const r = await checkImpliedArtifacts("write a hello world script", tmp)
    expect(r.ok).toBe(true)
    expect(r.expected).toEqual([])
    expect(r.missing).toEqual([])
  })

  it("ok=false + missing list when postgres prompt + no schema", async () => {
    const r = await checkImpliedArtifacts("build a PostgreSQL backend", tmp)
    expect(r.ok).toBe(false)
    expect(r.expected.map((a) => a.kind)).toContain("db_schema")
    expect(r.missing.map((a) => a.kind)).toContain("db_schema")
  })

  it("ok=true when postgres prompt + schema.sql exists", async () => {
    await fs.writeFile(path.join(tmp, "schema.sql"), "...", "utf8")
    const r = await checkImpliedArtifacts("build a PostgreSQL backend", tmp)
    expect(r.ok).toBe(true)
    expect(r.missing).toEqual([])
  })

  it("ok=false with multiple missing on combined prompt", async () => {
    const r = await checkImpliedArtifacts("build a PostgreSQL backend with tests", tmp)
    expect(r.ok).toBe(false)
    expect(r.missing).toHaveLength(2)
  })
})

describe("buildArtifactMissingInject", () => {
  it("returns empty string when nothing missing", () => {
    expect(buildArtifactMissingInject([])).toBe("")
  })

  it("renders header + footer markers", () => {
    const out = buildArtifactMissingInject([{
      kind: "db_schema",
      expected: "a SQL schema file",
      trigger: "your prompt mentioned a database",
      examples: ["schema.sql"],
    }])
    expect(out).toContain("═══ COMPLETION BLOCKED — PROMPT-IMPLIED ARTIFACT MISSING ═══")
    expect(out).toContain("═══ END COMPLETION BLOCKED ═══")
  })

  it("lists missing artifact with expected + trigger + examples", () => {
    const out = buildArtifactMissingInject([{
      kind: "db_schema",
      expected: "a SQL schema file (e.g. `schema.sql`)",
      trigger: "your prompt mentioned a database",
      examples: ["schema.sql", "migrations/001_initial.sql"],
    }])
    expect(out).toContain("MISSING: a SQL schema file")
    expect(out).toContain("WHY REQUIRED: your prompt mentioned a database")
    expect(out).toContain("- schema.sql")
    expect(out).toContain("- migrations/001_initial.sql")
  })

  it("warns against shipping 'manual step' disclaimer", () => {
    const out = buildArtifactMissingInject([{
      kind: "db_schema",
      expected: "schema",
      trigger: "postgres",
      examples: ["schema.sql"],
    }])
    expect(out).toContain("manual step")
    expect(out).toContain("part of the agent's job")
  })

  it("uses singular vs plural framing correctly", () => {
    const single = buildArtifactMissingInject([
      { kind: "db_schema", expected: "schema", trigger: "x", examples: ["schema.sql"] },
    ])
    expect(single).toContain("1 artifact that wasn't")

    const multi = buildArtifactMissingInject([
      { kind: "db_schema", expected: "schema", trigger: "x", examples: ["schema.sql"] },
      { kind: "tests", expected: "tests", trigger: "y", examples: ["foo.test.ts"] },
    ])
    expect(multi).toContain("2 artifacts that weren't")
  })

  it("warns against re-declaring completion until all artifacts exist", () => {
    const out = buildArtifactMissingInject([{
      kind: "db_schema", expected: "x", trigger: "y", examples: ["z"],
    }])
    expect(out).toContain("Do NOT declare 'completed' again")
  })
})

// ─── LLM-driven tier (Stage 4 follow-up: LLM decides, gate enforces) ───

describe("impliedArtifactFromKind", () => {
  it("rehydrates db_schema metadata", () => {
    const a = impliedArtifactFromKind("db_schema")
    expect(a.kind).toBe("db_schema")
    expect(a.expected).toContain("SQL schema")
    expect(a.trigger).toContain("project-init reasoner")
    expect(a.examples.length).toBeGreaterThan(0)
  })

  it("rehydrates prisma_schema metadata", () => {
    const a = impliedArtifactFromKind("prisma_schema")
    expect(a.kind).toBe("prisma_schema")
    expect(a.examples).toContain("prisma/schema.prisma")
  })

  it("rehydrates tests metadata", () => {
    const a = impliedArtifactFromKind("tests")
    expect(a.kind).toBe("tests")
    expect(a.examples.some((e) => e.includes(".test.") || e.includes(".spec."))).toBe(true)
  })
})

describe("checkImpliedArtifacts — LLM-driven tier (Stage 4 follow-up)", () => {
  let tmp: string
  const RUN_ID = "test-llm-tier"
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sysflow-llm-tier-"))
    clearExpectedArtifacts(RUN_ID)
  })
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true })
    clearExpectedArtifacts(RUN_ID)
  })

  it("LLM said no artifacts → gate skips even when prompt mentions postgres (no false positive)", async () => {
    // The KEYWORD classifier would fire here. The LLM verdict wins.
    setExpectedArtifacts(RUN_ID, [])
    const r = await checkImpliedArtifacts("build a CLI that reads PG conn from env", tmp, RUN_ID)
    expect(r.ok).toBe(true)
    expect(r.expected).toEqual([])
    expect(r.missing).toEqual([])
  })

  it("LLM said db_schema required → gate enforces (missing file → block)", async () => {
    setExpectedArtifacts(RUN_ID, ["db_schema"])
    const r = await checkImpliedArtifacts("build a PG-backed app", tmp, RUN_ID)
    expect(r.ok).toBe(false)
    expect(r.missing.map((a) => a.kind)).toEqual(["db_schema"])
  })

  it("LLM said db_schema required → gate passes when schema.sql exists", async () => {
    setExpectedArtifacts(RUN_ID, ["db_schema"])
    await fs.writeFile(path.join(tmp, "schema.sql"), "...", "utf8")
    const r = await checkImpliedArtifacts("build a PG-backed app", tmp, RUN_ID)
    expect(r.ok).toBe(true)
    expect(r.missing).toEqual([])
  })

  it("LLM said multiple artifacts → gate enforces all", async () => {
    setExpectedArtifacts(RUN_ID, ["db_schema", "tests"])
    await fs.writeFile(path.join(tmp, "schema.sql"), "...", "utf8")
    // tests missing
    const r = await checkImpliedArtifacts("anything", tmp, RUN_ID)
    expect(r.ok).toBe(false)
    expect(r.missing.map((a) => a.kind)).toEqual(["tests"])
  })

  it("LLM tier WINS over keyword classifier even when prompt has DB keywords", async () => {
    // Keyword classifier would say db_schema; LLM says no.
    setExpectedArtifacts(RUN_ID, [])
    const r = await checkImpliedArtifacts("build a tool similar to postgres", tmp, RUN_ID)
    expect(r.ok).toBe(true)
  })

  it("falls back to keyword classifier when LLM didn't run (no per-run state)", async () => {
    // Don't call setExpectedArtifacts — simulates project-init not firing.
    const r = await checkImpliedArtifacts("build a PostgreSQL backend", tmp, RUN_ID)
    expect(r.ok).toBe(false)
    expect(r.expected.map((a) => a.kind)).toContain("db_schema")
  })

  it("falls back to keyword classifier when no runId provided", async () => {
    const r = await checkImpliedArtifacts("build a PostgreSQL backend", tmp)
    expect(r.ok).toBe(false)
    expect(r.expected.map((a) => a.kind)).toContain("db_schema")
  })

  it("filters invalid kinds defensively from the LLM's array", async () => {
    setExpectedArtifacts(RUN_ID, ["db_schema", "not_a_real_kind", "tests"])
    const r = await checkImpliedArtifacts("anything", tmp, RUN_ID)
    // Only the two valid kinds get classified.
    expect(r.expected.map((a) => a.kind).sort()).toEqual(["db_schema", "tests"])
  })

  it("empty LLM list is meaningful (treated as 'no artifacts needed') — NOT same as missing state", async () => {
    setExpectedArtifacts(RUN_ID, [])
    // Prompt has postgres keyword — keyword classifier WOULD fire — but LLM-driven path says skip.
    const r = await checkImpliedArtifacts("PostgreSQL setup guide explanation", tmp, RUN_ID)
    expect(r.ok).toBe(true)
    expect(r.expected).toEqual([])
  })
})
