import { GoogleGenerativeAI, SchemaType, type ChatSession, type GenerateContentResult } from "@google/generative-ai"
import { BaseProvider, SHARED_SYSTEM_PROMPT } from "./base-provider.js"
import type { ProviderPayload, NormalizedResponse, TokenUsage } from "../types.js"

const RESPONSE_SCHEMA = {
  description: "Agent action response",
  type: SchemaType.OBJECT,
  properties: {
    kind: {
      type: SchemaType.STRING,
      description: "The type of response",
      enum: ["needs_tool", "completed", "failed"]
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

  // Gemini uses structured output with args_json field instead of args
  protected override readonly systemPrompt: string = SHARED_SYSTEM_PROMPT + `

═══ GEMINI-SPECIFIC: ARGS FORMAT ═══

CRITICAL: The "path" field is REQUIRED in args_json for ALL file operations. Never omit it.

Your response uses the field "args_json" which is a JSON STRING containing the tool arguments.
Examples:
- read_file: args_json: {"path": "src/app.js"}
- read_file with range: args_json: {"path": "src/app.js", "offset": 50, "limit": 100}
- edit_file search/replace: args_json: {"path": "src/app.js", "search": "old text", "replace": "new text"}
- edit_file remove line: args_json: {"path": "src/app.js", "search": "import X from './Y'\\n", "replace": ""}
- write_file: args_json: {"path": "src/app.js", "content": "full file code here"}
- run_command: args_json: {"command": "npm run build", "cwd": "."}
- web_search: args_json: {"query": "how to create nestjs project 2026"}

After reading a file, use the SAME path in your edit. For example:
  1. read_file args_json: {"path": "src/components/Foo.tsx"}
  2. edit_file args_json: {"path": "src/components/Foo.tsx", "search": "bad import line\\n", "replace": ""}

args_json must be a valid JSON string. For parallel tools, each item in the "tools" array uses args_json.

═══ GEMINI-SPECIFIC: FILE SIZE STRATEGY ═══

CRITICAL: Your args_json has a size limit. For files longer than ~80 lines, use this incremental strategy:

1. write_file with a SKELETON first (imports, component structure, return statement with placeholder sections)
2. Then use edit_file insert_at to ADD each section one at a time

Example for a large React component:
  Step 1: write_file → skeleton with imports + empty component + export
  Step 2: edit_file insert_at → add the hero section JSX
  Step 3: edit_file insert_at → add the features section JSX
  Step 4: edit_file insert_at → add the remaining sections

This prevents args_json from being too large and failing. ALWAYS use this approach for landing pages, dashboards, and components with many sections.

For small files (< 80 lines): write_file with full content in one go.

ALSO: Split large pages into SEPARATE component files:
  - src/components/Navbar.tsx (one file)
  - src/components/Hero.tsx (one file)
  - src/components/Features.tsx (one file)
  - src/App.tsx (imports and assembles all components)
Each component file stays small enough for a single write_file.`

  constructor() {
    super()
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

    try {
      if (!payload.toolResult && !payload.toolResults) {
        // First call — create a new chat session
        const model = genAI.getGenerativeModel({
          model: geminiModelName,
          systemInstruction: this.systemPrompt,
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

        let normalized = this.parseJsonResponse(text)
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
          systemInstruction: this.systemPrompt,
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

      const toolMsg = this.buildToolResultMessage(payload)

      const result = await chat.sendMessage(toolMsg)
      const text = result.response.text()

      // ActionPlanner handles broken args and loops in the handler layer
      let normalized = this.parseJsonResponse(text)

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
