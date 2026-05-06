import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import {
  createChunkSnapshot,
  listSnapshots,
  rollbackToChunk,
  cleanupChunkSnapshots,
  _resetChunkSnapshotsForTests,
} from "../git.js"

const exec = promisify(execFile)

let tmp: string

async function initRepo(dir: string): Promise<void> {
  await exec("git", ["init", "-q", "-b", "main"], { cwd: dir })
  await exec("git", ["config", "user.email", "t@example.com"], { cwd: dir })
  await exec("git", ["config", "user.name", "test"], { cwd: dir })
  await exec("git", ["config", "commit.gpgsign", "false"], { cwd: dir })
  await fs.writeFile(path.join(dir, "seed.txt"), "seed\n", "utf8")
  await exec("git", ["add", "."], { cwd: dir })
  await exec("git", ["commit", "-q", "-m", "init"], { cwd: dir })
}

beforeEach(async () => {
  _resetChunkSnapshotsForTests()
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sysflow-git-"))
  await initRepo(tmp)
})

afterEach(async () => {
  // Best-effort tag cleanup so the tmp dir doesn't leak refs back into shared state.
  // (Each tmpdir is a fresh repo so this is just hygiene.)
  await fs.rm(tmp, { recursive: true, force: true })
})

describe("git chunk-snapshot queue", () => {
  it("listSnapshots is empty for a fresh runId", () => {
    expect(listSnapshots("never-touched")).toEqual([])
  })

  it("createChunkSnapshot tags a clean tree and queues the snapshot", async () => {
    const snap = await createChunkSnapshot(tmp, "run-1", 1)
    expect(snap).not.toBeNull()
    expect(snap!.chunkIndex).toBe(1)
    expect(snap!.strategy).toBe("tag")
    expect(listSnapshots("run-1")).toHaveLength(1)
    expect(listSnapshots("run-1")[0].chunkIndex).toBe(1)
  })

  it("queues multiple snapshots in chunk order", async () => {
    await createChunkSnapshot(tmp, "run-2", 1)
    // Mutate the tree between snapshots so they're addressing different states.
    await fs.writeFile(path.join(tmp, "a.txt"), "first\n", "utf8")
    await exec("git", ["add", "."], { cwd: tmp })
    await exec("git", ["commit", "-q", "-m", "second"], { cwd: tmp })
    await createChunkSnapshot(tmp, "run-2", 2)
    const list = listSnapshots("run-2")
    expect(list.map((s) => s.chunkIndex)).toEqual([1, 2])
  })

  it("isolates queues by runId", async () => {
    await createChunkSnapshot(tmp, "run-A", 1)
    await createChunkSnapshot(tmp, "run-B", 1)
    expect(listSnapshots("run-A")).toHaveLength(1)
    expect(listSnapshots("run-B")).toHaveLength(1)
  })

  it("rollbackToChunk restores tag-strategy state and trims the queue", async () => {
    // Snapshot at chunk 1 with the seed file only.
    await createChunkSnapshot(tmp, "run-3", 1)
    // Add a file and commit (so it goes into HEAD).
    await fs.writeFile(path.join(tmp, "post.txt"), "post-chunk-1\n", "utf8")
    await exec("git", ["add", "."], { cwd: tmp })
    await exec("git", ["commit", "-q", "-m", "after chunk 1"], { cwd: tmp })
    // Snapshot at chunk 2 with both files.
    await createChunkSnapshot(tmp, "run-3", 2)
    // Add a third file (uncommitted is also fine).
    await fs.writeFile(path.join(tmp, "post2.txt"), "post-chunk-2\n", "utf8")
    await exec("git", ["add", "."], { cwd: tmp })
    await exec("git", ["commit", "-q", "-m", "after chunk 2"], { cwd: tmp })

    const ok = await rollbackToChunk(tmp, "run-3", 1)
    expect(ok).toBe(true)

    // Files added after chunk-1 should be gone; seed should remain.
    expect((await fs.readdir(tmp)).sort()).toEqual([".git", "seed.txt"].sort())

    // Queue should now only hold snapshots ≤ chunk 1.
    const list = listSnapshots("run-3")
    expect(list.map((s) => s.chunkIndex)).toEqual([1])
  })

  it("rollbackToChunk returns false for an unknown chunkIndex", async () => {
    await createChunkSnapshot(tmp, "run-4", 1)
    const ok = await rollbackToChunk(tmp, "run-4", 99)
    expect(ok).toBe(false)
  })

  it("cleanupChunkSnapshots wipes the queue", async () => {
    await createChunkSnapshot(tmp, "run-5", 1)
    await cleanupChunkSnapshots(tmp, "run-5")
    expect(listSnapshots("run-5")).toEqual([])
  })

  it("returns null in a non-git directory", async () => {
    const noGit = await fs.mkdtemp(path.join(os.tmpdir(), "no-git-"))
    try {
      const snap = await createChunkSnapshot(noGit, "run-6", 1)
      expect(snap).toBeNull()
    } finally {
      await fs.rm(noGit, { recursive: true, force: true })
    }
  })
})
