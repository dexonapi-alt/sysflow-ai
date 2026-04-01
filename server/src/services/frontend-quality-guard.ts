/**
 * Frontend Quality Guard — validates that generated frontend code meets
 * modern design standards before allowing task completion.
 *
 * Similar to completion-guard.ts (which checks file counts), this guard
 * checks the QUALITY of frontend code: animations, Tailwind patterns,
 * component structure, and design polish.
 *
 * Runs as an additional layer when the task involves frontend work.
 */

import type { NormalizedResponse } from "../types.js"

// ─── Quality Signals ───

const ANIMATION_SIGNALS = [
  "framer-motion",
  "motion.",
  "motion.div",
  "motion.section",
  "whileInView",
  "whileHover",
  "initial=",
  "animate=",
  "transition=",
  "variants=",
  "staggerChildren",
  "AnimatePresence",
  "useAnimation",
  "useInView",
  "animate-",
  "keyframes",
  "@keyframes",
]

const TAILWIND_QUALITY_SIGNALS = [
  "backdrop-blur",
  "bg-gradient",
  "from-",
  "via-",
  "to-",
  "bg-clip-text",
  "text-transparent",
  "transition-",
  "hover:scale",
  "hover:bg-",
  "hover:border-",
  "hover:text-",
  "ring-",
  "border-white/",
  "bg-white/",
  "blur-",
  "rounded-2xl",
  "rounded-xl",
  "shadow-",
  "shadow-lg",
  "shadow-xl",
  "tracking-tight",
  "leading-",
  "max-w-",
]

const DARK_THEME_SIGNALS = [
  "bg-black",
  "bg-neutral-950",
  "bg-neutral-900",
  "bg-gray-950",
  "bg-gray-900",
  "bg-zinc-950",
  "bg-zinc-900",
  "bg-slate-950",
  "bg-slate-900",
  "text-white",
  "text-neutral-400",
  "text-neutral-300",
  "text-gray-400",
  "dark:",
  "border-white/",
]

const COMPONENT_STRUCTURE_SIGNALS = [
  "className=",
  "flex",
  "grid",
  "items-center",
  "justify-",
  "gap-",
  "space-y-",
  "space-x-",
  "px-",
  "py-",
  "md:",
  "lg:",
  "sm:",
  "xl:",
]

// ─── Types ───

export interface FrontendQualityResult {
  pass: boolean
  score: number          // 0-100
  animationScore: number
  styleScore: number
  structureScore: number
  reason?: string        // why it was rejected — sent to AI as hint
}

// ─── Content Accumulator ───
// Captures frontend file content from AI write_file responses as they flow through.
// Content is only available briefly in the AI response before being sent to the client,
// so we capture it here for quality analysis at completion time.

const runFrontendContent = new Map<string, string[]>()

const FRONTEND_FILE_EXTENSIONS = /\.(tsx|jsx|vue|svelte|css|scss|astro)$/i
const FRONTEND_PATH_PATTERNS = /\b(pages?|components?|app|views?|layouts?|sections?|features?|ui)\b/i

/**
 * Called after every AI response to capture content from frontend write operations.
 * Must be called BEFORE the response is sent to the client.
 */
export function accumulateFrontendContent(runId: string, normalized: NormalizedResponse): void {
  if (normalized.kind !== "needs_tool") return

  const tools = normalized.tools
    || (normalized.tool ? [{ id: "0", tool: normalized.tool, args: normalized.args || {} }] : [])

  for (const tc of tools) {
    if (tc.tool !== "write_file" && tc.tool !== "edit_file") continue

    const filePath = (tc.args?.path as string) || ""
    const content = (tc.args?.content || tc.args?.patch || "") as string

    if (!content || content.length < 50) continue
    if (!FRONTEND_FILE_EXTENSIONS.test(filePath) && !FRONTEND_PATH_PATTERNS.test(filePath)) continue

    if (!runFrontendContent.has(runId)) {
      runFrontendContent.set(runId, [])
    }
    // Store up to 3000 chars per file to limit memory while capturing enough for signal detection
    runFrontendContent.get(runId)!.push(content.slice(0, 3000))
  }
}

/** Clean up accumulated content for a run */
export function clearFrontendContent(runId: string): void {
  runFrontendContent.delete(runId)
}

// ─── Quality Validation ───

/**
 * Analyze accumulated frontend content for quality signals.
 */
export function validateFrontendQuality(
  runId: string,
  prompt: string
): FrontendQualityResult {
  const contentPieces = runFrontendContent.get(runId)

  if (!contentPieces || contentPieces.length === 0) {
    return { pass: true, score: 100, animationScore: 100, styleScore: 100, structureScore: 100 }
  }

  const combined = contentPieces.join("\n")

  const animationScore = scoreSignals(combined, ANIMATION_SIGNALS, 3)
  const styleScore = scoreSignals(combined, TAILWIND_QUALITY_SIGNALS, 8)
  const structureScore = scoreSignals(combined, COMPONENT_STRUCTURE_SIGNALS, 6)

  // Weighted total: animations matter most, then styling, then structure
  const score = Math.round(animationScore * 0.4 + styleScore * 0.35 + structureScore * 0.25)

  const PASS_THRESHOLD = 40

  if (score >= PASS_THRESHOLD) {
    return { pass: true, score, animationScore, styleScore, structureScore }
  }

  const hints: string[] = []

  if (animationScore < 30) {
    hints.push(
      "ANIMATIONS MISSING: Your frontend has no motion. Use framer-motion for page entrance animations, " +
      "scroll-triggered reveals on sections, staggered sequences for lists/grids, " +
      "and hover feedback on interactive elements. Choose animation styles that fit the project's personality."
    )
  }

  if (styleScore < 30) {
    hints.push(
      "STYLING BASIC: Your Tailwind usage is too plain. Add visual depth: " +
      "gradients for accents, backdrop-blur for glass surfaces, translucent borders/backgrounds, " +
      "rounded corners, hover state transitions, tracking/leading on typography, and shadows for depth. " +
      "Choose colors and patterns that match the brand."
    )
  }

  if (structureScore < 30) {
    hints.push(
      "LAYOUT WEAK: Add responsive breakpoints (md:, lg:), consistent spacing rhythm, " +
      "flex/grid layouts, and max-width containers. The layout should adapt to mobile and desktop."
    )
  }

  const wantsDark = /dark|night|black/i.test(prompt)
  if (wantsDark) {
    const darkScore = scoreSignals(combined, DARK_THEME_SIGNALS, 3)
    if (darkScore < 30) {
      hints.push(
        "DARK THEME MISSING: The user requested a dark design. Use a dark background, " +
        "light headings, muted body text, and translucent borders."
      )
    }
  }

  return {
    pass: false,
    score,
    animationScore,
    styleScore,
    structureScore,
    reason: buildRejectionReason(score, hints)
  }
}

// ─── Helpers ───

function scoreSignals(content: string, signals: string[], expectedMinHits: number): number {
  let hits = 0
  for (const signal of signals) {
    if (content.includes(signal)) hits++
  }

  // Score as percentage of expected minimum hits (capped at 100)
  return Math.min(100, Math.round((hits / expectedMinHits) * 100))
}

function buildRejectionReason(score: number, hints: string[]): string {
  const lines = [
    `FRONTEND QUALITY GUARD: Your frontend code scored ${score}/100 (minimum: 40).`,
    "",
    "Your code is too basic and does not meet modern frontend standards.",
    "Fix the following issues before completing:",
    "",
    ...hints,
    "",
    "Edit the frontend files to add these improvements. Use framer-motion for animations",
    "and modern Tailwind patterns for styling. Do NOT complete until the UI is polished.",
  ]

  return lines.join("\n")
}

/**
 * Build a rejection payload that forces the AI to improve frontend quality.
 */
export function buildFrontendRejectionPayload(reason: string, prompt: string): {
  tool: string
  result: Record<string, unknown>
} {
  return {
    tool: "_frontend_quality_rejected",
    result: {
      success: false,
      error: reason,
      originalTask: prompt,
      hint: "Your frontend code is too basic. Add animations (framer-motion), visual depth (gradients, glass, hover effects), and proper responsive layout. Design it to match the specific brand and product."
    }
  }
}
