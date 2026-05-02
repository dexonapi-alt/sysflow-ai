# Sysflow Phase 3 — Capabilities

- **Created:** 2026-05-02
- **Status:** implemented (2026-05-02)
- **Scope:** Make the tool layer first-class: typed input schemas, structured validation errors going back to the model, a real permission system with modes + per-tool gates, and a hook registry that can override permissions, prevent execution, or inject context.

## Goal

Replace ad-hoc string-pattern validation in `executeToolLocally` with declared Zod schemas; add a permission system the user can drive (allow/deny/ask, plus mode-level defaults); and ship a hook registry so future features (audit logs, plan mode, MCP) can plug in without surgery on the executor.

## Context from knowledge base

`.claude/knowledge/` is still empty. Canonical references:

- `docs/sysflow-improvement/03-tool-system.md` — Zod input/output schemas, `buildTool` factory, `validateInput`, `checkPermissions`, tool flags. Phase 3 lands input schemas + checkPermissions + the validation pipeline; output schemas, the full `buildTool` factory, and MCP tools stay deferred.
- `docs/sysflow-improvement/04-error-handling.md` — `classifyToolError` taxonomy with `validation` and `permission` categories. Phase 2 added the classifier; Phase 3 wires the validation/permission paths into the new categories with their own dedicated hints.
- `docs/sysflow-improvement/08-permissions-safety.md` — multi-mode permission system, per-tool checks, allow/deny/ask, persistent rules, glob-based deny patterns.
- `.claude/plans/applied/2026-05-02-phase-2-foundation.md` — added `tool-meta.ts` (concurrency flags) and `tool-error-classifier.ts`. Phase 3 extends both: tool-meta gains a `permissionGate` field; the classifier gains explicit recognition for the new structured errors.

## Affected files

### CLI — Zod schemas + validation pipeline

- `cli-client/package.json` — add `zod ^3.23.x` (single small dep, runtime + types in one).
- `cli-client/src/agent/tool-schemas.ts` *(new)* — one Zod schema per tool: `read_file`, `batch_read`, `list_directory`, `file_exists`, `create_directory`, `write_file`, `edit_file`, `move_file`, `delete_file`, `search_code`, `search_files`, `run_command`, `web_search`, `batch_write`. Each schema enforces required + optional fields; `edit_file` uses `z.union` to express the four valid edit shapes (search/replace, line edit, insert, full patch).
- `cli-client/src/agent/validate-tool-input.ts` *(new)* — `validateToolInput(tool, args)` returns `{ ok: true, args: ParsedArgs } | { ok: false, error: ValidationError }`. ValidationError carries the tool name, the field path that failed, the expected shape (`schema.shape` summary), and a recovery hint string suitable for the model.
- `cli-client/src/agent/executor.ts` — the manual `if (!args.path)` blocks at the top of `executeToolLocally` are replaced by `validateToolInput(tool, args)`. On `ok: false` the function returns `{ error, success: false, _errorCategory: 'validation', _validation: { tool, field, expected } }` instead of the legacy string error.

### CLI — Permission system

- `cli-client/src/agent/permissions.ts` *(new)* — `PermissionMode = "default" | "auto" | "plan" | "bypass"`, `PermissionDecision = "allow" | "deny" | "ask"`, `Rule = { tool, pattern?, decision }`. `checkPermissions({ tool, args, mode, rules })` consults rules first (longest-pattern-wins glob match), then per-tool defaults, then mode defaults. Persistent rules read/written to `<sysbasePath>/permissions.json`.
- `cli-client/src/agent/tool-meta.ts` — extend `ToolMeta` with `defaultPermission: 'allow' | 'ask' | 'deny'`. Read tools default to `allow`; write tools and `run_command` default to `ask`; `delete_file` defaults to `ask`.
- `cli-client/src/cli/permission-prompt.ts` *(new)* — interactive `await askPermission(decision, ctx)` renders a small box with the tool + args + a 4-option prompt: `[a]llow once`, `[A]llow always for this tool/path`, `[d]eny once`, `[D]eny always`. The "always" choices append a rule to `permissions.json`.
- `cli-client/src/agent/executor.ts` — call `checkPermissions(...)` after validation, before tool execution. On `deny`, return `{ error, success: false, _errorCategory: 'permission' }`. On `ask`, prompt the user; cache the answer for the rest of the run unless the user selects "always".
- `cli-client/src/lib/sysbase.ts` — add `getPermissionMode()` and `setPermissionMode()` (reads/writes the mode to `<sysbasePath>/config.json` next to the existing model preference).
- `cli-client/src/commands/permissions.ts` *(new)* — `/permissions` slash command lists active rules and lets the user remove or toggle them.
- `cli-client/src/cli/parser.ts` — register `/permissions` and `/mode <name>` commands.
- `cli-client/src/cli/ui.ts` — wire the new commands into `processInput`.

### CLI — Hook registry

- `cli-client/src/agent/hooks.ts` *(new)* — `HookContext`, `Hook = (ctx) => HookResult | Promise<HookResult>`, `HookResult = { override?: PermissionDecision, prevent?: boolean, context?: string }`. Hooks register against named events: `pre_tool_use`, `post_tool_use`, `post_tool_use_failure`. `runHooks(event, ctx)` runs all registered hooks in registration order; first non-`undefined` `override` wins.
- `cli-client/src/agent/executor.ts` — call `runHooks('pre_tool_use', ...)` after validation but before permission check; an override here can skip the permission prompt. After execution, run `post_tool_use` (success) or `post_tool_use_failure` (error).
- `cli-client/src/agent/builtin-hooks.ts` *(new)* — built-in hooks shipped enabled by default: an audit-log hook that appends each tool call to `<sysbasePath>/audit.jsonl`, and a secrets-block hook that denies `write_file`/`edit_file` whose `path` matches `.env*` or `*.pem` unless the user has explicitly allowed it.

### Server — error code passthrough

- `server/src/services/tool-error-classifier.ts` — recognise new `_errorCategory` field already attached by the CLI executor, so the server's classifier short-circuits to that category instead of re-deriving from the error string.
- `server/src/handlers/tool-result.ts` — when the incoming tool result has `_errorCategory: 'validation'` or `'permission'`, surface a slightly different recovery hint (specifically: tell the model the request was rejected on a structural ground, not because the underlying file was wrong).

### Docs

- `docs/status/current.md` — Recent Work entry for Phase 3.
- `docs/sysflow-improvement/14-complete-gap-checklist.md` — check off Tool System (Zod input schemas, validateInput hook), Permissions & Safety (mode system, checkPermissions, allow/deny/ask, interactive prompt, persistent rules), Tool System (hook system).

## Migrations / data

N/A. New on-disk artifacts: `<sysbasePath>/permissions.json`, `<sysbasePath>/audit.jsonl`. Both are append-only/idempotent and live under sysbase, which is already gitignored.

## Hooks / skills / settings to update

`<sysbasePath>/config.json` gains a `permissionMode` field. Existing config files without it default to `"default"`.

## Dependencies

- New npm package: `zod ^3.23` in `cli-client/`. Server doesn't need it (validation runs client-side; the server already trusts the client to validate).

## Risks & mitigations

- **Zod adds cold-start cost.** → 3.23+ is < 50 KB minified gzipped; 12 small schemas parse in microseconds. Acceptable.
- **Permission prompts block automation.** → `auto` and `bypass` modes exist for non-interactive runs; rules cached in `permissions.json` so the user only confirms once per pattern.
- **Hooks introduce action-at-a-distance debugging.** → Hook results include a `source` field (which hook overrode/prevented) that's logged on every execution. `runHooks` is small and synchronous-by-default.
- **Existing manual validation in executor produced specific error messages models had learned.** → Validation error format includes the tool's expected shape (`expected: { path: string, content: string, ... }`), so models still get actionable feedback.
- **`audit.jsonl` grows unbounded.** → Best-effort append, no rotation in this plan; sysbase is per-project and disposable. Rotation is a Phase 4 follow-up.
- **Secrets-block hook may flag false positives** (legitimate `.env.example` writes). → It allows `.env.example` and any path matching `*.example` explicitly.

## Implementation order

Each step compiles green and is independently revertable. Steps 1–3 are validation, 4–6 are permissions, 7 is hooks, 8 is docs.

1. **Add Zod dependency + schemas** — `npm install zod` in `cli-client/`, write `tool-schemas.ts`, write `validate-tool-input.ts`. Pure addition — no caller changes yet.
2. **Wire validation into executor** — replace the manual `if (!args.path)` blocks with `validateToolInput(tool, args)`. On failure return `{ _errorCategory: 'validation' }`.
3. **Server classifier passthrough** — `tool-error-classifier.ts` reads `_errorCategory` if present and short-circuits; `enrichSingleError` uses the new category for hint selection.
4. **Permission types + checker** — `agent/permissions.ts` with the type + `checkPermissions(...)`. No call site yet.
5. **Permission prompt + slash commands** — `cli/permission-prompt.ts`, `commands/permissions.ts`, `parser.ts` and `ui.ts` registrations. Add mode persistence to `sysbase.ts`.
6. **Wire permissions into executor** — call `checkPermissions` after validation; handle `ask` via the new prompt; cache run-scoped answers.
7. **Hook registry + built-ins** — `agent/hooks.ts`, `agent/builtin-hooks.ts`, executor invocations at `pre_tool_use` / `post_tool_use` / `post_tool_use_failure`.
8. **Docs + checklist update.**

## Verification

- **Compile:** `tsc --noEmit` clean in both `cli-client/` and `server/`.
- **Manual smoke:**
  - Trigger a deliberately bad tool call (e.g., `edit_file` with no `path`) — confirm the model receives `_errorCategory: 'validation'` and the hint includes the expected shape.
  - Run a `write_file` to `package.json` in default mode — confirm the permission prompt appears with allow/deny/always options.
  - Pick "Allow always" — confirm `<sysbasePath>/permissions.json` gets a new rule and the next prompt for the same tool/path is auto-allowed.
  - Switch to `bypass` mode (`/mode bypass`) — confirm the next write skips the prompt.
  - Verify `<sysbasePath>/audit.jsonl` grows by one line per tool call.
  - Try writing to `.env` — confirm the secrets-block hook denies it; writing to `.env.example` is allowed.
- **Out-of-scope confirmation:** plan-mode tool, multi-agent coordinator, MCP tools, Zod *output* schemas all stay deferred.

## Follow-ups (Phase 4)

- Plan-mode tool (`EnterPlanMode` / `ExitPlanMode`) + plan-mode model routing.
- Feature flag system (env-driven + per-user override).
- Background task system + token-budget tracking per task.
- Initial test suite seeded from this phase's pure modules.
- Audit-log rotation.

## Completion notes

Implemented 2026-05-02. All 8 ordered steps executed in sequence, pushed as 8 separate feature/refactor commits.

**Deviations from the plan:**

- Slash commands wire through the existing `parser.ts` / `ui.ts` shape (added `permission-mode` and `permissions` modes) rather than a new "command registry." Keeping the convention is cheaper than refactoring for this small surface.
- The hook registry didn't grow a third party loader (`.claude/hooks/`); it ships only the two built-in hooks for now. External hook loading is a Phase 4 follow-up that pairs with the feature-flag system.
- `executeToolLocally` was split into a lightweight wrapper plus a private `dispatch()` function. This gives a single return path for post-hooks without rewriting every case branch — a smaller refactor than the plan's "thread post-hooks through every case" implication.
- Audit-log rotation deferred to Phase 4. `audit.jsonl` grows unbounded today; sysbase is per-project and disposable so this is acceptable short-term.

**Surprises:**

- Zod 3.23's discriminated unions don't error well when *no* branch matches (you get a flat list of issues from each branch). The plan called for a `z.discriminatedUnion`, but `edit_file`'s shapes don't share a common discriminator field, so a plain `z.union` was used with a separate `expected: "one of: { path, search, replace } | ..."` description for the model.
- The `audit.jsonl` redactor needed a 200-char threshold; the previous default of 80 chars was too aggressive for things like search queries with regex.
- Adding `defaultPermission: 'allow'` on `create_directory` is the right call — denying it would block scaffolding flows the user clearly intended. `delete_file` stays `ask` because it's destructive and not always recoverable from snapshot.

**Knowledge to capture (next pass):**

- "Per-event hook registry with first-override-wins ordering" pattern → `.claude/knowledge/patterns.md`.
- "Decision: trust client-set _errorCategory on the server" → `.claude/knowledge/decisions.md`.
- "Glob matcher is hand-rolled; doesn't support character classes" → `.claude/knowledge/gotchas.md`.
