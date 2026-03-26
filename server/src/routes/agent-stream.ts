import { handleUserMessage } from "../handlers/user-message.js"
import { handleToolResult } from "../handlers/tool-result.js"
import { extractUser } from "./auth.js"
import { resolveChat } from "./chats.js"
import { checkUsageAllowed } from "../store/subscriptions.js"
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify"

function sendSSE(reply: FastifyReply, event: string, data: unknown): void {
  reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

export async function agentStreamRoute(fastify: FastifyInstance): Promise<void> {
  fastify.post("/agent/stream", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as Record<string, unknown>

    // Set up SSE headers
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no"
    })

    try {
      const user = extractUser(request)
      if (user) {
        body.userId = user.userId
        body.username = user.username
      }

      if (body.chatUid && user) {
        const chat = await resolveChat(body.chatUid as string, user.userId)
        if (chat) {
          body.chatId = chat.id
          body.chatUid = chat.chatUid
        }
      }

      if (body.type === "user_message" && user) {
        const usage = await checkUsageAllowed(user.userId)
        if (!usage.allowed) {
          sendSSE(reply, "error", {
            status: "usage_limit",
            error: usage.reason,
            plan: usage.plan,
            remaining: usage.remaining
          })
          reply.raw.end()
          return
        }
      }

      // Send progress phases
      sendSSE(reply, "phase", { phase: "loading_context", label: "loading project context..." })

      let result: Record<string, unknown>

      if (body.type === "user_message") {
        sendSSE(reply, "phase", { phase: "calling_model", label: "calling AI model..." })
        result = await handleUserMessage(body as never) as unknown as Record<string, unknown>
      } else if (body.type === "tool_result") {
        sendSSE(reply, "phase", { phase: "processing_result", label: "processing tool result..." })
        sendSSE(reply, "phase", { phase: "calling_model", label: "calling AI model..." })
        result = await handleToolResult(body as never) as unknown as Record<string, unknown>
      } else {
        sendSSE(reply, "error", { status: "failed", error: "Unknown request type" })
        reply.raw.end()
        return
      }

      sendSSE(reply, "phase", { phase: "done", label: "response ready" })
      sendSSE(reply, "result", result)
      reply.raw.end()
    } catch (error) {
      request.log.error(error)
      sendSSE(reply, "error", {
        status: "failed",
        error: (error as Error).message || "Internal server error"
      })
      reply.raw.end()
    }
  })
}
