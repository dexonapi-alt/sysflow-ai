/**
 * In-memory cache for reasoning briefs. Keyed by sha256 of
 * (trigger, userMessage, cwd, model, projectMemoryMtime, errorContext).
 *
 * 30-min TTL by default (flag-tunable). FIFO eviction at 200 entries.
 * No on-disk persistence in Phase 5 — the win is avoiding the model
 * round-trip on identical re-runs within the same session.
 */

import crypto from "node:crypto"
import type { ReasoningBrief, ReasoningTrigger } from "./reasoning-schema.js"

interface CacheKeyParts {
  trigger: ReasoningTrigger
  userMessage: string
  cwd?: string | null
  model: string
  projectMemoryMtime?: number
  errorContext?: string
}

interface CacheEntry {
  value: ReasoningBrief
  expiresAt: number
}

const CACHE_CAP = 200
const DEFAULT_TTL_MS = 30 * 60 * 1000

const store = new Map<string, CacheEntry>()
const insertionOrder: string[] = []

let nowMs: () => number = () => Date.now()
let ttlMs = DEFAULT_TTL_MS

export function buildCacheKey(parts: CacheKeyParts): string {
  const composite = JSON.stringify({
    t: parts.trigger,
    u: parts.userMessage ?? "",
    c: parts.cwd ?? "",
    m: parts.model,
    p: parts.projectMemoryMtime ?? 0,
    e: parts.errorContext ?? "",
  })
  return crypto.createHash("sha256").update(composite).digest("hex")
}

export function getReasoningCache(parts: CacheKeyParts): ReasoningBrief | null {
  const key = buildCacheKey(parts)
  const hit = store.get(key)
  if (!hit) return null
  if (hit.expiresAt < nowMs()) {
    store.delete(key)
    return null
  }
  return hit.value
}

export function setReasoningCache(parts: CacheKeyParts, value: ReasoningBrief): void {
  const key = buildCacheKey(parts)
  if (!store.has(key)) {
    insertionOrder.push(key)
  }
  store.set(key, { value, expiresAt: nowMs() + ttlMs })
  while (insertionOrder.length > CACHE_CAP) {
    const evict = insertionOrder.shift()!
    store.delete(evict)
  }
}

export function resetReasoningCache(): void {
  store.clear()
  insertionOrder.length = 0
}

/** Test-only hooks. */
export function _setNowFn(fn: () => number): void { nowMs = fn }
export function _setTtlMs(ms: number): void { ttlMs = ms }
export function _resetTimingHooks(): void {
  nowMs = () => Date.now()
  ttlMs = DEFAULT_TTL_MS
}
