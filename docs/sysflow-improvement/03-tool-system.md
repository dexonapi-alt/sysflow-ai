# 03 — Tool System & Execution

## What Claude Code Has

### Typed Tool Registry with `buildTool`
- Every tool is a structured object created via `buildTool(def)` which merges `TOOL_DEFAULTS`
- Each tool has: `name`, `description`, `inputSchema` (Zod), `outputSchema` (Zod), `validateInput`, `checkPermissions`, `call`, `isConcurrencySafe`, `isReadOnly`, `isEnabled`, `aliases`, `maxResultSizeChars`
- Tools are registered in `getAllBaseTools()` with feature-flag gating
- `assembleToolPool` merges built-in + MCP tools, deduped, sorted for prompt-cache stability

### Zod Input/Output Validation
- **Every tool input** is validated with Zod schemas before execution
- `partitionToolCalls` uses `tool.inputSchema.safeParse(toolUse.input)` before deciding concurrency
- Validation errors produce structured, helpful error messages via `formatZodValidationError`
- Output schemas validate tool results, catching malformed outputs
- `validateInput` hook for custom validation beyond schema (secrets, file size, UNC paths, read-before-edit)

### Concurrency-Safe Parallel Execution
- `partitionToolCalls` groups consecutive tools into batches:
  - **Concurrent batch**: all tools in batch are `isConcurrencySafe === true` → run in parallel
  - **Serial batch**: non-safe tools → run one at a time
- Merge rule: consecutive safe tools coalesce into one batch; any non-safe tool starts a new batch
- `runToolsConcurrently` with configurable concurrency (default 10, via `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY`)
- Context modifiers queued during parallel execution, applied in order after batch completes

### Streaming Tool Executor
- `StreamingToolExecutor` starts executing tools **while the model is still streaming**
- `addTool(block)` called per tool_use block as it arrives
- `processQueue()` checks `canExecuteTool` (concurrency-safe classification)
- `getCompletedResults()` yields results in order as they finish
- `getRemainingResults()` waits for all executing tools after stream ends
- **Sibling abort**: Bash error aborts sibling tools via shared `AbortController`
- `discard()` for streaming fallback scenarios

### Rich Tool Error Classification
- `classifyToolError` categorizes errors (MCP auth, Zod validation, timeout, permission denied, etc.)
- `formatError` produces user-readable error messages
- `formatZodValidationError` includes schema hint
- `buildSchemaNotSentHint` for deferred tools (schema not in prompt)
- MCP auth errors set app state to `needs-auth`

### Tool Hooks System
- `runPreToolUseHooks`: can modify input, inject context, stop execution, override permissions
- `runPostToolUseHooks`: can modify output, inject follow-up context
- `runPostToolUseFailureHooks`: handle tool failures
- Hooks receive full `ToolUseContext` including messages, file caches, options
- Hook results can set `preventContinuation`, `stopReason`, `additionalContext`

### Tool Use Summary Generation
- After tools execute, `generateToolUseSummary` creates a summary of what was done
- Pending summaries carried across turns
- Provides the model with compact context about prior tool actions

### Per-Tool Size Caps
- `maxResultSizeChars` per tool (e.g. FileEditTool = 100,000)
- `processToolResultBlock` / `addToolResult` pipeline enforces caps
- GrowthBook overrides for A/B testing different caps
- Large results persisted to disk, replaced with preview tags in context

### 40+ Tools Available
Core: Bash, FileRead, FileWrite, FileEdit, NotebookEdit, Glob, Grep, WebFetch, WebSearch, WebBrowser, TodoWrite, AskUserQuestion, EnterPlanMode, ExitPlanModeV2, Agent, TaskCreate/Get/Update/List/Output/Stop, SendMessage, ListPeers, Skill, Brief, Config, LSP, PowerShell, Snip, TerminalCapture, VerifyPlanExecution, REPL, Workflow, Sleep, Monitor, SendUserFile, PushNotification, SubscribePR, MCP tools (dynamic)

---

## What Sysflow AI Has (Gaps)

### No Typed Tool System
- Tools are string-matched in `VALID_TOOLS` array and `TOOL_ALIASES` map
- No Zod schemas for input or output validation
- `sanitizeToolName` does fuzzy string matching on tool names
- `parseArgsRobust` is a **multi-strategy JSON parser** that tries:
  1. Object passthrough
  2. `JSON.parse`
  3. Double-encoded string hack
  4. Quote fixing
  5. Regex extraction of specific fields
  6. Fallback empty object
- This is a symptom of not having proper schemas — the model can return garbage and the system tries to salvage it

### No Concurrency Safety Classification
- `executeToolsBatch` runs all non-command tools in parallel, all commands serially
- No per-tool `isConcurrencySafe` flag
- No partitioning algorithm — it's binary: commands vs everything else
- Two write_file operations to the same file could run in parallel (race condition)

### No Streaming Tool Execution
- Tools only execute after the full model response
- No `StreamingToolExecutor` equivalent
- Adds unnecessary latency to every turn

### No Tool Hooks
- No pre-tool or post-tool hook system
- No ability to inject context, modify input, or prevent execution
- Action planner partially fills this role but it's not a general hook system

### No Tool Use Summaries
- No `generateToolUseSummary` equivalent
- The model must re-read all tool results to understand prior context
- Working context (`buildWorkingContextString`) is a partial substitute but lacks structure

### No Per-Tool Size Caps
- Tool results can be arbitrarily large
- A `read_file` on a 10MB file passes the entire content back
- No truncation, no disk persistence, no preview tags

### Fewer Tools (12 vs 40+)
Available: `list_directory`, `read_file`, `batch_read`, `write_file`, `batch_write`, `edit_file`, `move_file`, `delete_file`, `search_code`, `search_files`, `run_command`, `web_search`

Missing: Glob (pattern search), Grep (ripgrep integration), WebFetch (URL content), WebBrowser, NotebookEdit, Plan mode tools, Agent/Task tools, AskUserQuestion (structured), Skill, LSP, REPL, MCP integration

### Fragile Argument Parsing
- `parseArgsRobust` tries 6 strategies in sequence — any strategy can silently produce wrong args
- Regex extraction for `path`, `content`, `patch` is brittle with multiline content
- The root cause: no Zod schemas forcing the model to produce valid JSON
- Unknown tools are silently converted to `list_directory` — hides model errors

---

## What to Implement

### Priority 1: Zod-Based Tool Definitions
```typescript
import { z } from 'zod';

interface ToolDef<TInput, TOutput> {
  name: string;
  description: string;
  inputSchema: z.ZodSchema<TInput>;
  outputSchema?: z.ZodSchema<TOutput>;
  isConcurrencySafe: (input: TInput) => boolean;
  isReadOnly: boolean;
  maxResultSizeChars: number;
  validateInput?: (input: TInput) => ValidationResult;
  checkPermissions?: (input: TInput, context: PermissionContext) => PermissionDecision;
  call: (input: TInput, context: ToolContext) => Promise<TOutput>;
}

// Example: read_file tool
const readFileTool: ToolDef<ReadFileInput, ReadFileOutput> = {
  name: 'read_file',
  description: 'Read file contents with optional line range',
  inputSchema: z.object({
    path: z.string().min(1, 'Path is required'),
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
  }),
  outputSchema: z.object({
    content: z.string(),
    lineCount: z.number(),
    truncated: z.boolean(),
  }),
  isConcurrencySafe: () => true, // reads are always safe
  isReadOnly: true,
  maxResultSizeChars: 50_000,
  call: async (input, ctx) => { /* implementation */ },
};
```

### Priority 2: Tool Partitioning Algorithm
```typescript
interface Batch {
  isConcurrencySafe: boolean;
  tools: ToolUseBlock[];
}

function partitionToolCalls(toolUses: ToolUseBlock[]): Batch[] {
  const batches: Batch[] = [];
  
  for (const toolUse of toolUses) {
    const tool = findToolByName(toolUse.name);
    if (!tool) {
      batches.push({ isConcurrencySafe: false, tools: [toolUse] });
      continue;
    }
    
    const parsed = tool.inputSchema.safeParse(toolUse.input);
    const isSafe = parsed.success && tool.isConcurrencySafe(parsed.data);
    
    const lastBatch = batches[batches.length - 1];
    if (lastBatch?.isConcurrencySafe && isSafe) {
      lastBatch.tools.push(toolUse);
    } else {
      batches.push({ isConcurrencySafe: isSafe, tools: [toolUse] });
    }
  }
  
  return batches;
}
```

### Priority 3: Tool Hooks
```typescript
interface ToolHook {
  name: string;
  preToolUse?: (tool: Tool, input: any, context: ToolContext) => Promise<HookResult>;
  postToolUse?: (tool: Tool, input: any, output: any, context: ToolContext) => Promise<void>;
  postToolUseFailure?: (tool: Tool, input: any, error: Error, context: ToolContext) => Promise<void>;
}

interface HookResult {
  updatedInput?: any;
  preventExecution?: boolean;
  stopReason?: string;
  additionalContext?: string;
  permissionOverride?: PermissionDecision;
}
```

### Priority 4: Missing Tools to Add
1. **GlobTool** — pattern-based file discovery (uses fast-glob)
2. **GrepTool** — ripgrep integration with line numbers, context, pagination
3. **WebFetchTool** — fetch URL content and convert to markdown
4. **NotebookEditTool** — Jupyter notebook cell editing
5. **AskUserQuestion** — structured questions with options (not just free text)
6. **PlanMode tools** — enter/exit plan mode for reasoning without action
7. **AgentTool** — spawn sub-agents for complex subtasks

### Priority 5: Stop Converting Unknown Tools to list_directory
Instead of silently converting unknown tools, return a structured error:
```typescript
if (!tool) {
  return {
    type: 'tool_result',
    tool_use_id: toolUse.id,
    content: `Unknown tool "${toolUse.name}". Available tools: ${availableTools.join(', ')}`,
    is_error: true,
  };
}
```
