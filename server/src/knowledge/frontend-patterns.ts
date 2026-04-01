/**
 * Frontend Design Intelligence — Entry Point
 *
 * Detects frontend tasks, identifies the tech stack, and delegates
 * to the comprehensive design system for prompt-aware brief generation.
 */

import { buildDesignBrief } from "./design-system.js"
import { getComponentTemplates, getCompactTemplateReminder } from "./component-templates.js"

// ─── Stack Detection ───

export type FrontendStack = "nextjs" | "react-vite" | "vue" | "svelte" | "generic"

export function detectFrontendStack(
  prompt: string,
  directoryTree?: Array<{ name: string; type: string }>
): FrontendStack | null {
  const lower = prompt.toLowerCase()
  const files = (directoryTree || []).map((e) => e.name.toLowerCase())

  if (lower.includes("next") || files.some((f) => f.includes("next.config"))) return "nextjs"
  if (lower.includes("vite") || files.some((f) => f.includes("vite.config"))) return "react-vite"
  if (lower.includes("vue") || files.some((f) => f.includes("vue"))) return "vue"
  if (lower.includes("svelte") || files.some((f) => f.includes("svelte"))) return "svelte"

  if (
    lower.includes("react") || lower.includes("frontend") || lower.includes("landing") ||
    lower.includes("dashboard") || lower.includes("website") || lower.includes("web app") ||
    lower.includes("ui") || lower.includes("page")
  ) {
    return "nextjs"
  }

  return null
}

export function isFrontendTask(prompt: string): boolean {
  return /\b(frontend|landing\s*page|dashboard|website|web\s*app|ui|homepage|portfolio|saas|pricing|hero|components?|pages?|layout|navbar|sidebar|footer|modal|form|card|table|grid|responsive|animation|animated|modern\s*ui|beautiful|sleek|stylish)\b/i.test(prompt)
}

// ─── Design Brief Generation ───

/**
 * Generates a prompt-aware design brief using the comprehensive design system.
 * Analyzes the user's prompt to select theme, palette, layout, and component
 * inspirations specific to the project.
 */
export function getFrontendPatterns(_stack: FrontendStack, prompt: string): string {
  const brief = buildDesignBrief(prompt)
  const templates = getComponentTemplates()
  return brief + "\n\n" + templates
}

/**
 * Compact reminder injected during tool-result rounds.
 * Keeps the AI on track without repeating the full brief.
 */
export function getFrontendPatternsCompact(): string {
  const reminder = [
    "═══ FRONTEND QUALITY REMINDER ═══",
    "CRITICAL: Every component must look premium and polished. Follow these rules:",
    "",
    "STRUCTURE (mandatory for every section):",
    '- Section wrapper: py-24 with max-w-7xl mx-auto px-6',
    '- Section heading: text-center mb-16, label (text-sm text-blue-400) + h2 (text-3xl md:text-5xl font-bold tracking-tight) + subtitle (text-neutral-400)',
    '- Cards: rounded-2xl border border-white/5 bg-white/[0.02] p-6 with hover:bg-white/[0.05] transition-all',
    "",
    "VISUAL DEPTH (at least 3 of these per page):",
    '- Ambient glow: absolute w-[500px] h-[500px] bg-blue-500/20 rounded-full blur-[120px]',
    '- Glass surface: bg-white/5 backdrop-blur-xl border border-white/10',
    '- Gradient text: bg-gradient-to-r from-blue-400 via-cyan-400 to-emerald-400 bg-clip-text text-transparent',
    '- Gradient border: border-white/10 with hover:border-white/20',
    "",
    "SPACING & TYPOGRAPHY:",
    '- Hero: text-5xl md:text-7xl font-bold tracking-tight',
    '- Body text: text-neutral-400 (never raw text-white for paragraphs)',
    '- Buttons: px-8 py-3.5 rounded-xl with hover transition',
    '- Consistent gap-6 between cards, mb-4 to mb-6 between elements',
    "",
    "DO NOT: use raw text without containers, skip responsive breakpoints (md:, lg:), or omit hover states.",
    "═══ END REMINDER ═══"
  ].join("\n")

  return reminder + "\n\n" + getCompactTemplateReminder()
}
