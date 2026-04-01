/**
 * Scaffold Options — programmatic scaffolding confirmation flow.
 *
 * Detects when a task requires project creation and presents the user
 * with scaffolding options (use installer vs create files manually).
 * Replaces the prompt-based scaffolding instructions with a reliable code path.
 */

export interface ScaffoldOption {
  label: string
  command: string | null  // null = create files manually
  framework: string
}

interface DirectoryEntry {
  name: string
  type: string
}

// ─── Framework detection patterns ───

const FRAMEWORK_PATTERNS: Array<{
  pattern: RegExp
  framework: string
  options: ScaffoldOption[]
}> = [
  {
    pattern: /\b(react|vite)\b(?!.*\bnext)/i,
    framework: "react-vite",
    options: [
      { label: "Use create-vite (recommended)", command: "npx --yes create-vite@latest {name} --template react-ts", framework: "react-vite" },
      { label: "Create files manually", command: null, framework: "react-manual" }
    ]
  },
  {
    pattern: /\bnext\.?js\b|\bnext\s*app\b/i,
    framework: "nextjs",
    options: [
      { label: "Use create-next-app (recommended)", command: "npx --yes create-next-app@latest {name} --ts --eslint --tailwind --app --src-dir --use-npm", framework: "nextjs" },
      { label: "Create files manually", command: null, framework: "nextjs-manual" }
    ]
  },
  {
    pattern: /\bnest\.?js\b|\bnest\s*backend\b/i,
    framework: "nestjs",
    options: [
      { label: "Use @nestjs/cli (recommended)", command: "npx --yes @nestjs/cli new {name} --skip-install --package-manager npm", framework: "nestjs" },
      { label: "Create files manually", command: null, framework: "nestjs-manual" }
    ]
  },
  {
    pattern: /\bangular\b/i,
    framework: "angular",
    options: [
      { label: "Use @angular/cli", command: "npx --yes @angular/cli new {name} --skip-install", framework: "angular" },
      { label: "Create files manually", command: null, framework: "angular-manual" }
    ]
  },
  {
    pattern: /\bvue\.?js\b|\bvue\s*app\b/i,
    framework: "vue",
    options: [
      { label: "Use create-vite with Vue template", command: "npx --yes create-vite@latest {name} --template vue-ts", framework: "vue" },
      { label: "Create files manually", command: null, framework: "vue-manual" }
    ]
  },
  {
    pattern: /\bnuxt\b/i,
    framework: "nuxt",
    options: [
      { label: "Use nuxi init", command: "npx --yes nuxi@latest init {name}", framework: "nuxt" },
      { label: "Create files manually", command: null, framework: "nuxt-manual" }
    ]
  },
  {
    pattern: /\bdjango\b/i,
    framework: "django",
    options: [
      { label: "Use django-admin startproject", command: "django-admin startproject {name}", framework: "django" },
      { label: "Create files manually", command: null, framework: "django-manual" }
    ]
  },
  {
    pattern: /\blaravel\b/i,
    framework: "laravel",
    options: [
      { label: "Use Laravel installer", command: "composer create-project laravel/laravel {name}", framework: "laravel" },
      { label: "Create files manually", command: null, framework: "laravel-manual" }
    ]
  },
  {
    pattern: /\bastro\b/i,
    framework: "astro",
    options: [
      { label: "Use create astro", command: "npm create astro@latest {name}", framework: "astro" },
      { label: "Create files manually", command: null, framework: "astro-manual" }
    ]
  },
  {
    pattern: /\bremix\b/i,
    framework: "remix",
    options: [
      { label: "Use create-remix", command: "npx --yes create-remix@latest {name}", framework: "remix" },
      { label: "Create files manually", command: null, framework: "remix-manual" }
    ]
  },
  {
    pattern: /\bsvelte\b/i,
    framework: "svelte",
    options: [
      { label: "Use create-vite with Svelte template", command: "npx --yes create-vite@latest {name} --template svelte-ts", framework: "svelte" },
      { label: "Create files manually", command: null, framework: "svelte-manual" }
    ]
  }
]

// Keywords that indicate project creation (not modification of existing project)
const NEW_PROJECT_KEYWORDS = /\b(create|build|make|set\s*up|initialize|init|new|start|bootstrap|scaffold)\b/i

// ─── Per-run scaffold choice storage ───

const scaffoldChoices = new Map<string, ScaffoldOption>()

/**
 * Detect if the task requires scaffolding and return options for the user.
 * Returns null if no scaffolding needed (existing project, simple task, or no framework detected).
 */
export function detectScaffoldingNeed(prompt: string, tree: DirectoryEntry[]): ScaffoldOption[] | null {
  // Skip if directory already has project files (not a new project)
  const nonSysbase = tree.filter((e) => !e.name.startsWith("sysbase"))
  if (nonSysbase.length > 2) return null

  // Skip if prompt doesn't indicate creating something new
  if (!NEW_PROJECT_KEYWORDS.test(prompt)) return null

  // Skip fix/debug/modify requests
  if (/\b(fix|error|bug|modify|edit|update|change|refactor|debug)\b/i.test(prompt)) return null

  // Detect frameworks mentioned in the prompt
  const detectedOptions: ScaffoldOption[] = []
  const detectedFrameworks = new Set<string>()

  for (const fp of FRAMEWORK_PATTERNS) {
    if (fp.pattern.test(prompt) && !detectedFrameworks.has(fp.framework)) {
      detectedFrameworks.add(fp.framework)
      detectedOptions.push(...fp.options)
    }
  }

  // If no specific framework detected but it's a new project request, offer generic option
  if (detectedOptions.length === 0 && NEW_PROJECT_KEYWORDS.test(prompt)) {
    // Check for generic frontend/backend keywords
    const isFrontend = /\b(frontend|front-end|landing|page|website|webapp|web\s*app|ui|dashboard|portfolio)\b/i.test(prompt)
    if (isFrontend) {
      detectedOptions.push(
        { label: "Use create-vite (React + TypeScript)", command: "npx --yes create-vite@latest {name} --template react-ts", framework: "react-vite" },
        { label: "Use create-next-app (Next.js)", command: "npx --yes create-next-app@latest {name} --ts --eslint --tailwind --app --src-dir --use-npm", framework: "nextjs" },
        { label: "Create files manually", command: null, framework: "manual" }
      )
    }
  }

  return detectedOptions.length > 0 ? detectedOptions : null
}

/**
 * Store the user's scaffolding choice for this run.
 */
export function storeScaffoldChoice(runId: string, choice: ScaffoldOption): void {
  scaffoldChoices.set(runId, choice)
}

/**
 * Get the stored scaffolding choice for this run.
 */
export function getScaffoldChoice(runId: string): ScaffoldOption | null {
  return scaffoldChoices.get(runId) || null
}

/**
 * Parse user response to scaffold question and return the chosen option.
 */
export function parseScaffoldResponse(userResponse: string, options: ScaffoldOption[]): ScaffoldOption | null {
  const trimmed = userResponse.trim()

  // Try numeric selection (1, 2, 3...)
  const num = parseInt(trimmed, 10)
  if (!isNaN(num) && num >= 1 && num <= options.length) {
    return options[num - 1]
  }

  // Try keyword matching
  const lower = trimmed.toLowerCase()
  if (lower.includes("manual") || lower.includes("manually") || lower.includes("no scaffold")) {
    return options.find((o) => o.command === null) || null
  }

  for (const opt of options) {
    if (opt.command && lower.includes(opt.framework.split("-")[0])) {
      return opt
    }
  }

  // Default to first option if response is ambiguous
  return options[0]
}

/**
 * Build the scaffold confirmation message for the user.
 */
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

/**
 * Clean up scaffold state for a run.
 */
export function clearScaffoldState(runId: string): void {
  scaffoldChoices.delete(runId)
}
