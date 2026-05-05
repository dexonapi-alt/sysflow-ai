# Sysflow Phase 6 — Scaffold-First

- **Created:** 2026-05-02
- **Status:** implemented (2026-05-02)
- **Scope:** Stop hand-writing config files for fresh projects when a canonical scaffolder exists. Replace the "ask the user which scaffolder to use" prompt with a reasoning-driven recommender that auto-runs the scaffolder + auto-installs deps for HIGH-confidence single-scaffolder cases. Cover 15+ stacks. Resolve the system-prompt vs scaffold-options.ts contradiction.

## Goal

When the user says "create a react app for a todo list", run `npm create vite@latest todo-list -- --template react-ts` followed by `npm install` followed by the agent customising the scaffold — instead of hand-writing 15 config files. Same for Next, Nest, Tauri, Svelte, Astro, Remix, Vue, Solid, Expo, Nuxt, Hono, Bun, Tauri, Foundry, etc. For stacks without a canonical scaffolder (Express, FastAPI, Discord.js, scripts), continue to hand-write.

## Context from knowledge base

`.claude/knowledge/` is still empty. References that matter:

- `server/src/services/scaffold-options.ts` — the existing detection module covers 11 frameworks via regex. Triggers `waiting_for_user` + `parseScaffoldResponse` after the user picks a number. Phase 6 expands the registry, moves the module to `server/src/scaffold/`, and integrates with the Phase 5 reasoner.
- `server/src/providers/prompt/sections/task-guidelines.ts` — currently includes the line *"NEVER run: npm install, npx prisma init/migrate/generate, npx shadcn init, npx tailwindcss init."* This **contradicts** the scaffold-options system. Phase 6 rewrites the COMMANDS subsection to actively encourage scaffolders for fresh projects.
- `.claude/plans/applied/2026-05-02-phase-3-capabilities.md` — permission system. Auto-install after scaffold flows through the existing `run_command` permission gate (defaults to `ask`); user confirms once.
- `.claude/plans/applied/2026-05-02-phase-5-pre-flight-reasoning.md` — `runReasoning({ trigger: 'preflight' })` returns an `ImplementBrief` with `recommendedStack.{language, frameworks, libraries}` and a `confidence` field. Phase 6 reads this brief to decide whether to scaffold.
- `server/src/handlers/user-message.ts` — current scaffold-options check happens BEFORE the reasoner runs (line ~140). Phase 6 reorders: reasoning first, then scaffold decision.

## Affected files

### Server — scaffold module (new directory)

- `server/src/scaffold/registry.ts` *(new)* — typed registry of 15+ canonical scaffolders. Each entry: `{ stackKey, displayName, command, projectNameTemplate, postScaffoldInstall, additionalArgs?, autoTrustForHighConfidence }`. Stacks: `react-vite`, `vue-vite`, `svelte-vite`, `solid-vite`, `nextjs`, `nuxt`, `nestjs`, `angular`, `astro`, `remix`, `expo`, `tauri`, `qwik`, `sveltekit`, `vite-vanilla`, `bun-init`, `hono`, `electron-vite`, `django`, `laravel`. Each scaffolder has its non-interactive flags pre-baked (e.g. Next gets `--ts --eslint --tailwind --app --src-dir --use-npm`).
- `server/src/scaffold/recommender.ts` *(new)* — `recommendScaffold({ implementBrief, cwd, directoryTree })` returns `{ shouldScaffold: bool, scaffolder: ScaffolderEntry | null, projectName: string, autoTrust: bool, reason: string }`. Logic:
  1. If cwd has > 2 non-sysbase entries → not a fresh project, `shouldScaffold: false`.
  2. If `implementBrief.confidence !== 'HIGH'` OR brief is null → fall back to the existing user-prompt flow (ambiguous stack means asking).
  3. Match `implementBrief.recommendedStack` against the registry. Single match + HIGH confidence → `shouldScaffold: true, autoTrust: true`.
  4. Multiple matches (e.g. brief mentions both React + Next) → return all candidates with `autoTrust: false` so the user picks.
  5. No registry match → not a known scaffolder, `shouldScaffold: false` (agent hand-writes).
- `server/src/scaffold/project-name.ts` *(new)* — `extractProjectName(userMessage, cwd)` returns a kebab-case name from the user's prompt ("todo list app" → `todo-list-app`), falling back to the cwd basename if the prompt doesn't suggest one.
- `server/src/scaffold/orchestrator.ts` *(new)* — `runScaffoldFlow({ recommendation, runId, sysbasePath })` builds the synthetic agent action. Returns a `NormalizedResponse` with `kind: needs_tool, tool: run_command, args: { command: <resolved scaffolder> }` plus `reasoning: "Scaffolding the recommended stack so we don't hand-write config files."`. Marks `actionPlanner.injectContext` with a follow-up: "After scaffold succeeds, run `npm install` (or pnpm/yarn equivalent), then read the generated package.json to verify, then customise the project for the user's task."
- `server/src/scaffold/index.ts` *(new)* — barrel re-exports.
- `server/src/services/scaffold-options.ts` — **delete** (replaced by `scaffold/registry.ts` + `scaffold/recommender.ts`). Existing imports in `handlers/user-message.ts` and `handlers/tool-result.ts` are rewired to the new module's compatibility shims (`detectScaffoldingNeed`, `parseScaffoldResponse`, `buildScaffoldConfirmationMessage`) — these stay supported during the transition for the multi-candidate ask-user path.
- `server/src/scaffold/legacy-shims.ts` *(new)* — re-implements `detectScaffoldingNeed`, `parseScaffoldResponse`, `buildScaffoldConfirmationMessage` on top of the new registry so the existing `tool-result.ts` scaffold-choice flow keeps working. Eventually deletable once the multi-candidate path also flows through `recommender.ts`.

### Server — handler integration

- `server/src/handlers/user-message.ts` — reorder + wire:
  1. Run `runReasoning({ trigger: 'preflight' })` as today.
  2. NEW: if reasoning succeeds AND returns an implement brief AND cwd is empty-ish → run `recommendScaffold(brief, cwd, directoryTree)`.
  3. If `shouldScaffold && autoTrust` → return a `needs_tool` response with the scaffold command directly. No user prompt; reasoning brief box already showed the choice.
  4. If `shouldScaffold && !autoTrust` (multiple candidates) → fall back to the existing `waiting_for_user` flow with the candidates as choices.
  5. If `!shouldScaffold` → existing flow (agent hand-writes).
- `server/src/handlers/tool-result.ts` — when the agent's last action was a scaffold `run_command` AND it succeeded, inject a follow-up via `actionPlanner.injectContext`: *"Scaffold succeeded. Next: run `npm install` to install deps (the permission system will ask once). Then read package.json to verify the generated stack and start customising. Do NOT recreate files the scaffolder produced."*

### Server — prompt rewrite

- `server/src/providers/prompt/sections/task-guidelines.ts` — replace the COMMANDS subsection. Remove the `NEVER run: npm install, npx prisma init/migrate/generate, npx shadcn init, npx tailwindcss init` line (it contradicted the scaffolder system). New text:
  ```
  COMMANDS:
  - For fresh projects with a canonical scaffolder (Vite, Next, Nest, Tauri, Svelte, Astro, Remix, Vue, Nuxt, Solid, Expo, Angular, Astro, etc.) — RUN the scaffolder. Hand-writing 15 config files is slow and error-prone.
  - For stacks WITHOUT a canonical scaffolder (Express, FastAPI, Discord.js, Bun scripts, ML scripts), hand-write the minimal file set.
  - After the scaffolder finishes, run `npm install` (or the package manager the scaffolder set up) to install deps.
  - NEVER run long-running commands (npm start, npm run dev, node server.js, npm run watch).
  - For migration commands (prisma migrate dev, drizzle-kit push), defer to the user — those need a connected DB and are destructive.
  - If a command is skipped, keep writing source files — do not stop.
  - The system already chose the scaffolder for you when one is available — RUN IT, don't second-guess.
  ```
- `server/src/providers/prompt/sections/tools.ts` — extend the `run_command` tool description: *"Use for scaffolders (`npm create vite`, `npx create-next-app`), `npm install`, build/test commands, git, and one-shot scripts. Never use for long-running servers."*

### Tests

- `server/src/scaffold/__tests__/recommender.test.ts` *(new)* — recommendation matrix:
  - HIGH confidence implement brief with React+Vite stack + empty cwd → `{ shouldScaffold: true, scaffolder: react-vite, autoTrust: true }`.
  - HIGH confidence brief with NestJS stack + empty cwd → NestJS recommended with autoTrust.
  - MEDIUM confidence brief → `autoTrust: false` even on single match.
  - Brief with stack not in registry (e.g. Express) → `shouldScaffold: false`.
  - cwd with 5 existing files → `shouldScaffold: false` regardless of brief.
  - Brief with multiple-stack ambiguity (mentions React + Next) → returns multiple candidates + `autoTrust: false`.
- `server/src/scaffold/__tests__/registry.test.ts` *(new)* — every registry entry is well-formed (has command, command contains `{name}` placeholder when projectNameTemplate isn't `'none'`, postScaffoldInstall is one of `npm|pnpm|yarn|none`).
- `server/src/scaffold/__tests__/project-name.test.ts` *(new)* — `extractProjectName`:
  - "create a todo list app" → "todo-list-app"
  - "build me a portfolio site for jane" → "portfolio-site" (drops "for jane")
  - "build something" with cwd `/projects/my-app` → "my-app" (cwd fallback)
  - "build a discord bot" → "discord-bot"

### Docs

- `docs/status/current.md` — Recent Work entry for Phase 6.
- `docs/sysflow-improvement/14-complete-gap-checklist.md` — add a "Scaffolder-first project initialisation" entry under the Phase 1–4 additions section.

## Migrations / data

N/A. Scaffold registry lives in code; no on-disk data. Per-run `scaffoldChoices` Map continues to live in memory (cleared on terminal states).

## Hooks / skills / settings to update

N/A. The new code rides on the existing permission system (`run_command` defaults to `ask`) and the existing pre-flight reasoning system.

## Dependencies

- No new npm packages.
- No new env vars. (We could add a `prompt.scaffold_first_enabled` flag for safety; default `true`. Cheap to add given the Phase 4 flag system.)

## Risks & mitigations

- **Scaffolder regressions / dead URLs / changed flags** — `npx create-next-app@latest` etc. evolves; flags can break. → Pin recommended versions where possible (e.g. `npx --yes create-next-app@14.x.x`); keep the agent's customise pass tolerant of slight scaffold output differences (read package.json before assuming structure).
- **Scaffolders are interactive** despite our flags — some prompt for "TypeScript? (y/n)" even with `--ts`. → All registry commands include the `--yes` / `-y` / `--non-interactive` equivalents. The CLI's existing `INTERACTIVE_PATTERNS` detection in `executor.ts` handles the fallback gracefully.
- **User wanted a different stack than the recommender picked** — e.g. user said "react app" meaning Next, not Vite. → Reasoning brief is rendered in the CLI BEFORE the scaffold runs. The user can `Ctrl+C` and re-prompt with the right stack name. Future improvement: add a "scaffold-confirm" step for HIGH-confidence cases under a flag (default off, on for power users).
- **Scaffolder fails (network, permission, broken CLI)** — → On failure, `tool-result.ts` already routes through the bug pipeline (Phase 5 on-error trigger). Bug pipeline gets the failed command + stderr and proposes either retry-with-different-flags or fall-back-to-hand-write. Recovery is automatic.
- **The agent re-creates files the scaffolder already produced** — wasted work + potential conflicts. → New post-scaffold context injection (in `tool-result.ts`) explicitly says "Do NOT recreate files the scaffolder produced. Read package.json first."
- **Prompt rewrite changes existing agent behaviour for non-scaffold runs** — → The new COMMANDS section is additive; the long-running-commands ban + migration deferral remain. The only thing removed is the `NEVER run npx X init` line that was wrong.
- **`scaffold-options.ts` deletion breaks imports** — handlers import `parseScaffoldResponse`, etc. → Phase 6 ships compatibility shims in `scaffold/legacy-shims.ts`. Imports get rewired in the same commit; nothing breaks.
- **autoTrust skips a confirmation the user expected** — → autoTrust requires HIGH confidence + a single registry match. Anything ambiguous still asks. Plus the reasoning brief is on screen before the scaffolder fires.

## Implementation order

Each step compiles green and is independently revertable.

1. **Scaffold registry + project name extractor** — `scaffold/registry.ts`, `scaffold/project-name.ts`. Pure data + pure regex; no callers yet. Tests for both.
2. **Scaffold recommender** — `scaffold/recommender.ts`. Pure function over `(implementBrief, cwd, directoryTree)`. Tests for the recommendation matrix.
3. **Legacy shims + index** — `scaffold/legacy-shims.ts` re-implements the three existing functions (`detectScaffoldingNeed`, `parseScaffoldResponse`, `buildScaffoldConfirmationMessage`) on top of the new registry. `scaffold/index.ts` barrel exports. Compiles + ready for swap-in.
4. **Swap import sites** — `handlers/user-message.ts` and `handlers/tool-result.ts` import from `scaffold/legacy-shims.ts` (or `scaffold/`) instead of `services/scaffold-options.ts`. Delete the old file.
5. **Wire reasoner-driven recommender** — in `handlers/user-message.ts`, after `runReasoning` returns and before the existing scaffold-options call, run `recommendScaffold(brief, cwd, directoryTree)`. If `shouldScaffold && autoTrust`, build a `NormalizedResponse` directly with the scaffold command and skip the model call. Otherwise fall through to the existing flow.
6. **Post-scaffold guidance + auto-install hint** — `handlers/tool-result.ts` detects the scaffold command in the recent action history and injects the post-scaffold context (read package.json, run npm install, don't recreate files).
7. **Rewrite COMMANDS prompt section** — `prompt/sections/task-guidelines.ts` + `prompt/sections/tools.ts`. The contradiction with scaffold-options is gone.
8. **Docs + checklist update** — `docs/status/current.md` + gap checklist.

## Verification

- **Compile:** `tsc --noEmit` clean in both packages.
- **Tests:** `npm test` in `server/` adds ~12 new cases (recommender matrix + registry well-formedness + project-name extraction).
- **Manual smoke:**
  - `sys "create a react app for a todo list"` in an empty directory → reasoning brief renders showing React+Vite + HIGH confidence; `npm create vite@latest todo-list -- --template react-ts` runs without a user prompt; permission system asks once for `npm install`; agent then customises App.tsx etc. for a todo list. **No 15 hand-written config files.**
  - `sys "build a discord bot"` in an empty directory → reasoning brief picks Discord.js (no scaffolder in registry); falls back to hand-writing the minimal file set (package.json, index.ts, .env.example).
  - `sys "add a button to the navbar"` in an existing React project → scaffold check sees > 2 files, returns `shouldScaffold: false`; agent reads + edits Navbar.tsx as today.
  - `sys "create a fullstack thing with react and express"` → reasoning brief is MEDIUM confidence (React has scaffolder, Express doesn't, ambiguous); falls back to the existing multi-candidate `waiting_for_user` flow.
- **Audit trail:** `<sysbasePath>/audit.jsonl` shows the scaffold + npm install commands with their `_errorCategory: null` (success path).

## Follow-ups (out of scope this session)

- **Multi-package monorepo scaffolds** (yarn/pnpm workspaces, Turborepo, Nx) — separate plan; needs a "compose multiple scaffolders" orchestrator.
- **Pinning scaffolder versions per registry entry** — track upstream releases; auto-bump via Renovate.
- **CLI override** for the auto-trust threshold (`/scaffold-confirm always` for cautious users).
- **Pure-prompt scaffold templates** — for stacks without a canonical scaffolder, ship Sysflow-internal templates (e.g. `sysflow-discord-bot-template`) that get cloned via `git clone` instead of hand-written. Faster than file-by-file.
- **File restructure** (the originally-promised next plan) — now genuinely next, after this lands.

## Completion notes

Implemented 2026-05-02. All 8 ordered steps executed in sequence and pushed as separate feature/refactor commits.

**Deviations from the plan:**

- The registry grew from "15+" to **22** stacks during step 1; included Preact, Lit, Vite-vanilla, Qwik, Electron-Vite, Bun-init, Rails on top of the originally listed set. Easy expansion since each entry is ~6 lines of data.
- The `orchestrator.ts` file the plan called for was folded directly into `handlers/user-message.ts` (the auto-trust path is ~20 lines; a separate file would have been over-architecture for a single call site). The post-scaffold guidance lives there too. If a second caller appears later (e.g. a CLI-side scaffold preview), it can be extracted then.
- Project-name extractor's stopword list ended up larger than planned to handle phrases like "build me a portfolio site for jane" (drops "for jane" + "build" + "me" + "site").
- `recommender.ts` `collectTokens()` adds a user-message backfill list for common stack aliases (next.js / nestjs / tauri / etc.) — the reasoner sometimes under-lists frameworks in `recommendedStack`, and the user's literal mention is more reliable.
- The "auto-install npm install via the permission system" was implemented as guidance injection (the agent then issues run_command for `npm install`, which the existing permission gate handles). No new code path was needed in the executor.

**Surprises:**

- The scaffold pattern detection regex needed `npx --yes` recognition because all our registry commands include it for non-interactive runs. Without that, post-scaffold guidance wouldn't fire.
- Astro's create command supports more flags than I expected (`--template minimal --typescript strict --install --git no`); pre-baking these eliminates the interactive prompt that other registry entries don't have.
- `findScaffoldersByTerms` deduplicates per-entry — important because a brief mentioning both 'react' AND 'vite' was double-listing react-vite. The dedup is via Set on stackKey.

**Knowledge to capture (next pass):**

- "Scaffold-first vs hand-write decision: HIGH confidence + single registry match → auto-trust" → `.claude/knowledge/decisions.md`.
- "Two-place post-scaffold guidance (pre-injected before scaffold + post-detected after)" → `.claude/knowledge/patterns.md`.
- "Pre-bake non-interactive flags in the registry instead of teaching the model each scaffolder's CLI surface" → `.claude/knowledge/decisions.md`.
