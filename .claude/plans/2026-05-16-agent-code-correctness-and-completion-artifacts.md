# Agent code-correctness gate + completion-artifact enforcement

- **Created:** 2026-05-16
- **Status:** in-progress
- **Scope:** Stop the agent from declaring a run "complete" when the code it wrote doesn't compile, has missing imports, omits required prompt-implied artifacts (schema, migrations), or violates Node ESM rules. Fixes the user-reported repro where `sys` "built" a POS backend that crashed on every `npm run dev` with cascading `ReferenceError` / `ERR_MODULE_NOT_FOUND` / `SyntaxError` failures because the verification gate only ran on `.js` files and the system prompt had no Node-ESM rules.

## Goal

User report (2026-05-16):

> *"the WHOLE IMPLEMENTATION IS GOOD BUT THE IMPORTS ARE LITERALLY MISSING"* — `ReferenceError: authRoutes is not defined` at runtime, fixed only after manual editing.
>
> *"IT ALSO DIDN'T KNOW how to import in JS like it only have `import pool from '../config/db'`; instead of `import pool from '../config/db.ts'`;"* — `ERR_MODULE_NOT_FOUND` on every relative import.
>
> *"IT CONSIDER THE TYPESCRIPT TYPE AS NORMAL IMPORT WHILE ITS JUST A TYPE!"* — `Named export 'NextFunction' not found. The requested module 'express' is a CommonJS module…`. Same bug for `ValidationChain`.
>
> *"does not provide an export named 'default'"* — `import errorHandler from './middleware/errorHandler.ts'` against a file that uses `export const errorHandler` (named, not default).
>
> *"IT DIDNT EVEN CREATE THE DATABASE, THE DATABASE SCHEMA"* — agent claimed `"Database schema creation is a manual step for the user"` in its completion summary even though the user prompt was *"Build a clean and scalable Express.js POS backend"*.

These are not deep-learning bugs — they're **missing gates**. The verification-gate's `checkNodeSyntax` runs `node --check` only on `.js/.mjs/.cjs` (skipping `.ts`), so type-import mistakes never get caught. The import-sanitizer silently strips bad imports without telling the agent, leaving a file that uses unimported names. The completion-guard doesn't check whether the prompt implied artifacts (schema files, migrations) were actually produced. And the system prompt has zero Node-ESM rules teaching the model what valid TS-on-ESM imports look like.

End state — for the SAME prompt:

- Agent attempts to write `src/index.ts` with `import errorHandler from './middleware/errorHandler.ts'` against a file using named export → **pre-write validator rejects**, returns a diagnostic to the agent forcing it to fix the import OR change the source's export.
- Agent attempts `import { NextFunction } from 'express'` → **rejected** with hint *"NextFunction is a TypeScript type; use `import type { NextFunction } from 'express'`"*.
- Agent forgets the `.ts` extension on a relative import → **rejected** with hint about ESM extension requirement.
- Agent calls completion → **`tsc --noEmit` runs on every authored `.ts` file**; any error blocks the completion + injects the error list back to the agent.
- Prompt mentions PostgreSQL → **completion-guard refuses to declare done** until `schema.sql` (or a migration file) exists.
- import-sanitizer logs are **surfaced to the model** as a `[STRIPPED IMPORT]` block — not silent.

## Context from knowledge base

- `architecture.md: ## Forced error reasoning + recovery` — the four-net pattern (chain → inject → reject → memory) is the template. Stage 3 of this plan reuses INJECT (block tsc errors into the next prompt) + REJECT (refuse completion).
- `decisions.md: ## System-level enforcement beats prompt-level guidance for free models` — load-bearing. Telling the model "remember to use `import type` for types" doesn't work on free-tier; we have to mechanically reject the wrong shape and feed the diagnostic back.
- `decisions.md: ## 0-hit web search is a recovery situation, not a success` — same shape. A failing `tsc --noEmit` is a recovery situation, not a success.
- `gotchas.md: ## Agent demanded tsconfig.json in empty directory and hard-stopped on 0-hit web search` — adjacent failure mode; same agent loop.
- `applied/2026-05-15-free-tier-quality-enforcement.md` — Stage 1's verify-after-write injector is the template for Stage 3's tsc-gate inject.

## Affected files

### Stage 1 — Node ESM + TypeScript rules in the system prompt

- `server/src/providers/prompt/sections/task-guidelines.ts` (or new `node-esm-rules.ts`) — append a NODE-ESM-AWARE TS RULES block covering:
  1. **Always include the file extension on relative imports.** TS-on-ESM (the modern default for new projects) requires `import x from './foo.ts'` not `import x from './foo'`. CJS/Webpack older projects skip this; the agent must check `package.json: "type": "module"` or `tsconfig.json: "moduleResolution": "NodeNext"` to decide.
  2. **`import type` for type-only imports.** Anything that's purely a type (`Request`, `Response`, `NextFunction`, `ValidationChain`, generic param constraints) must use `import type { … } from 'pkg'` when the source module is CommonJS — otherwise ESM runtime fails because CJS modules don't expose named type re-exports.
  3. **Default vs named exports.** Before importing `default from './file'`, verify the source file uses `export default`. If the file uses `export const X`, use `import { X } from './file'`. The agent must read or grep the target file's exports before writing the import.
  4. **Bare-package imports require the dep in `package.json`.** Don't `import express from 'express'` until `package.json` has `"express"` in dependencies (the prior PR #93's project-init investigation plan should cover this for fresh scaffolds; this rule reinforces it).
  5. **Forward-reference rule.** Don't write a consumer file (e.g. `src/index.ts`) that imports producers (e.g. `./routes/auth`) until the producers exist. If a batch creates both, list the producers FIRST in the batch.
- `server/src/providers/prompt/build.ts` — wire the new section if it lives in its own file. Cacheable (rules are static across runs).
- 6-8 new tests verifying the section renders + that key examples (`import type`, `.ts` extension) appear verbatim.

### Stage 2 — Make `import-sanitizer` LOUD, not silent

- `server/src/services/scaffold-validator.ts` (where `[import-sanitizer] Stripped bad import …` originates) — modify `validateImports()`:
  - Currently: strips the bad import, returns the cleaned content, logs to server console.
  - New: returns `{ cleanedContent, strippedImports: string[] }`. The handler injects a `═══ IMPORTS STRIPPED ═══` block into the next provider payload (via `actionPlanner.injectContext`) listing each stripped import + the source file + the recovery instruction:
    ```
    ═══ IMPORTS STRIPPED — YOU REFERENCED FILES THAT DON'T EXIST ═══

    In src/index.ts, you imported:
      - "./middleware/errorHandler" (file does not exist)
      - "./routes/auth" (file does not exist)

    These imports were STRIPPED before writing the file to disk. The file you wrote no longer compiles correctly — it uses these names elsewhere without importing them.

    REQUIRED for next turn:
    1. Either create the missing files in your next batch (preferred — they're real intent)
    2. OR remove the usages of those names from src/index.ts (rare — only if you meant something else)

    Do NOT proceed past this without addressing it.

    ═══ END IMPORTS STRIPPED ═══
    ```
- `server/src/handlers/tool-result.ts` — when `validateImports` returns a non-empty `strippedImports`, fire the inject (one-shot, consumed on the next adapter call).
- 6 new tests for the inject content + handler wiring.

### Stage 3 — Pre-completion `tsc --noEmit` gate on `.ts` files

- `server/src/services/verification-gate.ts` — extend `checkNodeSyntax` (currently skips `.ts`) to run `npx --no-install tsc --noEmit` on the project root when any `.ts` file was authored this run. Gracefully degrade when `tsc` isn't installed (note in result; don't block).
- `server/src/services/completion-guard.ts` — new `requireCleanTsc` predicate: when the run wrote `.ts` files AND the project has a `tsconfig.json`, completion is gated on `tsc --noEmit` returning zero errors. On failure, the diagnostics are injected as a `═══ TYPECHECK FAILED — FIX BEFORE COMPLETION ═══` block + the completion request is rejected (returned as `needs_tool` with the inject as context).
- `server/src/handlers/tool-result.ts` — wire the gate at the completion-detection point (before `mapNormalizedResponseToClient` returns `completed`).
- New flag `quality.precompletion_tsc_gate_enabled` (default `true`).
- 8-10 new tests: gate fires on type errors; passes on clean tsc; degrades gracefully when tsc isn't installed; respects the flag off-switch.

### Stage 4 — Prompt-implied completion artifacts (DB schema, migrations, tests)

- `server/src/services/completion-guard.ts` — new `requireImpliedArtifacts(prompt, writtenFiles)` predicate. Scans the original user prompt for keywords:
  - `postgres` / `postgresql` / `pg` / `mysql` / `sqlite` / `mongo` → require at least one of: `**/*.sql`, `**/schema.{sql,prisma,js,ts}`, `**/migrations/**/*`.
  - `prisma` → require `prisma/schema.prisma`.
  - `test` / `tests` / `testing` (when standalone in the prompt, not in package names) → require at least one `**/*.test.{ts,js}` OR `**/*.spec.{ts,js}`.
  - `auth` (in noun position, not "authenticate") + `passwords` → require a hashing utility import (`bcrypt` / `argon2` / `scrypt`) in any auth file.
- When an implied artifact is missing, completion is blocked + the agent gets an inject:
  ```
  ═══ COMPLETION BLOCKED — PROMPT-IMPLIED ARTIFACT MISSING ═══

  The user's prompt mentioned "PostgreSQL" but no schema / migration file was written.

  Required: create a `schema.sql` (or `migrations/001_initial.sql`) with the DDL for the tables
  the application uses. The agent's job for a "build me a backend" prompt includes the schema —
  saying "manual step for the user" is NOT acceptable when the prompt explicitly named the DB.

  Do NOT declare complete without writing the schema.

  ═══ END COMPLETION BLOCKED ═══
  ```
- New flag `quality.completion_artifact_check_enabled` (default `true`).
- 10-12 new tests: schema-missing on PG prompt → block; schema-present → pass; passes when prompt didn't mention DB; off-switch.

### Stage 5 — Telemetry + KB + plan archive

- `cli-client/src/agent/usage-log.ts` — `RunSummary` gains:
  - `tscErrorCount: number` (per-run count of `tsc --noEmit` errors caught by Stage 3)
  - `importsStrippedCount: number` (per-run count of stripped imports from Stage 2 — spike = LLM still emits forward references)
  - `completionBlockedReason: string | null` (which Stage 4 predicate blocked, if any)
- KB:
  - `architecture.md: ## Code-correctness gates` — diagram of Stage 1+2+3+4 composition; how each gate composes with prior INJECT/REJECT patterns.
  - `decisions.md: ## tsc --noEmit is a completion gate, not a hint` — why this is mechanical enforcement, not prompt advice.
  - `decisions.md: ## Prompt-implied artifacts (schema, tests) are mandatory, not suggested` — rationale.
  - `gotchas.md: ## Agent shipped a POS backend with cascading ESM import failures` — canonical repro from the user.
- Plan archived to `applied/`.

## Migrations / data

None. All changes are gates that read existing files. `RunSummary` field additions are additive.

## Hooks / skills / settings to update

- `quality.precompletion_tsc_gate_enabled` (bool, default `true`)
- `quality.completion_artifact_check_enabled` (bool, default `true`)
- `quality.import_sanitizer_loud_enabled` (bool, default `true`) — Stage 2 kill switch

## Dependencies

- No new npm packages.
- Stage 3 invokes `npx tsc` which is a peer dep of the user's project. Degrades gracefully when absent.

## Risks & mitigations

- **`tsc --noEmit` is slow on large projects (multi-second).** Mitigation: only fires when `.ts` files were authored THIS run AND `tsconfig.json` exists. For project-init runs the cost is acceptable (one tsc run before completion). Telemetry on `tscErrorCount` informs if we need a faster check (e.g. swc-checker).
- **Stage 4's keyword heuristic over-fires.** Mitigation: confidence-aware — only block when keyword is unambiguous (`postgres` in a noun-class context, not in "your-prompt-engineering-postgres-something"). The block surfaces a hint, not a hard refusal — the agent can write a minimal schema in one batch + retry completion.
- **import-sanitizer LOUD spam.** Mitigation: one inject per run (latched), only fires when strip count > 0.
- **Stage 1 prompt section bloats the system prompt.** Mitigation: section is cacheable so it doesn't hit per-turn token budget. Live tuning via the cacheable-prompt cache invalidation.
- **The agent ignores the typecheck inject (already known free-tier failure mode).** Mitigation: Phase 4 of forced-error-reasoning already shipped the reject loop — typecheck failures plug into the same loop (typecheck error → inject → if next response doesn't acknowledge OR tries to "complete" anyway → reject + re-call).

## Implementation order

1. **Stage 1 — Node ESM + TS rules in prompt.** Foundation. Pure prompt change. Smallest blast radius. *(One PR.)*
2. **Stage 2 — Loud import-sanitizer.** Adds the inject; reuses `actionPlanner.injectContext`. *(One PR.)*
3. **Stage 3 — tsc gate on completion.** The biggest impact — catches the cascading runtime failures from the user's repro. *(One PR.)*
4. **Stage 4 — Implied-artifact completion gate.** Catches the "Database schema is a manual step" failure mode. *(One PR.)*
5. **Stage 5 — Telemetry + KB + plan archive.** *(One PR.)*

Each stage = one PR off `main`. ~1,500 LOC + 30-40 new tests across the five stages.

## Verification

**Stage 1**

- Unit: `task-guidelines` / `node-esm-rules` section renders the 5-rule block verbatim. `tests/prompt-sections.test.ts` regex against the rendered block.
- Manual: run `sys` on an empty TS-ESM project — observe the agent's first writes include `.ts` extensions on relative imports and `import type` for type imports.

**Stage 2**

- Unit: `validateImports` returns `strippedImports[]`; handler injects the block when count > 0; one-shot (consumed on next call).
- Manual: write a file with a bad relative import on purpose — observe the `═══ IMPORTS STRIPPED ═══` block in the next tool-result body.

**Stage 3**

- Unit: gate fires on a synthetic tsc error; passes on clean tsc; degrades when tsc binary missing; respects the flag.
- Manual: scaffold a TS project with intentional type errors — observe completion blocked + agent retries fixing the errors before declaring done.

**Stage 4**

- Unit: schema-missing on PG prompt blocks; schema-present passes; passes when prompt didn't mention DB; off-switch.
- Manual: re-run the user's POS backend prompt — observe the agent writes `schema.sql` before declaring done.

**Stage 5**

- Telemetry: `tscErrorCount`, `importsStrippedCount`, `completionBlockedReason` populate per-run in `usage.jsonl`.
- KB entries lint cleanly.
- Server + cli test suites green.

## Out of scope

- **Running the user's project (`npm run dev`) to verify it boots.** Too risky — could start servers, expose ports, run install scripts. The tsc gate catches structural errors; runtime errors are a future plan.
- **Auto-fixing the typecheck errors without model agreement.** Same principle as forced-error-reasoning: the gate surfaces the diagnostic; the model decides.
- **Migrations beyond initial schema** (Stage 4 only requires schema OR migration on PG prompts).
- **Cross-language scaffolds (Python / Rust / Go).** This plan targets Node + TS — the dominant stack in observed runs. Future stages can mirror for other languages.

## Composition with existing systems

- **Forced-error-reasoning plan** (applied 2026-05-15) — typecheck failure goes through the same chain → inject → reject pipeline. No new mechanism.
- **Agent-runtime-fixes plan** (applied 2026-05-15) — Stage 4's per-turn directory refresh now sees newly-created schema files; the working context knows they exist.
- **Phase 11 awareness** — `intent_keyword_absent` heuristic improvement in plan `2026-05-16-awareness-and-verification-correctness.md` will reduce false positives that today fire alongside legitimate completions.
