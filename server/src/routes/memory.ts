/**
 * POST /memory/remember — explicit user-typed memory entry.
 * GET  /memory/list?cwd=...
 * DELETE /memory/:id?cwd=...
 * DELETE /memory/stale?cwd=...
 * DELETE /memory/all?cwd=...&confirm=...
 *
 * The CLI uses these for the /memory and /remember slash commands.
 * Routes are project-scoped (cwd in the query/body) — there's no
 * cross-project sharing yet.
 */

import {
  loadMemoryEntries,
  saveMemoryEntries,
  deleteEntry,
  recordUserCorrection,
} from "../memory-store/index.js"
import { runAllValidators } from "../memory-store/index.js"
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify"

export async function memoryRoute(fastify: FastifyInstance): Promise<void> {
  fastify.post("/memory/remember", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as { cwd?: string; text?: string }
    if (!body?.cwd || !body?.text) {
      return reply.code(400).send({ ok: false, error: "cwd + text required" })
    }
    const entry = await recordUserCorrection(body.cwd, body.text, { trigger: "/remember" })
    if (!entry) {
      return { ok: false, error: "entry not recorded (empty, secret-pattern, or write failure)" }
    }
    return { ok: true, entry }
  })

  fastify.get("/memory/list", async (request: FastifyRequest, reply: FastifyReply) => {
    const cwd = (request.query as { cwd?: string }).cwd
    if (!cwd) return reply.code(400).send({ ok: false, error: "cwd required" })
    const entries = await loadMemoryEntries(cwd)
    const partition = runAllValidators(entries, { cwd })
    return {
      ok: true,
      summary: {
        total: entries.length,
        active: partition.active.length,
        stale: partition.stale.length,
        contradicted: partition.contradicted.length,
      },
      entries: [...partition.active, ...partition.stale, ...partition.contradicted].map(redact),
    }
  })

  fastify.delete("/memory/stale", async (request: FastifyRequest, reply: FastifyReply) => {
    const cwd = (request.query as { cwd?: string }).cwd
    if (!cwd) return reply.code(400).send({ ok: false, error: "cwd required" })
    const all = await loadMemoryEntries(cwd)
    const partition = runAllValidators(all, { cwd })
    const staleIds = new Set([...partition.stale, ...partition.contradicted].map((e) => e.id))
    const next = all.filter((e) => !staleIds.has(e.id))
    await saveMemoryEntries(cwd, next)
    return { ok: true, removed: staleIds.size }
  })

  fastify.delete("/memory/all", async (request: FastifyRequest, reply: FastifyReply) => {
    const q = request.query as { cwd?: string; confirm?: string }
    if (!q.cwd) return reply.code(400).send({ ok: false, error: "cwd required" })
    if (q.confirm !== "confirm") {
      const entries = await loadMemoryEntries(q.cwd)
      return { ok: false, requiresConfirmation: true, count: entries.length, hint: "append &confirm=confirm to actually wipe" }
    }
    await saveMemoryEntries(q.cwd, [])
    return { ok: true, wiped: true }
  })

  // /memory/:id must come AFTER the more specific /memory/stale + /memory/all.
  fastify.delete("/memory/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const id = (request.params as { id?: string }).id
    const cwd = (request.query as { cwd?: string }).cwd
    if (!id || !cwd) return reply.code(400).send({ ok: false, error: "id + cwd required" })
    const removed = await deleteEntry(cwd, id)
    return { ok: removed, id }
  })
}

interface RawEntry {
  id: string
  kind: string
  content: string
  status: string
  useCount: number
  contradictionCount: number
  createdAt: number
  lastConfirmedAt: number
  lastUsedAt: number
  staleReasons?: string[]
}

function redact(e: RawEntry): RawEntry {
  // Trim the content for the list view; full content available via per-id GET if needed.
  return { ...e, content: e.content.length > 280 ? e.content.slice(0, 280) + "…" : e.content }
}
