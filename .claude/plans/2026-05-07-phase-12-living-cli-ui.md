# Phase 12 — Living CLI: animation language, persistent zones, reactive color

- **Created:** 2026-05-07
- **Status:** in-progress
- **Scope:** Replace the static + linear "log a line, move on" CLI rendering with a living, reactive interface where every visible element has vital signs — animation, color shifts, persistent zones — without copying any specific tool's design language.

## Goal

Today the CLI emits text top-to-bottom and forgets it. Even with the Phase 11 confidence badge and the Phase 10 chunk-progress, the visible surface is a scrolling log of frozen lines. The agent feels like a script that prints things, not a partner that's working alongside you.

Phase 12 introduces a deliberate animation language and three persistent zones (header, stream, status) so the CLI feels **alive** even when nothing is happening — idle states have ambient micro-motion, active states have contextual flow, transitions are smooth instead of jump-cut. The design is grounded in a single visual metaphor — *breath* — chosen because it's slow enough to never strobe, organic enough to never feel mechanical, and has a natural mapping to state intensity (faster when active, slower when idle).

This is not a Claude Code clone. It's our own design vocabulary that solves the same problem (CLI that doesn't feel like a printer) with different primitives (breath, color temperature, persistent header) and different aesthetic (purple → teal palette already in `theme.ts`, not Anthropic-ish).

## Context from knowledge base

- `architecture.md: ## Chunked reasoning loop (Phase 10)` — `renderChunkProgress` is the natural-language step renderer Phase 12 will replace with a living component.
- `architecture.md: ## Awareness loop (Phase 11)` — the awareness snapshot already streams to the cli per response (`response.awarenessSnapshot`); Phase 12 turns that into an animated badge in the persistent header rather than the inline marker that lives only in the chunk-progress block.
- `decisions.md: ## Render natural agent steps, not "chunk N/M" UI` — the user-facing language stays natural; Phase 12 only changes HOW it's rendered, not WHAT.
- `gotchas.md: ## process.stdin.isTTY lies through bin/sys.js spawn on Windows` — Ink's input loop and the legacy `readline`-based modals already coexist behind the `SYS_INK` flag. Phase 12 keeps both paths working; legacy mode just gets fewer of the new effects.

Also relevant: plan `2026-05-05-phase-9-ink-ui-rewrite.md` (in-progress). Phase 9 built the scaffold — `App.tsx`, `AgentStream`, `ChatInput`, `StatusLine`, `Spinner`, the event bus, `theme.ts`, the agent-events hook. Phase 12 builds **on** that scaffold; it does not restart the rewrite. Phase 9's remaining work folds into Phase 12's stages where natural.

## Affected files

### New modules
- `cli-client/src/ui/animation/use-frame.ts` — 30fps render-tick hook. Single source of truth for "should I redraw" — components subscribe via `useFrame((t) => …)` and get a normalised time `t` they can shape. Auto-pauses when no subscribers; respects `--no-motion`.
- `cli-client/src/ui/animation/easings.ts` — sin/cos breath curves, cubic-out for fade, elastic-out for "settle" transitions. Pure functions over `t ∈ [0,1]`. No deps.
- `cli-client/src/ui/animation/color-lerp.ts` — HSL-space interpolation between palette colors. Handles confidence-warm-to-cool, error-flash-decay, success-pulse. Uses chalk truecolor when available; falls back to nearest-256 on terminals without truecolor (detect via `chalk.level`).
- `cli-client/src/ui/animation/primitives/Breath.tsx` — wraps children in an opacity/intensity pulse at a configurable bpm (default 60). The single-most-reused effect.
- `cli-client/src/ui/animation/primitives/Shimmer.tsx` — gradient sweep across the child's frame. Used on tool cards while running.
- `cli-client/src/ui/animation/primitives/Typewriter.tsx` — char-by-char text reveal with natural pauses (longer on `,`, `.`, `:`). Default speed 250wpm; slows on long tokens to avoid jumpy reveals.
- `cli-client/src/ui/animation/primitives/Fade.tsx` — opacity in/out. Used for collapse/expand and message arrival.
- `cli-client/src/ui/animation/primitives/Pulse.tsx` — scale or color pulse on a discrete event (success ping, error flare). Single-shot, decays via cubic-out.
- `cli-client/src/ui/components/Header.tsx` — persistent top zone: model + chat + confidence badge + chunk-pulse. Always visible; updates without scrolling.
- `cli-client/src/ui/components/ToolCard.tsx` — tool calls render as cards (small bordered boxes) instead of log lines. Shimmering border while running, settles to a muted line when done. Also consolidates the existing `formatToolLabel` + per-tool diff preview behind one component.
- `cli-client/src/ui/components/IdleAmbient.tsx` — ambient drift when the agent is idle and waiting for user input. Slow particle-style unicode glyphs in the cursor row's background. Opt-out via `--no-motion`.
- `cli-client/src/ui/components/Reasoning.tsx` — replaces `cli/reasoning-display.ts`. Reasoning briefs animate in (fade) and collapse to a one-line summary after a few seconds; user can re-expand.
- `cli-client/src/ui/components/OffCourseModal.tsx` — Ink port of `cli/off-course-prompt.ts`. Slide-in animation, focus-pulse on the highlighted key, breath on the divergence-evidence list.
- `cli-client/src/ui/components/PermissionModal.tsx` — Ink port of `cli/permission-prompt.ts`. Same animation language as `OffCourseModal`.
- `cli-client/src/ui/state/motion.ts` — single boolean store for `motionEnabled` (read by every animation primitive). Defaults true; flipped false by `--no-motion` CLI arg or `SYS_NO_MOTION=1` env.

### Extended modules
- `cli-client/src/ui/theme.ts` — extend with `tempo` (heartbeat ms), `easing` (default curves), `gradient` (palette pairs for color-lerp), `spacing` (consistent padding around zones). Single source of truth so a future re-skin only edits this file.
- `cli-client/src/ui/App.tsx` — composes `<Header />` + `<AgentStream />` + `<StatusLine />` + `<ChatInput />` as fixed zones instead of pure scroll. Adds `<MotionProvider>` + `<ThemeProvider>` at the root.
- `cli-client/src/ui/components/AgentStream.tsx` — port the per-event renderer (currently mostly `<Text>`) to use `<ToolCard>`, `<Reasoning>`, animated chunk-progress. Each event becomes a child component that owns its own animation lifecycle (mount = fade-in, settle on completion).
- `cli-client/src/ui/components/StatusLine.tsx` — promote to the bottom living zone: spinner (replaced by `<Breath>`), current focus verb, time elapsed, jobs running, awareness badge, chunk pulse. Updates on every `useFrame` tick.
- `cli-client/src/ui/components/Spinner.tsx` — replace ora-style dot rotation with a breath effect (intensity pulse on a single glyph). Same component swap, no external API change.
- `cli-client/src/ui/components/ChatInput.tsx` — cursor pulse on idle (slow), prompt pulse on keystroke (single-shot), placeholder fade between hints.
- `cli-client/src/agent/events.ts` — extend `AgentEvent` union with structured types: `tool_start` / `tool_end`, `chunk_plan`, `chunk_reflect`, `awareness_update`, `permission_request`, `off_course_request`, `reasoning_brief`. The `log` catch-all stays for unstructured strings during the migration. Each new type carries the data the matching component needs (no parsing strings out of `text`).
- `cli-client/src/agent/agent.ts` — emit the new structured events instead of (or alongside) the existing `console.log` calls. Behind `isInkActive()` check so legacy console mode still works.
- `cli-client/src/cli/render.ts` — keep the `renderConfidenceBadge` and `renderChunkProgress` legacy exports but mark them as the legacy-mode renderer. The Ink path stops calling them.
- `cli-client/src/cli/permission-prompt.ts` + `off-course-prompt.ts` — gain an Ink-mode branch that renders via `<PermissionModal>` / `<OffCourseModal>` instead of raw stdin. Legacy branch unchanged.
- `cli-client/src/index.ts` — parse `--no-motion` flag and set the motion store before the Ink root mounts.

### Tests
- `cli-client/src/ui/animation/__tests__/easings.test.ts` — verify breath curve hits min/max at expected `t` values; cubic-out monotonic.
- `cli-client/src/ui/animation/__tests__/color-lerp.test.ts` — confidence 100→0 produces a continuous HSL path (no flash through black); 256-color fallback returns the nearest palette color.
- `cli-client/src/ui/animation/__tests__/use-frame.test.ts` — subscribers tick at 30fps, auto-pause when no subscribers, motion-disabled mode emits one tick then stops.
- `cli-client/src/ui/components/__tests__/ToolCard.test.tsx` — Ink-test render: shimmering when status=running, settled when status=done, error variant flares.
- `cli-client/src/ui/components/__tests__/Header.test.tsx` — confidence badge color shifts when state flips on_track→off_course→blocked; chunk-pulse increments visibly per chunk.
- `cli-client/src/ui/components/__tests__/Typewriter.test.tsx` — final reveal matches input text; pause durations longer after `,` and `.`; respects motion-disabled (renders full text immediately).
- `cli-client/src/ui/components/__tests__/IdleAmbient.test.tsx` — no glyphs render with motion disabled; particle count caps at the configured maximum.

## Migrations / data

N/A. Pure rendering changes. Event-bus payload shape grows but is additive — legacy `log` events keep working.

## Hooks / skills / settings to update

- No `.claude/hooks/` changes.
- `.claude/knowledge/architecture.md` (post-implementation) — replace the existing chunk-progress / awareness-loop CLI sections' "key files" rows with the new component names.
- `.claude/knowledge/decisions.md` (post-implementation) — record the breath-as-metaphor choice and the animation-tempo defaults so a future contributor doesn't dial them up to "snappy" and break the aesthetic.
- `.claude/knowledge/gotchas.md` (post-implementation) — note the truecolor fallback story and the `--no-motion` contract for accessibility / CI runs.

## Dependencies

- `ink` is already installed (Phase 9 scaffold).
- `chalk` is already installed; relies on its `chalk.level` detection for truecolor capability.
- **No new npm packages.** All animation primitives are <50 LoC each on top of Ink + React state. Resist the urge to pull in `ink-spinner` / `ink-text-input` — we want the animation language to be ours, not a third party's.
- New env var: `SYS_NO_MOTION=1` (alongside the existing `SYS_INK=1`).
- New CLI flag: `--no-motion`.

## Risks & mitigations

- **Animation flicker on slow terminals or over SSH.** Ink re-renders the whole tree on state change; a 30fps tick can stutter on a 5Hz SSH link. Mitigation: cap `useFrame` to 30fps and memoise components by their last-rendered prop set so unchanged subtrees don't redraw. Also: animations only run inside the Header + StatusLine + currently-active ToolCard — settled cards in the stream don't tick.
- **Windows ConHost truecolor support is uneven.** Old conhost shows truecolor as a flat 16-color approximation, which makes color-lerp gradients look like banding. Mitigation: chalk's `chalk.level` already detects this; `color-lerp.ts` falls back to discrete 256-color steps (4 stops between palette colors instead of smooth) when truecolor isn't available. Visual feel degrades but doesn't break.
- **Visual fatigue from constant motion.** "Always animating" is exactly the failure mode that turns alive into annoying. Mitigation: tempo decreases on idle (60bpm active → 20bpm idle); ambient particles are opt-in via flag for users who want them off; the `--no-motion` lever exists for CI / screen-readers / users on principle.
- **Ink reconciliation cost on large streams.** A 200-event scrollback re-rendering every frame would burn CPU. Mitigation: AgentStream renders only the visible window (terminal-rows tall); off-screen events are virtualised. Combined with per-card animation lifecycle (settle → no-tick), CPU should stay <2% sustained.
- **The off-course modal gets used at the worst possible moment.** When the user is already frustrated with a wrong run, an over-animated modal is exactly wrong. Mitigation: modals use the slowest tempo (40bpm); the focus-pulse is on the highlighted key only, not the surrounding box; reduced-motion mode is automatic for any modal that fires within 5s of an error event.
- **Legacy console mode regressions.** Tests run in Vitest where Ink isn't mounted; the legacy `cli/render.ts` path must keep working. Mitigation: every component has a "legacy fallback" — Phase 12 doesn't delete `renderChunkProgress` or `renderConfidenceBadge`, just stops calling them when Ink is active. Existing render tests still pass against the legacy renderer.
- **Color identity drift.** Adding lerps + gradients risks the palette losing its character. Mitigation: `theme.ts` is the only file that names colors; everything else uses semantic tokens (`palette.confidence(state)` not `#F4D03F`).
- **`--no-motion` is hard to test by eye.** It's easy to ship animation primitives that ignore the flag in some code paths. Mitigation: the `<MotionProvider>` is a React context; primitives that try to schedule a tick without consuming it fail a lint rule + a test.

## Implementation order

Each stage is its own PR. Stages 1-3 are foundation (no visible change). Stage 4 is the first user-visible win. Stages 5-8 layer on the rest.

### Stage 1 — Animation foundations + theme extension (no visible change)
1. `ui/animation/use-frame.ts` — the 30fps tick hook with auto-pause + motion-disabled handling.
2. `ui/animation/easings.ts` — pure curves (breath, cubic-out, elastic-out).
3. `ui/animation/color-lerp.ts` — HSL interpolation + chalk-level fallback.
4. `ui/state/motion.ts` — `motionEnabled` store; CLI flag + env wiring in `index.ts`.
5. `ui/theme.ts` extension — `tempo`, `easing`, `gradient`, `spacing` tokens; semantic accessors (`palette.confidence(state)`).
6. Tests for easings + color-lerp + use-frame.
7. **Behaviour: nothing changes for users.**

### Stage 2 — Animation primitives + theme/motion providers
1. `<Breath>` / `<Pulse>` / `<Shimmer>` / `<Typewriter>` / `<Fade>` components, each <80 LoC.
2. `<MotionProvider>` + `<ThemeProvider>` in `App.tsx`.
3. Each primitive renders its child raw when `motionEnabled === false`.
4. Storybook-style smoke tests in vitest using ink-testing-library.
5. **Behaviour: nothing changes for users.**

### Stage 3 — Living StatusLine + breath spinner
1. Replace `<Spinner>`'s rotating-dots with a breath effect on a single glyph.
2. Promote `<StatusLine>` to a multi-cell layout: `[breath] focus-verb · time · jobs · awareness · chunk·N`.
3. Time + jobs + awareness all subscribe to `useFrame` via the events bus (no polling).
4. Tempo of breath increases when a tool is running, decreases on idle.
5. **First user-visible win (small):** the bottom row is alive; the rest of the screen is unchanged.

### Stage 4 — Tool cards + AgentStream port
1. `<ToolCard>` renders a tool call as a small bordered card. States: `running` (shimmering border, breath on label), `success` (settled muted line, single success-pulse on transition), `error` (warm flare on transition, then settled red border).
2. `<AgentStream>` consumes the new structured events (`tool_start`, `tool_end`) and renders cards instead of log lines for tool turns.
3. `agent.ts` emits the structured events behind `isInkActive()`.
4. Card mount/unmount uses `<Fade>`. Settled cards stop ticking.
5. AgentStream window-virtualises off-screen events.
6. **Visible win:** every tool call now has a "lifetime" the user can see.

### Stage 5 — Header zone + persistent confidence badge
1. New `<Header>` component: model · chat · awareness badge · chunk·N pulse · token preview.
2. Awareness badge color-lerps between palette stops (green → yellow → red) via Stage 1's color-lerp instead of switching glyphs cold. Glyph stays as fallback for `--no-motion`.
3. Chunk pulse (a single dot or short bar) ticks once per new chunk_plan event.
4. App.tsx layout: `<Header>` (1-2 rows) on top, `<AgentStream>` middle, `<StatusLine>` + `<ChatInput>` bottom. Header + StatusLine are sticky; only AgentStream scrolls.
5. **Visible win:** the user always sees current state without scrolling up.

### Stage 6 — Streaming text + Reasoning component
1. `<Typewriter>` applied to AI message content in `<AgentStream>` (long-form completions, summaries).
2. `<Reasoning>` replaces the legacy reasoning-display: animates in via `<Fade>`, auto-collapses to a one-liner after 8s, expands on Tab.
3. The chunk-progress "▸ next action" gains a `<Pulse>` on transition between chunks (single-shot, cubic-out).
4. **Visible win:** AI output reads like writing, not loading.

### Stage 7 — Modal redesign + idle ambient
1. `<PermissionModal>` + `<OffCourseModal>` as Ink components: slide-in from below (Fade + position offset), focus-pulse on the highlighted key, breath on the evidence list.
2. Modals use the slowest tempo (40bpm); reduced-motion mode is auto-engaged when the modal fires within 5s of an error event.
3. `<IdleAmbient>` ships behind `--ambient` flag (off by default for v1): slow drift of unicode particles in the cursor's background row when the agent is waiting for user input >10s. Disabled by `--no-motion`.
4. Cursor pulse on the chat prompt; placeholder hint fades between rotating tips.
5. **Visible win:** modals feel composed; idle feels inhabited.

### Stage 8 — Polish, perf, accessibility, docs
1. Profile a 2-minute run: target sustained <2% CPU for animations. Frame-skip hook if any subtree exceeds budget.
2. Document the animation language in `.claude/knowledge/decisions.md` (the breath-metaphor choice + tempo defaults).
3. Document the truecolor fallback + `--no-motion` contract in `gotchas.md`.
4. Side-by-side before/after recordings under `docs/ui/phase-12/`.
5. Verify on Windows Terminal + iTerm2 + Alacritty + plain xterm + a CI tty.

## Verification

Per stage:
- `npm run typecheck` clean
- `npm test` — all new component tests pass; existing legacy tests unaffected.

End-to-end (after Stage 4, then re-checked at Stage 8):
- **Test 1 — alive at idle.** Launch `sys` and don't type. The bottom-row breath should pulse continuously; the chat prompt cursor should pulse; no other motion. Verify `--no-motion` freezes everything to a static frame.
- **Test 2 — alive at work.** Start an `/implement` task. Tool cards should appear, shimmer while running, settle on completion. Header awareness badge color should shift smoothly through `on_track → off_course` if the run drifts. Chunk pulse should tick on each new chunk_plan.
- **Test 3 — error flare.** Trigger a tool error (e.g. `cd nonexistent`). The matching tool card should flare warm, then settle into a red-bordered settled state. Status line shouldn't shake or strobe.
- **Test 4 — modal composure.** Force an off-course modal (`SYSFLOW_FLAG_AWARENESS_THRESHOLD_BLOCKED=80` to trip easily). Modal should slide in, focus-pulse on `[c]`, evidence list breathing slowly. Pick `r` and verify focus moves smoothly to the input.
- **Test 5 — terminal compatibility.** Run against Windows Terminal (truecolor), legacy ConHost (256-color fallback path), tmux session (truecolor), CI tty (motion auto-disabled because no `TTY`).
- **Test 6 — perf.** During a multi-chunk run, sample CPU at 1Hz. Sustained <2% on the renderer process. No frame > 33ms (30fps budget).

Aesthetic checks (subjective but worth naming):
- The CLI never feels frozen for >250ms while the agent is doing work.
- Idle screens never look dead — there's always *something* breathing.
- Color shifts are smooth, never abrupt; no glyph swap without a transition.
- Animations stop when there's no reason to animate (settled cards don't tick; idle slows to 20bpm).

## Out of scope

- Cross-platform parity beyond what chalk + Ink already give us (no native ConPTY direct integration).
- Web/TUI hybrid (no `ratatui`-style canvas, no embedded charts).
- Sound / audio cues — terminal-bell only on critical errors; no proactive sound design.
- Mouse support (Ink supports it but we're keystroke-only by design — the agent flow doesn't benefit from clicks).
- Theming / user-configurable palettes. The theme is opinionated. A `--theme dim` mode is fine if requested later but not v1.
- Replacing the legacy console mode entirely — `SYS_INK=0` keeps the existing `console.log` renderer; this plan does NOT delete it. (Phase 9's eventual goal is to make Ink the default; that's a separate decision and a separate PR.)

## Foundation iteration policy

Phase 12 leans on Phase 9's Ink scaffold and Phase 11's awareness event stream. **If the foundation has a gap, fix it.** Likely gaps that may surface:

- **Event bus payload shape.** Stage 4 needs `tool_start` / `tool_end`; Stage 5 needs `awareness_update`; Stage 6 needs `reasoning_brief`. If multiple components want different slices of the same data, factor a typed event-builder helper rather than inline-shaping each callsite.
- **Legacy mode test coverage.** Phase 12 risks regressions in the `SYS_INK=0` path because the agent.ts emit-conditionals are spread across many lines. If Stage 4 reveals brittleness, factor a `surface(event)` helper that fans out to console.log OR emitAgent based on `isInkActive()` — single chokepoint.
- **Theme accessors.** If multiple components reach for `palette.warning` directly when they semantically mean "off-course state", grow `palette.confidence(state)` and friends; semantic tokens beat raw colors.
- **Animation contract.** If a primitive needs to read time-since-mount and we end up implementing per-component clocks, factor a `useElapsed()` hook instead — the pattern recurs.

These count as in-scope foundation work for whichever stage surfaces the gap. Out-of-scope is anything that's *not* a downstream consequence of this phase (e.g. don't redesign the slash-command parser here just because we're touching `cli/`).

## Composition with Phase 9 (additive, not restart)

Phase 9 (Ink rewrite) is in-progress and built the scaffold this plan stands on. Phase 12 is **additive** — every Phase 9 component (`AgentStream`, `ChatInput`, `StatusLine`, `Spinner`) gets an animation pass and a few are extended (StatusLine grows cells, AgentStream gets card events) but none are deleted. Phase 9's remaining work (multiline input history, slash-command palette polish — see its plan) folds into Phase 12 stages where natural; the Phase 9 plan can be marked `superseded by Phase 12` once Stage 8 lands and we're sure the migration is complete.

The Phase 12 design language — breath, persistent zones, color-as-state — is what Phase 9's scaffold was *missing*. Phase 9 made it possible to render React components in a terminal; Phase 12 decides what those components should *feel* like.
