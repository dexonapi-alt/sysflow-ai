# UI/UX polish + action-aware spinner + scroll-glitch fix

- **Created:** 2026-05-18
- **Status:** in-progress
- **Scope:** Fix two specific user-reported UI bugs (uncontrollable scroll on terminal minimize during summary typeout; spinner verb cycle decoupled from agent actions) plus a broader polish sweep across the cli's rendered surfaces. Diagnose root causes — don't patch around symptoms.

## Goal

User report (2026-05-18):

> *"when i minimize the terminal when generating summary it hit the glitch scrolling bug it constantly scroll up and i cant even control the scroll anymore"*
>
> *"the spinner label just keep changing word without a meaningful ai actions it didn't even realize what the agent does it just randomly changing labels in an interval"*
>
> *"we need to enhance and polish our UI/UX experience"*

The cli's rendering layer must:

1. Survive a terminal minimize/restore mid-render without scroll storms.
2. Reflect the **actual** agent action in the spinner label — `reading src/index.ts`, `writing package.json`, `running npm install` — falling back to the verb cycle only when truly idle (waiting on Flash / main-model with no in-flight tool).
3. Read coherent across every rendered surface: action cards, awareness badges, off-course modal, permission prompts, error display, streaming output, reasoning peek.

## Context from knowledge base

- `architecture.md: ## Living CLI (Phase 12)` — the breath-driven living rendering layer this plan polishes.
- `architecture.md: ## Premium CLI components (Phase 14)` — `<RichSpinner>` / `<ActionCard>` / `<ReasoningPeek>` / `<InteractiveHints>`. The verb cycle + glyph rotation live in `<RichSpinner>`.
- `architecture.md: ## Task display selectivity (Phase 19)` — task box gating; touched only if Stage 3's audit finds an unclear edge case.
- `decisions.md: ## Breath is the single visual metaphor for the living CLI` — load-bearing constraint; nothing in this plan changes the metaphor.
- `decisions.md: ## RichSpinner: single colour-shifting glyph, NOT a 4-glyph swirl` — pinned visual; spinner's BODY stays unchanged. Stage 2 only touches the LABEL.
- `decisions.md: ## Workflow-flavoured verb cycle (22 entries) instead of generic "thinking"` — the cycle survives but becomes the IDLE fallback rather than the default.
- `decisions.md: ## Console-redirect gating via shouldRenderInlineForLegacy()` — the rule every raw-stdout write must respect; the scroll-glitch fix re-affirms it.
- `decisions.md: ## Pure shape functions instead of ink-testing-library` — every new render-path helper this plan adds gets pure-function unit tests, not Ink integration tests.
- `decisions.md: ## Modal Ink-port deferred from Phase 12` — permission + off-course modals stay raw-TTY; Stage 3's audit will catch whether they actually need an Ink port.
- `gotchas.md: ## Raw \x1b[nA cursor-up writes corrupt Ink's render zone` — the precedent for cursor-escape causing scroll storms; Stage 1 hunts for ANY remaining unguarded raw write.
- `gotchas.md: ## spinner.text = "thinking..." as default silently disabled the verb cycle` — the verb-cycle gate is `text` prop. Stage 2's action-aware label needs to coexist WITHOUT silently disabling the cycle on idle.
- `gotchas.md: ## --no-motion contract — every primitive renders settled state` — Stage 1 + 2 fixes must honour `isMotionEnabled() === false`.
- `gotchas.md: ## useFrame motion-listener registration is lazy on purpose` — the per-frame Typewriter setState is the prime suspect for the scroll-storm cause. Stage 1 audits its cadence.
- `applied/2026-05-07-phase-12-living-cli-ui.md` — full Phase 12 baseline; the polish sweep references its zone model (header / stream / status).
- `applied/2026-05-07-phase-14-premium-cli-experience.md` — RichSpinner + ActionCard implementation details.

## Affected files

### Stage 1 — Diagnose + fix the minimize-during-summary scroll storm

- `cli-client/src/ui/animation/primitives/Typewriter.tsx` — `useFrame` callback fires `setCount` every frame regardless of whether `count` actually advanced. When the typewriter has finished revealing (`count >= children.length`) it should DETACH from the frame loop. Add a `done` ref + early-return guard; expose via a `useFrameUntil(predicate)` variant or simpler: bail in the callback once `count` equals length.
- `cli-client/src/ui/animation/use-frame.ts` — current contract: register listener → fires every frame while subscribed. When ≥ N subscribers register simultaneously (Typewriter + RichSpinner glyph rotator + LiveStatusBar + ToolCard breath ticks), the per-frame work accumulates. Audit the listener count + per-frame work cost; add a `process.stdout` write-budget check (e.g. drop frames when SIGWINCH just fired).
- `cli-client/src/ui/components/AgentStream.tsx` — when `assistantMessage` is mounted (typewriter active), the parent re-renders on every Typewriter setState because it lives INSIDE the live region. Wrap the Typewriter section in a `React.memo` + stable-key boundary so its setState doesn't bubble.
- `cli-client/src/ui/animation/use-frame.ts` (continued) — add an opt-in `pauseDuringResize` listener that suspends frame callbacks for 200ms after a `process.stdout.on("resize")` fires. Restart on the next idle tick.
- `cli-client/src/agent/agent.ts` — grep for ANY remaining `process.stdout.write("\x1b[...")` callsites. Confirm each is gated by `shouldRenderInlineForLegacy()` per the existing decision. The plan-scoped gotcha-104 fix should be complete; verify no regression from later PRs added a new unguarded site.
- `cli-client/src/ui/hooks/useResizeDebounce.ts` (NEW) — pure-ish hook returning `{ isResizing: boolean }` that flips true on `process.stdout.on("resize")` and false again 150ms after the last resize event. Components that emit a lot of frames (Typewriter, LiveStatusBar) consult it.
- 12 new tests: `useFrame` pause behavior; resize-debounce semantics; Typewriter detaches when complete; Typewriter pauses during isResizing; pure-shape `computeTypewriterCount` already covered (extend with edge cases for completion latch).

### Stage 2 — Action-aware spinner labels

- `cli-client/src/agent/events.ts` — extend the agent-event reducer to track the CURRENT in-flight tool dispatch. New state slice: `currentTool: { tool: string; primaryArg: string | null } | null`. Set on `tool_dispatch_start` event; cleared on `tool_dispatch_settle`. The label resolution priority becomes:
  1. Explicit server phase label (preserved — e.g. "asking openrouter-auto...") — wins.
  2. `currentTool` → "reading src/index.ts" / "writing package.json" / "running npm install" etc. — pure formatter.
  3. Verb cycle — IDLE fallback only.
- `cli-client/src/agent/events.ts` — emit `tool_dispatch_start` / `tool_dispatch_settle` events from `executeToolsBatch` (cli-client/src/agent/executor.ts) so the reducer observes the in-flight tool list. The events ALREADY exist in some form via `surfaceToolBatch`; verify + extend.
- `cli-client/src/ui/components/AgentStream.tsx` — when the agent-events state has `currentTool`, pass `text={formatToolForSpinner(currentTool)}` to `<RichSpinner>`. Empty `currentTool` → don't pass `text`, letting the verb cycle run.
- `cli-client/src/ui/components/RichSpinner.tsx` — no internal change. The `text` prop already drives the override path; we just feed it from a smarter source.
- `cli-client/src/ui/components/__tests__/RichSpinner.test.ts` — existing tests pin the verb cycle. Add: `text` propagation; verb-cycle resumption after `text` clears.
- `cli-client/src/ui/spinner-label-format.ts` (NEW) — pure formatter `formatToolForSpinner(tool, args): string`. Examples:
  - `read_file` + `args.path = "src/index.ts"` → `"reading src/index.ts"`
  - `batch_read` + `args.paths.length === 4` → `"reading 4 files"`
  - `write_file` + `args.path = "package.json"` → `"writing package.json"`
  - `batch_write` + `args.files.length === 3` → `"writing 3 files"`
  - `edit_file` + `args.path = "src/db.ts"` → `"editing src/db.ts"`
  - `run_command` + `args.command = "npm install express"` → `"running npm install express"` (truncate at 40 chars)
  - `search_code` + `args.pattern = "express"` → `"searching for \"express\""`
  - `web_search` + `args.query = "fastify auth"` → `"searching the web for \"fastify auth\""`
  - `list_directory` → `"listing src/"`
  - `create_directory` → `"creating src/routes/"`
  - `reason` → `"thinking through it"` (matches the verb cycle vocabulary so the transition reads naturally)
- 8 new tests for the formatter (one per tool); 4 new tests for the reducer's tool-dispatch tracking.

### Stage 3 — Audit + cataloguing sweep

- `.claude/plans/2026-05-18-ui-ux-audit-findings.md` (NEW — written by this stage, NOT a fresh plan) — a structured catalog of every observed UI/UX gap from the audit sweep. NOT a plan; a findings doc. Format: per-surface entry (Spinner / Headers / Action Cards / Permission Prompt / Off-Course Modal / Reasoning Peek / Streaming Output / Error Display / Awareness Badge / Task Box) with:
  - **Current behavior:** one paragraph + screenshot-equivalent ASCII if useful.
  - **Observed issues:** bullet list, each with severity (cosmetic / clarity / blocking).
  - **Proposed fix:** brief + estimated stages-1-2-3 effort.
- `cli-client/src/ui/components/*.tsx` — read-only sweep. Document existing behaviour for each surface.
- `cli-client/src/cli/permission-prompt.ts` — included in the audit; copy/clarity check.
- `cli-client/src/cli/off-course-prompt.ts` — included; cross-reference with awareness plan.
- Manual run-through: spawn the cli against a fresh scaffold prompt + a bug-fix prompt + a /continue prompt and screenshot every distinct visual state. Cross-reference with the audit doc.
- The OUTPUT of this stage is the audit doc + a refined Stage 4/5 task list. Stage 4 and 5's specific scope below is a placeholder updated after the audit lands.

### Stage 4 — Targeted polish part A (audit-derived)

Per `.claude/plans/2026-05-18-ui-ux-audit-findings.md` — 4 issues:

1. **#1 — Sysflow_infra banner in Ink mode (BLOCKING).** New `infra_error` structured event + `<ErrorBanner>` component; gate the existing raw `console.log` chain behind `shouldRenderInlineForLegacy()` for legacy mode parity.
2. **#2 — ActionCard multi-line error rendering (CLARITY).** Replace `firstLine(error)` with pure `formatErrorLines(error, maxLines=3, maxCharsPerLine=100)`; render up to 3 indented lines with `+N more` tail when overflow.
3. **#3 — Awareness badge surfaces lastSignal context (CLARITY).** When state ≠ on_track, append `(<category>: <detail>)` after the score. On-track stays compact.
4. **#4 — Off-course modal Esc/q cancel + restrict default-on-unknown (CLARITY).** Explicit `q` / Esc → `continue` (safe default). Default-on-unknown limited to `r` / `R`; other keys re-prompt.

### Stage 5 — Targeted polish part B (audit-derived)

Per the audit doc — 4 issues:

5. **#5 — InteractiveHints modal-mode (CLARITY).** Reducer slot `activeModal` + `permission_modal_active` / `offcourse_modal_active` events; hint table grows two new states.
6. **#6 — Permission prompt width-aware diff preview (CLARITY).** Pure `pickPermissionBoxWidth(columns)` helper → `min(80, columns - 4)`.
7. **#7 — `run_command` stdout/stderr stream surface (CLARITY, BIG).** New `tool_stream` event with chunked stream lines (debounced 250ms); new `<StreamPreview>` block under the running ActionCard rendering last 5 lines muted.
8. **#8 — Header chunk-pulse branching cleanup (COSMETIC code clarity).** Pure `chunkRenderMode(chunk, runIntent)` helper → 3 exhaustive branches in Header.

Issues #9 and #10 from the audit are deferred (niche / cosmetic).

### Stage 6 — Telemetry + KB + plan archive

- `cli-client/src/agent/usage-log.ts` — new `RunSummary` fields:
  - `scrollGlitchEventsCount?: number` — bumped each time the cli detects a resize-during-typewriter event AND pauses the frame loop. Diagnostic: if the field is consistently >0 on runs where users report glitches, Stage 1's debounce is firing as designed.
  - `spinnerActionBoundLabelsCount?: number` — count of turns where the spinner ran with a `currentTool`-derived label rather than the verb cycle. Telemetry for "is the new label path actually firing".
  - `spinnerVerbCycleFallbacksCount?: number` — count of turns where the spinner ran with the verb cycle (no in-flight tool). Together with the previous, gives a ratio.
- `architecture.md: ## Living CLI (Phase 12)` — extend with the resize-debounce + currentTool label flow.
- `decisions.md: ## RichSpinner label resolution order` — new entry codifying explicit-phase > currentTool > verb-cycle priority.
- `decisions.md: ## useFrame listeners detach on completion + pause during resize` — new entry; rationale + alternatives rejected.
- `gotchas.md: ## Terminal minimize during summary typeout caused uncontrollable scroll` — canonical repro + the multi-layer fix (Typewriter detach + useFrame pause + resize-debounce).
- `gotchas.md: ## Spinner verb cycle ran during tool dispatch, hiding the actual action` — repro + the action-binding fix.
- Plan archived to `applied/`.

## Migrations / data

N/A.

## Hooks / skills / settings to update

- `quality.spinner_action_label_enabled` (bool, default `true`) — Stage 2 kill switch; off = verb cycle always.
- `quality.typewriter_pause_during_resize_ms` (number, default `150`) — Stage 1 debounce window. Operators can tune if 150ms over- or under-pauses on their terminal.

## Dependencies

- No new npm packages. Stage 2's formatter is pure string ops; Stage 1's resize hook uses the existing `process.stdout.on("resize")` event.

## Risks & mitigations

- **Pausing the frame loop during resize freezes the visible spinner** → Mitigation: the pause is < 200ms; the human eye won't notice. The spinner glyph stays on the last-rendered frame; the verb stays on the last-shown verb. Resume immediately on the next idle tick.
- **Typewriter detaching on completion breaks tests that assert continuous frame ticking** → Mitigation: add a test variant `Typewriter detaches when count === text.length`. The existing motion-disabled tests still pass because they short-circuit before the loop.
- **`currentTool`-derived labels feel choppy on short tools (read_file returns in 50ms)** → Mitigation: keep the label for at least 300ms (debounce off-direction). If a tool dispatch settles AND another starts within 300ms, the label transitions without flickering to verb-cycle in between.
- **Stage 3's audit produces a Wall-of-Findings doc that's unactionable** → Mitigation: cap the audit at 10 issues; per-issue severity classification (cosmetic / clarity / blocking) makes prioritisation explicit; Stages 4-5 each tackle a fixed budget (4 issues each).
- **Action-aware spinner exposes private tool args (filenames in user-visible cli output)** → Mitigation: the labels echo what the agent ALREADY emits via `ActionCard`. Same info, different surface. No new privacy boundary crossed.
- **Resize debounce conflicts with Ink's own resize handling** → Mitigation: Ink's resize handler triggers full re-render via React state. Our debounce only affects per-frame `useFrame` listeners (Typewriter / spinner glyph rotation). Ink still re-renders correctly post-debounce.
- **Stage 2's event reducer change breaks existing AgentStream rendering** → Mitigation: incremental — keep the existing spinner_text event path working; the new `currentTool` slice is additive. Fall-through to old behaviour when undefined.

## Implementation order

1. **Stage 1 — Scroll glitch root-cause fix.** Highest user-pain. Mechanical: Typewriter completion detach + useFrame pause-during-resize + audit raw cursor writes. *(One PR.)*
2. **Stage 2 — Action-aware spinner labels.** Visible UX win; isolated to the reducer + RichSpinner consumer. *(One PR.)*
3. **Stage 3 — UI/UX audit sweep.** Produces `.claude/plans/2026-05-18-ui-ux-audit-findings.md`. Locks scope for stages 4 + 5. *(One PR — the audit doc itself; no code changes.)*
4. **Stage 4 — Targeted polish part A (4 audit-derived issues).** *(One PR.)*
5. **Stage 5 — Targeted polish part B (4 audit-derived issues).** *(One PR.)*
6. **Stage 6 — Telemetry + KB + plan archive.** *(One PR.)*

Each stage = one PR off `main`. ~1,100 LOC + ~30 new tests across six stages (Stage 3 ships 0 tests / 0 code; Stage 4-5 each ship ~5-8 tests depending on audit findings).

## Verification

**Stage 1**

- Unit: `computeTypewriterCount` edge cases (completion latch); `useFrame` pause hook (mock `process.stdout.on('resize')`; assert frame callbacks suspend then resume).
- Unit: `Typewriter` detaches from frame loop after `onDone`.
- Manual on Windows + macOS: run a long-summary prompt (e.g. /continue on a 12-chunk run). Minimize the terminal mid-typewriter. Restore. The buffer should be stable — no scroll storm, no buffer corruption. The typewriter resumes from where it left off.
- Manual: confirm motion-disabled mode (`SYSFLOW_NO_MOTION=1`) renders the full summary immediately and never triggers the pause (resize during settled state is a no-op).

**Stage 2**

- Unit: `formatToolForSpinner` per tool (8 tests).
- Unit: reducer's `currentTool` slice transitions on tool_dispatch_start / settle.
- Manual: run a multi-tool prompt. Observe the spinner reads "reading X.ts" → "writing Y.ts" → "running npm install" in time with the cli's ActionCards. Between tools (post-settle, pre-next-dispatch), the verb cycle resumes briefly.
- Manual: confirm explicit phase labels (e.g. server-emitted "asking openrouter-auto...") still override the currentTool label.

**Stage 3**

- Output: `.claude/plans/2026-05-18-ui-ux-audit-findings.md` exists; 10 entries; severity classification on each.

**Stage 4 + 5**

- Verification specs locked in after Stage 3 lands. Each issue gets a manual + unit verification line.

**Stage 6**

- Telemetry populates. KB entries lint clean. Plan archived.

## Out of scope

- **Full Ink redesign.** Phase 9 / Phase 12 already covered the core; this plan polishes their output.
- **Web / Electron renderer.** The cli stays in the terminal.
- **Custom terminal-emulator hacks.** We work with whatever the user's terminal provides (Windows Terminal, iTerm2, Alacritty, etc.); no per-terminal-emulator workarounds beyond what already exists for ConHost truecolor banding.
- **Permission modal Ink port.** Phase 12's deferred decision stands. The audit may flag UX gaps in the permission flow; fixes can be applied to the raw-TTY implementation without porting.
- **Off-course modal Ink port.** Same as above. Audit may surface gaps; raw-TTY fixes only.
- **Cross-OS terminal quirks beyond the scroll-glitch repro.** If the user reports Windows-Terminal-specific or Alacritty-specific bugs in the audit, those land here. Otherwise, no proactive cross-OS coverage.
- **Theme / palette redesign.** Stays on the Phase 12 colour language. Stage 5 may tweak individual mappings (e.g. awareness badge → off-course modal colour consistency) but no global palette swap.

## Composition with existing systems

- **Phase 12 living CLI** — this plan polishes the same zone model (header / stream / status) without adding new zones.
- **Phase 14 premium components** — RichSpinner / ActionCard / ReasoningPeek stay as designed; Stage 2 wires the spinner LABEL to action state; visual is unchanged.
- **Phase 19 task display selectivity** — orthogonal; Stage 3 audit may surface a redundant edge case but won't change the core gating.
- **Awareness plan** — off-course modal is in Stage 3's audit surface list; any change here composes additively with the awareness plan's modal triggering logic.
- **Accountability plan** — ToolCard rendering for batches (3-tool cap) is in Stage 3's audit surface list; the cap affects density which Stage 5 may need to tune.
