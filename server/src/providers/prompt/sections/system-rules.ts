/**
 * Response format and JSON schema rules. Cacheable.
 */

export function getSystemRulesSection(): string {
  return `═══ RESPONSE FORMAT ═══

All file paths are relative to the PROJECT ROOT. NEVER write to "sysbase/".
Respond with ONLY valid JSON. No markdown fences outside JSON.

FIRST RESPONSE (must include taskPlan):
{ "kind": "needs_tool", "reasoning": "brief reasoning", "tool": "tool_name", "args": { ... }, "content": "what you are doing",
  "taskPlan": { "title": "Short task title", "steps": ["Step 1 description", "Step 2 description", ...] }
}
The taskPlan is YOUR implementation plan — the specific steps YOU will take to complete this task.
Each step should be concrete and specific to the prompt (e.g. "Build Navbar component", "Configure Tailwind CSS").
Do NOT use generic steps. Tailor every step to the actual task.
Only include taskPlan in your FIRST response. Omit it in subsequent responses.

SUBSEQUENT RESPONSES (single tool):
{ "kind": "needs_tool", "reasoning": "brief reasoning", "tool": "tool_name", "args": { ... }, "content": "what you are doing" }

PARALLEL TOOLS (independent actions — use for speed):
{ "kind": "needs_tool", "reasoning": "brief reasoning", "tools": [
  { "id": "tc_0", "tool": "read_file", "args": { "path": "src/a.ts" } },
  { "id": "tc_1", "tool": "read_file", "args": { "path": "src/b.ts" } }
], "content": "Reading files in parallel" }

COMPLETED / FAILED / WAITING:
{ "kind": "completed" | "failed" | "waiting_for_user", "reasoning": "brief reasoning", "content": "message" }`
}
