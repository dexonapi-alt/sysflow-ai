/**
 * POST /reason — self-invoked reasoning endpoint.
 *
 * The agent's `reason` tool calls this endpoint when it hits a fork
 * mid-execution. Returns a DecisionBrief or a fallback string the agent
 * can act on without blocking.
 *
 * Per-run invocation budget enforced here: above the cap, returns a
 * fallback "budget exhausted" answer instead of calling the model.
 */

import { runReasoning } from "../reasoning/task-reasoner.js"
import { getFlag } from "../services/flags.js"
import { extractUser } from "./auth.js"
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify"

const selfInvocationCount = new Map<string, number>()
const FALLBACK_MAX = 5

export function _resetSelfInvocationCounts(): void {
  selfInvocationCount.clear()
}

export async function reasonRoute(fastify: FastifyInstance): Promise<void> {
  fastify.post("/reason", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as Record<string, unknown>
    extractUser(request)  // attach if present; not required for reasoning calls

    const runId = (body.runId as string) || "no-run"
    const question = (body.question as string) || ""
    const context = (body.context as string) || ""
    const options = Array.isArray(body.options) ? (body.options as string[]).slice(0, 6) : []
    const kind = (body.kind as string) || "choice"
    const cwd = (body.cwd as string) || undefined
    const sysbasePath = (body.sysbasePath as string) || undefined
    const model = (body.model as string) || "gemini-flash"

    if (!question.trim()) {
      return reply.code(400).send({
        ok: false,
        error: "question is required",
      })
    }

    // Budget check.
    const cap = (() => {
      try { return getFlag<number>("reasoning.max_self_invocations_per_run", sysbasePath) }
      catch { return FALLBACK_MAX }
    })()
    const used = selfInvocationCount.get(runId) ?? 0
    if (used >= cap) {
      console.log(`[reasoning] self_invoked budget exhausted for run ${runId} (${used}/${cap})`)
      return {
        ok: true,
        budgetExhausted: true,
        answer: `(reasoning budget exhausted at ${cap} calls — proceed with best judgement and note the call you made in your final summary)`,
      }
    }
    selfInvocationCount.set(runId, used + 1)

    // Build the user-turn for the decision pipeline.
    const userMessage = options.length > 0
      ? `${question}\n\nOptions to choose from:\n${options.map((o, i) => `${i + 1}. ${o}`).join("\n")}`
      : question

    const brief = await runReasoning({
      trigger: "self_invoked",
      userMessage,
      model,
      cwd,
      sysbasePath,
      context: { questionKind: kind, providedContext: context.slice(0, 1500) },
    })

    if (!brief || brief.pipeline !== "decision" || !brief.decisionBrief) {
      return {
        ok: true,
        fallback: true,
        answer: "(reasoning unavailable — proceed with best judgement based on the project context)",
      }
    }

    return {
      ok: true,
      brief,
      // Convenience flat-string answer for the agent's tool_result consumption.
      answer: `${brief.decisionBrief.recommendation} (confidence: ${brief.confidence}). ${brief.decisionBrief.proceedHint}`,
    }
  })
}
