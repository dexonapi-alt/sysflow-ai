/**
 * Tiny token estimator for the CLI side. Server has the canonical version in
 * services/context-budget.ts; mirroring the math here keeps the CLI free of
 * a server-source dependency.
 *
 * 4 chars ≈ 1 token is a common rule-of-thumb for English; good enough for
 * the usage log and any other rough budgeting on the client side.
 */

const CHARS_PER_TOKEN = 4

export function estimateTokens(input: unknown): number {
  if (input == null) return 0
  if (typeof input === "string") return Math.ceil(input.length / CHARS_PER_TOKEN)
  if (typeof input === "number" || typeof input === "boolean") {
    return Math.ceil(String(input).length / CHARS_PER_TOKEN)
  }
  try {
    return Math.ceil(JSON.stringify(input).length / CHARS_PER_TOKEN)
  } catch {
    return 0
  }
}
