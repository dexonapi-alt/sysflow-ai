/**
 * Stage 4.1 of `2026-05-16-awareness-and-verification-correctness.md`.
 *
 * Per-run platform store.
 *
 * THE BUG (uncovered when the user asked "does the agent know what
 * terminal it's running on?"): the cli sends `client.platform` with
 * the initial user_message, but the server's prompt builder fell
 * through to `process.platform` (the SERVER's platform — `linux`
 * in our SaaS deployment) because `clientPlatform` wasn't threaded
 * into `PromptCtx`. So the model's `═══ ENVIRONMENT ═══` block
 * always said `platform: linux` + bash-style preferred commands,
 * regardless of which OS the user was actually on. That's why
 * Windows users kept seeing the model emit `ls -la` — the prompt
 * told it bash, so it spoke bash.
 *
 * THE STORE
 *
 * - `setRunPlatform(runId, platform)` — called from
 *   `handleUserMessage` once per run, from `body.client.platform`.
 * - `getRunPlatform(runId)` — called from `handleToolResult` to
 *   recover the platform on subsequent turns (the cli only sends
 *   `client` on the initial request; subsequent tool_result
 *   payloads don't carry it).
 * - `clearRunPlatform(runId)` — called from the terminal-exit
 *   cleanup block alongside `clearRunContext`.
 *
 * Why in-memory + per-run: platform is constant for the run's
 * lifetime, doesn't need persistence beyond run completion, and
 * doesn't justify a schema migration on the `runs` table. If the
 * server restarts mid-run, the fallback to `process.platform` is
 * the same behaviour as the pre-fix world — degraded but not
 * broken.
 *
 * Pure module — no I/O. The store is module-scoped.
 */

const runPlatforms = new Map<string, NodeJS.Platform>()

export function setRunPlatform(runId: string, platform: NodeJS.Platform): void {
  runPlatforms.set(runId, platform)
}

export function getRunPlatform(runId: string): NodeJS.Platform | undefined {
  return runPlatforms.get(runId)
}

export function clearRunPlatform(runId: string): void {
  runPlatforms.delete(runId)
}

/**
 * Resolve the platform for a run with the fallback chain:
 *   1. The platform stored by `setRunPlatform` (from `body.client.platform`)
 *   2. Otherwise `process.platform` (the server's own platform)
 *
 * Use this in places that need a platform on EVERY turn and don't
 * want to repeat the same `?? process.platform` dance. The
 * `getRunPlatform` raw accessor stays available for code that
 * needs to distinguish "no client info" from "explicitly the
 * server's platform".
 */
export function resolveRunPlatform(runId: string): NodeJS.Platform {
  return runPlatforms.get(runId) ?? process.platform
}

/**
 * Test-only — clear the entire store. Production code uses
 * `clearRunPlatform(runId)` for the run-level cleanup pattern.
 */
export function _resetRunPlatformStoreForTests(): void {
  runPlatforms.clear()
}
