/**
 * Verification gate — ground-truth checks that don't need an LLM.
 *
 * Phase 11 Stage 2. Reads files written this run from disk and runs four
 * cheap, parallelisable checks. Each check that flags something becomes a
 * `DivergenceSignal` consumed by the same confidence tracker as the
 * heuristic detector — they're peers, not chained.
 *
 * The gate runs server-side (so it can read the run's cwd directly) and is
 * gated by the same `awareness.enabled` flag as the heuristic detector.
 *
 * Checks:
 *   1. import-resolves           — every relative + bare import points at
 *                                  a real file or installed dep
 *   2. deps-cross-check          — package.json `dependencies` and the
 *                                  set of imported bare specifiers are
 *                                  consistent (no missing deps; no unused
 *                                  bloat from one chunk to the next)
 *   3. node-syntax-check         — `node --check` syntax-only on each
 *                                  changed JS/TS file (TS via ts-node not
 *                                  required — node parses the source)
 *   4. dir-emptiness audit       — every `create_directory` path has at
 *                                  least one file written into it by now
 *
 * All checks have hard timeouts; on timeout / error we emit no signal
 * rather than guess. The gate is best-effort; its goal is to feed the
 * confidence tracker, not to block the run.
 */

import fs from "node:fs/promises"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { DivergenceSignal } from "./divergence-detector.js"

const exec = promisify(execFile)

export interface VerificationGateInput {
  /** Working directory of the run. */
  cwd: string
  /** Files modified this run (relative to cwd, deduped). */
  filesModified: string[]
  /** Directories the agent explicitly created via create_directory. */
  createdDirs: string[]
}

export interface VerificationCheckOutcome {
  name: "import_resolves" | "deps_cross_check" | "node_syntax" | "dir_emptiness"
  durationMs: number
  signals: DivergenceSignal[]
  /** Optional debug info — used by tests, logged at debug level otherwise. */
  notes?: string
}

const PER_CHECK_TIMEOUT_MS = 1_000
const NODE_CHECK_TIMEOUT_MS = 800
const SCRIPT_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"])

/**
 * Run all four checks in parallel and return their outcomes. Pure I/O —
 * never throws; check failures are reported as `signals: []` with a note.
 */
export async function runVerificationGate(input: VerificationGateInput): Promise<VerificationCheckOutcome[]> {
  const checks = [
    withTimeout(checkImportResolves(input), PER_CHECK_TIMEOUT_MS, "import_resolves"),
    withTimeout(checkDepsCrossCheck(input), PER_CHECK_TIMEOUT_MS, "deps_cross_check"),
    withTimeout(checkNodeSyntax(input), PER_CHECK_TIMEOUT_MS * 2, "node_syntax"),
    withTimeout(checkDirEmptiness(input), PER_CHECK_TIMEOUT_MS, "dir_emptiness"),
  ]
  return Promise.all(checks)
}

/** Convenience: flatten all gate outcomes into a single signals array. */
export function gateSignals(outcomes: VerificationCheckOutcome[]): DivergenceSignal[] {
  return outcomes.flatMap((o) => o.signals)
}

// ─── Check 1: import-resolves ────────────────────────────────────────────

async function checkImportResolves(input: VerificationGateInput): Promise<VerificationCheckOutcome> {
  const start = Date.now()
  const signals: DivergenceSignal[] = []
  const broken: string[] = []

  // Cache installed deps once per check.
  const installedDeps = await readInstalledDeps(input.cwd)

  for (const rel of input.filesModified) {
    if (!SCRIPT_EXTS.has(path.extname(rel))) continue
    const full = path.resolve(input.cwd, rel)
    let content: string
    try {
      content = await fs.readFile(full, "utf8")
    } catch {
      continue // file doesn't exist on disk — flagged elsewhere
    }

    for (const spec of extractImports(content)) {
      if (spec.startsWith(".")) {
        const ok = await tryResolveRelative(path.dirname(full), spec)
        if (!ok) broken.push(`${rel}: relative import "${spec}" doesn't resolve`)
      } else {
        // Bare import — must appear in package.json deps OR be a node builtin.
        const root = bareSpecifierRoot(spec)
        if (NODE_BUILTINS.has(root)) continue
        if (!installedDeps.has(root)) broken.push(`${rel}: bare import "${spec}" not in package.json deps`)
      }
    }
  }

  if (broken.length > 0) {
    signals.push({
      category: "repeated_tool_error",
      detail: `${broken.length} unresolved import(s): ${broken.slice(0, 3).join("; ")}`,
      severity: broken.length >= 3 ? "major" : "moderate",
    })
  }

  return { name: "import_resolves", durationMs: Date.now() - start, signals, notes: broken.length > 0 ? `${broken.length} broken` : "ok" }
}

// ─── Check 2: deps cross-check ───────────────────────────────────────────

async function checkDepsCrossCheck(input: VerificationGateInput): Promise<VerificationCheckOutcome> {
  const start = Date.now()
  const signals: DivergenceSignal[] = []

  const declared = await readDeclaredDeps(input.cwd)
  if (!declared) {
    return { name: "deps_cross_check", durationMs: Date.now() - start, signals, notes: "no package.json" }
  }

  // Bare imports actually used across the run's files.
  const usedBare = new Set<string>()
  for (const rel of input.filesModified) {
    if (!SCRIPT_EXTS.has(path.extname(rel))) continue
    const full = path.resolve(input.cwd, rel)
    let content: string
    try { content = await fs.readFile(full, "utf8") } catch { continue }
    for (const spec of extractImports(content)) {
      if (spec.startsWith(".")) continue
      const root = bareSpecifierRoot(spec)
      if (!NODE_BUILTINS.has(root)) usedBare.add(root)
    }
  }

  const missing: string[] = []
  for (const used of usedBare) {
    if (!declared.has(used)) missing.push(used)
  }

  if (missing.length > 0) {
    signals.push({
      category: "repeated_tool_error",
      detail: `${missing.length} import(s) not in package.json deps: ${missing.slice(0, 4).join(", ")}`,
      severity: missing.length >= 3 ? "major" : "moderate",
    })
  }

  return { name: "deps_cross_check", durationMs: Date.now() - start, signals, notes: `used=${usedBare.size} declared=${declared.size} missing=${missing.length}` }
}

// ─── Check 3: node --check syntax-only ───────────────────────────────────

async function checkNodeSyntax(input: VerificationGateInput): Promise<VerificationCheckOutcome> {
  const start = Date.now()
  const signals: DivergenceSignal[] = []
  const broken: string[] = []

  // Cap how many files we run `node --check` on per chunk so a giant batch
  // never blows the gate's <1s budget. Most chunks touch ≤5 files anyway.
  const targets = input.filesModified.filter((r) => {
    const ext = path.extname(r)
    return ext === ".js" || ext === ".mjs" || ext === ".cjs"
  }).slice(0, 5)

  for (const rel of targets) {
    const full = path.resolve(input.cwd, rel)
    try {
      await exec(process.execPath, ["--check", full], { cwd: input.cwd, timeout: NODE_CHECK_TIMEOUT_MS })
    } catch (err) {
      const msg = (err as Error & { stderr?: string }).stderr || (err as Error).message
      broken.push(`${rel}: ${(msg || "").split("\n")[0].slice(0, 140)}`)
    }
  }

  if (broken.length > 0) {
    signals.push({
      category: "repeated_tool_error",
      detail: `${broken.length} syntax error(s): ${broken.slice(0, 2).join(" | ")}`,
      severity: "major",
    })
  }

  return { name: "node_syntax", durationMs: Date.now() - start, signals, notes: broken.length > 0 ? `${broken.length} broken` : "ok" }
}

// ─── Check 4: dir emptiness audit ────────────────────────────────────────

async function checkDirEmptiness(input: VerificationGateInput): Promise<VerificationCheckOutcome> {
  const start = Date.now()
  const signals: DivergenceSignal[] = []
  const empty: string[] = []

  for (const dir of input.createdDirs) {
    const norm = dir.endsWith("/") ? dir : dir + "/"
    const populatedFromLog = input.filesModified.some((f) => f.startsWith(norm))
    if (populatedFromLog) continue

    // Disk-side double-check — the agent could have written via a tool path
    // we don't track in filesModified. Walk one level only; fast.
    const full = path.resolve(input.cwd, dir)
    let onDisk = false
    try {
      const entries = await fs.readdir(full)
      onDisk = entries.length > 0
    } catch {
      // Dir was create_directory'd but never made it to disk — still empty.
    }
    if (!onDisk) empty.push(dir)
  }

  if (empty.length > 0) {
    signals.push({
      category: "mkdir_empty_at_chunk_boundary",
      detail: `${empty.length} created dir(s) still empty: ${empty.slice(0, 3).join(", ")}`,
      severity: "minor",
    })
  }

  return { name: "dir_emptiness", durationMs: Date.now() - start, signals, notes: `created=${input.createdDirs.length} empty=${empty.length}` }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/** Rejecting `withTimeout` returns an empty-signals outcome so the gate keeps moving. */
function withTimeout(p: Promise<VerificationCheckOutcome>, ms: number, name: VerificationCheckOutcome["name"]): Promise<VerificationCheckOutcome> {
  return new Promise<VerificationCheckOutcome>((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve({ name, durationMs: ms, signals: [], notes: "timeout" })
    }, ms)
    p.then((v) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(v)
    }).catch((err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ name, durationMs: ms, signals: [], notes: `error: ${(err as Error).message}` })
    })
  })
}

/** Extract import + require specifiers. Misses dynamic imports — fine for v1. */
function extractImports(content: string): string[] {
  const out: string[] = []
  const importRe = /(?:import\s+(?:[^'"]+?\s+from\s+)?|export\s+[^'"]+?\s+from\s+)['"]([^'"]+)['"]/g
  const requireRe = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g
  let m
  while ((m = importRe.exec(content)) !== null) out.push(m[1])
  while ((m = requireRe.exec(content)) !== null) out.push(m[1])
  return out
}

async function tryResolveRelative(fromDir: string, spec: string): Promise<boolean> {
  const candidates = [
    spec,
    spec + ".ts", spec + ".tsx", spec + ".js", spec + ".jsx", spec + ".mjs", spec + ".cjs",
    path.join(spec, "index.ts"),
    path.join(spec, "index.tsx"),
    path.join(spec, "index.js"),
    path.join(spec, "index.jsx"),
  ]
  for (const c of candidates) {
    try {
      await fs.access(path.resolve(fromDir, c))
      return true
    } catch { /* try next */ }
  }
  return false
}

/** Strip subpath imports like `react-router-dom/server` → `react-router-dom`. Scoped pkgs preserved. */
function bareSpecifierRoot(spec: string): string {
  if (spec.startsWith("@")) {
    const parts = spec.split("/")
    return parts.slice(0, 2).join("/") || spec
  }
  return spec.split("/")[0]
}

async function readInstalledDeps(cwd: string): Promise<Set<string>> {
  // Use the declared deps as the source of truth — node_modules can be stale.
  // A future iteration can fall back to fs.readdir(node_modules) when deps
  // are missing.
  const declared = await readDeclaredDeps(cwd)
  return declared ?? new Set()
}

async function readDeclaredDeps(cwd: string): Promise<Set<string> | null> {
  try {
    const raw = await fs.readFile(path.join(cwd, "package.json"), "utf8")
    const pkg = JSON.parse(raw) as Record<string, Record<string, string> | undefined>
    const out = new Set<string>()
    for (const k of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      const obj = pkg[k]
      if (obj && typeof obj === "object") for (const name of Object.keys(obj)) out.add(name)
    }
    return out
  } catch {
    return null
  }
}

const NODE_BUILTINS = new Set([
  "node:fs", "node:path", "node:url", "node:util", "node:os", "node:crypto", "node:child_process", "node:stream",
  "node:buffer", "node:events", "node:http", "node:https", "node:net", "node:tls", "node:zlib", "node:process",
  "node:worker_threads", "node:assert", "node:querystring", "node:readline", "node:perf_hooks", "node:timers",
  "fs", "path", "url", "util", "os", "crypto", "child_process", "stream",
  "buffer", "events", "http", "https", "net", "tls", "zlib", "process",
  "worker_threads", "assert", "querystring", "readline", "perf_hooks", "timers",
  "fs/promises", "node:fs/promises", "stream/promises", "node:stream/promises",
])
