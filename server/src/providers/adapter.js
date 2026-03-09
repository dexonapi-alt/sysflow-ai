import { callSweAdapter } from "./swe.js"
import { callGeminiAdapter } from "./gemini.js"
import { callOpenRouterAdapter } from "./openrouter.js"
import { callClaudeSonnetAdapter } from "./claude-sonnet.js"
import { callClaudeOpusAdapter } from "./claude-opus.js"

export async function callModelAdapter(payload) {
  switch (payload.model) {
    case "swe":
      return callSweAdapter(payload)
    case "gemini-flash":
    case "gemini-pro":
      return callGeminiAdapter(payload)
    case "openrouter-auto":
    case "llama-70b":
    case "mistral-small":
    case "gemini-flash-or":
      return callOpenRouterAdapter(payload)
    case "claude-sonnet-4":
      return callClaudeSonnetAdapter(payload)
    case "claude-opus-4":
      return callClaudeOpusAdapter(payload)
    default:
      throw new Error(`Unsupported model: ${payload.model}`)
  }
}
