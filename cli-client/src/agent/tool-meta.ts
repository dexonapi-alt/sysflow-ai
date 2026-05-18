/**
 * Tool metadata: concurrency safety, read-only flag, sibling-abort behaviour.
 *
 * Single source of truth for the concurrency model used by executor.ts.
 * Replaces the heuristic 'if tool === run_command run sequentially'
 * that was sprinkled through batch execution.
 *
 * Each tool declares:
 *   - isConcurrencySafe: can run in parallel with siblings (different paths)
 *   - isReadOnly: doesn't modify project state
 *   - abortsSiblingsOnError: a failure should cancel sibling tools in the batch
 */

export interface ToolMeta {
  isConcurrencySafe: boolean
  isReadOnly: boolean
  abortsSiblingsOnError: boolean
  /** Default permission decision for this tool when no rule matches. */
  defaultPermission: "allow" | "ask" | "deny"
}

export const TOOL_META: Record<string, ToolMeta> = {
  read_file:        { isConcurrencySafe: true,  isReadOnly: true,  abortsSiblingsOnError: false, defaultPermission: "allow" },
  batch_read:       { isConcurrencySafe: true,  isReadOnly: true,  abortsSiblingsOnError: false, defaultPermission: "allow" },
  list_directory:   { isConcurrencySafe: true,  isReadOnly: true,  abortsSiblingsOnError: false, defaultPermission: "allow" },
  search_code:      { isConcurrencySafe: true,  isReadOnly: true,  abortsSiblingsOnError: false, defaultPermission: "allow" },
  search_files:     { isConcurrencySafe: true,  isReadOnly: true,  abortsSiblingsOnError: false, defaultPermission: "allow" },
  web_search:       { isConcurrencySafe: true,  isReadOnly: true,  abortsSiblingsOnError: false, defaultPermission: "allow" },
  file_exists:      { isConcurrencySafe: true,  isReadOnly: true,  abortsSiblingsOnError: false, defaultPermission: "allow" },
  // Authoring tools auto-allow: scaffolding 30 files shouldn't take 30
  // permission prompts. The agent works on a project the user explicitly
  // pointed it at, and every change is git-snapshotted before the batch
  // runs (see executeToolsBatch). The user gates the *agent run*, not
  // each line of code it writes.
  write_file:       { isConcurrencySafe: true,  isReadOnly: false, abortsSiblingsOnError: false, defaultPermission: "allow" },
  edit_file:        { isConcurrencySafe: true,  isReadOnly: false, abortsSiblingsOnError: false, defaultPermission: "allow" },
  create_directory: { isConcurrencySafe: true,  isReadOnly: false, abortsSiblingsOnError: false, defaultPermission: "allow" },
  // move/delete are destructive (not authoring) — keep them gated.
  move_file:        { isConcurrencySafe: false, isReadOnly: false, abortsSiblingsOnError: false, defaultPermission: "ask" },
  delete_file:      { isConcurrencySafe: false, isReadOnly: false, abortsSiblingsOnError: false, defaultPermission: "ask" },
  // Shell commands stay gated — that's the side-effect surface that can
  // touch the network, install packages, or escape the project dir.
  run_command:      { isConcurrencySafe: false, isReadOnly: false, abortsSiblingsOnError: true,  defaultPermission: "ask" },
  batch_write:      { isConcurrencySafe: true,  isReadOnly: false, abortsSiblingsOnError: false, defaultPermission: "allow" },
  // Phase 5: pure thinking — no permission prompt, no side effects.
  reason:           { isConcurrencySafe: true,  isReadOnly: true,  abortsSiblingsOnError: false, defaultPermission: "allow" },
  // Phase 7: pure local poll of the in-memory JobRegistry.
  check_jobs:       { isConcurrencySafe: true,  isReadOnly: true,  abortsSiblingsOnError: false, defaultPermission: "allow" },
}

const DEFAULT_META: ToolMeta = {
  isConcurrencySafe: false,
  isReadOnly: false,
  abortsSiblingsOnError: false,
  defaultPermission: "ask",
}

export function getToolMeta(tool: string): ToolMeta {
  return TOOL_META[tool] ?? DEFAULT_META
}

/**
 * Stage 1 of plan 2026-05-16-server-hardening-and-error-source-distinction.md.
 *
 * Canonical set of tool names the cli executor knows how to dispatch.
 * Derived from TOOL_META keys so the set stays in sync with the
 * registry. Used by the validation gate (`isKnownTool`) before any
 * tool call leaves the cli — closes the bug where the agent emitted
 * a null/hallucinated tool name, the cli rendered `▸ unknown {}`, and
 * the server crashed with a Postgres NOT NULL violation on `tool`.
 */
export const KNOWN_TOOL_NAMES: ReadonlySet<string> = new Set(Object.keys(TOOL_META))

/**
 * Pure: returns true when `tool` is a non-empty string in
 * `KNOWN_TOOL_NAMES`. Null / undefined / empty / unknown → false.
 */
export function isKnownTool(tool: unknown): tool is string {
  return typeof tool === "string" && tool.length > 0 && KNOWN_TOOL_NAMES.has(tool)
}

export interface ToolCallEntry {
  id: string
  tool: string
  args: Record<string, unknown>
}

/**
 * Split a batch of tool calls into concurrency-safe parallel groups + a serial
 * tail. Order within each group is preserved.
 *
 * Returns:
 *   - parallel: tools that can run via Promise.allSettled in one shot
 *   - serial:   tools that must run one-at-a-time, in order, after the parallel batch
 */
export function partitionToolCalls(tools: ToolCallEntry[]): { parallel: ToolCallEntry[]; serial: ToolCallEntry[] } {
  const parallel: ToolCallEntry[] = []
  const serial: ToolCallEntry[] = []
  for (const tc of tools) {
    if (getToolMeta(tc.tool).isConcurrencySafe) parallel.push(tc)
    else serial.push(tc)
  }
  return { parallel, serial }
}

/**
 * Plan `2026-05-18-batch-heading-and-permission-label-polish.md` issue #5.
 *
 * Classify a batch's dispatch shape from the tool list, so the cli's
 * `╭── … (N tools)` heading reflects what'll actually happen on the
 * wire instead of always reading `batch`.
 *
 *   "parallel" — every tool is concurrency-safe; the executor will
 *                run them via Promise.allSettled.
 *   "serial"   — every tool is concurrency-unsafe; the executor will
 *                run them one-at-a-time (run_command path).
 *   "mixed"    — both kinds present; the executor runs the parallel
 *                group first, then drains serial.
 *
 * Pre-Plan-2 the heading was decided by `hasCommands ? "batch" : "parallel"`
 * which collapsed every mixed batch into a single "batch" label, hiding
 * the fact that the run_command items are serialised behind the parallel
 * group. Users reading "batch" expected parallel; some saw a sequential
 * series of permission prompts and were confused.
 *
 * Pure; exported for direct tests.
 */
export type BatchDispatchShape = "parallel" | "serial" | "mixed"

export function classifyBatchDispatch(tools: ReadonlyArray<ToolCallEntry>): BatchDispatchShape {
  const { parallel, serial } = partitionToolCalls([...tools])
  if (parallel.length === 0 && serial.length > 0) return "serial"
  if (serial.length === 0 && parallel.length > 0) return "parallel"
  if (parallel.length > 0 && serial.length > 0) return "mixed"
  // Empty batch — render as "parallel" by convention (the heading
  // accommodates 0 tools cleanly).
  return "parallel"
}

export interface BatchHeading {
  /** The shape verb — "parallel" / "serial" / "mixed". Rendered in accent. */
  verb: string
  /** The parenthetical count — `(N tools)` or `(P parallel + S serial)`. Rendered in muted. */
  detail: string
}

/**
 * Pure: structured heading for a batch shape. Keeps the verb + detail
 * separable so the cli can preserve the existing accent/muted colour
 * split when rendering.
 *
 * `mixed` form surfaces BOTH counts so the user can predict the
 * dispatch pattern (e.g. one batch_read parallel + two run_command
 * serial).
 */
export function formatBatchHeading(tools: ReadonlyArray<ToolCallEntry>): BatchHeading {
  const { parallel, serial } = partitionToolCalls([...tools])
  const shape = classifyBatchDispatch(tools)
  if (shape === "mixed") {
    return { verb: "mixed", detail: `(${parallel.length} parallel + ${serial.length} serial)` }
  }
  return { verb: shape, detail: `(${tools.length} tools)` }
}

/** Does the batch contain any tool whose error should cancel siblings? */
export function batchHasSiblingAborter(tools: ToolCallEntry[]): boolean {
  return tools.some((tc) => getToolMeta(tc.tool).abortsSiblingsOnError)
}

/**
 * Group tool calls so same-file write/edit operations run serially while
 * different-file ops still parallelise.
 *
 * `edit_file` and `write_file` are individually concurrency-safe (they don't
 * trigger sibling aborts or share global state with other tools), but two
 * edits targeting the SAME path are NOT safe to run in parallel — each
 * search/replace operates on the file content as it found it, so two
 * concurrent edits race and the second one's search either fails to match
 * or overwrites the first one's changes. The agent surfaces this as
 * "I tried multiple times but the file isn't being updated".
 *
 * Returns an array of groups. Within each group, items run sequentially.
 * Across groups, items run in parallel. Tools without a `path` (read,
 * search, run_command, etc.) get a group of one — same parallel semantics
 * as before.
 */
export function groupForParallelExecution(tools: ToolCallEntry[]): ToolCallEntry[][] {
  const byPath = new Map<string, ToolCallEntry[]>()
  const standalone: ToolCallEntry[][] = []

  for (const tc of tools) {
    const isPathMutation = tc.tool === "write_file" || tc.tool === "edit_file"
    const filePath = isPathMutation ? (tc.args.path as string | undefined) : undefined
    if (!filePath) {
      standalone.push([tc])
      continue
    }
    const existing = byPath.get(filePath)
    if (existing) {
      existing.push(tc)
    } else {
      byPath.set(filePath, [tc])
    }
  }

  return [...standalone, ...byPath.values()]
}

// ─── Stage 1 of accountability-and-parallel-execution-sequencing plan ───
//
// Parallel batch cap. The agent's `tools[]` can carry N parallel calls
// in one response (we've seen 11 in user-reported repros). Without a
// cap, the cli's executor fires all N at once and ships one combined
// tool_result — the agent never reasons between batches, never reads
// back what it wrote, and can author `src/index.ts` (consumer) in the
// SAME turn as `src/routes/auth.ts` (producer), leaving the import
// sanitizer to silently strip the unresolved reference.
//
// Stage 1 enforces a per-turn cap. When the agent emits more than `cap`
// tools, the cli executes the first `cap` AND defers the rest with a
// synthetic `batch_cap_enforced` failure result so the agent's next
// turn sees the deferral + the prior batch's outcomes + can reason
// before re-emitting.

export type RepoState = "empty" | "small" | "existing-small" | "existing-large" | null

/**
 * Default cap. Empty / small / existing-small repos cap at 3 — the
 * common case for fresh scaffolds where ordering + per-file
 * accountability matter most. existing-large gets a relaxed cap
 * because edits across a known codebase are more likely to be wide
 * and the agent's existing context is richer.
 *
 * Kept as constants (not flags) for v1 — flag plumbing is a separate
 * micro-PR if telemetry shows we need tuning.
 */
export const BATCH_CAP_DEFAULT = 3
export const BATCH_CAP_EXISTING_LARGE = 5

/**
 * Resolve the cap for this run based on the project-init brief's
 * classified `repoState`. Falls back to `BATCH_CAP_DEFAULT` when the
 * classifier didn't fire (null) or for the smaller-repo states.
 */
export function resolveBatchCap(repoState: RepoState): number {
  if (repoState === "existing-large") return BATCH_CAP_EXISTING_LARGE
  return BATCH_CAP_DEFAULT
}

export interface BatchCapSplit {
  /** First `cap` tools — to be executed this turn. */
  executed: ToolCallEntry[]
  /** Tools beyond `cap` — synthesise deferral results, agent re-emits next turn. */
  deferred: ToolCallEntry[]
}

/**
 * Pure: split a batch into the executed prefix + deferred suffix.
 * When `tools.length <= cap` (or cap <= 0), returns the whole batch
 * as `executed` with an empty `deferred`.
 */
export function applyBatchCap(tools: ReadonlyArray<ToolCallEntry>, cap: number): BatchCapSplit {
  if (cap <= 0 || tools.length <= cap) {
    return { executed: [...tools], deferred: [] }
  }
  return { executed: tools.slice(0, cap), deferred: tools.slice(cap) }
}

/**
 * Build the synthetic failure result the cli attaches for each
 * deferred tool. The agent sees this in its next tool_result payload
 * alongside the executed tools' real results and can decide whether
 * to re-issue the deferred tools, revise the plan, or stop.
 *
 * The `_errorCategory: "batch_cap_enforced"` lets the server's
 * existing error-classification path treat this as a recovery
 * situation (forced-error-reasoning Stage 3) rather than a hard
 * failure.
 */
export function buildBatchCapDeferralResult(
  toolName: string,
  batchSize: number,
  cap: number,
): Record<string, unknown> {
  return {
    error: `Batch cap enforced: this turn carried ${batchSize} tool calls but the cap is ${cap}. The first ${cap} tools were executed; this tool (${toolName}) was DEFERRED so you can reason about the prior batch's outcomes before re-issuing. READ the executed tools' results carefully, then RE-EMIT the deferred tools in your next response if you still want them — or revise the plan if the results warrant.`,
    success: false,
    _errorCategory: "batch_cap_enforced",
    _deferred: true,
  }
}

// ─── Stage 2 of accountability-and-parallel-execution-sequencing plan ───
//
// Producer-before-consumer topological ordering inside a batch.
//
// THE BUG (user repro continued):
//
//   write_file("src/index.ts", `import { auth } from './routes/auth'`)
//   write_file("src/routes/auth.ts", `export async function auth() {...}`)
//
//   When both fire in the same parallel batch, the cli's
//   `groupForParallelExecution` puts each different path in its own
//   group, and `Promise.allSettled` runs all groups in parallel.
//   If index.ts's write completes (and the import-sanitizer runs)
//   BEFORE routes/auth.ts has been written to disk, the sanitizer
//   sees the unresolved `./routes/auth` reference and silently
//   strips the import — leaving index.ts with a broken file.
//
// THE FIX:
//
//   1. Extract relative imports (`./X`, `../X`) from every
//      write_file in the batch.
//   2. Resolve each import against the batch's other write paths
//      (with common extension expansions: .ts/.tsx/.js/.jsx/.mjs/.cjs,
//      directory `/index.ts`, etc.).
//   3. Build a dependency graph (consumer → producers).
//   4. Topo-sort with Kahn's algorithm. Cycle → reject the involved
//      writes with a synthetic failure; the agent has to break the
//      cycle (extract a shared interface, etc.).
//   5. Collapse the topo-ordered writes into ONE serial group so
//      they run sequentially (producer lands on disk before
//      consumer is dispatched). Non-write tools (create_directory,
//      etc.) keep their parallel grouping.

/**
 * Pure: scan TypeScript / JavaScript source for relative import
 * specifiers. Matches both `import` and `export ... from` forms.
 * Returns the raw specifier strings (e.g. `"./routes/auth"`,
 * `"../db"`). Non-relative imports (`"react"`, `"@scope/pkg"`) are
 * filtered out — those aren't files we're authoring this batch.
 *
 * The regex tolerates side-effect imports (`import "./styles"`),
 * default imports, named imports, namespace imports, and
 * re-exports. It does NOT handle dynamic `import(...)` —
 * conservative-by-design; if the agent writes a dynamic import to a
 * batch sibling, we won't reorder for it (rare, low impact).
 */
const IMPORT_SPECIFIER_RE = /(?:import|export)\s+(?:[^'"\n]*?from\s+)?['"]([^'"\n]+)['"]/g

export function extractRelativeImports(content: string): string[] {
  if (!content) return []
  const out: string[] = []
  let m: RegExpExecArray | null
  // Reset lastIndex defensively in case the regex literal is reused.
  IMPORT_SPECIFIER_RE.lastIndex = 0
  while ((m = IMPORT_SPECIFIER_RE.exec(content)) !== null) {
    const spec = m[1]
    if (spec.startsWith("./") || spec.startsWith("../")) {
      out.push(spec)
    }
  }
  return out
}

/**
 * Pure: resolve a relative import specifier against a from-file's
 * path. Strips `./` segments, walks `../`, returns the normalized
 * path WITHOUT extension. The caller matches against batch paths
 * via `findBatchMatchForImport` which expands extensions.
 *
 * Example:
 *   resolveRelativeImport("src/index.ts", "./routes/auth")
 *     → "src/routes/auth"
 *   resolveRelativeImport("src/lib/db.ts", "../config")
 *     → "src/config"
 */
export function resolveRelativeImport(fromFile: string, specifier: string): string {
  const lastSlash = fromFile.lastIndexOf("/")
  const fromDir = lastSlash >= 0 ? fromFile.slice(0, lastSlash) : ""
  const joined = (fromDir ? fromDir + "/" : "") + specifier
  const parts = joined.split("/").filter((p) => p !== "" && p !== ".")
  const stack: string[] = []
  for (const p of parts) {
    if (p === "..") {
      if (stack.length > 0) stack.pop()
    } else {
      stack.push(p)
    }
  }
  return stack.join("/")
}

/**
 * Common extensions to try when matching an extensionless resolved
 * specifier against a batch path. Order reflects typical priority
 * (TypeScript projects use .ts more than .mjs).
 */
const COMMON_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]
const COMMON_INDEX_PATHS = COMMON_EXTENSIONS.map((ext) => "/index" + ext)

/**
 * Pure: find a matching batch path for a resolved import specifier.
 *
 * Tries exact match first (in case the specifier already has an
 * extension, e.g. ".env.example"). Then tries each common
 * extension, then each directory-index variant. Returns the first
 * matching batch path, or null.
 *
 * Case-sensitive — file systems vary but POSIX is the norm we
 * target; matching case-insensitively could over-resolve on mac/win.
 */
export function findBatchMatchForImport(
  resolvedNoExt: string,
  batchPaths: ReadonlyArray<string>,
): string | null {
  const set = new Set(batchPaths)
  if (set.has(resolvedNoExt)) return resolvedNoExt
  for (const ext of COMMON_EXTENSIONS) {
    const candidate = resolvedNoExt + ext
    if (set.has(candidate)) return candidate
  }
  for (const idx of COMMON_INDEX_PATHS) {
    const candidate = resolvedNoExt + idx
    if (set.has(candidate)) return candidate
  }
  return null
}

export interface TopoOrderResult {
  /**
   * Groups for the executor's parallel loop. Dependent write_files
   * are collapsed into ONE serial group (in topo order); non-write
   * tools + non-dependent writes each get their own group as
   * `groupForParallelExecution` would have produced.
   */
  groups: ToolCallEntry[][]
  /**
   * When non-null, list of paths in a detected import cycle. The
   * `groups` returned EXCLUDES the cycle members so the executor
   * can synthesise failure results for them separately.
   */
  cycle: string[] | null
  /** True if topo-ordering rearranged any tools (i.e. edges existed). */
  reordered: boolean
}

/**
 * Pure: analyse + topo-order a parallel batch's write_file tools.
 *
 * Algorithm:
 *   1. Pull write_file tools that carry both `path` + `content`.
 *   2. Build consumer→producer edges via relative-import resolution.
 *   3. If a cycle is detected → return `cycle` populated; the
 *      executor synthesises failures for the cycle members and
 *      excludes them from execution.
 *   4. If no edges → return the default `groupForParallelExecution`
 *      layout (no work to do).
 *   5. Otherwise → Kahn's topo sort the writes. Build groups:
 *        - One serial group containing every dependent write in
 *          topo order (producers first).
 *        - One group per non-write tool / non-dependent tool.
 *
 * This guarantees that when a consumer write is dispatched, every
 * producer it relative-imports has already landed on disk — closing
 * the import-sanitizer-strips-the-reference bug.
 */
export function topoOrderParallelWrites(tools: ToolCallEntry[]): TopoOrderResult {
  const writes: Array<{ tc: ToolCallEntry; path: string; content: string }> = []
  for (const t of tools) {
    if (t.tool !== "write_file") continue
    const p = t.args.path
    const c = t.args.content
    if (typeof p === "string" && typeof c === "string") {
      writes.push({ tc: t, path: p, content: c })
    }
  }

  if (writes.length < 2) {
    return { groups: groupForParallelExecution(tools), cycle: null, reordered: false }
  }

  const writePaths = writes.map((w) => w.path)
  const edges = new Map<string, Set<string>>()
  const fwd = new Map<string, Set<string>>()
  let hasEdges = false

  for (const w of writes) {
    const imports = extractRelativeImports(w.content)
    for (const spec of imports) {
      const resolved = resolveRelativeImport(w.path, spec)
      const matched = findBatchMatchForImport(resolved, writePaths)
      if (matched && matched !== w.path) {
        let s = edges.get(w.path)
        if (!s) {
          s = new Set()
          edges.set(w.path, s)
        }
        s.add(matched)
        let f = fwd.get(matched)
        if (!f) {
          f = new Set()
          fwd.set(matched, f)
        }
        f.add(w.path)
        hasEdges = true
      }
    }
  }

  if (!hasEdges) {
    return { groups: groupForParallelExecution(tools), cycle: null, reordered: false }
  }

  const cycle = detectCycleDfs(writePaths, edges)
  if (cycle) {
    const cycleSet = new Set(cycle)
    const remainingTools = tools.filter(
      (t) => !(t.tool === "write_file" && typeof t.args.path === "string" && cycleSet.has(t.args.path)),
    )
    return {
      groups: groupForParallelExecution(remainingTools),
      cycle,
      reordered: false,
    }
  }

  // Kahn's algorithm — producers first.
  const indegree = new Map<string, number>()
  for (const w of writes) indegree.set(w.path, 0)
  for (const [consumer, producers] of edges) {
    indegree.set(consumer, producers.size)
  }
  const ready: string[] = []
  for (const [path, deg] of indegree) {
    if (deg === 0) ready.push(path)
  }
  const ordered: string[] = []
  while (ready.length > 0) {
    const cur = ready.shift() as string
    ordered.push(cur)
    const dependents = fwd.get(cur)
    if (dependents) {
      for (const d of dependents) {
        const next = (indegree.get(d) ?? 0) - 1
        indegree.set(d, next)
        if (next === 0) ready.push(d)
      }
    }
  }

  // Map ordered paths back to ToolCallEntry. The serial group is
  // every write_file in topo order; non-write tools keep their own
  // groups.
  const byPath = new Map(writes.map((w) => [w.path, w.tc] as const))
  const writeGroup = ordered.map((p) => byPath.get(p)).filter((tc): tc is ToolCallEntry => Boolean(tc))
  const writePathSet = new Set(writePaths)
  const nonWriteTools = tools.filter(
    (t) => !(t.tool === "write_file" && typeof t.args.path === "string" && writePathSet.has(t.args.path)),
  )
  const groups = [...groupForParallelExecution(nonWriteTools), writeGroup]
  return { groups, cycle: null, reordered: true }
}

/**
 * Pure DFS cycle detector. Returns the cycle path (in traversal
 * order, with the back-edge endpoint as the first AND last element)
 * when a cycle is found, or null otherwise.
 *
 * Uses three-colour DFS: WHITE (unvisited) → GRAY (on stack) → BLACK
 * (finished). A GRAY hit is the back-edge that proves a cycle.
 */
function detectCycleDfs(
  paths: ReadonlyArray<string>,
  edges: ReadonlyMap<string, ReadonlySet<string>>,
): string[] | null {
  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const color = new Map<string, number>()
  for (const p of paths) color.set(p, WHITE)
  const parent = new Map<string, string>()

  function dfs(node: string): string[] | null {
    color.set(node, GRAY)
    const next = edges.get(node)
    if (next) {
      for (const n of next) {
        const c = color.get(n)
        if (c === GRAY) {
          // Walk parent chain back to n to reconstruct the cycle.
          const stack: string[] = [node]
          let cur: string | undefined = node
          while (cur !== undefined && cur !== n && parent.has(cur)) {
            cur = parent.get(cur)
            if (cur !== undefined) stack.push(cur)
          }
          stack.reverse()
          stack.push(node)
          return stack
        }
        if (c === WHITE) {
          parent.set(n, node)
          const r = dfs(n)
          if (r) return r
        }
      }
    }
    color.set(node, BLACK)
    return null
  }

  for (const p of paths) {
    if (color.get(p) === WHITE) {
      const r = dfs(p)
      if (r) return r
    }
  }
  return null
}

/**
 * Synthetic failure result for a write_file rejected because of a
 * detected import cycle within the batch. Tagged
 * `_errorCategory: "import_cycle"` so the server's existing
 * forced-error-reasoning path treats it as a recovery situation.
 */
export function buildImportCycleResult(filePath: string, cycle: ReadonlyArray<string>): Record<string, unknown> {
  return {
    error: `Import cycle detected within this batch: ${cycle.join(" → ")}\n\nThis file (${filePath}) is part of a relative-import cycle with its siblings, so the cli can't topologically order the batch. Break the cycle by extracting a shared interface to a new file, or by inverting one dependency direction. Then re-emit the batch.`,
    success: false,
    _errorCategory: "import_cycle",
    path: filePath,
    cycle: [...cycle],
  }
}
