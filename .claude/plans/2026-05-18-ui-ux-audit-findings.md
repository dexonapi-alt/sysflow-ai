# UI/UX audit findings — 2026-05-18

- **Source:** Stage 3 of plan `2026-05-18-ui-ux-polish-and-action-aware-spinner.md`
- **Status:** complete — Stage 4 + 5 polish stages assigned below
- **Scope:** structured catalog of UI/UX gaps observed across the cli-client's rendered surfaces. NOT a fresh plan; the catalog feeds Stage 4 + 5 of the parent UI/UX-polish plan.

## Method

Read-only sweep across every rendered surface:

- `<Header>` (top zone — model / folder / chat / user / awareness badge / chunk pulse)
- `<ActionCard>` (per-tool single-line render)
- `<RichSpinner>` (post-Stage-2 action-aware label + verb cycle fallback)
- `<ReasoningPeek>` (Flash brief surface)
- `<InteractiveHints>` (bottom-row keybinding affordances)
- Raw-TTY `permission-prompt.ts` (modal)
- Raw-TTY `off-course-prompt.ts` (modal)
- Inline rendered error banners (sysflow_infra etc.)
- Streaming output during `run_command`

10 issues catalogued + severity-classified (`blocking` / `clarity` / `cosmetic`) + Stage 4/5 assignment + estimated effort.

## Findings

### #1 — Sysflow_infra error banner raw-printed in Ink mode (BLOCKING)

- **Severity:** blocking
- **Surface:** `agent.ts` lines 858-862 (the sysflow_infra terminal-exit path)
- **Current behavior:** when the server returns `errorSource: "sysflow_infra"`, the cli calls `spinner.stop()` then `console.log("")` + 4 more raw lines (`═══ SYSFLOW INFRASTRUCTURE ERROR ═══` etc.) inline. In Ink mode the redirected `console.log` routes those bytes through the event bus, but the raw `═══` line drawing + multi-line indentation can collide with Ink's reserved region — same class as gotcha-104 (`Raw \x1b[nA cursor-up writes corrupt Ink's render zone`).
- **Observed issues:**
  - Multi-line block from raw stdout in a path that runs WITH Ink mounted (Ink doesn't unmount until the agent returns).
  - Banner copy is fine; the rendering path is the risk.
- **Proposed fix:** emit a structured `infra_error` event from agent.ts; AgentStream renders an `<ErrorBanner>` component in the live region. Until that lands, gate the existing `console.log` calls behind `shouldRenderInlineForLegacy()` so Ink mode emits via the event-bus channel.
- **Stage:** **Stage 4** (load-bearing; same gotcha-104 risk class)
- **Effort:** 1 new component + agent.ts gate flip + 4 tests.

### #2 — ActionCard renders only `firstLine(error)` — multi-line errors clipped (CLARITY)

- **Severity:** clarity
- **Surface:** `<ActionCard>` lines 144-149
- **Current behavior:** on `status === "error"`, the card renders `⎿  <firstLine(error)>` truncated at 100 chars. Multi-line errors (tsc diagnostics, eslint reports, run_command stderr) lose every line after the first.
- **Observed issues:**
  - User can't see WHAT went wrong beyond the first sentence.
  - tsc errors often have the diagnostic on line 2 (line 1 is the file path).
- **Proposed fix:** render up to 3 error lines with 2-space indent, each truncated at 100 chars. Add a tail line `+N more` when overflow. Pure helper `formatErrorLines(error, maxLines, maxCharsPerLine)`.
- **Stage:** **Stage 4**
- **Effort:** pure helper + ActionCard render update + 6 tests.

### #3 — Awareness badge has no context: `⚠ 60` doesn't tell user WHY (CLARITY)

- **Severity:** clarity
- **Surface:** `<Header> / <AwarenessBadge>` lines 153-164
- **Current behavior:** the badge shows glyph + score (`✔ 92`, `⚠ 60`, `✖ 25`). The reducer's `awareness.lastSignal` field carries the most-recent divergence signal but isn't surfaced.
- **Observed issues:**
  - User sees confidence drop but doesn't know what's driving it.
  - `lastSignal` is computed AND stored but invisible.
- **Proposed fix:** when `state !== "on_track"`, append the lastSignal text (truncated to ~40 chars) after the score. Format: `⚠ 60 (intent_keyword_absent: postgres)`. On-track stays compact (`✔ 92`).
- **Stage:** **Stage 4**
- **Effort:** Header.tsx render update + 4 tests for the conditional display.

### #4 — Off-course modal: any non-c/b key defaults to redirect (no Esc/q to cancel) (CLARITY, minor blocking)

- **Severity:** clarity (minor blocking — a mis-press becomes a 60-second redirect prompt the user has to escape)
- **Surface:** `cli/off-course-prompt.ts` lines 87-105
- **Current behavior:**
  ```
  if (key === "c" || key === "C") → continue
  if (key === "b" || key === "B") → backtrack
  default → redirect (opens text-entry prompt)
  ```
- **Observed issues:**
  - Mis-press (e.g. user fat-fingers `s` or `Esc`) triggers the redirect text prompt the user then has to escape by entering an empty line (which the code collapses to `continue` — but this is buried).
  - No `q` / Esc to dismiss without action.
  - User who wants to BACK OUT of the modal can't.
- **Proposed fix:** add explicit `q` / Esc handling that collapses to `continue` (the safe default — agent keeps going, user can interrupt later via Ctrl+C). Default-on-unknown stays as `redirect` but limit it to `r` / `R` only; other keys re-prompt with `> ` so the user knows their press didn't take.
- **Stage:** **Stage 4**
- **Effort:** off-course-prompt.ts key-handling rewrite + 5 tests of the input dispatch (pure-ish).

### #5 — InteractiveHints doesn't switch to modal-mode hints (CLARITY)

- **Severity:** clarity
- **Surface:** `<InteractiveHints>` + `ui/state/hints.ts`
- **Current behavior:** the bottom-row hint shows `↑ history · / commands · tab complete · ctrl+c exit` when idle and `ctrl+c cancel` when a spinner is running. It never reflects modal state.
- **Observed issues:**
  - When the permission modal is active, the hint row still says "↑ history · / commands · …" — but those keys do nothing during the modal.
  - When the off-course modal is active, the hint row likewise lies.
  - User reads the hint row, expects the keys to work, presses one, nothing happens (the modal reads raw stdin via its own listener; the hint-row keys aren't bound).
- **Proposed fix:** new `permission_modal_active` / `offcourse_modal_active` events emitted from the respective modal entry/exit points. Reducer tracks `activeModal: "permission" | "offcourse" | null`. `deriveHintState` consults the modal slot first; new hint entries in `state/hints.ts` for each modal state.
- **Stage:** **Stage 5**
- **Effort:** 2 new events + reducer slot + 2 hint-table entries + 8 tests.

### #6 — Permission prompt diff preview overflows narrow terminals (CLARITY)

- **Severity:** clarity
- **Surface:** `permission-prompt.ts` lines 28-50 (`BOX_WIDTH = 64`, `DIFF_PREVIEW_LINES = 12`)
- **Current behavior:** the modal box is hardcoded to 64 columns; the diff preview renders up to 12 lines inside. On terminals < 64 cols the box wraps. On wide terminals it under-uses the available width — a `+ const veryLongTypeAnnotation = SomeReallyVerboseTypeHelper<X, Y>` line truncates that's perfectly readable in a 120-col terminal.
- **Observed issues:**
  - Wraps on narrow terminals (lots of `iTerm2 split panes` use 60-col panes).
  - Truncates unnecessarily on wide terminals.
- **Proposed fix:** read `process.stdout.columns` once on modal entry; cap box width to `min(80, columns - 4)`. Diff lines wrap to the same width. Pure helper `pickPermissionBoxWidth(columns: number): number`.
- **Stage:** **Stage 5**
- **Effort:** pure helper + permission-prompt.ts read site + 3 tests.

### #7 — `run_command` stdout/stderr stream not surfaced during execution (CLARITY)

- **Severity:** clarity
- **Surface:** `<ActionCard>` for `run_command` + `tools.ts` runCommandTool
- **Current behavior:** while a long `run_command` (e.g. `npm install`) executes, the cli shows a settled ActionCard header (`● Bash(npm install)`) + the action-aware spinner (`running npm install`). The actual stdout/stderr stream is captured BUT not surfaced to the user. The user has no visibility into progress.
- **Observed issues:**
  - User sees the spinner spin for 30+ seconds with no indication anything is happening.
  - On failure, the multi-line output appears AFTER the close handler — too late to interrupt.
- **Proposed fix:** emit `tool_stream` events with chunked stdout/stderr lines (last 5 lines, debounced to once per 250ms). AgentStream renders a `<StreamPreview>` block under the running ActionCard showing the most recent 5 lines (muted, monospace). Settles into the ActionCard on tool_end.
- **Stage:** **Stage 5**
- **Effort:** new event + reducer slot + StreamPreview component + tools.ts wiring + 10 tests. **The biggest item in the audit.**

### #8 — Header chunk-pulse branching logic is hard to read (3 conditional branches) (COSMETIC)

- **Severity:** cosmetic (code-clarity, not user-visible)
- **Surface:** `<Header>` lines 106-134
- **Current behavior:** three conditional branches:
  1. `chunk && runIntent === "implement"` → render the chunk pulse normally.
  2. `chunk && runIntent !== "implement" && runIntent === null` → also render the chunk pulse normally (legacy path for pre-classified runs).
  3. `chunk !== null && runIntent !== null && runIntent !== "implement"` → render a muted "thinking through it" indicator.
- **Observed issues:**
  - The three branches have overlapping conditions (chunk truthy in all three).
  - Branch 2's "Pre-Phase-19 path" comment suggests it's transitional; we could potentially fold it into branch 1.
  - Future maintainer reads this and gets lost.
- **Proposed fix:** extract a single `chunkRenderMode(chunk, runIntent): "implement-pulse" | "internal-indicator" | "hidden"` pure helper. Header.tsx renders one of three exhaustive branches based on the helper's return. 4 tests for the helper.
- **Stage:** **Stage 5**
- **Effort:** pure helper + Header render simplification + 4 tests.

### #9 — ReasoningPeek `r`-toggle could conflict with prompts starting with 'R' (COSMETIC, edge case)

- **Severity:** cosmetic edge case
- **Surface:** `<ReasoningPeek>` line 329-339 (`useInput`)
- **Current behavior:** `useInput` listens for bare `r` / `R` keystrokes globally. The comment claims it only fires "while the input is empty / blurred", but Ink's `useInput` is global by default — there's no actual gating based on TextInput focus state.
- **Observed issues:**
  - If the user starts typing a fresh prompt that begins with `r` (e.g. "rewrite the auth handler"), the FIRST `r` toggles the reasoning peek instead of going into the ChatInput.
  - Hard to repro because the prompt has to start with `r` AND the reasoning brief has to be present AND the user has to be in the chat-input mode.
- **Proposed fix:** gate `useInput`'s callback on a "chat input focused" flag from the reducer. ChatInput emits `input_focused` / `input_blurred` events; ReasoningPeek consults the reducer's focused state and short-circuits when focused. **Deferred — niche edge case.**
- **Stage:** **deferred** (not Stage 4 or 5; hold for future polish if a user reports it)
- **Effort:** would need ChatInput rewiring; substantial.

### #10 — ActionCard target truncation at 80 chars overflows on narrow terminals (COSMETIC)

- **Severity:** cosmetic
- **Surface:** `<ActionCard>` `TARGET_MAX = 80` constant
- **Current behavior:** target string (path, command, query) truncates at 80 chars. With the verb prefix (`Write(` = 6 chars) + closing paren + 2-char indent + bullet, an 80-char target renders to ~90 chars total. Overflows 80-col terminals.
- **Observed issues:**
  - Wrapping on narrow terminals breaks the single-line card design.
- **Proposed fix:** scale `TARGET_MAX` to `process.stdout.columns - 12` (leaving room for bullet + verb + parens + indent). Pure helper.
- **Stage:** **deferred** (cosmetic; the wrap doesn't lose info, just spans 2 lines)
- **Effort:** small (1-line constant change → pure helper) but low priority.

## Stage 4 + 5 assignment summary

**Stage 4 — 4 issues:** all blocking + most-impactful clarity items.

1. #1 — Sysflow_infra banner in Ink mode (blocking)
2. #2 — ActionCard multi-line error rendering (clarity)
3. #3 — Awareness badge surfaces lastSignal context (clarity)
4. #4 — Off-course modal Esc/q to cancel + non-redirect default (clarity)

**Stage 5 — 4 issues:** clarity items that touch broader bus / state, plus the cosmetic code-clarity refactor.

5. #5 — InteractiveHints modal-mode (clarity)
6. #6 — Permission prompt width-aware diff preview (clarity)
7. #7 — `run_command` stdout/stderr stream surface (clarity, BIG item)
8. #8 — Header chunk-pulse branching cleanup (cosmetic — code clarity)

**Deferred — 2 issues:** niche / low-priority. Re-evaluate after Stages 4 + 5 ship.

- #9 — ReasoningPeek `r`-toggle vs prompt-starts-with-r
- #10 — ActionCard target truncation on narrow terminals

## Notes for Stages 4 + 5 implementation

- **#1 is load-bearing.** Should ship first in Stage 4 — same gotcha-class risk as the existing scroll-storm class.
- **#7 is the biggest Stage-5 item.** Probably 60% of Stage 5's effort. If timeboxed, descope to "surface last 1 line only" first.
- **#4's off-course modal change touches a raw-TTY codepath.** The Phase 12 "Modal Ink-port deferred" decision still holds; raw-TTY fixes only.
- **All Stage 4/5 stages get telemetry counters in Stage 6** (Stage 6's `RunSummary` field list will be updated to include any new counters introduced).

## Method note

The audit didn't run a live cli session (per "manual run-through" in the plan's Stage 3 spec). Findings are derived from reading the rendered-surface modules + their existing tests + cross-referencing with the gotchas / decisions catalog. A live manual run would likely surface 1-2 more issues — those can be appended here OR caught by Stage 5's manual verification step.
