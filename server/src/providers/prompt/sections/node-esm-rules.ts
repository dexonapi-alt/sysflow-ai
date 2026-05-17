/**
 * Plan `2026-05-16-agent-code-correctness-and-completion-artifacts.md` Stage 1.
 *
 * Node-ESM + TypeScript rules section. Teaches the model the import
 * semantics that ts-node-on-ESM enforces at runtime:
 *
 *   1. Relative imports REQUIRE the file extension (.ts / .js).
 *   2. `import type` for type-only imports from CJS modules.
 *   3. Default vs named exports — verify the source before importing.
 *   4. Bare-package imports require the dep in package.json.
 *   5. Forward-reference rule — write producers before consumers.
 *
 * Closes the user-reported repro where the agent shipped a POS backend
 * with cascading runtime failures: `ReferenceError: authRoutes is not
 * defined`, `ERR_MODULE_NOT_FOUND './config/db'` (missing .ts),
 * `Named export 'NextFunction' not found` (TS type imported as value
 * from CJS), `does not provide an export named 'default'` (default
 * import against a named export). All five rules below directly map
 * to one of those runtime failures.
 *
 * Cacheable — rules are static across runs. Gated on language: only
 * renders when the project-init brief's keyMarkers indicate a Node /
 * TypeScript project (or the repo is empty / small — where the user
 * hasn't yet committed to a stack and Node is the dominant scaffold
 * target in observed runs). Skips on existing Python / Rust / Go /
 * etc. repos to avoid wasting ~2000 tokens on irrelevant rules.
 */

/** Pure: decide whether the rules apply to this run's project shape. */
export function shouldRenderNodeEsmRules(ctx: { projectInitBrief?: unknown } = {}): boolean {
  const brief = ctx.projectInitBrief as { repoState?: string; keyMarkers?: unknown } | undefined
  if (!brief || typeof brief !== "object") {
    // Without a project-init brief (project-init disabled, no reasoner
    // backend, or legacy code path), default to rendering — false
    // negative would re-introduce the original bug. Token cost is the
    // only downside, and only on non-Node existing projects.
    return true
  }
  // For empty / small repos we don't know the eventual stack yet.
  // Render the rules — the model can short-circuit when it's clearly
  // scaffolding non-Node, and Node is by far the dominant target in
  // observed runs.
  if (brief.repoState === "empty" || brief.repoState === "small") return true
  // Existing repos: check keyMarkers for Node / TS signals.
  const markers = Array.isArray(brief.keyMarkers) ? (brief.keyMarkers as unknown[]) : []
  for (const m of markers) {
    if (typeof m !== "string") continue
    // Canonical Node / TS markers the project-init reasoner reports.
    if (m === "package.json") return true
    if (m === "tsconfig.json") return true
    if (m === "node_modules" || m === "node_modules/") return true
    // Common Node directory shapes.
    if (m === "src/" || m === "src") {
      // src/ alone is ambiguous (Python uses it too). Pair-required
      // with another marker; if no other Node marker, fall through.
      continue
    }
    // File extensions in markers — some project-init implementations
    // surface filenames like 'index.ts' directly.
    if (m.endsWith(".ts") || m.endsWith(".tsx") || m.endsWith(".js") || m.endsWith(".mjs") || m.endsWith(".cjs") || m.endsWith(".jsx")) return true
  }
  return false
}

export function getNodeEsmRulesSection(ctx: { projectInitBrief?: unknown } = {}): string | null {
  if (!shouldRenderNodeEsmRules(ctx)) return null
  return `═══ NODE-ESM + TYPESCRIPT IMPORT RULES ═══

When you write TypeScript / JavaScript files in this run, your code
will execute under Node.js ESM (the modern default for new projects
since 2024 — \`package.json: "type": "module"\` OR \`tsconfig.json:
"moduleResolution": "NodeNext"\`). ESM enforces strict import
semantics that ts-node and the runtime BOTH check. Get these wrong
and the project doesn't boot — \`npm run dev\` will fail with errors
that look like the file works but doesn't.

Five rules. Apply ALL of them — each maps to a real runtime failure:

  1. RELATIVE IMPORTS REQUIRE THE FILE EXTENSION.

     Wrong:   import pool from './config/db'
     Wrong:   import { authRouter } from '../routes/auth'
     Right:   import pool from './config/db.ts'
     Right:   import { authRouter } from '../routes/auth.ts'

     ESM resolution does NOT auto-append .ts / .js / .mjs. Bare
     paths like \`./config/db\` throw \`ERR_MODULE_NOT_FOUND\` at
     runtime even when the file IS at that path.

     EXCEPTION: tsconfig with \`"moduleResolution": "Bundler"\` or
     legacy CommonJS projects (\`"type": "commonjs"\` AND no
     \`"moduleResolution": "NodeNext"\`) allow extensionless imports.
     Check the project's tsconfig + package.json before authoring.
     For NEW projects you scaffold: use NodeNext + always-extension.

  2. \`import type\` FOR TYPE-ONLY IMPORTS FROM CJS PACKAGES.

     Wrong:   import { Request, Response, NextFunction } from 'express'
     Wrong:   import { ValidationChain } from 'express-validator'
     Right:   import { Request, Response, NextFunction } from 'express'  // VALUES
              // ...
              // OR if Express is CJS:
              import type { Request, Response, NextFunction } from 'express'

     Express, express-validator, mongoose, and many older packages
     are CommonJS modules. CJS exposes a SINGLE default export at
     runtime; named-type-imports from CJS packages fail in ESM with
     \`SyntaxError: Named export 'X' not found. The requested module
     'pkg' is a CommonJS module...\`.

     RULE: types (TypeScript interfaces, classes used only as types,
     generic constraints) MUST use \`import type\` from any CJS
     package. Runtime values (functions, factories, instances) use
     the regular import shape that pkg supports (often default).

  3. DEFAULT vs NAMED EXPORTS — VERIFY THE SOURCE BEFORE IMPORTING.

     Wrong (when middleware/errorHandler.ts uses \`export const errorHandler\`):
       import errorHandler from './middleware/errorHandler.ts'
     Right:
       import { errorHandler } from './middleware/errorHandler.ts'

     OR change the source: \`export default errorHandler\`. Pick ONE
     shape per file and stick with it. Don't import \`default from x\`
     when the file emits \`export const X\`; the runtime error is
     \`does not provide an export named 'default'\`.

     When writing a NEW file: prefer NAMED exports for utility modules
     (multiple things per file) and default exports for single-purpose
     entry points (the file IS the thing — e.g. a route handler module
     where the default export is the Router instance).

  4. BARE-PACKAGE IMPORTS REQUIRE THE DEP IN package.json.

     Wrong (when package.json has no "express" in dependencies):
       import express from 'express'
     Right:
       1. Add "express" to package.json dependencies
       2. THEN import it

     Don't write code that imports packages you haven't declared.
     ts-node will throw \`ERR_MODULE_NOT_FOUND\` for missing deps;
     more importantly, \`npm install\` won't pull them. Project-init
     reasoning already establishes a \`buildPlan\`; ensure package.json
     dependencies cover everything the buildPlan imports.

  5. FORWARD-REFERENCE RULE — PRODUCERS BEFORE CONSUMERS.

     Wrong (single batch writes index.ts FIRST, then routes/auth):
       Batch 1: src/index.ts (imports './routes/auth')
                src/routes/auth.ts

     Right (same batch, ordered):
       Batch 1: src/routes/auth.ts            ← producer first
                src/index.ts                   ← consumer last

     OR split into TWO batches: producers in batch 1, consumers in
     batch 2. The reason: post-write validation strips imports that
     reference files which don't exist at write time. If index.ts
     is written first, its imports of routes/auth get stripped
     silently → file lands with bare unimported names → runtime
     \`ReferenceError: authRoutes is not defined\`.

     The cli's batching layer topologically orders writes when it
     can detect dependencies. When you emit a batch that crosses
     these dependency lines, you can also self-order by emitting
     producers earlier in your \`tools\` array.

VERIFICATION HINT — when a write referencing imports lands, the cli's
import-sanitizer warns you if any imports were stripped. Treat those
warnings as MANDATORY work in your next turn: either create the
missing files OR remove the usages of those names. Don't proceed to
completion with stripped imports.

═══ END NODE-ESM + TYPESCRIPT IMPORT RULES ═══`
}
