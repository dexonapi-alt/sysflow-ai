/**
 * Per-model nudges. Selected at assembly time based on the model id.
 * Non-cacheable across models, but cacheable within a single model's request stream.
 */

export function getModelSpecificSection(model: string | undefined): string | null {
  if (!model) return null
  if (model.startsWith("gemini")) return getGeminiSection()
  if (model.startsWith("claude")) return getClaudeSection()
  return getGenericJsonSection()
}

function getGeminiSection(): string {
  return `═══ GEMINI-SPECIFIC: ARGS FORMAT ═══

CRITICAL: The "path" field is REQUIRED in args_json for ALL file operations. Never omit it.

Your response uses the field "args_json" which is a JSON STRING containing the tool arguments.
Examples:
- read_file: args_json: {"path": "src/app.js"}
- read_file with range: args_json: {"path": "src/app.js", "offset": 50, "limit": 100}
- edit_file search/replace: args_json: {"path": "src/app.js", "search": "old text", "replace": "new text"}
- edit_file remove line: args_json: {"path": "src/app.js", "search": "import X from './Y'\\n", "replace": ""}
- write_file: args_json: {"path": "src/app.js", "content": "full file code here"}
- run_command: args_json: {"command": "npm run build", "cwd": "."}
- web_search: args_json: {"query": "how to create nestjs project 2026"}

After reading a file, use the SAME path in your edit. For example:
  1. read_file args_json: {"path": "src/components/Foo.tsx"}
  2. edit_file args_json: {"path": "src/components/Foo.tsx", "search": "bad import line\\n", "replace": ""}

args_json must be a valid JSON string. For parallel tools, each item in the "tools" array uses args_json.

═══ GEMINI-SPECIFIC: FILE SIZE STRATEGY ═══

CRITICAL: Your args_json has a size limit. For files longer than ~80 lines, use this incremental strategy:

1. write_file with a SKELETON first (imports, component structure, return statement with placeholder sections)
2. Then use edit_file insert_at to ADD each section one at a time

Example for a large React component:
  Step 1: write_file → skeleton with imports + empty component + export
  Step 2: edit_file insert_at → add the hero section JSX
  Step 3: edit_file insert_at → add the features section JSX
  Step 4: edit_file insert_at → add the remaining sections

This prevents args_json from being too large and failing. ALWAYS use this approach for landing pages, dashboards, and components with many sections.

For small files (< 80 lines): write_file with full content in one go.

ALSO: Split large pages into SEPARATE component files:
  - src/components/Navbar.tsx (one file)
  - src/components/Hero.tsx (one file)
  - src/components/Features.tsx (one file)
  - src/App.tsx (imports and assembles all components)
Each component file stays small enough for a single write_file.`
}

function getClaudeSection(): string {
  return `═══ CLAUDE-SPECIFIC ═══

- You may use either the "tool"+"args" form or the "tools" array form. Both are accepted.
- Reasoning blocks are optional — populate "reasoning" only when it adds signal.`
}

function getGenericJsonSection(): string {
  return `═══ MODEL-SPECIFIC: GENERIC JSON ═══

- Always respond with valid JSON matching the schema. No markdown fences around the JSON.
- Use the "tool" + "args" object form for tool calls.
- If the model is uncertain how to encode a string with newlines, prefer "\\n" escapes inside the JSON string.`
}
