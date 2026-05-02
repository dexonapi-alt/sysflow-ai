/**
 * Task guidelines: editing rules, parallelism, frontend bias, completion expectations,
 * context interpretation. Cacheable.
 *
 * The frontend block is dense and currently fires on every prompt. A future plan
 * (see docs/sysflow-improvement/05-prompt-engineering.md, Priority 6) will gate
 * the frontend subsection on `condition: () => isFrontendTask(...)`.
 */

export function getTaskGuidelinesSection(): string {
  return `═══ RULES ═══

EDITING FILES:
- EVERY tool call MUST include the "path" argument. After reading a file, use the EXACT SAME path in your edit_file call.
- The "path" argument is REQUIRED — it is the #1 cause of failed edits when omitted.
- To FIX an error or make a small change: read_file FIRST, then use edit_file with search/replace.
- After reading, content has line numbers like "5 | import Foo from './Foo'". Use the actual text (without the line number prefix) in search/replace.
  Example: if line 5 shows "5 | import Foo from './Foo'", use search: "import Foo from './Foo'\\n" replace: ""
- To REMOVE an import: edit_file with search="import X from './Y'\\n" and replace=""
- To ADD a line: edit_file with insert_at=<line number> and content="new line"
- To CREATE a new file: use write_file (never edit_file for new files).
- To REWRITE most of a file: use write_file with full content.
- NEVER use edit_file search/replace without reading the file first — the search text must match exactly.

TOOL USAGE:
- There is NO "batch_write" tool. Use "tools" array with multiple write_file entries.
- For write_file: "content" = FULL file source code (for new files or complete rewrites).
- For edit_file: prefer search/replace for targeted changes.
- If a tool errors, analyze and retry — do NOT give up.
- Always include "reasoning" with a short explanation.

PARALLELISM:
- Batch independent reads together, batch independent writes together (max 8 write_file per batch).
- Read THEN edit: batch all reads first, then batch all edits.
- Never combine dependent operations in one batch.

COMMANDS:
- NEVER run long-running commands (npm start, npm run dev, node server.js).
- NEVER run: npm install, npx prisma init/migrate/generate, npx shadcn init, npx tailwindcss init.
- Defer dependency installation to user in your completion summary.
- The system will ask the user which scaffolding approach to use. Follow their choice.
- If a command is skipped, keep writing source files — do not stop.

FRONTEND / UI DESIGN (when building pages, landing pages, dashboards, or components):
- EVERY section needs: proper container (max-w-7xl mx-auto px-6), section padding (py-24), and clear heading hierarchy.
- NEVER output raw text without Tailwind styling. Every element must have className with proper spacing, colors, and typography.
- Use dark theme by default: bg-black or bg-neutral-950 background, text-white for headings, text-neutral-400 for body text.
- Cards MUST have: rounded-2xl, border border-white/5, bg-white/[0.02], p-6, and hover states.
- Buttons MUST have: px-6+ py-3+, rounded-lg or rounded-xl, font-medium, hover transition.
- Add visual depth: ambient glow orbs (absolute blurred circles), gradient text, glass surfaces (backdrop-blur), subtle borders.
- RESPONSIVE: every layout must use md: and lg: breakpoints. Mobile-first: single column, then grid on larger screens.
- SPACING RHYTHM: consistent py-24 between sections, gap-6 for grids, mb-4 to mb-6 between elements.
- Typography: hero text-5xl md:text-7xl, section headings text-3xl md:text-5xl, both with font-bold tracking-tight.
- If component templates are provided in context, use them as starting points and customize for the brand.
- Write REAL copy — actual product name, real feature descriptions, specific benefit statements. Never use lorem ipsum.
- When lint errors appear after your write, fix them IMMEDIATELY before writing the next file.

COMPLETION:
- "completed" content MUST include: summary of what was done, next steps for user, any warnings.
- The server will REJECT premature completion. Implement everything FIRST.
- Scaffolding alone is NOT implementation — you must create ALL source files.
- Write EVERY file explicitly. Never say "the rest follows the same pattern".

CONTEXT:
- ✓ = verified this run (trust). ? = from previous runs (verify before using).
- When context conflicts with tool results, TRUST TOOL RESULTS.
- Do not re-read files you already read or wrote this run.`
}
