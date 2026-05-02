import { GoogleGenerativeAI, SchemaType, type ChatSession, type GenerateContentResult } from "@google/generative-ai"
import { BaseProvider, getSystemPrompt } from "./base-provider.js"
import {
  microcompactGeminiHistory,
  compactConversationSummary,
  isInsideAutocompactCall,
  estimateTokens,
  shouldBlockOnTokens,
  AUTOCOMPACT_SUMMARY_MAX_TOKENS,
  type GeminiContent,
} from "../services/context-budget.js"
import { discoverProjectMemory } from "../services/project-memory.js"
import type { ProviderPayload, NormalizedResponse, TokenUsage } from "../types.js"

/** Threshold: once the chat history has more than this many user-turn tool-results, run microcompact. */
const MICROCOMPACT_TRIGGER_THRESHOLD = 8

const RESPONSE_SCHEMA = {
  description: "Agent action response",
  type: SchemaType.OBJECT,
  properties: {
    kind: {
      type: SchemaType.STRING,
      description: "The type of response",
      enum: ["needs_tool", "completed", "failed", "waiting_for_user"]
    },
    reasoning: {
      type: SchemaType.STRING,
      description: "Brief internal reasoning about what to do next (1-2 sentences)"
    },
    tool: {
      type: SchemaType.STRING,
      description: "The tool to use (single tool mode). Required when kind is needs_tool and tools array is not used.",
      nullable: true,
      enum: [
        "list_directory", "read_file", "batch_read", "write_file",
        "edit_file", "create_directory", "search_code", "search_files",
        "run_command", "move_file", "delete_file", "web_search"
      ]
    },
    args_json: {
      type: SchemaType.STRING,
      description: "JSON string of tool arguments (single tool mode). MUST be valid JSON.",
      nullable: true
    },
    tools: {
      type: SchemaType.ARRAY,
      description: "Array of tool calls for parallel execution. Use INSTEAD of tool/args_json when calling multiple independent tools at once.",
      nullable: true,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          id: { type: SchemaType.STRING, description: "Unique ID like tc_0, tc_1" },
          tool: {
            type: SchemaType.STRING,
            enum: [
              "list_directory", "read_file", "batch_read", "write_file",
              "edit_file", "create_directory", "search_code", "search_files",
              "run_command", "move_file", "delete_file"
            ]
          },
          args_json: { type: SchemaType.STRING, description: "JSON string of tool arguments" }
        },
        required: ["id", "tool", "args_json"]
      }
    },
    stepTransition: {
      type: SchemaType.OBJECT,
      description: "Step transition to mark pipeline progress",
      nullable: true,
      properties: {
        complete: { type: SchemaType.STRING, description: "Step ID to mark completed", nullable: true },
        start: { type: SchemaType.STRING, description: "Step ID to mark in_progress", nullable: true }
      }
    },
    taskPlan: {
      type: SchemaType.OBJECT,
      description: "AI-generated implementation plan. Include only in the FIRST response.",
      nullable: true,
      properties: {
        title: { type: SchemaType.STRING, description: "Short task title", nullable: true },
        steps: {
          type: SchemaType.ARRAY,
          description: "Ordered list of concrete steps the agent will take",
          items: { type: SchemaType.STRING },
          nullable: true
        }
      }
    },
    content: {
      type: SchemaType.STRING,
      description: "Brief description of what you are doing or result message"
    }
  },
  required: ["kind", "reasoning", "content"]
}

export class GeminiProvider extends BaseProvider {
  readonly name = "Gemini"

  readonly modelMap: Record<string, string> = {
    "gemini-flash": "gemini-2.5-flash",
    "gemini-pro": "gemini-2.5-pro"
  }

  // Gemini uses structured output with args_json field instead of args.
  // The Gemini-specific args/skeleton instructions now live in
  // providers/prompt/sections/model-specific.ts and are assembled per-request.

  constructor() {
    super()
  }

  private async buildPrompt(payload: ProviderPayload): Promise<string> {
    const memory = await discoverProjectMemory(payload.cwd)
    return getSystemPrompt({
      model: payload.model,
      cwd: payload.cwd,
      projectMemory: memory.content || undefined,
      projectMemoryFiles: memory.files,
    })
  }

  // All broken-arg recovery, loop detection, and read-before-edit enforcement
  // is handled by the ActionPlanner service in the handler layer.

  private getGenAI(): GoogleGenerativeAI {
    const key = process.env.GEMINI_API_KEY
    if (!key) throw new Error("GEMINI_API_KEY is not set in .env")
    return new GoogleGenerativeAI(key)
  }

  private extractUsage(result: GenerateContentResult): TokenUsage {
    try {
      const meta = result.response.usageMetadata
      return {
        inputTokens: meta?.promptTokenCount || 0,
        outputTokens: meta?.candidatesTokenCount || 0
      }
    } catch {
      return this.emptyUsage()
    }
  }

  async call(payload: ProviderPayload): Promise<NormalizedResponse> {
    const genAI = this.getGenAI()
    const geminiModelName = this.getModelName(payload.model)
    // Assemble the prompt once per request (covers project-memory discovery I/O).
    const systemInstruction = await this.buildPrompt(payload)

    try {
      if (!payload.toolResult && !payload.toolResults) {
        // First call — create a new chat session
        const model = genAI.getGenerativeModel({
          model: geminiModelName,
          systemInstruction,
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: RESPONSE_SCHEMA as never,
            temperature: 0.1,
            maxOutputTokens: this.getAdaptiveMaxTokens(65536)
          }
        })

        const chat = model.startChat({ history: [] })
        this.runState.set(payload.runId, chat)
        this.setRunTask(payload.runId, payload.userMessage)

        const userMsg = this.buildInitialUserMessage(payload)
        const result = await chat.sendMessage(userMsg)
        const text = result.response.text()

        let normalized = this.parseJsonResponse(text, payload.runId)
        normalized.usage = this.extractUsage(result)
        this.onSuccessfulCall()

        // NOTE: broken args, loops, and tool transformations are handled by
        // the ActionPlanner in tool-result.ts / user-message.ts (runs after provider returns)

        // Layer 2: provider-level completion validation
        normalized = this.validateCompletionResponse(payload.runId, normalized)

        if (normalized.kind === "completed" || normalized.kind === "failed") {
          this.clearRunState(payload.runId)
        }

        return normalized
      }

      // Subsequent call — continue existing chat with tool result
      let chat = this.runState.get(payload.runId) as ChatSession | undefined

      if (!chat) {
        // Session lost — recreate
        const model = genAI.getGenerativeModel({
          model: geminiModelName,
          systemInstruction,
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: RESPONSE_SCHEMA as never,
            temperature: 0.1,
            maxOutputTokens: this.getAdaptiveMaxTokens(65536)
          }
        })

        chat = model.startChat({ history: [] })
        this.runState.set(payload.runId, chat)
      }

      // Ensure runTask is set even for error-aware flows that skip the initial model call
      if (!this.runTasks.has(payload.runId) && payload.userMessage) {
        this.setRunTask(payload.runId, payload.userMessage)
      }

      // ─── Compaction pipeline: microcompact first, then autocompact if still over budget ───
      try {
        const history = (await chat.getHistory()) as GeminiContent[]
        const toolResultTurns = history.filter((h) =>
          h.role === "user" && (h.parts?.[0]?.text ?? "").startsWith("Tool result")
        ).length

        // Step 1: cheap microcompact (regex-based history rewrite).
        let workingHistory: GeminiContent[] | null = null
        if (toolResultTurns > MICROCOMPACT_TRIGGER_THRESHOLD) {
          workingHistory = microcompactGeminiHistory(history)
          console.log(`[microcompact] Run ${payload.runId}: ${toolResultTurns} tool turns → compacted to last 5`)
        }

        // Step 2: full autocompact summary if estimated tokens still exceed budget.
        const candidateHistory = workingHistory ?? history
        const estTokens = estimateTokens(candidateHistory)
        if (
          shouldBlockOnTokens(estTokens, payload.model)
          && !isInsideAutocompactCall(payload.runId)
        ) {
          const compacted = await compactConversationSummary(
            payload.runId,
            candidateHistory,
            async (prompt, hist) => {
              const summaryModel = genAI.getGenerativeModel({
                model: geminiModelName,
                systemInstruction: prompt,
                generationConfig: {
                  responseMimeType: "text/plain",
                  temperature: 0.0,
                  maxOutputTokens: AUTOCOMPACT_SUMMARY_MAX_TOKENS,
                },
              })
              const summaryChat = summaryModel.startChat({ history: hist as never })
              const r = await summaryChat.sendMessage("Summarise the conversation per the rules above.")
              return r.response.text()
            },
          )
          if (compacted) {
            workingHistory = compacted
            console.log(`[autocompact] Run ${payload.runId}: history rewritten via summary call (was ~${estTokens} tokens)`)
          }
        }

        if (workingHistory) {
          const model = genAI.getGenerativeModel({
            model: geminiModelName,
            systemInstruction,
            generationConfig: {
              responseMimeType: "application/json",
              responseSchema: RESPONSE_SCHEMA as never,
              temperature: 0.1,
              maxOutputTokens: this.getAdaptiveMaxTokens(65536)
            }
          })
          chat = model.startChat({ history: workingHistory as never })
          this.runState.set(payload.runId, chat)
        }
      } catch (compactErr) {
        console.warn(`[compaction] Skipped due to error:`, (compactErr as Error).message)
      }

      const toolMsg = this.buildToolResultMessage(payload)

      const result = await chat.sendMessage(toolMsg)
      const text = result.response.text()

      // ActionPlanner handles broken args and loops in the handler layer
      let normalized = this.parseJsonResponse(text, payload.runId)

      normalized.usage = this.extractUsage(result)
      this.onSuccessfulCall()

      // Layer 2: provider-level completion validation
      normalized = this.validateCompletionResponse(payload.runId, normalized)

      if (normalized.kind === "completed" || normalized.kind === "failed") {
        this.clearRunState(payload.runId)
      }

      return normalized
    } catch (err) {
      const error = err as Error & { status?: number; httpStatusCode?: number }
      const errMsg = error.message || ""
      const errStatus = error.status || error.httpStatusCode || 0
      console.error("[gemini] Error:", errStatus, errMsg)

      if (errMsg.includes("API key") || errMsg.includes("API_KEY_INVALID")) {
        this.clearRunState(payload.runId)
        return this.failedResponse("Invalid GEMINI_API_KEY. Check your .env file.")
      }

      // Rate limit — DON'T clear run state, signal for retry/fallback
      if (errStatus === 429 || errMsg.includes("429") || errMsg.includes("RESOURCE_EXHAUSTED") || errMsg.includes("quota")) {
        return this.rateLimitedResponse("Gemini rate limit hit. Free tier: 15 RPM / 1000 RPD for Flash.")
      }

      this.clearRunState(payload.runId)
      return this.failedResponse(`Gemini error: ${errMsg}`)
    }
  }
}
