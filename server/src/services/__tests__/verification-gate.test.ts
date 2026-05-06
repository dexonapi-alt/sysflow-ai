import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { runVerificationGate, gateSignals } from "../verification-gate.js"

let tmp: string

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "verify-gate-"))
})

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

async function write(rel: string, content: string): Promise<void> {
  const full = path.join(tmp, rel)
  await fs.mkdir(path.dirname(full), { recursive: true })
  await fs.writeFile(full, content, "utf8")
}

describe("verification-gate — import_resolves", () => {
  it("emits no signal when every relative import resolves", async () => {
    await write("src/a.js", "import { thing } from './b'\n")
    await write("src/b.js", "export const thing = 1\n")
    const outcomes = await runVerificationGate({
      cwd: tmp,
      filesModified: ["src/a.js", "src/b.js"],
      createdDirs: [],
    })
    const o = outcomes.find((x) => x.name === "import_resolves")!
    expect(o.signals).toEqual([])
  })

  it("flags an unresolved relative import", async () => {
    await write("src/a.js", "import { thing } from './missing'\n")
    const outcomes = await runVerificationGate({
      cwd: tmp,
      filesModified: ["src/a.js"],
      createdDirs: [],
    })
    const o = outcomes.find((x) => x.name === "import_resolves")!
    expect(o.signals.length).toBe(1)
    expect(o.signals[0].detail).toContain("missing")
  })

  it("ignores node builtins in bare imports", async () => {
    await write("package.json", JSON.stringify({ name: "t", dependencies: {} }))
    await write("src/a.js", "import fs from 'node:fs'\nimport path from 'path'\n")
    const outcomes = await runVerificationGate({
      cwd: tmp,
      filesModified: ["src/a.js"],
      createdDirs: [],
    })
    const o = outcomes.find((x) => x.name === "import_resolves")!
    expect(o.signals).toEqual([])
  })
})

describe("verification-gate — deps_cross_check", () => {
  it("flags bare imports missing from package.json", async () => {
    await write("package.json", JSON.stringify({ name: "t", dependencies: { lodash: "^4" } }))
    await write("src/a.js", "import lodash from 'lodash'\nimport pg from 'pg'\nimport { z } from 'zod'\n")
    const outcomes = await runVerificationGate({
      cwd: tmp,
      filesModified: ["src/a.js"],
      createdDirs: [],
    })
    const o = outcomes.find((x) => x.name === "deps_cross_check")!
    expect(o.signals.length).toBe(1)
    // "pg" and "zod" should be flagged; "lodash" should not.
    expect(o.signals[0].detail).toMatch(/pg/)
    expect(o.signals[0].detail).toMatch(/zod/)
    expect(o.signals[0].detail).not.toMatch(/lodash/)
  })

  it("treats devDependencies + peerDependencies as declared", async () => {
    await write("package.json", JSON.stringify({
      name: "t",
      dependencies: {},
      devDependencies: { vitest: "^1" },
      peerDependencies: { react: "^18" },
    }))
    await write("src/a.js", "import { describe } from 'vitest'\nimport React from 'react'\n")
    const outcomes = await runVerificationGate({
      cwd: tmp,
      filesModified: ["src/a.js"],
      createdDirs: [],
    })
    const o = outcomes.find((x) => x.name === "deps_cross_check")!
    expect(o.signals).toEqual([])
  })

  it("emits no signal when there's no package.json", async () => {
    await write("src/a.js", "import x from 'foo'\n")
    const outcomes = await runVerificationGate({
      cwd: tmp,
      filesModified: ["src/a.js"],
      createdDirs: [],
    })
    const o = outcomes.find((x) => x.name === "deps_cross_check")!
    expect(o.signals).toEqual([])
    expect(o.notes).toBe("no package.json")
  })

  it("strips subpath from scoped package specifiers", async () => {
    await write("package.json", JSON.stringify({ name: "t", dependencies: { "@aws-sdk/client-s3": "^3" } }))
    await write("src/a.js", "import { S3 } from '@aws-sdk/client-s3/dist/something'\n")
    const outcomes = await runVerificationGate({
      cwd: tmp,
      filesModified: ["src/a.js"],
      createdDirs: [],
    })
    const o = outcomes.find((x) => x.name === "deps_cross_check")!
    expect(o.signals).toEqual([])
  })
})

describe("verification-gate — node_syntax", () => {
  it("emits no signal on a syntactically-valid JS file", async () => {
    await write("src/ok.js", "const x = 1; export default x;\n")
    const outcomes = await runVerificationGate({
      cwd: tmp,
      filesModified: ["src/ok.js"],
      createdDirs: [],
    })
    const o = outcomes.find((x) => x.name === "node_syntax")!
    expect(o.signals).toEqual([])
  })

  it("flags a syntax error in a JS file", async () => {
    await write("src/broken.js", "function broken( { return 1\n")
    const outcomes = await runVerificationGate({
      cwd: tmp,
      filesModified: ["src/broken.js"],
      createdDirs: [],
    })
    const o = outcomes.find((x) => x.name === "node_syntax")!
    expect(o.signals.length).toBe(1)
    expect(o.signals[0].severity).toBe("major")
  })

  it("skips TypeScript files (node --check can't parse them)", async () => {
    await write("src/a.ts", "this is :: not :: valid :: typescript\n")
    const outcomes = await runVerificationGate({
      cwd: tmp,
      filesModified: ["src/a.ts"],
      createdDirs: [],
    })
    const o = outcomes.find((x) => x.name === "node_syntax")!
    expect(o.signals).toEqual([])
  })
})

describe("verification-gate — dir_emptiness", () => {
  it("flags a created dir with no files in it on disk or in the log", async () => {
    await fs.mkdir(path.join(tmp, "lonely"), { recursive: true })
    const outcomes = await runVerificationGate({
      cwd: tmp,
      filesModified: [],
      createdDirs: ["lonely"],
    })
    const o = outcomes.find((x) => x.name === "dir_emptiness")!
    expect(o.signals.length).toBe(1)
    expect(o.signals[0].detail).toContain("lonely")
  })

  it("does not flag when the dir was populated via a tracked write", async () => {
    await write("populated/file.js", "// hi\n")
    const outcomes = await runVerificationGate({
      cwd: tmp,
      filesModified: ["populated/file.js"],
      createdDirs: ["populated"],
    })
    const o = outcomes.find((x) => x.name === "dir_emptiness")!
    expect(o.signals).toEqual([])
  })

  it("does not flag when the dir contains files not in the log", async () => {
    // Agent created the dir, then via a path we don't track wrote into it.
    await write("populated-untracked/x.txt", "content\n")
    const outcomes = await runVerificationGate({
      cwd: tmp,
      filesModified: [],
      createdDirs: ["populated-untracked"],
    })
    const o = outcomes.find((x) => x.name === "dir_emptiness")!
    expect(o.signals).toEqual([])
  })
})

describe("verification-gate — gateSignals helper", () => {
  it("flattens signals across all checks", async () => {
    await fs.mkdir(path.join(tmp, "empty"), { recursive: true })
    await write("src/a.js", "import './missing'\n")
    const outcomes = await runVerificationGate({
      cwd: tmp,
      filesModified: ["src/a.js"],
      createdDirs: ["empty"],
    })
    const all = gateSignals(outcomes)
    // Expect at least the import-resolves signal + the dir-emptiness signal.
    expect(all.length).toBeGreaterThanOrEqual(2)
  })
})
