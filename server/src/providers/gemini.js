/**
 * Gemini provider adapter (via Google AI Studio)
 *
 * Real LLM provider using Google's Gemini models through the free tier.
 * Requires GEMINI_API_KEY in .env
 *
 * Supported model IDs:
 *   gemini-flash   -> gemini-2.5-flash
 *   gemini-pro     -> gemini-2.5-pro
 */

import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai"

const MODEL_MAP = {
  "gemini-flash": "gemini-2.5-flash",
  "gemini-pro":   "gemini-2.5-pro"
}

// Chat sessions per run (multi-turn)
const runSessions = new Map()

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
      description: "The tool to use. Required when kind is needs_tool.",
      nullable: true,
      enum: [
        "list_directory", "read_file", "batch_read", "write_file",
        "edit_file", "create_directory", "search_code", "run_command",
        "move_file", "delete_file"
      ]
    },
    args_json: {
      type: SchemaType.STRING,
      description: "JSON string of tool arguments. Required when kind is needs_tool. Example for write_file: {\"path\":\"app.js\",\"content\":\"const x = 1;\"}. MUST be valid JSON.",
      nullable: true
    },
    content: {
      type: SchemaType.STRING,
      description: "Brief description of what you are doing or result message"
    }
  },
  required: ["kind", "reasoning", "content"]
}

const SYSTEM_PROMPT = `You are an AI coding agent. You help the user by performing actions on their codebase using tools.

IMPORTANT: All file paths are relative to the PROJECT ROOT (the current working directory ".").
- Place files in the project root: "package.json", "server.js", "src/app.js", etc.
- NEVER write files into the "sysbase/" directory. That folder is reserved for internal agent memory and is NOT part of the user's project.

Your response uses the field "args_json" which is a JSON STRING containing the tool arguments.

Available tools and their args_json examples:

1. list_directory
   args_json: {"path": "."}

2. read_file
   args_json: {"path": "src/app.js"}

3. batch_read
   args_json: {"paths": ["src/app.js", "package.json"]}

4. write_file — IMPORTANT: "content" must contain the COMPLETE file text, never empty or null
   args_json: {"path": "src/app.js", "content": "const express = require('express');\nconst app = express();\napp.get('/', (req, res) => res.send('Hello World'));\napp.listen(3000);"}

5. edit_file — "patch" must contain the COMPLETE new file text
   args_json: {"path": "src/app.js", "patch": "const express = require('express');\nmodified content here"}

6. create_directory
   args_json: {"path": "src/utils"}

7. search_code
   args_json: {"directory": ".", "pattern": "function auth"}

8. run_command
   args_json: {"command": "npm install express", "cwd": "."}

9. move_file
   args_json: {"from": "old.js", "to": "new.js"}

10. delete_file
    args_json: {"path": "temp.js"}

CRITICAL RULES:
- For write_file: args_json MUST include both "path" and "content". The "content" field must be the FULL file source code. Never leave content empty.
- For edit_file: args_json MUST include both "path" and "patch". The "patch" field must be the FULL new file content.
- args_json must be a valid JSON string.
- Use "needs_tool" when you need to perform an action.
- Use "completed" when the task is fully done. Set tool to null and args_json to null.
- Use "failed" ONLY if the task is truly impossible (e.g. missing permissions, impossible request).
- If a tool returns an error, DO NOT give up. Analyze the error, fix the problem, and try again with "needs_tool". For example, if a test fails, fix the test file and re-run. If a command fails, adjust the command.
- ALWAYS VERIFY your work before completing. If you write tests, RUN them. If you write code, TEST it. If you edit a file, READ it back to confirm. Never say "done" without verifying the result actually works.
- If something already exists but the user asks you to work on it, CHECK if it actually works first. Don't assume existing code is correct.
- Always include "reasoning" with a short explanation.
- Write complete, production-quality code.
- Do one action at a time. You will be called again with the tool result.

TERMINAL COMMAND RULES:
- NEVER run long-running/server commands like "npm start", "npm run dev", "node server.js", "python app.py", etc. These will hang forever.
- If the task requires starting a server, DO NOT run it yourself. Instead, complete the task and tell the user to run it manually: "Run \`npm start\` to start the server."
- Only run short-lived commands: install deps (npm install), build (npm run build), run tests (npm test), linting, etc.
- If a command times out or is skipped, acknowledge it and move on. Do NOT retry server-start commands.
- When verifying a server app works, do NOT start it. Instead, check that the code is correct by reading the files and confirming the structure is right.

MEMORY RULES:
- You have access to session history showing your previous actions in this chat. USE IT.
- Do NOT re-read files you just wrote in the same run. You already know their content.
- Do NOT redo steps that already succeeded in previous runs (check session history).
- If continuing from an interrupted run, pick up exactly where it left off.`

function getGenAI() {
  const key = process.env.GEMINI_API_KEY
  if (!key) {
    throw new Error("GEMINI_API_KEY is not set in .env")
  }
  return new GoogleGenerativeAI(key)
}

function getGeminiModelName(modelId) {
  return MODEL_MAP[modelId] || MODEL_MAP["gemini-flash"]
}

function buildInitialUserMessage(payload) {
  let msg = ""

  // Inject session history so the AI knows what happened in previous runs
  if (payload.context?.sessionHistory) {
    msg += `${payload.context.sessionHistory}\n\n`
  }

  // If continuing from a failed run, give specific context
  if (payload.context?.continueFrom) {
    const prev = payload.context.continueFrom
    msg += `IMPORTANT: You are continuing a previous task that ${prev.outcome === "failed" ? "FAILED" : "was interrupted"}.\n`
    msg += `Previous prompt: "${prev.prompt}"\n`
    if (prev.error) msg += `Error that occurred: ${prev.error}\n`
    if (prev.filesModified.length > 0) msg += `Files already modified: ${prev.filesModified.join(", ")}\n`
    if (prev.actions.length > 0) {
      const actionStr = prev.actions.map((a) => a.tool + (a.path ? ` ${a.path}` : "")).join(", ")
      msg += `Actions already taken: ${actionStr}\n`
    }
    msg += `\nPick up where the previous run left off. Do NOT redo work that was already completed successfully.\n\n`
  }

  msg += `Task: ${payload.userMessage}`

  if (payload.directoryTree && payload.directoryTree.length > 0) {
    const filtered = payload.directoryTree.filter((e) => !e.name.startsWith("sysbase"))
    if (filtered.length > 0) {
      const treeStr = filtered
        .map((e) => `${e.type === "directory" ? "[dir]" : "[file]"} ${e.name}`)
        .join("\n")
      msg += `\n\nCurrent project structure:\n${treeStr}`
    }
  }

  if (payload.context?.projectMemory) {
    const mem = Array.isArray(payload.context.projectMemory)
      ? payload.context.projectMemory.join("\n")
      : String(payload.context.projectMemory)
    msg += `\n\nProject context:\n${mem}`
  }

  // Inject learned patterns/memories from DB
  if (payload.context?.projectKnowledge) {
    msg += `\n\n${payload.context.projectKnowledge}`
  }

  return msg
}

function parseGeminiResponse(text) {
  let json = null

  // Try direct parse
  try {
    json = JSON.parse(text)
  } catch {
    // Try to extract JSON block from response
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      try {
        json = JSON.parse(jsonMatch[0])
      } catch {
        // Failed
      }
    }
  }

  if (!json || !json.kind) {
    return {
      kind: "completed",
      content: text || "Done.",
      reasoning: null
    }
  }

  const normalized = {
    kind: json.kind,
    content: json.content || "",
    reasoning: json.reasoning || null,
    usage: { inputTokens: 0, outputTokens: 0 }
  }

  if (json.kind === "needs_tool") {
    normalized.tool = json.tool
    // Parse args from args_json string
    let args = {}
    if (json.args_json) {
      try {
        args = typeof json.args_json === "string" ? JSON.parse(json.args_json) : json.args_json
      } catch {
        args = {}
      }
    } else if (json.args) {
      // Fallback if model uses "args" directly
      args = json.args
    }
    normalized.args = args
  }

  if (json.kind === "failed") {
    normalized.error = json.content || "Model reported failure"
  }

  return normalized
}

export async function callGeminiAdapter(payload) {
  const genAI = getGenAI()
  const geminiModelName = getGeminiModelName(payload.model)

  try {
    // First call — create a new chat session
    if (!payload.toolResult) {
      const model = genAI.getGenerativeModel({
        model: geminiModelName,
        systemInstruction: SYSTEM_PROMPT,
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: RESPONSE_SCHEMA,
          temperature: 0.1,
          maxOutputTokens: 8192
        }
      })

      const chat = model.startChat({ history: [] })
      runSessions.set(payload.runId, chat)

      const userMsg = buildInitialUserMessage(payload)
      const result = await chat.sendMessage(userMsg)
      const text = result.response.text()

      const normalized = parseGeminiResponse(text)
      normalized.usage = extractUsage(result)

      if (normalized.kind === "completed" || normalized.kind === "failed") {
        runSessions.delete(payload.runId)
      }

      return normalized
    }

    // Subsequent call — continue the existing chat with tool result
    const chat = runSessions.get(payload.runId)

    if (!chat) {
      // Session lost — recreate
      const model = genAI.getGenerativeModel({
        model: geminiModelName,
        systemInstruction: SYSTEM_PROMPT,
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: RESPONSE_SCHEMA,
          temperature: 0.1,
          maxOutputTokens: 8192
        }
      })

      const newChat = model.startChat({ history: [] })
      runSessions.set(payload.runId, newChat)

      const toolResultStr = JSON.stringify({
        tool: payload.toolResult.tool,
        result: payload.toolResult.result
      })
      const result = await newChat.sendMessage(
        `Previous tool result:\n${toolResultStr}\n\nDecide the next action.`
      )
      const text = result.response.text()
      const normalized = parseGeminiResponse(text)
      normalized.usage = extractUsage(result)

      if (normalized.kind === "completed" || normalized.kind === "failed") {
        runSessions.delete(payload.runId)
      }

      return normalized
    }

    // Normal continuation
    const toolResultStr = JSON.stringify({
      tool: payload.toolResult.tool,
      result: payload.toolResult.result
    })

    const result = await chat.sendMessage(
      `Tool result:\n${toolResultStr}\n\nDecide the next action.`
    )
    const text = result.response.text()

    const normalized = parseGeminiResponse(text)
    normalized.usage = extractUsage(result)

    if (normalized.kind === "completed" || normalized.kind === "failed") {
      runSessions.delete(payload.runId)
    }

    return normalized
  } catch (err) {
    runSessions.delete(payload.runId)

    const errMsg = err.message || ""
    const errStatus = err.status || err.httpStatusCode || 0
    console.error("[gemini] Error:", errStatus, errMsg)

    if (errMsg.includes("API key") || errMsg.includes("API_KEY_INVALID")) {
      return {
        kind: "failed",
        error: "Invalid GEMINI_API_KEY. Check your .env file.",
        usage: { inputTokens: 0, outputTokens: 0 }
      }
    }

    if (errStatus === 429 || errMsg.includes("429") || errMsg.includes("RESOURCE_EXHAUSTED") || errMsg.includes("quota")) {
      return {
        kind: "failed",
        error: "Gemini rate limit hit. Free tier: 15 RPM / 1000 RPD for Flash. Wait a minute and try again.",
        usage: { inputTokens: 0, outputTokens: 0 }
      }
    }

    return {
      kind: "failed",
      error: `Gemini error: ${errMsg}`,
      usage: { inputTokens: 0, outputTokens: 0 }
    }
  }
}

function extractUsage(result) {
  try {
    const meta = result.response.usageMetadata
    return {
      inputTokens: meta?.promptTokenCount || 0,
      outputTokens: meta?.candidatesTokenCount || 0
    }
  } catch {
    return { inputTokens: 0, outputTokens: 0 }
  }
}
