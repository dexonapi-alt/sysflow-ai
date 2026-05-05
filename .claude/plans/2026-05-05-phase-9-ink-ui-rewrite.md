# Phase 9 — Ink-based UI/UX rewrite

- **Created:** 2026-05-05
- **Status:** in-progress
- **Scope:** Replace the cli-client's `console.log` + `readline` rendering with an Ink (React-for-terminal) component tree so the UI updates in place, animates properly, and feels like a real product — closing the polish gap with Claude Code.

## Goal

The current CLI prints every status line as a new `console.log`, so the screen scrolls forever and nothing updates in place. The chat input is plain readline (no history, no multiline, ANSI-prompt issues on Windows). The spinner is a generic `ora` "thinking..." that lives forever after completion. The permission prompt fights with the spinner. Migrate the entire rendering layer to Ink so we get: live in-place re-rendering, real component encapsulation, custom animations, multiline input, and a foundation we can polish without bolt-on hacks.

The agent / executor / server logic stays untouched — this is purely a rendering-layer rewrite.

## Context from knowledge base

- `.claude/plans/applied/2026-05-02-phase-1-reasoning-and-cli-ux.md` — the original CLI UX pass that split agent.ts into renderer/state-machine/retry. The renderer split is what we're now replacing wholesale.
- `.claude/knowledge/architecture.md` — confirms cli-client is the user-facing layer; server stays the same.
- Reference: `C:\Users\DevAPI\Desktop\Projects\github clones\claude-code` — leaked Claude Code source (Ink-based, ~100 components in `src/components/`). Patterns we'll borrow: `Spinner.tsx` (verb cycling + shimmer), `TaskListV2.tsx` (live list), `StructuredDiff.tsx` (diff as component), `PromptInput/` (multiline input with history).

## Affected files

### New files (cli-client/src/ui/)
- `cli-client/src/ui/App.tsx` — root Ink component, owns the global app state
- `cli-client/src/ui/state/store.ts` — minimal pub/sub store (keep external deps light: no Redux/Zustand)
- `cli-client/src/ui/components/Spinner.tsx` — animated spinner with cycling verbs
- `cli-client/src/ui/components/ChatInput.tsx` — multiline input, history (↑/↓), slash-command auto-suggest
- `cli-client/src/ui/components/StatusLine.tsx` — top status bar (model · user · chat · plan-mode)
- `cli-client/src/ui/components/AgentStream.tsx` — scrolling region of agent output
- `cli-client/src/ui/components/TaskList.tsx` — live ✔/▸/○ list
- `cli-client/src/ui/components/PermissionPrompt.tsx` — modal-style approval UI
- `cli-client/src/ui/components/StructuredDiff.tsx` — `+`/`-` diff rendered as a component
- `cli-client/src/ui/components/ToolStep.tsx` — single tool-call line (e.g. `▸ create src/app.js +16`)
- `cli-client/src/ui/components/CompletionSummary.tsx` — final box with file list, next steps
- `cli-client/src/ui/components/JobsBar.tsx` — pinned bottom bar for background jobs
- `cli-client/src/ui/hooks/useTerminalSize.ts` — re-render on resize
- `cli-client/src/ui/hooks/useAgentEvents.ts` — subscribe to the agent's event stream
- `cli-client/src/ui/hooks/useKeyboard.ts` — typed keypress handler with shortcut tables
- `cli-client/src/ui/theme.ts` — single source of colours + glyphs (replaces `cli/render.ts` constants)

### Existing files modified
- `cli-client/package.json` — add `ink`, `react`, `@types/react`, ink helpers (`ink-text-input`, `ink-spinner`, `ink-select-input` if useful), set up `tsx`/`tsconfig` for JSX
- `cli-client/tsconfig.json` — JSX support, React types
- `cli-client/src/index.ts` — switch entrypoint to render `<App>`
- `cli-client/src/agent/agent.ts` — replace `console.log`/`spinner.text =` calls with `agentEvents.emit(...)` events; keep all logic intact
- `cli-client/src/cli/permission-prompt.ts` — re-export `askPermission` that resolves via the new `<PermissionPrompt>` modal
- `cli-client/src/cli/diff-preview.ts` — Tab-to-expand becomes a component; keep the API shim for now
- `cli-client/bin/sys.js` — keep, the entry script just calls into src/index.ts as before

### Files we deliberately keep + don't touch (logic, not rendering)
- `cli-client/src/agent/executor.ts`
- `cli-client/src/agent/tools.ts`
- `cli-client/src/agent/permissions.ts`
- `cli-client/src/agent/state-machine.ts`
- `cli-client/src/agent/background-jobs.ts`
- All `cli-client/src/lib/*`
- All `server/**`

## Migrations / data

N/A — pure rendering change.

## Hooks / skills / settings to update

- `cli-client/.eslintrc` (if present) and `tsconfig.json` need JSX support.
- No `.claude/hooks/`, `.claude/settings.json`, or CI config changes.

## Dependencies

New runtime deps (cli-client):
- `ink` (latest)
- `react` (latest 18.x — Ink doesn't yet support React 19 fully)
- `@types/react`
- Optional: `ink-text-input`, `ink-spinner`, `ink-select-input` for fast builds, OR roll our own (Claude rolls its own; we'll do the same for the spinner since we want verb cycling).

No new server deps.

## Risks & mitigations

- **Ink doesn't render well on raw Windows cmd.exe.** → Test on Windows Terminal (the user's environment per gitStatus is win32). Document required terminal in README. Fall back gracefully on TERM != "dumb".
- **TSX compile in `tsx --watch` dev mode.** → tsx already supports JSX; just need the right tsconfig.
- **Big diff = hard to review.** → Land the migration in stages (this plan's "Implementation order"), each stage independently shippable. Don't break trunk.
- **Existing tests touch readline mocks?** → grep first; rewire any test fixtures that imported the old UI.
- **Ink + ora conflict.** → Remove `ora` from cli-client deps once `Spinner.tsx` lands.
- **Performance under high event rate.** → Use `<Static>` from Ink for past output (it doesn't re-render) and a small live region for the current step.

## Implementation order

Each stage is one PR. Stages 1 + 2 must land first; the rest can be reordered.

### Stage 1 — Foundation (this session)
1. Add `ink`, `react`, `@types/react` to `cli-client/package.json`; run `npm install`.
2. Update `cli-client/tsconfig.json` — `"jsx": "react-jsx"`, `"jsxImportSource": "react"`, include `*.tsx`.
3. Create `cli-client/src/ui/App.tsx` — minimal `<App>` shell that just renders the existing status line + a `<ChatInput>` placeholder.
4. Create `cli-client/src/ui/state/store.ts` — tiny pub/sub: `createStore<T>(initial)` returns `{ get, set, subscribe }`.
5. Create `cli-client/src/ui/theme.ts` — re-exports `colors` + `BOX` from `cli/render.ts` (so existing components keep working) plus new glyphs.
6. Behind a flag (`SYS_INK=1` env var) the entrypoint renders `<App>` via Ink; without the flag it falls through to the old `startUi()`. Lets us iterate without breaking trunk.
7. `npm run typecheck` clean. No tests needed yet — visual smoke test.

### Stage 2 — Chat input
1. `<ChatInput>` component: multiline (Shift+Enter for newline, Enter to submit), arrow-up/down for history, slash-command auto-suggest popup.
2. Replace the readline loop in `cli/ui.ts`'s `startUi()` with the new component when `SYS_INK=1`.
3. History persisted to `<sysbasePath>/chat-history.jsonl` (last 100 entries).
4. Test: paste a multi-line prompt, submit, check history with ↑.

### Stage 3 — Agent stream
1. `cli-client/src/agent/agent.ts` — replace direct `console.log`s with `agentEvents.emit(eventName, payload)`.
2. `useAgentEvents` hook — subscribes; pushes into a ring-buffer state.
3. `<AgentStream>` component renders the buffer using `<Static>` (so old lines don't re-render) + a live `<ToolStep>` for the in-progress action.
4. Migrate one tool-call type at a time; keep old `console.log` paths as a fallback until stage is clean.

### Stage 4 — TaskList
1. `<TaskList>` — replaces `renderPipelineBox` from `cli/render.ts`.
2. List updates in place; checkmarks animate (one frame of `★` before settling on `✔`).
3. Wire to the same task-step events the existing flow emits.

### Stage 5 — Permission prompt
1. `<PermissionPrompt>` modal — overlays the bottom of the agent stream.
2. Embedded `<StructuredDiff>` for write_file / edit_file (replaces the inline diff we just added in `cli/permission-prompt.ts`).
3. Single keystroke handler via `useInput()` from Ink — no more raw stdin gymnastics.
4. Returns the answer via Promise the agent loop awaits, same contract as `askPermission` today.

### Stage 6 — Spinner
1. `<Spinner>` with verb cycling: `Thinking → Implementing → Wiring → Verifying → Polishing` (one verb per ~3s).
2. Subtle shimmer animation on the active verb (Claude has this; it's a 60-line component).
3. Replace `ora` calls; remove `ora` dep + `cli/spinner-control.ts`.

### Stage 7 — Diff preview + Tool steps
1. `<StructuredDiff>` — green +, red -, dim context, line-number gutter. Tab-to-expand becomes "press . to collapse / Tab to expand."
2. `<ToolStep>` — single line per tool call with status icon + label + diff stats; clicking Tab expands the diff inline.

### Stage 8 — CompletionSummary + JobsBar
1. `<CompletionSummary>` — final box with model output, file list, next-steps section.
2. `<JobsBar>` — pinned bottom bar showing background jobs (replaces `cli/job-status.ts`).

### Stage 9 — Switch over and clean up
1. Remove the `SYS_INK` flag — Ink becomes the only UI.
2. Delete `cli/ui.ts`, `cli/render.ts` (after migrating constants to `theme.ts`), `cli/permission-prompt.ts`'s body, etc.
3. Update tests that reference the old rendering.
4. Update `cli-client/README.md` (if any) with the supported-terminals list.
5. `npm run typecheck && npm test` — both clean.
6. Manual smoke: scaffold-first flow, plan mode, chat continue, /permissions, /memory.

## Verification

Per stage:
- `npm run typecheck` clean
- `npm test` — all existing tests pass (agent logic doesn't change)
- Manual: run `SYS_INK=1 sys` in a real terminal, run the same e-commerce prompt that exposed the original bugs, confirm:
  - Task list updates in place (doesn't scroll past)
  - Spinner shows cycling verbs, stops cleanly at completion
  - Permission prompt is a true modal, single keystroke approves
  - Inline diff renders cleanly inside the prompt
  - Long input wraps without prompt-stutter
  - No `[stream] Request failed` red lines

End-to-end (post-Stage 9):
- `sys "create a react app for a todo list"` runs the scaffold-first flow with no visual regressions
- `sys continue` resumes a chat
- `/permissions` slash command works
- Windows Terminal + macOS iTerm2 both render correctly

## Out of scope

- Vim mode in the chat input (Claude has it; we won't bother)
- Web/teammate UI parity (Claude has these; we don't have the surfaces)
- Custom theme picker (Phase 10 if ever)
- Server-side changes
