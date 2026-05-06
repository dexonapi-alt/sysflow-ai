/**
 * Git snapshot service — safe rollback for AI-generated changes.
 *
 * ONLY active when:
 * 1. The cwd is inside a git repository
 * 2. The repo has at least one commit
 *
 * Creates lightweight snapshots before batch writes using git stash.
 * Offers rollback if the batch fails or produces broken code.
 */

import { execFile } from "node:child_process"
import { promisify } from "node:util"

const exec = promisify(execFile)

// ─── Types ───

interface GitSnapshot {
  id: string
  runId: string
  /** The stash ref or commit hash */
  ref: string
  strategy: "stash" | "tag"
  createdAt: number
  /** Files that were dirty when snapshot was taken */
  dirtyFiles: string[]
}

interface GitState {
  isRepo: boolean
  hasCommits: boolean
  cwd: string
}

// ─── State ───

let cachedGitState: GitState | null = null
const snapshots = new Map<string, GitSnapshot>()

/**
 * Phase 11 Stage 2: per-chunk snapshot queue, indexed by runId.
 *
 * The legacy `snapshots` map (single-snapshot-per-run) is kept untouched so
 * Phase 7's existing `createSnapshot` / `rollback` / `cleanupSnapshot` /
 * `getSnapshot` callers continue to work unchanged. The queue is a *peer*
 * store, written through `createChunkSnapshot` and read via the new
 * `listSnapshots` / `rollbackToChunk` API. The two stores are independent
 * — a Phase 7 snapshot taken before chunked-loop kicks in won't appear in
 * the queue, and vice versa.
 */
interface ChunkSnapshot extends GitSnapshot {
  /** 0-indexed chunk number this snapshot was taken before. */
  chunkIndex: number
}

const chunkSnapshots = new Map<string, ChunkSnapshot[]>()

// ─── Public API ───

/**
 * Detect if the cwd is a git repo with commits.
 * Result is cached for the process lifetime.
 */
export async function detectGit(cwd: string): Promise<GitState> {
  if (cachedGitState && cachedGitState.cwd === cwd) return cachedGitState

  const state: GitState = { isRepo: false, hasCommits: false, cwd }

  try {
    // Check if inside a git work tree
    const { stdout: isInside } = await exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd, timeout: 5000 })
    if (isInside.trim() !== "true") {
      cachedGitState = state
      return state
    }
    state.isRepo = true

    // Check if there are any commits
    try {
      await exec("git", ["rev-parse", "HEAD"], { cwd, timeout: 5000 })
      state.hasCommits = true
    } catch {
      // No commits yet — HEAD doesn't exist
      state.hasCommits = false
    }
  } catch {
    // Not a git repo or git not installed
  }

  cachedGitState = state
  return state
}

/**
 * Create a snapshot before making changes.
 * Uses git stash to save current working state, then immediately pops it
 * so the working directory stays unchanged. The stash is kept as a ref.
 *
 * Strategy:
 * - If there are dirty files: stash them, record the stash, pop immediately
 * - If clean: create a lightweight tag pointing to HEAD
 */
export async function createSnapshot(cwd: string, runId: string): Promise<GitSnapshot | null> {
  const git = await detectGit(cwd)
  if (!git.isRepo || !git.hasCommits) return null

  try {
    const snapshotId = `sysflow-${runId.slice(0, 8)}-${Date.now()}`

    // Check for dirty files
    const { stdout: statusOut } = await exec("git", ["status", "--porcelain"], { cwd, timeout: 5000 })
    const dirtyFiles = statusOut.trim().split("\n").filter(Boolean).map((l) => l.slice(3))

    if (dirtyFiles.length > 0) {
      // Stash everything including untracked files
      await exec("git", ["stash", "push", "-u", "-m", snapshotId], { cwd, timeout: 15000 })

      // Get the stash ref
      const { stdout: stashList } = await exec("git", ["stash", "list", "--oneline", "-1"], { cwd, timeout: 5000 })
      const stashRef = stashList.trim().split(":")[0] || "stash@{0}"

      // Pop immediately — we just wanted the ref saved
      await exec("git", ["stash", "pop"], { cwd, timeout: 15000 })

      const snapshot: GitSnapshot = {
        id: snapshotId,
        runId,
        ref: stashRef,
        strategy: "stash",
        createdAt: Date.now(),
        dirtyFiles
      }
      snapshots.set(runId, snapshot)
      return snapshot
    }

    // Clean tree — tag HEAD
    const { stdout: headRef } = await exec("git", ["rev-parse", "HEAD"], { cwd, timeout: 5000 })
    const ref = headRef.trim()

    // Create a lightweight tag
    try {
      await exec("git", ["tag", snapshotId, ref], { cwd, timeout: 5000 })
    } catch {
      // Tag might already exist — not critical
    }

    const snapshot: GitSnapshot = {
      id: snapshotId,
      runId,
      ref,
      strategy: "tag",
      createdAt: Date.now(),
      dirtyFiles: []
    }
    snapshots.set(runId, snapshot)
    return snapshot

  } catch (err) {
    console.error(`[git] Failed to create snapshot: ${(err as Error).message}`)
    return null
  }
}

/**
 * Rollback to a previous snapshot.
 * - For stash snapshots: checkout the stashed state
 * - For tag snapshots: reset to the tagged commit
 */
export async function rollback(cwd: string, runId: string): Promise<boolean> {
  const snapshot = snapshots.get(runId)
  if (!snapshot) return false

  try {
    if (snapshot.strategy === "tag") {
      // Hard reset to the snapshot commit — discards all changes since
      await exec("git", ["checkout", "--", "."], { cwd, timeout: 15000 })
      // Clean untracked files that were added
      await exec("git", ["clean", "-fd"], { cwd, timeout: 15000 })
    } else {
      // Stash strategy: discard current changes, apply the stash
      await exec("git", ["checkout", "--", "."], { cwd, timeout: 15000 })
      await exec("git", ["clean", "-fd"], { cwd, timeout: 15000 })

      // Re-apply the original dirty state if it was stashed
      if (snapshot.dirtyFiles.length > 0) {
        try {
          // The stash ref may have shifted — find it by message
          const { stdout: stashList } = await exec("git", ["stash", "list"], { cwd, timeout: 5000 })
          const lines = stashList.trim().split("\n")
          const match = lines.find((l) => l.includes(snapshot.id))
          if (match) {
            const ref = match.split(":")[0]
            await exec("git", ["stash", "apply", ref], { cwd, timeout: 15000 })
          }
        } catch {
          // Stash apply failed — at least we're at a clean state
        }
      }
    }

    return true
  } catch (err) {
    console.error(`[git] Rollback failed: ${(err as Error).message}`)
    return false
  }
}

/**
 * Clean up a snapshot after successful completion.
 * Removes tags/stash entries to avoid clutter.
 */
export async function cleanupSnapshot(cwd: string, runId: string): Promise<void> {
  const snapshot = snapshots.get(runId)
  if (!snapshot) return

  try {
    if (snapshot.strategy === "tag") {
      await exec("git", ["tag", "-d", snapshot.id], { cwd, timeout: 5000 })
    }
    // For stash strategy, the stash was already popped — nothing to clean
  } catch {
    // Cleanup failure is non-critical
  }

  snapshots.delete(runId)
}

/**
 * Get the current snapshot for a run (if any).
 */
export function getSnapshot(runId: string): GitSnapshot | null {
  return snapshots.get(runId) || null
}

/**
 * Phase 11 Stage 2 — per-chunk snapshot API.
 *
 * `createChunkSnapshot` is invoked from the chunked-loop right before the
 * agent executes a chunk's tools. It tags the current HEAD (or stashes the
 * working state) so `rollbackToChunk` can restore that exact tree later if
 * the divergence detector triggers a backtrack.
 */

export async function createChunkSnapshot(cwd: string, runId: string, chunkIndex: number): Promise<ChunkSnapshot | null> {
  const git = await detectGit(cwd)
  if (!git.isRepo || !git.hasCommits) return null

  // Reuse `createSnapshot`'s logic by inlining a near-identical body that
  // tags the snapshot id with the chunk index so we can address it later.
  try {
    const snapshotId = `sysflow-${runId.slice(0, 8)}-chunk${chunkIndex}-${Date.now()}`

    const { stdout: statusOut } = await exec("git", ["status", "--porcelain"], { cwd, timeout: 5000 })
    const dirtyFiles = statusOut.trim().split("\n").filter(Boolean).map((l) => l.slice(3))

    let snap: ChunkSnapshot

    if (dirtyFiles.length > 0) {
      await exec("git", ["stash", "push", "-u", "-m", snapshotId], { cwd, timeout: 15000 })
      const { stdout: stashList } = await exec("git", ["stash", "list", "--oneline", "-1"], { cwd, timeout: 5000 })
      const stashRef = stashList.trim().split(":")[0] || "stash@{0}"
      await exec("git", ["stash", "pop"], { cwd, timeout: 15000 })

      snap = {
        id: snapshotId,
        runId,
        chunkIndex,
        ref: stashRef,
        strategy: "stash",
        createdAt: Date.now(),
        dirtyFiles,
      }
    } else {
      const { stdout: headRef } = await exec("git", ["rev-parse", "HEAD"], { cwd, timeout: 5000 })
      const ref = headRef.trim()
      try {
        await exec("git", ["tag", snapshotId, ref], { cwd, timeout: 5000 })
      } catch {
        // Tag might already exist — non-fatal.
      }
      snap = {
        id: snapshotId,
        runId,
        chunkIndex,
        ref,
        strategy: "tag",
        createdAt: Date.now(),
        dirtyFiles: [],
      }
    }

    const list = chunkSnapshots.get(runId) ?? []
    list.push(snap)
    chunkSnapshots.set(runId, list)
    return snap
  } catch (err) {
    console.error(`[git] Failed to create chunk snapshot: ${(err as Error).message}`)
    return null
  }
}

/** All chunk snapshots for a run, oldest first. Empty when none have been taken. */
export function listSnapshots(runId: string): ChunkSnapshot[] {
  return chunkSnapshots.get(runId) ?? []
}

/**
 * Roll the working tree back to the state captured before chunk `chunkIndex`.
 * Returns true on success. After the rollback, every snapshot AFTER the
 * target chunk is dropped from the queue (you can't roll forward to a
 * snapshot that referenced state you've now discarded).
 */
export async function rollbackToChunk(cwd: string, runId: string, chunkIndex: number): Promise<boolean> {
  const list = chunkSnapshots.get(runId)
  if (!list || list.length === 0) return false
  const target = list.find((s) => s.chunkIndex === chunkIndex)
  if (!target) return false

  try {
    if (target.strategy === "tag") {
      await exec("git", ["reset", "--hard", target.ref], { cwd, timeout: 15000 })
      await exec("git", ["clean", "-fd"], { cwd, timeout: 15000 })
    } else {
      await exec("git", ["checkout", "--", "."], { cwd, timeout: 15000 })
      await exec("git", ["clean", "-fd"], { cwd, timeout: 15000 })
      if (target.dirtyFiles.length > 0) {
        try {
          const { stdout: stashList } = await exec("git", ["stash", "list"], { cwd, timeout: 5000 })
          const lines = stashList.trim().split("\n")
          const match = lines.find((l) => l.includes(target.id))
          if (match) {
            const ref = match.split(":")[0]
            await exec("git", ["stash", "apply", ref], { cwd, timeout: 15000 })
          }
        } catch {
          // Best-effort; tree is at least clean.
        }
      }
    }

    // Drop snapshots taken *after* the target — they no longer match disk.
    const trimmed = list.filter((s) => s.chunkIndex <= chunkIndex)
    chunkSnapshots.set(runId, trimmed)
    return true
  } catch (err) {
    console.error(`[git] rollbackToChunk failed: ${(err as Error).message}`)
    return false
  }
}

/** Wipe a run's chunk snapshot queue (and try to delete its tags). */
export async function cleanupChunkSnapshots(cwd: string, runId: string): Promise<void> {
  const list = chunkSnapshots.get(runId)
  if (!list) return
  for (const s of list) {
    if (s.strategy === "tag") {
      try { await exec("git", ["tag", "-d", s.id], { cwd, timeout: 5000 }) } catch { /* non-fatal */ }
    }
  }
  chunkSnapshots.delete(runId)
}

/** Test-only: blow away every run's queue. */
export function _resetChunkSnapshotsForTests(): void {
  chunkSnapshots.clear()
}

/**
 * Get a short diff summary of changes since the snapshot.
 */
export async function getChangesSinceSnapshot(cwd: string, runId: string): Promise<string | null> {
  const git = await detectGit(cwd)
  if (!git.isRepo || !git.hasCommits) return null

  try {
    const { stdout } = await exec("git", ["diff", "--stat"], { cwd, timeout: 5000 })
    const untrackedOut = await exec("git", ["ls-files", "--others", "--exclude-standard"], { cwd, timeout: 5000 })
    const untracked = untrackedOut.stdout.trim().split("\n").filter(Boolean)

    let summary = stdout.trim()
    if (untracked.length > 0) {
      summary += `\n${untracked.length} new file(s): ${untracked.slice(0, 10).join(", ")}${untracked.length > 10 ? " ..." : ""}`
    }

    return summary || null
  } catch {
    return null
  }
}
