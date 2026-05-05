/**
 * Compatibility shims for the legacy services/scaffold-options.ts API.
 *
 * Existing handlers import detectScaffoldingNeed / parseScaffoldResponse /
 * buildScaffoldConfirmationMessage / scaffoldChoices state. We re-implement
 * those on top of the new registry so handlers can swap their import path
 * without changing behaviour, then we delete the old file.
 *
 * After Phase 6, the multi-candidate ask-user path still uses these.
 * The HIGH-confidence single-match path bypasses them entirely via the
 * recommender + handler integration.
 */

import { findScaffoldersByTerms, type ScaffolderEntry } from "./registry.js"

export interface ScaffoldOption {
  label: string
  command: string | null
  framework: string
}

interface DirectoryEntry {
  name: string
  type: string
}

const NEW_PROJECT_KEYWORDS = /\b(create|build|make|set\s*up|initialize|init|new|start|bootstrap|scaffold)\b/i
const FIX_KEYWORDS = /\b(fix|error|bug|modify|edit|update|change|refactor|debug)\b/i

const scaffoldChoices = new Map<string, ScaffoldOption>()

/**
 * Detect if a fresh-project scaffold is warranted. Mirrors the old
 * scaffold-options.ts surface but reads from the new registry.
 */
export function detectScaffoldingNeed(prompt: string, tree: DirectoryEntry[]): ScaffoldOption[] | null {
  const nonSysbase = tree.filter((e) => !e.name.startsWith("sysbase"))
  if (nonSysbase.length > 2) return null
  if (!NEW_PROJECT_KEYWORDS.test(prompt)) return null
  if (FIX_KEYWORDS.test(prompt)) return null

  // Token harvest from the prompt (matches the recommender's backfill list).
  const lower = prompt.toLowerCase()
  const promptTokens: string[] = []
  for (const term of ["next.js", "next", "nuxt", "nestjs", "nest.js", "angular", "tauri", "expo", "react native", "react-native", "astro", "remix", "svelte", "sveltekit", "qwik", "solid", "vue", "preact", "lit", "react", "vite", "django", "laravel", "rails", "electron", "bun"]) {
    if (lower.includes(term)) promptTokens.push(term)
  }
  if (promptTokens.length === 0) {
    // Fallback: generic frontend hint
    if (/\b(frontend|front-end|landing|page|website|webapp|web\s*app|ui|dashboard|portfolio)\b/i.test(prompt)) {
      promptTokens.push("react", "vite")
    }
  }
  const matches = findScaffoldersByTerms(promptTokens)
  if (matches.length === 0) return null

  return [
    ...matches.map(toScaffoldOption),
    { label: "Create files manually", command: null, framework: "manual" },
  ]
}

function toScaffoldOption(entry: ScaffolderEntry): ScaffoldOption {
  return {
    label: `Use ${entry.displayName}`,
    command: entry.command,
    framework: entry.stackKey,
  }
}

export function storeScaffoldChoice(runId: string, choice: ScaffoldOption): void {
  scaffoldChoices.set(runId, choice)
}

export function getScaffoldChoice(runId: string): ScaffoldOption | null {
  return scaffoldChoices.get(runId) || null
}

export function parseScaffoldResponse(userResponse: string, options: ScaffoldOption[]): ScaffoldOption | null {
  const trimmed = userResponse.trim()
  const num = parseInt(trimmed, 10)
  if (!isNaN(num) && num >= 1 && num <= options.length) {
    return options[num - 1]
  }
  const lower = trimmed.toLowerCase()
  if (lower.includes("manual") || lower.includes("manually") || lower.includes("no scaffold")) {
    return options.find((o) => o.command === null) || null
  }
  for (const opt of options) {
    if (opt.command && lower.includes(opt.framework.split("-")[0])) {
      return opt
    }
  }
  return options[0]
}

export function buildScaffoldConfirmationMessage(options: ScaffoldOption[]): string {
  let msg = "This task requires creating a new project. How would you like to set it up?\n\n"
  options.forEach((opt, i) => {
    msg += `${i + 1}. ${opt.label}`
    if (opt.command) msg += ` — \`${opt.command.replace("{name}", "<project>")}\``
    msg += "\n"
  })
  msg += "\nReply with a number or describe your preference."
  return msg
}

export function clearScaffoldState(runId: string): void {
  scaffoldChoices.delete(runId)
}
