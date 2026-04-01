/**
 * Scaffold Validator — programmatic enforcement of command safety.
 *
 * Replaces the massive "BANNED COMMANDS" and "KNOWN-GOOD COMMANDS" prompt sections
 * with actual code that blocks/corrects commands before execution.
 */

// ─── Banned commands: these time out, don't exist, or cause problems ───

const BANNED_COMMAND_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /^(npm|yarn|pnpm)\s+install\b/i, reason: "Dependency installation times out. Defer to user in completion summary." },
  { pattern: /^(npm|yarn|pnpm)\s+i\b(?!\s+--)/i, reason: "Dependency installation times out. Defer to user in completion summary." },
  { pattern: /^npx\s+prisma\s+(init|migrate|generate)\b/i, reason: "Prisma CLI commands are slow. Create schema.prisma and .env manually with write_file." },
  { pattern: /^npx\s+(shadcn-ui|shadcn)\s+init\b/i, reason: "shadcn init is interactive and slow. Create components manually with write_file." },
  { pattern: /^(npx\s+)?tailwindcss\s+init\b/i, reason: "tailwindcss init was removed in Tailwind v4. Create config files manually." },
  { pattern: /^npm\s+(start|run\s+dev|run\s+start)\b/i, reason: "Long-running server commands hang forever. Tell user to run manually." },
  { pattern: /^(node|python|python3|ruby|go\s+run)\s+\S+\.(js|ts|py|rb|go)\b/i, reason: "Running server files hangs forever. Tell user to run manually." },
  { pattern: /^npm\s+create\s+@nestjs\b/i, reason: "npm create @nestjs does not exist. Use: npx --yes @nestjs/cli new" },
  { pattern: /^(npx\s+)?create-react-app\b/i, reason: "create-react-app is deprecated. Use: npx --yes create-vite@latest --template react-ts" },
]

// ─── Known-good scaffolding commands ───

const KNOWN_GOOD_COMMANDS: Record<string, string> = {
  "react": "npx --yes create-vite@latest {name} --template react-ts",
  "nextjs": "npx --yes create-next-app@latest {name} --ts --eslint --tailwind --app --src-dir --use-npm",
  "nestjs": "npx --yes @nestjs/cli new {name} --skip-install --package-manager npm",
  "angular": "npx --yes @angular/cli new {name} --skip-install",
  "vue": "npx --yes create-vite@latest {name} --template vue-ts",
  "svelte": "npx --yes create-vite@latest {name} --template svelte-ts",
  "nuxt": "npx --yes nuxi@latest init {name}",
  "remix": "npx --yes create-remix@latest {name}",
  "astro": "npm create astro@latest {name}",
}

/**
 * Check if a command is banned.
 * Returns the reason if banned, null if allowed.
 */
export function isBannedCommand(command: string): string | null {
  const trimmed = command.trim()
  for (const { pattern, reason } of BANNED_COMMAND_PATTERNS) {
    if (pattern.test(trimmed)) {
      return reason
    }
  }
  return null
}

/**
 * Validate a scaffolding command and suggest corrections if needed.
 */
export function validateScaffoldCommand(command: string): { valid: boolean; corrected?: string; reason?: string } {
  const trimmed = command.trim()

  // Check if it's a banned command
  const banReason = isBannedCommand(trimmed)
  if (banReason) {
    return { valid: false, reason: banReason }
  }

  // Check for common mistakes and suggest corrections
  if (/npm\s+create\s+@nestjs/i.test(trimmed)) {
    return { valid: false, corrected: KNOWN_GOOD_COMMANDS.nestjs, reason: "npm create @nestjs does not exist" }
  }

  if (/create-react-app/i.test(trimmed)) {
    return { valid: false, corrected: KNOWN_GOOD_COMMANDS.react, reason: "create-react-app is deprecated" }
  }

  // Check for missing --yes flag on npx commands
  if (/^npx\s+(?!--yes)/.test(trimmed) && !trimmed.includes("--yes")) {
    const corrected = trimmed.replace(/^npx\s+/, "npx --yes ")
    return { valid: true, corrected, reason: "Added --yes flag to auto-accept prompts" }
  }

  return { valid: true }
}

/**
 * Validate imports in file content against known files and packages.
 * Returns an array of warning strings for suspicious imports.
 */
export function validateImports(
  filePath: string,
  content: string,
  knownFiles: Map<string, boolean>
): string[] {
  const warnings: string[] = []

  // Extract import statements
  const importRegex = /(?:import\s+.*?\s+from\s+['"](.+?)['"]|require\s*\(\s*['"](.+?)['"]\s*\))/g
  let match

  while ((match = importRegex.exec(content)) !== null) {
    const importPath = match[1] || match[2]
    if (!importPath) continue

    // Skip node built-ins
    if (isNodeBuiltin(importPath)) continue

    // Check relative imports
    if (importPath.startsWith(".")) {
      const resolved = resolveRelativeImport(filePath, importPath)
      if (resolved && knownFiles.has(resolved) && knownFiles.get(resolved) === false) {
        warnings.push(`Import "${importPath}" resolves to "${resolved}" which does not exist`)
      }
    }
  }

  return warnings
}

// ─── Helpers ───

const NODE_BUILTINS = new Set([
  "assert", "buffer", "child_process", "cluster", "console", "constants", "crypto",
  "dgram", "dns", "domain", "events", "fs", "http", "https", "module", "net",
  "os", "path", "perf_hooks", "process", "punycode", "querystring", "readline",
  "repl", "stream", "string_decoder", "sys", "timers", "tls", "tty", "url",
  "util", "v8", "vm", "worker_threads", "zlib",
  "node:assert", "node:buffer", "node:child_process", "node:crypto", "node:events",
  "node:fs", "node:http", "node:https", "node:net", "node:os", "node:path",
  "node:process", "node:readline", "node:stream", "node:url", "node:util",
  "node:worker_threads", "node:zlib"
])

function isNodeBuiltin(importPath: string): boolean {
  return NODE_BUILTINS.has(importPath) || importPath.startsWith("node:")
}

function resolveRelativeImport(fromFile: string, importPath: string): string | null {
  const dir = fromFile.split("/").slice(0, -1).join("/")
  if (!dir) return importPath.replace(/^\.\//, "")

  const parts = [...dir.split("/"), ...importPath.split("/")]
  const resolved: string[] = []
  for (const part of parts) {
    if (part === "." || part === "") continue
    if (part === "..") resolved.pop()
    else resolved.push(part)
  }

  const result = resolved.join("/")
  // Try common extensions
  const extensions = ["", ".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx", "/index.js"]
  for (const ext of extensions) {
    const candidate = result + ext
    // Return the base path without extension for checking
    if (ext === "") return result
  }
  return result
}
