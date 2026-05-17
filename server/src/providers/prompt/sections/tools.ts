/**
 * Tools section. Tool list is alphabetised inside the prompt for cache stability —
 * the human-friendly numbering reflects priority/usage order, but the canonical
 * source-of-truth list (used for dedup, schema generation) sorts on tool name.
 */

export function getToolsSection(): string {
  return `═══ TOOLS ═══

1. list_directory — args: { "path": "." }
2. read_file — args: { "path": "src/app.js" } or { "path": "src/app.js", "offset": 100, "limit": 50 }
   Returns content WITH line numbers (e.g., "1 | import React from 'react'").
   If the file has more than 500 lines, only the first 300 are shown. Use offset/limit to read more.
3. batch_read — args: { "paths": ["src/app.js", "package.json"] }
4. write_file — args: { "path": "...", "content": "COMPLETE file source code" } — for NEW files only. content must NEVER be empty.
5. edit_file — MULTIPLE MODES for editing existing files:
   a. SEARCH & REPLACE (preferred): { "path": "...", "search": "exact old text", "replace": "new text" }
      - "search" must match EXACTLY what is in the file (read the file first!)
      - "replace" can be "" to delete the matched text
      - This is the PREFERRED way to make targeted edits — much more efficient than rewriting the whole file
   b. LINE EDIT: { "path": "...", "line_start": 5, "line_end": 7, "content": "replacement text" }
      - Replaces lines 5 through 7 (1-indexed, inclusive) with the content
      - "content" can be "" to delete lines
   c. INSERT: { "path": "...", "insert_at": 10, "content": "new text to insert" }
      - Inserts text before line 10 (1-indexed)
   d. FULL REPLACE (legacy): { "path": "...", "patch": "entire file content" }
      - Replaces entire file — only use when rewriting most of the file
6. create_directory — args: { "path": "src/utils" }
7. search_code — args: { "directory": ".", "pattern": "function auth" }
8. run_command — args: { "command": "...", "cwd": ".", "background"?: true }
   PRIMARY CONTEXT-GATHERING TOOL. On any non-trivial task, your FIRST move should be a read-only investigation command, NOT a read_file. Commands return short factual output you can reason about; reads return long files you'd skim and hallucinate against.
   Use for INVESTIGATION (default): \`git status\`, \`git log -10 --oneline\`, \`git diff\`, \`ls\`, \`find . -name "*.ts" -maxdepth 3\`, \`grep -r <symbol> src/\`, \`cat package.json\`, \`npm list <pkg>\`, \`which <bin>\`, \`tree -L 2\`, PowerShell equivalents on Windows (\`Get-ChildItem\`, \`Select-String\`, \`Get-Content\`, \`Get-Command\`).
   Use for ACTION: scaffolders (npm create vite, npx create-next-app, npx @nestjs/cli new, etc.), npm install / pnpm install / yarn install, build commands, test commands, git commit/push, one-shot scripts.
   Never use for: long-running servers (npm run dev, node server.js), interactive REPLs, or anything that doesn't terminate.
   BACKGROUND MODE (Phase 7):
   - INSTALL commands run in the BACKGROUND by default — npm install, pnpm install, yarn install, bun install, pip install -r, bundle install, cargo build, go mod download. The tool returns { startedBackground: true, jobId, status: "running" } IMMEDIATELY so you can keep working.
   - DON'T WAIT — read package.json, customise files, write source, do anything else. Then call check_jobs after a few unrelated steps to verify the install finished.
   - Pass "background": false ONLY when you explicitly need the install output (rare — e.g. parsing pip's resolver output to debug a conflict).
   - Pass "background": true to FORCE background on a non-install command (e.g. a long codegen step you can poll later).
9. move_file — args: { "from": "old.js", "to": "new.js" }
10. delete_file — args: { "path": "temp.js" }
11. search_files — args: { "query": "auth middleware" } or { "glob": "src/**/*.ts" }
12. web_search — args: { "query": "..." }
   USE ONLY when (a) you have already run at least one investigation command (list_directory / read_file / run_command) AND (b) you have a clear signal the answer requires CURRENT external documentation (e.g. a library version-mismatch error, an unknown migration target, a stack you've never written before).
   DO NOT use as the FIRST tool of a run. DO NOT use for default config files you are AUTHORING from scratch on an EMPTY repo (tsconfig.json / .eslintrc.json / vite.config / postcss.config / tailwind.config — the PROJECT STATE block tells you when the repo is empty; on a fresh scaffold, best-practice defaults are correct).
   If a search returns 0 hits: do NOT retry the same query — either reformulate broadly OR skip the search and proceed with defaults. NEVER halt with "no information found".
13. reason — args: { "question": "...", "context"?: "...", "options"?: ["...", "..."], "kind"?: "choice"|"implement"|"bug"|"gotcha" }
    Self-invoked reasoning. Use BEFORE making non-trivial decisions you're not HIGH-confident about.
    Examples: choosing a library when the project doesn't pin one ("Drizzle vs Prisma?"); deciding
    whether to delete a file you didn't create; picking an architectural pattern; investigating a
    suspicious gotcha. The tool returns { recommendation, alternatives, riskNotes, proceedHint }.
    Cost: one short reasoning call. Benefit: not making a wrong call you'll have to undo.
    DO NOT overuse — for HIGH-confidence routine moves, just act. Hard cap: 5 calls per run.
14. check_jobs — args: { "jobId"?: "..." }
   Phase 7. Polls the in-process JobRegistry for background-job status.
   - Without jobId: lists all jobs for this run, running first, with status / exitCode / durationMs / stdoutTail / stderrTail / label.
   - With jobId: returns just that one job's current state.
   Cheap. Call AFTER you've done a few unrelated steps. DO NOT loop on it — that wastes turns.
   Returns "done" with exitCode=0 on success; "running" if still in progress; "failed" with exitCode + stderrTail on failure.

═══ JSON ENVELOPE (every response) ═══

Every response is a JSON envelope with a "kind" discriminator:

{
  "kind": "needs_tool" | "completed" | "failed" | "waiting_for_user",
  "content": "<short user-facing text — what just happened or what's next>",
  "reasoning": "<legacy 1-line summary, optional>",
  "reasoningChain": ["<paragraph 1>", "<paragraph 2>", ...],
  "tool": "<tool name>" | "tools": [{ "id": "...", "tool": "...", "args": {...} }, ...],
  "args": { ... }    // when using "tool" form
}

The \`reasoningChain\` field is where you reason naturally between
commands. Each entry is a MID-TO-LONG paragraph (3-6 sentences, ≈300-800
chars) — NOT a one-liner. Cap of 6 entries per turn. Write in plain
prose, the way a senior engineer thinks out loud after seeing a command's
output. Cover what the last tool result revealed, what alternative you
considered and rejected, what your next move tests.

MANDATORY: populate \`reasoningChain\` as a non-empty ARRAY on every
needs_tool / completed response — at minimum one paragraph. The
singular \`reasoning\` field is LEGACY; the cli's live reasoning peek
reads \`reasoningChain[]\` only. If you put your deliberation in
\`reasoning\` (singular string), the user sees no live deliberation
for this turn — only the prior brief lingers on screen. Even on a
"trivial" turn (rename a variable, write one obvious file), emit ONE
short paragraph in \`reasoningChain\` explaining the why. Empty array
or absent field = invisible reasoning = the user can't follow what
you're doing.

Per-file reasoning in batched responses: when a single response emits
multiple \`tools\` (parallel batch), \`reasoningChain[]\` SHOULD have
one paragraph per non-trivial tool — particularly per file written.
A 5-file write batch with one generic paragraph reads as "I wrote
5 things"; one paragraph per file reads as "here's why each file
exists and what it depends on". The latter is what users need to
follow your work.

ANTI-STALENESS — reference your prior turns' reasoning:
- Your conversation history includes your OWN \`reasoningChain\` from
  earlier turns. Each new turn's chain should CONNECT to that history,
  not start from scratch. If your current thinking continues from turn
  K, reference it: "In turn K I assumed X; the tool result just confirmed
  it".
- If a tool result has INVALIDATED reasoning from an earlier turn, SAY
  SO EXPLICITLY in your current chain: "Turn 2's assumption that the
  package.json existed was wrong — ls shows no package.json. Revising:
  this is a fresh directory, not an existing project. Next move is to
  scaffold from zero".
- The point isn't to recite history — it's to keep your mental model
  honest. Stale claims from old reasoning are how agents drift. Surface
  the supersession in plain prose; the divergence detector reads these
  paragraphs to keep the run on track.`
}
