# Phase 14 — Premium CLI experience: stability, coherence, density

- **Created:** 2026-05-07
- **Status:** in-progress
- **Scope:** Fix five user-visible breakages on the live CLI: terminal scroll glitch, slow-repeat completion summary, heavy ASCII boxes around every iteration, no visibility into thinking/reasoning, and a generic spinner. Result should feel as polished as Claude Code's session view — ● bullets, indented diffs, live elapsed/token counter, no double-rendered content, no cursor jumps.

## Goal

Phase 12 built a coherent design language (breath, persistent zones, color-as-state). Phase 13 made it the default. **Phase 14 fixes what the user actually sees breaking on the live screen**:

1. **Terminal scroll glitch** — when the agent runs, the terminal scrolls up and down on its own; the user loses control of their viewport.
2. **Slow-repeat completion summary** — after a run finishes, the same summary text appears twice — once instantly inside an ASCII box, once slowly via the Typewriter — so the user reads identical content twice with a delay between.
3. **Heavy boxes everywhere** — pipeline plan, every diff, every tool result, every section gets wrapped in `╭── ──╮` ASCII chrome. Reads as cluttered, takes 4× the vertical space of the equivalent indented format Claude Code uses (single `●` bullet header, `⎿ Added X lines, removed Y lines` summary, plain numbered diff hunks underneath).
4. **No visibility into what the agent is doing during a long step** — the spinner just says `thinking…` and rotates verbs every 3s. There's no elapsed time, no token delta, no "thought for Xs" callout, no peek at the reasoning brief while it's being thought through.
5. **Generic spinner glyph + animation** — single `●` breathing between two colours. Compared to Claude's morphing glyph (`✢ ✺ ✣ ✤`-style) with elapsed + token counters in the status line, ours reads as low-effort.

The goal is to close all five gaps without losing the design language Phase 12 locked in (breath at three tempos, single-metaphor motion, palette in `theme.ts`).

## Context from knowledge base

- `architecture.md: ## Living CLI (Phase 12)` — the persistent-zones design Phase 14 builds on. We do NOT replace zones; we fix the renderers within them.
- `decisions.md: ## Breath is the single visual metaphor` — the new richer spinner must still use breath. No strobe, no rotating-dot fallback. The glyph cycle is additive.
- `gotchas.md: ## --no-motion contract` — every new animation Phase 14 introduces ships its `--no-motion` settled-frame variant from day one.
- `cli-client/src/cli/render.ts:204 renderPipelineBox` — the heavy box renderer Phase 14 replaces.
- `cli-client/src/cli/render.ts:36-46 boxTop / boxMid / boxBot` — the building blocks the agent uses for the SUMMARY box, the diff preview boxes, the MEMORY box, etc. Phase 14 replaces those with indented-list helpers.
- `cli-client/src/agent/agent.ts:822 renderCompletion` — the double-emission site (legacy SUMMARY box + assistant_message event both fire). Phase 14 collapses them.
- `cli-client/src/agent/agent.ts:1048 process.stdout.write("\\x1b[${n}A")` — the raw cursor-up escape that breaks Ink's render zone. Phase 14 removes it (the equivalent is already an Ink reconciliation concern when in Ink mode).

## Affected files

### New modules
- `cli-client/src/ui/components/ActionCard.tsx` — replaces the heavy `renderPipelineBox` + per-step bordered card with a Claude-style single-line header (`● Bash(...)` / `● Update(file.ts)` / `● Searched for ...`) + a one-line subtle summary (`⎿ Added X lines, removed Y lines`) + an optional indented diff/output preview underneath. NO surrounding box. Replaces both the pipeline-plan list AND the per-tool diff preview with one component family.
- `cli-client/src/ui/components/RichSpinner.tsx` — replaces the current `Spinner.tsx`. Three cells: breathing glyph (cycles through a 4-glyph set: `✢ ✺ ✣ ✤` with breath colour, NOT discrete-frame swap — the breath modulates which glyph is brightest), action verb (cycles every 3s as today), live overlay (elapsed since spinner started + estimated tokens delta if we have one). Format: `✢ Making the alive UI default…  (4m 30s · ↑ 11.8k tokens · thought for 10s)`.
- `cli-client/src/ui/components/ReasoningPeek.tsx` — surfaces the reasoning brief INCREMENTALLY as it streams in (today they only render when the call completes). Mounted in a collapsible Box above the spinner; auto-collapses to a one-liner after the brief lands; expandable with `ctrl+o`.
- `cli-client/src/ui/components/InteractiveHints.tsx` — bottom-of-screen one-liner that contextually shows the keys the user can press right now. Examples: `(ctrl+o expand · ctrl+b background · tab complete)` while running, `(↑ history · tab complete · \↵ newline)` while typing. Replaces the existing inline hint on ChatInput so the keys live in one place that's always visible.
- `cli-client/src/ui/state/screen-control.ts` — single store for "should the agent re-render the live region". Lets components opt out of frame ticks while paused (e.g. user pressed `ctrl+t` to hide tasks).

### Extended modules
- `cli-client/src/ui/components/AgentStream.tsx` — render `<ActionCard>` instead of `<ToolCard>` once the new component lands. Move pipeline-plan rendering into the same family. The settled-vs-running partition stays.
- `cli-client/src/ui/components/Header.tsx` — drop the second row of slash-command help (it's noisy and duplicated by `<InteractiveHints>` at the bottom). The Header keeps just the identity row + awareness badge + chunk pulse.
- `cli-client/src/ui/components/ChatInput.tsx` — drop the inline `↑ history · Tab complete · \↵ newline` hint (moved to `<InteractiveHints>`). Keep cursor pulse + rotating placeholder hints.
- `cli-client/src/ui/components/Spinner.tsx` — re-exports `<RichSpinner>` for back-compat with existing imports; old simple `<Breath>` glyph kept as a `<MiniSpinner>` for the LiveStatusBar and the small in-modal slot where a one-cell breath is right.
- `cli-client/src/ui/App.tsx` — mount `<InteractiveHints>` between ChatInput and LiveStatusBar.
- `cli-client/src/agent/agent.ts` — three coherence fixes:
  - **Stop double-emitting completion summary**. In `renderCompletion`, when `isInkActive()`, skip the legacy `console.log("  " + boxTop("SUMMARY"...))` block entirely and let `assistant_message` be the only emission. The Typewriter renders it once, slowly. (Today both fire; the user reads the same text twice.)
  - **Stop writing raw cursor-up escapes**. Lines around 1048 + 1052 do `process.stdout.write("\\x1b[${n}A")` and `\\r\\x1b[K` to erase the just-printed `○` placeholders before painting the `✔` results. In Ink mode this corrupts Ink's layout state and causes the scroll glitch. When `isInkActive()`, skip the cursor moves entirely — the in-flight tool list is already represented by the `<ToolCard>` running variants which the AgentStream re-renders cleanly.
  - **Stop rendering the pipeline plan box twice**. `renderPipelineBox` is called from `renderCompletion` AND from the chunked-loop progress sites. With Ink active, both paths now emit log events through the redirect, so the user sees the box once on plan-creation, then again at completion. Gate the duplicate render behind `!isInkActive()`.
- `cli-client/src/cli/render.ts` — keep `boxTop` / `boxMid` / `boxBot` for legacy console mode but mark them `@deprecated` for new callers. `renderPipelineBox` keeps working in legacy mode.

### Tests
- `cli-client/src/ui/components/__tests__/ActionCard.test.ts` — pure helpers: header formatter for each action kind (`Bash` / `Update` / `Read` / `Search` / `Write`), diff-stat summary line, indent helper.
- `cli-client/src/ui/components/__tests__/RichSpinner.test.ts` — pure helpers: `formatTokens(n)` (`12300 → "12.3k"`), `formatThoughtFor(ms)` (`10000 → "thought for 10s"`), glyph picker (cycles `✢ ✺ ✣ ✤` deterministically per breath cycle).
- `cli-client/src/ui/components/__tests__/InteractiveHints.test.ts` — context selector returns the right hint set per state (`idle` / `running` / `awaiting_modal` / `typing`).
- `cli-client/src/ui/hooks/__tests__/useAgentEvents.test.ts` — extend with reducer cases for new events (`reasoning_stream_chunk`, `agent_summary_collapse`, etc.) when the wire-in stages add them.

## Migrations / data

N/A. All changes are renderer-side or agent-emission-side; no schema, no persistent state.

## Hooks / skills / settings to update

- No `.claude/hooks/` changes.
- `.claude/knowledge/decisions.md` (post-implementation) — record (1) the Claude-style ●-bullet format choice and the boxed-everything alternative we rejected; (2) the rich-spinner glyph cycle as additive to the breath metaphor (NOT a replacement).
- `.claude/knowledge/gotchas.md` (post-implementation) — write up the raw `\x1b[nA` cursor-move bug + how to spot it on Windows Terminal so a future contributor doesn't reintroduce it.

## Dependencies

- **Zero new npm packages.** Everything builds on Ink + React + chalk like Phase 12.
- No env vars added; the `--no-motion`, `SYS_INK`, `SYS_LEGACY` flags from Phase 12/13 cover what we need.

## Risks & mitigations

- **Removing the heavy boxes makes the output feel "too plain"** — some users associate visual chrome with "premium". Mitigation: the Claude reference proves the indented-list format reads as MORE premium when done well. Use colour, indentation, and subtle separators (`⎿`, `─`, single accent characters) to maintain density without ASCII chrome.
- **Stopping the cursor-up writes might leave stale `○` placeholders on screen in legacy mode** — but legacy mode still uses them and we only gate the skip behind `isInkActive()`. Legacy is unaffected.
- **The double-emission fix for SUMMARY removes the legacy box from Ink mode** — users who liked seeing both the box AND the typewriter (none, presumably; this is the actual bug) lose the box. Mitigation: the assistant_message event renders the same content via Typewriter; the box is redundant.
- **The new RichSpinner adds a token counter we don't fully track on the cli side**. Mitigation: estimate tokens from the prompt + response sizes via the existing `cliEstimateTokens()` helper in `token-estimate.ts` — same source the run-summary telemetry uses. "Estimated" is fine; the user just wants a sense of scale.
- **Live reasoning peek requires structured streaming events the server doesn't emit yet** — today reasoning briefs are returned as one chunk after the Flash call resolves. Mitigation: Phase 14 ships the *component* + the event-bus contract; the server-side streaming is a follow-up that lights it up. Until then the peek shows the brief once it arrives, not as it streams. Still better than current (silent → full block).
- **Tests for components that hold useEffect/setInterval are fragile** — vitest's fake timers + Ink rendering interact badly. Mitigation: test the pure helpers per Phase 12's pattern; trust the React glue.
- **Windows Terminal still has its own scroll quirks** — even after we stop emitting raw cursor moves, ConHost on older Win10 re-paints differently than Windows Terminal. Mitigation: profile on both during Stage 6 verification; document any residual quirks in `gotchas.md`.

## Implementation order

Each stage is its own PR. Stages 1-2 are the no-regression-tolerated stability fixes; Stages 3-5 are the visible polish; Stage 6 is documentation.

### Stage 1 — Output coherence (kill double-emission, kill cursor jumps)
1. `agent.ts: renderCompletion` — gate the legacy `console.log("  " + boxTop("SUMMARY", 50))` block + its `boxMid` lines + `boxBot` behind `!isInkActive()`. The `assistant_message` emit stays. Result: Typewriter is the single source of truth in Ink mode; legacy mode unchanged.
2. `agent.ts:1048` — gate the `process.stdout.write(\`\\x1b[${toolCalls!.length}A\`)` + the per-line `\\r\\x1b[K` block behind `!isInkActive()`. The visual representation in Ink is already the running `<ToolCard>` set; re-printing rows is unnecessary AND breaks Ink's layout.
3. `agent.ts: renderPipelineBox` callsite — same gating. In Ink mode the pipeline plan should land via a single structured event the AgentStream renders as an `<ActionCard>` (Stage 2 introduces that component). For Stage 1, just stop double-rendering.
4. Add a pure helper `shouldRenderInlineForLegacy(): boolean` that returns `!isInkActive()` and use it at every gated callsite. One canonical predicate so Stage 4+ contributors don't re-derive the check.
5. Manual smoke test: run `sys` interactively in Ink mode, complete a run, assert the SUMMARY appears once via Typewriter and the terminal doesn't scroll-jump.
6. Tests: extend the events-redirect test to assert the SUMMARY box callsite is gated when `isInkActive()` is true (mock `isInkActive`).

**Verdict for Stage 1:** the two worst user-visible bugs (scroll glitch + repeat summary) are fixed. Nothing visually new yet.

### Stage 2 — `<ActionCard>` redesign (replace boxes with ● bullets + indented diffs)
1. Build `<ActionCard>` per the design above. Header line: `● Verb(target)` where Verb maps from tool name (Bash for run_command, Update for edit_file, Write for write_file, Read for read_file, Search for search_files). Target is path or short summary.
2. Diff summary line: `  ⎿  Added X lines, removed Y lines` rendered with `<Text color={muted}>`. Numbers from the existing diff stats.
3. Optional expanded preview: 5-8 lines of the diff or output, indented under the bullet, with `<Pulse>` on the bullet for newly-arrived cards.
4. Replace `<ToolCard>` in `<AgentStream>` with `<ActionCard>`. Status mapping: running → pulsing bullet, success → settled muted bullet, error → red bullet + one-line error.
5. Replace the pipeline-plan rendering with a list of `<ActionCard>`s, one per planned step, with the leading bullet greyed out (`○`) until the step starts.
6. Drop `renderPipelineBox` from the Ink path entirely. Legacy `cli/render.ts: renderPipelineBox` stays for `--legacy` mode.
7. Tests: pure header-formatter (Verb mapping per tool) + diff-stat summary line + indent helper.

**Verdict for Stage 2:** the visual chrome problem is fixed. Output reads like Claude.

### Stage 3 — `<RichSpinner>` (live elapsed + token counter + premium glyph cycle)
1. Build `<RichSpinner>`. Three regions: (a) glyph that cycles through `["✢", "✺", "✣", "✤"]` driven by which one is brightest under the breath colour-lerp (the others render dimmed), (b) cycling verb (existing behaviour preserved), (c) overlay `(elapsed · token-delta · "thought for Xs" if last brief was reasoning)`.
2. Pure helpers: `formatTokens(n)` (12300 → "12.3k"), `formatThoughtFor(ms)` (10000 → "thought for 10s"), `pickPrimaryGlyph(now, bpm)` (returns the index of the brightest glyph this tick).
3. Wire token estimate via the existing `cliEstimateTokens` from `token-estimate.ts`. Server tokens are tracked in usage-log; reuse the same accumulator for the live counter.
4. Re-export old `<Spinner>` as `<MiniSpinner>` for the LiveStatusBar one-cell slot — that one stays single-glyph.
5. Tests: helpers + glyph picker (deterministic per `nowMs % periodMs`).

**Verdict for Stage 3:** the spinner stops feeling generic. Long operations show the user what's happening + how long it's taken.

### Stage 4 — `<ReasoningPeek>` (live visibility into thinking)
1. Build `<ReasoningPeek>` as a collapsible Box mounted in `AgentStream` above the spinner when a reasoning event is in flight.
2. Add `reasoning_stream_chunk { id, partial }` event type — append-only, one per ~250ms of streaming output. The reducer aggregates by id.
3. Reducer renders the latest 3-5 lines while streaming; auto-collapses to a one-liner (`⎿ thought for X · 12 lines`) once the brief lands; expandable via `ctrl+o`.
4. Server side: extend reasoning calls to emit partials when supported (Gemini Flash supports streaming via `generateContentStream`). Behind a flag — if streaming isn't available, fall back to the current single-emission and the peek stays collapsed.
5. Tests: reducer for the new event type + collapse-after-complete behaviour.

**Verdict for Stage 4:** the user can see what the agent is reasoning about as it's reasoning, not after.

### Stage 5 — `<InteractiveHints>` + `ctrl+o` / `ctrl+b` controls
1. Build `<InteractiveHints>`. Reads from a per-state hint table: `{ idle, running, modal, typing }` → `string[]`. Each state has 2-3 keys. Rendered in muted colour at the bottom of the App, between ChatInput and LiveStatusBar.
2. `ctrl+o` expands the most recently collapsed `<ActionCard>` or `<ReasoningPeek>` (whichever is on top of the focus stack). Implementation: a small Zustand-style focus store that components register into.
3. `ctrl+b` moves the currently-running tool card to "background" — visually drops it into the LiveStatusBar's secondary slot (`◦ working · 2 jobs in bg`) and the AgentStream proceeds to the next step. Backgrounded tools surface their result as a card later.
4. `tab` keeps its existing slash-completion behaviour in ChatInput.
5. Tests: pure context-selector for hints + focus-store reducer.

**Verdict for Stage 5:** the user has interactive control they can discover from the always-visible hint row.

### Stage 6 — Polish + KB docs + plan archived
1. Profile Ink mode on a 2-min run on Windows Terminal + iTerm + xterm. Target: no scroll jumps, sustained <2% CPU for animations.
2. `.claude/knowledge/decisions.md` — entries for the ● bullet format choice + the rich-spinner glyph cycle additive to breath.
3. `.claude/knowledge/gotchas.md` — write up the raw `\x1b[nA` cursor-move trap.
4. `.claude/knowledge/architecture.md` — extend the Phase 12 Living CLI section with the Phase 14 component additions (ActionCard / RichSpinner / ReasoningPeek / InteractiveHints).
5. Plan moved to `.claude/plans/applied/` with completion notes.

## Verification

Per stage:
- `npm run typecheck` clean both sides.
- `npm test` — existing tests pass; new component tests added per stage.

End-to-end (after Stages 1, 2, 5 specifically):
- **Test 1 — terminal stability.** Run `sys` interactively. Submit `"build me a simple express api"`. Verify the terminal does NOT scroll-jump up/down during the run. Verify the user can still scroll the buffer with the mouse without the cursor fighting them.
- **Test 2 — single completion summary.** Same run. Verify the completion summary appears EXACTLY once (via Typewriter, slowly). Not in a box. Not twice.
- **Test 3 — visual density.** Compare the same run output side-by-side with the screenshot the user shared from Phase 13. The pipeline plan should be a list of `●`/`○` bullets, NOT a `╭── ──╮` box. Diffs should be `⎿  Added X lines, removed Y lines` + indented diff lines, NOT a `┌── diff:` box. Tool calls should be single-line `● Verb(target)` headers.
- **Test 4 — live progress visibility.** Trigger a long step (e.g. `npm install` via run_command). Verify the spinner shows live elapsed time + glyph cycling + token delta. Verify a reasoning step shows the `<ReasoningPeek>` populating as the brief streams in.
- **Test 5 — interactive hints discoverable.** From a fresh launch, the bottom row should show `↑ history · tab complete · \↵ newline`. After submitting, it should show `ctrl+o expand · ctrl+b background · esc cancel`. Pressing each key should do what the hint says.

Subjective aesthetic check (the bar Phase 14 has to hit):
- The CLI feels as polished as Claude Code on the same workflow.
- No box draws around content that doesn't need it (just diffs, just plans, just summaries — they all use indentation + bullets instead).
- The screen never moves on its own.
- The user always has a sense of "what's happening" + "how long it's taken" + "what they can do next".

## Out of scope

- **Mouse support.** Ink supports it but we're keystroke-only by design.
- **Re-flowing on terminal resize**. Ink handles this somewhat; if it breaks during Phase 14 testing we fix it then. Not a separate stage.
- **A proper streaming protocol for ALL provider responses** — Stage 4 only adds streaming for reasoning calls (Gemini Flash). Main-model streaming is a separate phase since it touches the server's response normalisation.
- **Multi-pane layout** (split window, sidebar, etc.). The single-zone scroll model is the design. A future Phase could add panes if metrics show they're wanted.
- **Theming / user-configurable palettes** — same out-of-scope notes as Phase 12.

## Foundation iteration policy

Phase 14 leans hard on the Phase 12 + Phase 13 work that's already in. **If the foundation has a gap, fix it.** Likely places:

- **Event bus payload shape** — Stage 4 needs `reasoning_stream_chunk`; Stage 5 needs focus-stack events. If multiple components want different slices of the same data, factor a typed event-builder helper rather than inline-shaping each callsite.
- **The `cliEstimateTokens` helper** — currently called once per request; Stage 3 wants it per-frame for the running counter. May need memoisation by content hash.
- **Console-redirect coverage** — if Stage 1's gating reveals more raw-stdout calls (other modules besides agent.ts), audit them and either route through emitAgent or skip in Ink mode.

## Composition with Phase 12 + Phase 13 (additive only)

Phase 12 built the component layer. Phase 13 made it the default. **Phase 14 polishes the renderers + closes the visible-quality gap to Claude Code without touching the underlying architecture.** Every Phase 12 primitive (`<Breath>`, `<Pulse>`, `<Shimmer>`, `<Fade>`, `<Typewriter>`) is reused in the new components. The events bus + reducer pattern stays. The breath metaphor stays. The motion + theme stores stay.

What changes is what gets rendered and how the agent emits — not how the rendering engine works.
