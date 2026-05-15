/**
 * Gemini Flash reasoner backend. This is the body of the pre-Stage-D
 * `callReasoner` extracted as-is into the new backend interface so the
 * existing behaviour is preserved verbatim when `pickReasonerBackend`
 * returns `"gemini"`.
 *
 * Model: `gemini-2.5-flash`. Cheap, fast, JSON-mode-native. Unchanged
 * from the pre-Stage-D defaults; future Gemini Flash releases swap here
 * without re-planning.
 */

import { GoogleGenerativeAI } from "@google/generative-ai"
import type { BackendCallArgs } from "./index.js"

const REASONER_MODEL = "gemini-2.5-flash"

export async function callGeminiBackend(args: BackendCallArgs): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set")

  const genAI = new GoogleGenerativeAI(apiKey)
  const model = genAI.getGenerativeModel({
    model: REASONER_MODEL,
    systemInstruction: args.systemInstruction,
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.0,
      maxOutputTokens: args.maxOutputTokens,
    },
  })

  const userTurn = args.userTurnOverride ?? args.defaultUserTurn
  const result = await model.generateContent(userTurn)
  return result.response.text()
}
