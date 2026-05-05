/**
 * Scaffolder registry — canonical commands for fresh-project initialisation
 * across 20+ stacks. Replaces hand-written scaffolding with one
 * non-interactive command per stack.
 *
 * Each entry includes the flags needed to skip interactive prompts
 * (--yes / --non-interactive / preset templates) so the agent can run them
 * without hanging.
 */

export type StackKey =
  | "react-vite"
  | "vue-vite"
  | "svelte-vite"
  | "solid-vite"
  | "preact-vite"
  | "lit-vite"
  | "vite-vanilla"
  | "nextjs"
  | "nuxt"
  | "sveltekit"
  | "remix"
  | "astro"
  | "qwik"
  | "nestjs"
  | "angular"
  | "expo"
  | "tauri"
  | "electron-vite"
  | "bun-init"
  | "django"
  | "laravel"
  | "rails"

export type PostScaffoldInstaller = "npm" | "pnpm" | "yarn" | "bun" | "pip" | "composer" | "bundle" | "none"

export interface ScaffolderEntry {
  stackKey: StackKey
  displayName: string
  /** Command template; `{name}` is replaced by the resolved project name. */
  command: string
  /** Match terms — language, frameworks, libraries — that imply this scaffolder. */
  matchTerms: string[]
  /** Package manager (or none) used for `<installer> install` after scaffold. */
  postScaffoldInstall: PostScaffoldInstaller
  /**
   * If true, the scaffold-first flow auto-runs this without asking the user
   * when reasoning is HIGH confidence and this is the only registry match.
   */
  autoTrustForHighConfidence: boolean
  /** Optional note that gets injected into the agent's post-scaffold context. */
  postScaffoldNote?: string
}

export const SCAFFOLDER_REGISTRY: ScaffolderEntry[] = [
  // ─── Vite-family — auto-trust DISABLED ───
  // These scaffolds are 5-7 small files (package.json, vite.config.ts,
  // tsconfig.json, index.html, src/main.tsx, src/App.tsx). Hand-writing
  // is FASTER than spawning `npm create vite`, gives the agent full
  // control over each file, no scaffolder defaults to delete (default
  // README/favicon/eslint config), no waiting for create-vite to
  // download itself. The recommender still detects the stack so the
  // multi-candidate flow works if the agent or user wants to scaffold
  // anyway, but auto-trust is off — the main agent loop takes over and
  // writes the files directly.
  {
    stackKey: "react-vite",
    displayName: "React + Vite (TypeScript)",
    command: "npm create vite@latest {name} -- --template react-ts",
    matchTerms: ["react", "vite", "react+vite", "vite-react"],
    postScaffoldInstall: "npm",
    autoTrustForHighConfidence: false,
  },
  {
    stackKey: "vue-vite",
    displayName: "Vue + Vite (TypeScript)",
    command: "npm create vite@latest {name} -- --template vue-ts",
    matchTerms: ["vue", "vue.js", "vuejs"],
    postScaffoldInstall: "npm",
    autoTrustForHighConfidence: false,
  },
  {
    stackKey: "svelte-vite",
    displayName: "Svelte + Vite (TypeScript)",
    command: "npm create vite@latest {name} -- --template svelte-ts",
    matchTerms: ["svelte"],
    postScaffoldInstall: "npm",
    autoTrustForHighConfidence: false,
    postScaffoldNote: "If user mentioned routing or full-stack, SvelteKit may be a better fit — check the brief.",
  },
  {
    stackKey: "solid-vite",
    displayName: "SolidJS + Vite",
    command: "npm create vite@latest {name} -- --template solid-ts",
    matchTerms: ["solid", "solidjs", "solid.js"],
    postScaffoldInstall: "npm",
    autoTrustForHighConfidence: false,
  },
  {
    stackKey: "preact-vite",
    displayName: "Preact + Vite",
    command: "npm create vite@latest {name} -- --template preact-ts",
    matchTerms: ["preact"],
    postScaffoldInstall: "npm",
    autoTrustForHighConfidence: false,
  },
  {
    stackKey: "lit-vite",
    displayName: "Lit (web components) + Vite",
    command: "npm create vite@latest {name} -- --template lit-ts",
    matchTerms: ["lit", "web components"],
    postScaffoldInstall: "npm",
    autoTrustForHighConfidence: false,
  },
  {
    stackKey: "vite-vanilla",
    displayName: "Vanilla TypeScript + Vite",
    command: "npm create vite@latest {name} -- --template vanilla-ts",
    matchTerms: ["vanilla", "vanilla typescript", "plain js"],
    postScaffoldInstall: "npm",
    autoTrustForHighConfidence: false,
  },

  // ─── Full-stack frameworks ───
  {
    stackKey: "nextjs",
    displayName: "Next.js (TypeScript + Tailwind + App router)",
    command: "npx --yes create-next-app@latest {name} --ts --eslint --tailwind --app --src-dir --use-npm",
    matchTerms: ["next", "next.js", "nextjs", "next app"],
    postScaffoldInstall: "npm",
    autoTrustForHighConfidence: true,
  },
  {
    stackKey: "nuxt",
    displayName: "Nuxt 3",
    command: "npx --yes nuxi@latest init {name}",
    matchTerms: ["nuxt", "nuxt 3"],
    postScaffoldInstall: "npm",
    autoTrustForHighConfidence: true,
  },
  {
    stackKey: "sveltekit",
    displayName: "SvelteKit",
    command: "npm create svelte@latest {name}",
    matchTerms: ["sveltekit", "svelte kit", "svelte+kit"],
    postScaffoldInstall: "npm",
    autoTrustForHighConfidence: false,
    postScaffoldNote: "create-svelte is interactive in some versions; if it hangs, fall back to hand-writing.",
  },
  {
    stackKey: "remix",
    displayName: "Remix",
    command: "npx --yes create-remix@latest {name}",
    matchTerms: ["remix"],
    postScaffoldInstall: "npm",
    autoTrustForHighConfidence: true,
  },
  {
    stackKey: "astro",
    displayName: "Astro",
    command: "npm create astro@latest {name} -- --template minimal --typescript strict --install --git no",
    matchTerms: ["astro"],
    postScaffoldInstall: "npm",
    autoTrustForHighConfidence: true,
  },
  {
    stackKey: "qwik",
    displayName: "Qwik",
    command: "npm create qwik@latest basic {name}",
    matchTerms: ["qwik"],
    postScaffoldInstall: "npm",
    autoTrustForHighConfidence: false,
  },

  // ─── Backend ───
  {
    stackKey: "nestjs",
    displayName: "NestJS",
    command: "npx --yes @nestjs/cli new {name} --skip-install --package-manager npm",
    matchTerms: ["nest", "nestjs", "nest.js", "nest backend"],
    postScaffoldInstall: "npm",
    autoTrustForHighConfidence: true,
  },
  {
    stackKey: "angular",
    displayName: "Angular",
    command: "npx --yes @angular/cli new {name} --skip-install --defaults",
    matchTerms: ["angular"],
    postScaffoldInstall: "npm",
    autoTrustForHighConfidence: true,
  },

  // ─── Desktop / Mobile ───
  {
    stackKey: "expo",
    displayName: "Expo (React Native)",
    command: "npx --yes create-expo-app@latest {name} --template default",
    matchTerms: ["expo", "react native", "react-native"],
    postScaffoldInstall: "npm",
    autoTrustForHighConfidence: true,
  },
  {
    stackKey: "tauri",
    displayName: "Tauri",
    command: "npm create tauri-app@latest {name} -- --template vanilla-ts --manager npm",
    matchTerms: ["tauri"],
    postScaffoldInstall: "npm",
    autoTrustForHighConfidence: true,
    postScaffoldNote: "Tauri requires Rust toolchain. Verify `cargo --version` works before npm run tauri dev.",
  },
  {
    stackKey: "electron-vite",
    displayName: "Electron + Vite",
    command: "npm create @quick-start/electron@latest {name} -- --template vanilla-ts",
    matchTerms: ["electron"],
    postScaffoldInstall: "npm",
    autoTrustForHighConfidence: false,
  },

  // ─── Runtime-init (no project skeleton, just runtime files) ───
  {
    stackKey: "bun-init",
    displayName: "Bun project",
    command: "bun init {name}",
    matchTerms: ["bun"],
    postScaffoldInstall: "bun",
    autoTrustForHighConfidence: false,
    postScaffoldNote: "Requires Bun installed; verify `bun --version` first.",
  },

  // ─── Non-Node ecosystems ───
  {
    stackKey: "django",
    displayName: "Django",
    command: "django-admin startproject {name}",
    matchTerms: ["django"],
    postScaffoldInstall: "pip",
    autoTrustForHighConfidence: true,
    postScaffoldNote: "Run pip install django first if django-admin is missing.",
  },
  {
    stackKey: "laravel",
    displayName: "Laravel",
    command: "composer create-project laravel/laravel {name}",
    matchTerms: ["laravel"],
    postScaffoldInstall: "composer",
    autoTrustForHighConfidence: true,
  },
  {
    stackKey: "rails",
    displayName: "Ruby on Rails",
    command: "rails new {name} --skip-bundle",
    matchTerms: ["rails", "ruby on rails"],
    postScaffoldInstall: "bundle",
    autoTrustForHighConfidence: true,
  },
]

/** Look up by stackKey. */
export function getScaffolder(key: StackKey): ScaffolderEntry | null {
  return SCAFFOLDER_REGISTRY.find((s) => s.stackKey === key) ?? null
}

/**
 * Find scaffolders whose matchTerms intersect any of the supplied tokens.
 * Tokens should be lower-case stack/framework/library names.
 */
export function findScaffoldersByTerms(tokens: string[]): ScaffolderEntry[] {
  if (!tokens || tokens.length === 0) return []
  const lower = tokens.map((t) => t.toLowerCase())
  const seen = new Set<StackKey>()
  const matches: ScaffolderEntry[] = []
  for (const entry of SCAFFOLDER_REGISTRY) {
    for (const term of entry.matchTerms) {
      if (lower.includes(term)) {
        if (!seen.has(entry.stackKey)) {
          seen.add(entry.stackKey)
          matches.push(entry)
        }
        break
      }
    }
  }
  return matches
}

/** Resolve {name} placeholder. */
export function resolveCommand(entry: ScaffolderEntry, projectName: string): string {
  return entry.command.replace("{name}", projectName)
}

/** Build the install-deps command for the post-scaffold step. */
export function getInstallCommand(entry: ScaffolderEntry, projectName: string): string | null {
  switch (entry.postScaffoldInstall) {
    case "npm":      return `cd ${projectName} && npm install`
    case "pnpm":     return `cd ${projectName} && pnpm install`
    case "yarn":     return `cd ${projectName} && yarn install`
    case "bun":      return `cd ${projectName} && bun install`
    case "pip":      return `cd ${projectName} && pip install -r requirements.txt`
    case "composer": return null  // composer create-project already installs
    case "bundle":   return `cd ${projectName} && bundle install`
    case "none":     return null
  }
}
