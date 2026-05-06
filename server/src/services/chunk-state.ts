/**
 * Chunk-state — per-run history of every chunk the chunked-reasoning loop
 * (Phase 10) has executed. Pure in-memory, mirrors `task-pipeline.ts`'s shape.
 *
 * Each `ChunkBoundary` captures one full chunk cycle: the planner's intent,
 * the files the main model actually wrote/edited, and the reflector's verdict
 * after. The next planner call gets the full history so it can decide what
 * to do next without re-reasoning from scratch.
 *
 * Cleared by `clearChunkState(runId)` when the run terminates (paired with
 * `clearPipeline()` in `tool-result.ts`).
 */

import type { ChunkPlanBrief, ChunkReflectionBrief } from "../reasoning/reasoning-schema.js"

export interface ChunkBoundary {
  /** 0-indexed chunk number within the run. */
  index: number
  /** Wall-clock millis when this chunk's planner emitted its plan. */
  startedAt: number
  /** What the planner said the chunk should do. */
  plan: ChunkPlanBrief
  /** Files the main model actually touched in the chunk (write_file + edit_file paths). */
  executedFiles: string[]
  /** Reflector's verdict after the chunk's tools resolved. Null if reflector hasn't run yet. */
  reflection: ChunkReflectionBrief | null
}

const chunkHistory = new Map<string, ChunkBoundary[]>()

/**
 * Append a new boundary at chunk-start time. The reflection is null until
 * `attachReflection` lands the reflector's verdict for the same chunk index.
 */
export function recordChunkStart(runId: string, plan: ChunkPlanBrief, executedFiles: string[] = []): ChunkBoundary {
  const list = chunkHistory.get(runId) ?? []
  const boundary: ChunkBoundary = {
    index: list.length,
    startedAt: Date.now(),
    plan,
    executedFiles,
    reflection: null,
  }
  list.push(boundary)
  chunkHistory.set(runId, list)
  return boundary
}

/**
 * Record the files the main model actually touched. Called once tool results
 * for the chunk are in. Idempotent — re-calling for the same chunk replaces
 * the file list (last call wins).
 */
export function attachExecutedFiles(runId: string, chunkIndex: number, executedFiles: string[]): void {
  const boundary = chunkHistory.get(runId)?.[chunkIndex]
  if (!boundary) return
  boundary.executedFiles = executedFiles
}

/**
 * Attach the reflector's verdict to a chunk. Called from the chunk loop after
 * the reflector returns. Only mutates the most recent boundary that lacks a
 * reflection — multiple in-flight reflectors per run aren't supported.
 */
export function attachReflection(runId: string, chunkIndex: number, reflection: ChunkReflectionBrief): void {
  const boundary = chunkHistory.get(runId)?.[chunkIndex]
  if (!boundary) return
  boundary.reflection = reflection
}

/** Full history for a run, oldest first. Empty array when the run has no chunks yet. */
export function getChunkHistory(runId: string): ChunkBoundary[] {
  return chunkHistory.get(runId) ?? []
}

/** How many chunks have been started for this run (regardless of reflector status). */
export function chunkCount(runId: string): number {
  return chunkHistory.get(runId)?.length ?? 0
}

/** Most recent boundary, or null. */
export function getLatestChunk(runId: string): ChunkBoundary | null {
  const list = chunkHistory.get(runId)
  if (!list || list.length === 0) return null
  return list[list.length - 1]
}

/** Wipe a run's chunk history. Called from the same teardown path as `clearPipeline`. */
export function clearChunkState(runId: string): void {
  chunkHistory.delete(runId)
}

/** Test-only: blow away every run's state. */
export function _resetForTests(): void {
  chunkHistory.clear()
}
