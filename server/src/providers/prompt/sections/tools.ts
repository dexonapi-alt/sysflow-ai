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
8. run_command — args: { "command": "...", "cwd": "." }
   Use for: scaffolders (npm create vite, npx create-next-app, npx @nestjs/cli new, etc.), npm install / pnpm install / yarn install, build commands, test commands, git, one-shot scripts.
   Never use for: long-running servers (npm run dev, node server.js), interactive REPLs, or anything that doesn't terminate.
9. move_file — args: { "from": "old.js", "to": "new.js" }
10. delete_file — args: { "path": "temp.js" }
11. search_files — args: { "query": "auth middleware" } or { "glob": "src/**/*.ts" }
12. web_search — args: { "query": "..." } — use before any scaffolding command or config file writing
13. reason — args: { "question": "...", "context"?: "...", "options"?: ["...", "..."], "kind"?: "choice"|"implement"|"bug"|"gotcha" }
    Self-invoked reasoning. Use BEFORE making non-trivial decisions you're not HIGH-confident about.
    Examples: choosing a library when the project doesn't pin one ("Drizzle vs Prisma?"); deciding
    whether to delete a file you didn't create; picking an architectural pattern; investigating a
    suspicious gotcha. The tool returns { recommendation, alternatives, riskNotes, proceedHint }.
    Cost: one short reasoning call. Benefit: not making a wrong call you'll have to undo.
    DO NOT overuse — for HIGH-confidence routine moves, just act. Hard cap: 5 calls per run.`
}
