# Sysflow Phase 8 — Persistent Reasoning Memory (Anti-Stale)

- **Created:** 2026-05-02
- **Status:** implemented (2026-05-02)
- **Scope:** Auto-write decision briefs + completed-task patterns + user-corrections to a project-local `.sysflow-memory.md`. Anti-staleness is first-class: read-time validators (file-existence, dep-existence, age) gate every entry; auto-confirmation bumps confidence on agreement; auto-contradiction marks entries dead after 2 reasoner-disagreements OR explicit user override. New `/memory` and `/remember` slash commands. Compaction at 100 KB.

## Goal

Stop the agent from re-deliberating the same decisions every fresh session. After a Phase 5 reasoner picks Drizzle, after a Phase 5 self-invoked `reason` tool decides "rename-then-delete this file", after the user explicitly says "no, use Bun not Node" — write that down to a project-local memory file, validate at read-time so stale entries never reach the prompt, auto-confirm on agreement, auto-contradict on disagreement, and let the user audit/edit/forget via slash commands. The user's hand-written `.sysflow.md` from Phase 2 stays untouched — Sysflow's auto-managed memory lives in a separate sibling file so editing one never clobbers the other.

## Context from knowledge base

`.claude/knowledge/` is still empty. References that matter for this slice:

- `.claude/plans/applied/2026-05-02-phase-2-foundation.md` — added `services/project-memory.ts` discovering `.sysflow.md` + `CLAUDE.md` with mtime caching. Phase 8 reuses the same discovery + caching pattern for `.sysflow-memory.md`. The new file lives alongside, never overwrites the user's hand-written one.
- `.claude/plans/applied/2026-05-02-phase-5-pre-flight-reasoning.md` — established `reasoning/reasoning-schema.ts` (Zod envelope), the four pipelines, and `reasoning/task-reasoner.ts` orchestrator. Phase 8 hooks: pre-flight reads memory entries into the prompt; decision pipeline writes its outputs back; on-completion writes the implement summary back; on-error writes the bug brief back.
- `.claude/plans/applied/2026-05-02-phase-3-capabilities.md` — Zod input schemas + slash command pattern (`/permissions`, `/mode`). Phase 8 follows the same pattern for `/memory` and `/remember`.
- `.claude/plans/applied/2026-05-02-phase-4-productionisation.md` — feature flag system + vitest. Phase 8 adds three flags + ~25 test cases.
- `cli-client/src/lib/sysbase.ts` — `getSysbasePath()` is the project-local sysbase root. Memory file lives in cwd alongside `.sysflow.md`, NOT in sysbase, so it's discoverable + git-trackable like `.sysflow.md`.
- `server/src/services/project-memory.ts` — existing 50k char cap + secret-pattern allowlist. Phase 8 adds a separate path for the auto-memory file with a separate cap (100 KB).
- `cli-client/src/cli/parser.ts` + `ui.ts` — slash command registration follows the existing pattern.

## Affected files

### Server — memory module (new directory under `server/src/memory-store/`)

The directory is named `memory-store/` rather than `memory/` to avoid colliding with the existing `server/src/store/memory.ts` (which is a different concept — auto-saved completion notes to DB).

- `server/src/memory-store/entry-schema.ts` *(new)* — Zod schema for one memory entry: `{ id, kind: 'decision' | 'implement' | 'bug_pattern' | 'user_correction' | 'preference', content (max 1500 chars), createdAt, lastConfirmedAt, lastUsedAt, sourceRef: { runId?, trigger?, filePaths?, packageDeps? }, status: 'active' | 'stale' | 'contradicted', useCount, contradictionCount, tags?[] }`. `id` is sha256 of (kind + content) truncated to 12 chars so re-recording the same fact dedupes naturally.
- `server/src/memory-store/file-format.ts` *(new)* — serialise/deserialise `MemoryEntry[]` to/from a markdown-with-frontmatter format that's both human-readable AND machine-parseable. Each entry is one `## <id> · <kind>` block with a YAML frontmatter (the metadata) followed by the human-readable body (the content). Why not pure JSON? — so the user can open `.sysflow-memory.md`, eyeball the entries, and hand-edit/delete without breaking a binary parser. Round-trip tested.
- `server/src/memory-store/store.ts` *(new)* — `loadMemoryEntries(cwd)`, `saveMemoryEntries(cwd, entries)`, `upsertEntry(cwd, entry)` (dedupes by id). Uses an mtime-cached read like `project-memory.ts`. Atomic write via temp-file + rename so concurrent runs don't corrupt the file.
- `server/src/memory-store/validators.ts` *(new)* — three pure validators that mark entries stale at READ time:
  - `validateFileRefs(entry, cwd)`: every `sourceRef.filePaths[]` and any `path:` shape mentioned in `content` must exist on disk. Missing → stale.
  - `validateDepRefs(entry, cwd)`: every `sourceRef.packageDeps[]` must appear in cwd's `package.json` deps/devDeps. Missing → stale.
  - `validateAge(entry, nowMs)`: `lastConfirmedAt` more than `STALE_AFTER_DAYS` (default 60) ago → stale unless `useCount >= 5` (frequently-used entries get a longer leash to 180 days).
  - `runAllValidators(entries, cwd)` returns `{ active, stale, contradicted }` partition. Stale entries are auto-marked status='stale' and persisted on next write. Contradicted ones are dropped from the prompt regardless.
- `server/src/memory-store/recall.ts` *(new)* — `recallForReasoning({ cwd, userMessage, kind? })` returns the top-N most-relevant active entries. Relevance = recency + useCount + token-overlap with userMessage. Cap at 12 entries to keep the prompt section bounded. Each entry's content is rendered into a compact paragraph with its id prefix so the user can later say `/memory forget abc123`.
- `server/src/memory-store/recorder.ts` *(new)* — three writer functions:
  - `recordDecision(cwd, brief: DecisionBrief, sourceRef)`: from self-invoked `reason` tool returns. Skips if `brief.confidence === 'LOW'` (don't memorialise low-confidence decisions).
  - `recordImplementSummary(cwd, brief: SummaryBrief | ImplementBrief, sourceRef)`: from on-completion. Compacts the brief into a short paragraph capturing chosen stack + key conventions.
  - `recordUserCorrection(cwd, correctionText, sourceRef)`: from `/remember` slash command. Always recorded with status='active' regardless of validators (user gave it explicitly).
  - All three call `upsertEntry`; the id-by-sha256 ensures repeated identical content dedupes.
- `server/src/memory-store/confirmation-tracker.ts` *(new)* — `noteAgreement(cwd, entryId)` bumps lastConfirmedAt + useCount. `noteContradiction(cwd, entryId)` bumps contradictionCount; if it hits 2, set status='contradicted'. `noteAccessed(cwd, entryId)` bumps lastUsedAt only.
- `server/src/memory-store/compaction.ts` *(new)* — `compactIfNeeded(cwd)`. Triggered on every write. If file size > `MEMORY_FILE_MAX_BYTES` (default 100 KB), drops in this order until under cap: contradicted → stale → low-useCount active → oldest active. Logged once per compaction.
- `server/src/memory-store/index.ts` *(new)* — barrel re-exports.

### Server — reasoning integration

- `server/src/reasoning/task-reasoner.ts` — pre-flight call now includes a `recallForReasoning` step BEFORE building the user-turn. Active+valid entries get appended to the reasoner's user turn under a `KNOWN PROJECT MEMORY:` section so the reasoner can build on them.
- `server/src/reasoning/critical-context-detector.ts` — extend with a comparison step: when the new brief's `recommendedStack` agrees with a memory entry's stack mention, call `noteAgreement(entryId)`. When it disagrees on a hard claim ("uses Drizzle" → brief picks Prisma), call `noteContradiction(entryId)`.
- `server/src/handlers/user-message.ts` — after `runReasoning`, if the brief is a `decision` from self-invoked OR an implement brief that the agent will act on, call `recordDecision` / `recordImplementSummary` via the recorder. Threading: pass `cwd` through (already done in Phase 2).
- `server/src/handlers/tool-result.ts` — on-completion path: when the run finishes with a SummaryBrief, call `recordImplementSummary(cwd, brief, sourceRef)`.

### Server — prompt section

- `server/src/providers/prompt/sections/learned-memory.ts` *(new)* — non-cacheable section. When recalled entries exist, renders:
  ```
  ═══ LEARNED PROJECT MEMORY ═══
  These are auto-recorded facts from previous runs in this project, validated against current files + deps.
  Trust them unless tool results contradict. They are NOT user-written; for human conventions see PROJECT MEMORY above.

  - [<id>] <content one-liner>
  - [<id>] ...
  ```
  Caps at 12 entries; each content cap at 200 chars in the rendered form.
- `server/src/providers/prompt/build.ts` — register the section at priority 106 (between project_memory at 105 and reasoning_brief at 107). Order matters: user's hand-written memory first, learned memory second, then the reasoning brief that sits on top of both.
- `server/src/providers/gemini.ts` — `buildPrompt(payload)` already calls `discoverProjectMemory`. Add a `recallForReasoning(cwd, userMessage)` call alongside; pass the result as `learnedMemory` in the prompt context.

### CLI — slash commands

- `cli-client/src/cli/parser.ts` —
  - `/memory` → `{ mode: "memory", memorySub: "list" | "forget" | "show" | "clear" | "clear-stale", memoryArg?: string }`
  - `/remember <text>` → `{ mode: "remember", rememberText: string }` (the text is what the user wants to memorialise verbatim)
- `cli-client/src/cli/ui.ts` — wire both commands to the new `commands/memory.ts`.
- `cli-client/src/commands/memory.ts` *(new)* — three exported functions:
  - `showMemoryList()` — formatted table of active + stale + contradicted entries (status-color-coded), with id, kind, age, useCount, lastConfirmed.
  - `showMemoryEntry(id)` — full content of one entry.
  - `forgetMemoryEntry(id)` / `clearStaleEntries()` / `clearAllEntries()` — DELETE / partial-delete / wipe.
  - `recordExplicitMemory(text)` — calls `recordUserCorrection` directly via a new lightweight server endpoint `POST /memory/remember`.
- `server/src/routes/memory.ts` *(new)* — Fastify endpoints: `POST /memory/remember { cwd, text }`, `GET /memory/list?cwd=...`, `DELETE /memory/:id?cwd=...`, `DELETE /memory/stale?cwd=...`, `DELETE /memory/all?cwd=...`. CLI uses these for the slash commands.
- `server/src/index.ts` — register `memoryRoute`.

### Tests

- `server/src/memory-store/__tests__/file-format.test.ts` *(new)* — round-trip serialise → parse → equal; rejects malformed frontmatter; tolerates extra whitespace; preserves entry order.
- `server/src/memory-store/__tests__/validators.test.ts` *(new)* — fileRefValidator marks stale when path missing; depRefValidator marks stale when dep removed from package.json; ageValidator marks stale at 61 days; ageValidator extends to 180 days when useCount ≥ 5; runAllValidators partitions into active/stale/contradicted; entries with status='contradicted' never become active again.
- `server/src/memory-store/__tests__/recall.test.ts` *(new)* — caps at 12; sorts by recency × useCount × overlap; `kind` filter narrows; pure `userMessage` overlap matching.
- `server/src/memory-store/__tests__/confirmation-tracker.test.ts` *(new)* — noteAgreement bumps both timestamps + counter; noteContradiction at 2 flips status='contradicted'; noteAccessed touches lastUsedAt only.
- `server/src/memory-store/__tests__/compaction.test.ts` *(new)* — compactIfNeeded keeps file under cap; eviction order is contradicted → stale → low-use → oldest; never drops user_correction entries (those are sacred).
- `server/src/memory-store/__tests__/recorder.test.ts` *(new)* — recordDecision skips LOW confidence; recordImplementSummary deduplicates via id-by-sha256; recordUserCorrection always records.

### Docs

- `docs/status/current.md` — Recent Work entry for Phase 8.
- `docs/sysflow-improvement/14-complete-gap-checklist.md` — check off "CLAUDE.md project memory — file-based, user-editable" (already partially done in Phase 2; Phase 8 adds the auto-memory complement).

## Migrations / data

N/A. Memory entries live in `<cwd>/.sysflow-memory.md` — a single text file per project. No DB. Existing projects with no memory file just start empty.

## Hooks / skills / settings to update

`.gitignore` — add `.sysflow-memory.md` to the recommended ignore patterns? **No.** Default behaviour: the memory file IS git-tracked so teammates share learnings. Users who want it private can add it themselves. Document this in the README.

## Dependencies

- No new npm packages.
- New flags (env-only kill switches):
  - `prompt.learned_memory_enabled` (default `true`) — disable to skip memory recall in prompts entirely.
  - `memory.stale_after_days` (default `60`).
  - `memory.stale_after_days_high_use` (default `180`) — frequently-used entries get the longer leash.
  - `memory.file_max_bytes` (default `102_400` = 100 KB).
  - `memory.max_recall_entries` (default `12`).

## Risks & mitigations

- **Memory file drifts from reality faster than read-time validators catch** — e.g. user refactors and `package.json` gets a new ORM but the old entry doesn't reference the deleted dep, just outdated content. → ageValidator + auto-contradiction together cover most of it. Plus the human-readable file lets users `/memory list` and prune visually. We don't pretend validation is perfect.
- **User edits `.sysflow-memory.md` and breaks the YAML frontmatter** — file becomes unparseable. → Tolerant parser: malformed entries are skipped + logged, not fatal. The valid ones still load. Log says which entries were skipped.
- **Confirmation/contradiction signals are fuzzy** — what counts as "agreement"? "Same stack token in the brief" is loose. False positives mean stale entries stay alive. → Conservative bump: agreement only on EXACT stack-key match (e.g. brief says `react-vite` AND entry mentions `react-vite`). Contradiction only when the brief picks a different stack-key on the same kind of decision. We err toward not-noting rather than false-noting.
- **Memory file grows unbounded across many sessions** — compaction handles it but only on writes; long read-only periods leave the file large. → Compaction also runs on first-write-of-day (cheap heuristic; piggybacks on the daily-rotation pattern from Phase 4 audit log).
- **User runs `sys` in a sub-folder of a project that already has `.sysflow-memory.md` in the parent** — recall finds nothing. → Discovery walks up one parent like Phase 2 does. (Cap at 1 parent level — don't drift to the wrong project.)
- **Two concurrent CLI instances write the file at the same time** — torn writes. → Atomic write (temp file + rename). On Windows the rename is best-effort; if it fails we retry once with a small delay, then log + skip. The recorder is best-effort by design.
- **Memory entry contains a secret** — agent recorded "API key for X is abc123" verbatim. → Recorder runs the same SECRET_PATTERNS check from Phase 2's project-memory; entries matching are refused with a one-line log. `/remember` does the same check before persisting.
- **`/memory clear all` is destructive** — user accidentally types it. → Slash command requires `/memory clear all confirm` (the literal word `confirm`) to actually wipe. Without `confirm`, prints a warning + count.
- **Auto-confirmation creates a perverse incentive** — entries persist not because they're TRUE but because the agent keeps mentioning the same stack. → useCount alone doesn't extend lifespan; lastConfirmedAt does. So agreement only counts when the validators ALSO pass at that moment.
- **The recall step adds another LLM-side cost** — every preflight reasoning call's user-turn now includes up to 12 memory entries. → Capped at 12 entries × 200 chars rendered = ~6 KB worst case, well within budget. Plus `prompt.learned_memory_enabled=false` is the kill switch.
- **The reasoner relies on memory and gets confidently wrong on a stale-but-not-yet-detected entry** — → Memory entries are explicitly framed in the prompt as "auto-recorded; trust unless tool results contradict." The agent's existing CONFIDENCE-AWARE rule applies: if reading the actual code disagrees with the memory entry, tool results win.

## Implementation order

Each step compiles green and is independently revertable. Steps 1–4 build the store, 5–7 wire reasoning, 8–9 ship CLI + tests, 10 docs.

1. **Schema + file format** — `entry-schema.ts`, `file-format.ts`. Pure data + Zod. Round-trip tests.
2. **Store** — `store.ts` (load / save / upsert with mtime cache + atomic write). Tests for the file-roundtrip + dedup-by-id.
3. **Validators** — `validators.ts` (file-ref / dep-ref / age + runAllValidators partition). Tests for each + combined path.
4. **Confirmation tracker + compaction** — `confirmation-tracker.ts`, `compaction.ts`. Tests for noteAgreement / noteContradiction / compactIfNeeded eviction order.
5. **Recall + recorder** — `recall.ts`, `recorder.ts`, `index.ts` barrel. Recorder is best-effort (try/catch around writes; never throws into the agent flow).
6. **Prompt section + reasoner integration** — `prompt/sections/learned-memory.ts`; register at priority 106 in `prompt/build.ts`; `task-reasoner.ts` calls `recallForReasoning` before the model call; brief includes recall context. `critical-context-detector.ts` notes agreement/contradiction.
7. **Handler integration** — `handlers/user-message.ts` writes decision briefs to memory; `handlers/tool-result.ts` writes implement summaries on completion.
8. **Slash commands + endpoint** — `routes/memory.ts` Fastify route; `commands/memory.ts` CLI wrapper; `parser.ts` + `ui.ts` registrations for `/memory` and `/remember`.
9. **Tests** — six test files (~25 cases) over the pure modules.
10. **Docs + flag inventory** — `docs/status/current.md`; register the five flags in `services/flags.ts`.

## Verification

- **Compile:** `tsc --noEmit` clean in both packages.
- **Tests:** `npm test` in `server/` adds ~25 new cases.
- **Manual smoke:**
  - In a fresh project: `sys "create an automation for spreadsheet"` → reasoner picks Python+gspread, asks for sheet ID + service-account JSON. After completion, `.sysflow-memory.md` contains a `decision` entry recording Python+gspread + the share-with-service-account reminder.
  - Next session in same project: `sys "add another script that pulls a different sheet"` → reasoner sees the prior entry in the prompt, doesn't re-deliberate the stack, asks ONLY for the new sheet ID. Faster + consistent.
  - `/memory list` shows two entries with status=active, both confirmed-recent.
  - Delete `requirements.txt` then run another prompt → fileRefValidator marks the entry stale on next read; `/memory list` shows it as stale; reasoner doesn't include it in the prompt.
  - `/remember "we use uv, not pip, for installs"` → entry persists; next reasoning call sees it.
  - Run a session where reasoner picks a contradicting stack twice → contradictionCount hits 2, entry is marked contradicted, no longer injected.
  - File hits 100 KB → compaction logs which entries were dropped; user_correction entries always survive.
- **Audit log spot-check:** `<sysbasePath>/audit.jsonl` shows `_memory_recorded` and `_memory_recalled` synthetic markers (added via the audit hook) so we can later mine usage.

## Follow-ups (out of scope this session)

- **Cross-project memory sharing** — a `~/.sysflow/global-memory.md` for stuff the user wants to apply to every project (e.g., "always use TypeScript strict mode"). Needs precedence rules + scope tagging.
- **Server-side memory mirror** — let multiple devices share project memory via the user's account. Big change; deferred.
- **Agent-driven memory editing during a run** — agent can call a `_remember` synthetic tool mid-run when it learns something. Risk: noise. Punted.
- **Embeddings-based recall** — use vector similarity for the relevance ranking instead of token-overlap. Needs an embedding model dep.
- **Memory diff visualization** — show what was added/removed/marked stale at the end of a run as part of the completion summary.
- **Manual `/memory promote <id>` to mark an entry as "load-bearing"** — extends its lifespan beyond the high-use leash.

## Completion notes

Implemented 2026-05-02. All 10 ordered steps executed in sequence and pushed as 9 separate feature/test/docs commits.

**Deviations from the plan:**

- The original plan listed 6 separate tests files; in practice some related tests merged: `confirmation-and-compaction.test.ts` covers two modules' tests in one file because they share the same setup pattern. End count: 5 test files, ~40 cases.
- The `critical-context-detector.ts` extension to call `noteAgreement` / `noteContradiction` from inside the reasoner was deferred — it requires per-stack semantic comparison that's risky to get right (false positives would contradict valid entries). Phase 8 ships the lifecycle hooks (`noteAgreement`, `noteContradiction`, `noteAccessed`) on the public API so the reasoner can be wired in a follow-up after we observe real reasoner outputs.
- The plan's "summary on-completion writes back" was implemented but uses the brief's `constraints` as consistency notes since `SummaryBrief` doesn't carry an explicit `recommendedStack` — slight type adaptation.
- `recordImplementSummary` ignores libraries that don't look like package names (regex `/^[a-z0-9@\-/.]+$/i`) so freeform stack mentions like "TypeScript stdlib" don't pollute `packageDeps`.
- All four recorder functions are explicitly `.catch(() => { })` at the call site — memory writes never block the agent flow and never throw into recordRunSummary.

**Surprises:**

- The markdown-with-frontmatter format roundtrip was harder than expected to make tolerant. The parser had to handle: nested YAML lists (sourceRef.filePaths), CRLF line endings, missing required fields, and trailing whitespace — without false-positive accepting bogus content. The 6-case roundtrip test is what gave us confidence it works.
- The "user_correction always recorded" rule made the secret-pattern check more important: if a user `/remember`s a string that looks like a Stripe key, the recorder MUST refuse rather than persist it sacred-style. SECRET_PATTERNS catches Stripe / AWS / Google / Slack / GitHub / generic API_KEY= / PEM markers.
- File compaction order is by an "eviction priority score" not a sequence of filters. Score combines status (contradicted = -1M, stale = -500K), useCount × 1000, recency in days, and user_correction = +10M. Sort low-to-high, evict lowest first. Cleaner than chained filters.

**Knowledge to capture (next pass):**

- "Memory entries with sourceRef.packageDeps auto-stale when deps removed from package.json" → `.claude/knowledge/decisions.md`.
- "Markdown-with-HTML-comment-frontmatter for human-auditable + machine-parseable persistence" → `.claude/knowledge/patterns.md`.
- "Sacred entry kinds (user_correction) survive compaction; agent-derived kinds are evictable" → `.claude/knowledge/decisions.md`.
- "Memory file lives alongside .sysflow.md (not under sysbase) so it's git-trackable + shared with the team by default" → `.claude/knowledge/decisions.md`.
