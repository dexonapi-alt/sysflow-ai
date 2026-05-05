/**
 * Scaffold recommender — consumes the Phase 5 implement brief + cwd state
 * and decides whether to scaffold, what to run, and whether to skip the
 * user-confirmation prompt.
 *
 * Pure function. No I/O. No model calls.
 */

import { extractProjectName } from "./project-name.js"
import { findScaffoldersByTerms, type ScaffolderEntry } from "./registry.js"

export interface ImplementBriefMinimal {
  recommendedStack?: {
    language?: string
    frameworks?: string[]
    libraries?: string[]
  }
  intent?: string
}

export interface ReasoningEnvelopeMinimal {
  pipeline?: string
  confidence?: "HIGH" | "MEDIUM" | "LOW" | string
  implementBrief?: ImplementBriefMinimal | null
}

export interface DirectoryEntryMinimal {
  name: string
  type: string
}

export interface RecommendArgs {
  brief?: ReasoningEnvelopeMinimal | null
  userMessage: string
  cwd?: string | null
  directoryTree?: DirectoryEntryMinimal[]
}

export interface ScaffoldRecommendation {
  shouldScaffold: boolean
  /** When shouldScaffold=true and exactly one match, the chosen entry. */
  scaffolder: ScaffolderEntry | null
  /** All matching entries — used for the multi-candidate ask-user fallback. */
  candidates: ScaffolderEntry[]
  projectName: string
  autoTrust: boolean
  reason: string
}

/** Threshold for "fresh project" — more than this many entries means it's an existing project. */
const FRESH_PROJECT_FILE_THRESHOLD = 2

export function recommendScaffold(args: RecommendArgs): ScaffoldRecommendation {
  const projectName = extractProjectName(args.userMessage, args.cwd)
  const baseEmpty: ScaffoldRecommendation = {
    shouldScaffold: false,
    scaffolder: null,
    candidates: [],
    projectName,
    autoTrust: false,
    reason: "",
  }

  // Gate 1: must be a fresh project.
  const tree = args.directoryTree ?? []
  const nonSysbase = tree.filter((e) => !e.name.startsWith("sysbase"))
  if (nonSysbase.length > FRESH_PROJECT_FILE_THRESHOLD) {
    return { ...baseEmpty, reason: "cwd has existing project files" }
  }

  // Gate 2: brief must exist + carry an implement brief.
  if (!args.brief || args.brief.pipeline !== "implement" || !args.brief.implementBrief) {
    return { ...baseEmpty, reason: "no implement brief from reasoner" }
  }
  const stack = args.brief.implementBrief.recommendedStack ?? {}
  const tokens = collectTokens(stack, args.userMessage)
  if (tokens.length === 0) return { ...baseEmpty, reason: "stack tokens empty" }

  // Gate 3: registry must have at least one match.
  const candidates = findScaffoldersByTerms(tokens)
  if (candidates.length === 0) {
    return { ...baseEmpty, reason: `no registry match for stack tokens [${tokens.join(", ")}]` }
  }

  const confidence = args.brief.confidence ?? "MEDIUM"
  const isHigh = confidence === "HIGH"
  const exactlyOne = candidates.length === 1
  const candidate = candidates[0]
  const candidateAutoTrusts = candidate.autoTrustForHighConfidence

  const autoTrust = isHigh && exactlyOne && candidateAutoTrusts
  return {
    shouldScaffold: true,
    scaffolder: exactlyOne ? candidate : null,
    candidates,
    projectName,
    autoTrust,
    reason: autoTrust
      ? `HIGH-confidence single match for ${candidate.stackKey} — auto-trusting`
      : exactlyOne
        ? `single match for ${candidate.stackKey} but ${isHigh ? "scaffolder is opt-in only" : `confidence=${confidence}`}; user will confirm`
        : `multiple matches (${candidates.map((c) => c.stackKey).join(", ")}); user will pick`,
  }
}

function collectTokens(
  stack: { language?: string; frameworks?: string[]; libraries?: string[] },
  userMessage: string,
): string[] {
  const out = new Set<string>()
  const add = (s: string | undefined): void => {
    if (!s) return
    out.add(s.toLowerCase().trim())
  }
  add(stack.language)
  for (const f of stack.frameworks ?? []) add(f)
  for (const l of stack.libraries ?? []) add(l)
  // Also seed with stack-name tokens that show up in the user message —
  // catches cases where the reasoner under-listed (e.g. user said "next.js"
  // but the brief only carries "TypeScript" + "React").
  const lowerMsg = (userMessage || "").toLowerCase()
  for (const term of ["next.js", "next", "nuxt", "nestjs", "nest.js", "tauri", "expo", "react native", "react-native", "astro", "remix", "svelte", "sveltekit", "qwik", "solid", "vue", "preact", "angular", "django", "laravel", "rails"]) {
    if (lowerMsg.includes(term)) out.add(term)
  }
  return [...out].filter(Boolean)
}
