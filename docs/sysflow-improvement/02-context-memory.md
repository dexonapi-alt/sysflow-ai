# 02 — Context & Memory Management

## What Claude Code Has

### Multi-Layer Compaction Pipeline
Claude Code has **5 distinct compaction mechanisms** that work together:

#### 1. Tool Result Budget (`applyToolResultBudget`)
- Before any compaction, **caps the size of individual tool results**
- Per-tool `maxResultSizeChars` (e.g. FileEditTool = 100,000 chars)
- Persists replacements via `recordContentReplacement`
- Prevents a single large tool result from blowing the context

#### 2. Snip (`snipCompactIfNeeded`)
- Feature-gated (`HISTORY_SNIP`)
- Removes old messages from history, yielding a boundary message
- Tracks `snipTokensFreed` for downstream token math
- Fast, low-cost way to reclaim context space

#### 3. Microcompact
- **Time-based trigger**: if idle gap > config threshold, content-clears old tool results with `[Old tool result content cleared]`
- Keeps last N compactable tools (Read, Grep, Glob, Edit, Write, shell, web search/fetch)
- **Cached microcompact**: registers tool results, emits `cache_edits` for API without local message mutation (preserves prompt cache)
- Mutates messages in-place for non-cached path
- Runs **every turn** as part of the pre-API pipeline

#### 4. Autocompact
- **Proactive**: triggers when token count exceeds `effectiveContextWindow - 13k buffer`
- Uses a **circuit breaker** (3 consecutive failures → stop trying)
- Tries session memory compaction first, then full conversation compaction
- Full compaction: pre-compact hooks, streaming summary generation, image stripping, post-compact file/skill/plan attachments
- **Post-compact cleanup**: resets microcompact state, context collapse, classifier approvals, session cache
- Notifies for prompt-cache break detection

#### 5. Reactive Compact
- **On-demand**: triggers after API returns 413 (prompt too long) or media errors
- Works with context collapse: drain staged collapses, then compact
- Yields post-compact messages and retries the API call
- Last resort before declaring `prompt_too_long` terminal

#### 6. Context Collapse
- **Progressive**: stages collapses before autocompact runs
- `applyCollapsesIfNeeded` as a projection step
- On 413 recovery: `recoverFromOverflow` commits staged collapses
- Reset on post-compact cleanup (main thread only)

### CLAUDE.md Project Memory
- **File-based**: discovers `CLAUDE.md` files in project root + parent dirs + additional dirs
- **Memoized**: `getUserContext` caches discovery results
- Content filtered through `filterInjectedMemoryFiles`
- Injected into system prompt via `loadMemoryPrompt()`
- Acts as persistent, project-specific instructions without DB
- User editable — the AI can also suggest edits

### Tool Result Persistence
- Large tool results stored to disk under `session/tool-results/`
- Preview tags for truncated content
- Per-tool size caps with GrowthBook overrides
- `processToolResultBlock` / `addToolResult` pipeline

### System Context
- **Git-aware**: branch, main branch, user name, truncated status, recent commits
- **Date-aware**: local ISO date injected
- **Cache-breakable**: optional injection for cache busting
- Memoized with cache invalidation on injection changes

### Token-Aware Decisions
- `tokenCountWithEstimation` used throughout
- `calculateTokenWarningState` for pre-API blocking
- `getEffectiveContextWindowSize` per model
- `AUTOCOMPACT_BUFFER_TOKENS` (13k) reserved
- `taskBudgetRemaining` tracking with adjustments

---

## What Sysflow AI Has (Gaps)

### No Compaction At All
- **Zero compaction mechanisms**: no autocompact, no microcompact, no snip, no reactive compact
- Context grows unbounded until the model hits its token limit
- When limit is hit, the model either fails or produces garbage — no recovery
- `buildCompressedSessionSummary` in `context-manager.ts` is **defined but never imported/called**

### Primitive Context Manager
- `context-manager.ts` tracks facts, files, commands, errors per run
- No token counting — only entry counts (`MAX_FILE_ENTRIES` etc.)
- `buildWorkingContextString` returns a flat text summary
- Injected only every 5 tool turns (or first 3) — inconsistent freshness
- `ingestToolResult` for `search_code`/`search_files` expects array format — if server returns string, context update silently fails

### Project Context is DB-Based, Not File-Based
- `loadProjectContext` reads from database entries, not file system
- No equivalent to CLAUDE.md
- Project memory is an in-memory map (`projectMemories`) — lost on restart
- No user-editable project instructions file
- `sysbase/fixes` markdown files are a partial attempt but not comprehensive

### No Tool Result Budget
- Individual tool results can be arbitrarily large
- A single `read_file` of a large file can consume most of the context
- No per-tool size caps
- No disk persistence for large results

### No Token Awareness
- No token counting anywhere in the codebase
- No estimation of message array token cost
- No pre-API blocking limit check
- No awareness of context window size per model
- Compaction decisions (if they existed) couldn't be token-informed

### Session Summary is Shallow
- `buildSessionSummary` in `store/sessions.ts` creates a basic recap
- `buildContinueContext` for follow-up tasks
- No compression, no priority weighting, no token budgeting

---

## What to Implement

### Priority 1: Token Counting
```typescript
// Estimate tokens for a message array
function estimateTokenCount(messages: Message[]): number {
  let total = 0;
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      total += Math.ceil(msg.content.length / 4); // rough estimate
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'text') total += Math.ceil(block.text.length / 4);
        if (block.type === 'tool_result') total += Math.ceil(JSON.stringify(block).length / 4);
      }
    }
  }
  return total;
}

// Model context windows
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  'gemini-pro': 1_000_000,
  'gemini-flash': 1_000_000,
  'claude-sonnet': 200_000,
  'mistral-small': 32_000,
};
```

### Priority 2: Tool Result Budget
```typescript
const TOOL_RESULT_MAX_CHARS: Record<string, number> = {
  read_file: 50_000,
  search_code: 20_000,
  run_command: 30_000,
  list_directory: 15_000,
  edit_file: 100_000,
  write_file: 5_000,
  web_search: 10_000,
};

function applyToolResultBudget(messages: Message[]): Message[] {
  return messages.map(msg => {
    if (msg.role !== 'tool') return msg;
    const maxChars = TOOL_RESULT_MAX_CHARS[msg.toolName] ?? 30_000;
    if (msg.content.length > maxChars) {
      msg.content = msg.content.slice(0, maxChars) + 
        `\n\n[Content truncated. Original: ${msg.content.length} chars, showing: ${maxChars} chars]`;
    }
    return msg;
  });
}
```

### Priority 3: Microcompact
```typescript
const COMPACTABLE_TOOLS = new Set([
  'read_file', 'search_code', 'search_files', 'list_directory',
  'run_command', 'web_search', 'edit_file', 'write_file'
]);

function microcompact(messages: Message[], keepLastN: number = 5): Message[] {
  const toolResultIndices = messages
    .map((m, i) => COMPACTABLE_TOOLS.has(m.toolName) ? i : -1)
    .filter(i => i >= 0);
  
  const toCompact = toolResultIndices.slice(0, -keepLastN);
  return messages.map((msg, i) => {
    if (toCompact.includes(i)) {
      return { ...msg, content: `[Old ${msg.toolName} result cleared]` };
    }
    return msg;
  });
}
```

### Priority 4: Autocompact with Summary
```typescript
const AUTOCOMPACT_BUFFER = 13_000; // tokens reserved

async function autocompactIfNeeded(
  messages: Message[], 
  model: string,
  callModel: ModelCallFn
): Promise<{ messages: Message[], summary: string } | null> {
  const tokens = estimateTokenCount(messages);
  const threshold = MODEL_CONTEXT_WINDOWS[model] - AUTOCOMPACT_BUFFER;
  
  if (tokens < threshold) return null;
  
  const summary = await callModel({
    messages: [{
      role: 'user',
      content: `Summarize this conversation so far, preserving:
        1. The original task/goal
        2. All files created/modified (with paths)
        3. Key decisions made
        4. Current progress and what remains
        5. Any errors encountered and how they were resolved
        
        Conversation: ${JSON.stringify(messages)}`
    }],
    maxTokens: 4000,
  });
  
  return {
    messages: [{
      role: 'user', 
      content: `[Previous conversation compacted]\n\n${summary}\n\n[Continue from here]`
    }],
    summary,
  };
}
```

### Priority 5: CLAUDE.md-Style Project Memory
```typescript
// Discover .sysflow.md files in project tree
async function discoverProjectMemory(projectRoot: string): Promise<string[]> {
  const memoryFiles: string[] = [];
  const candidates = [
    path.join(projectRoot, '.sysflow.md'),
    path.join(projectRoot, 'SYSFLOW.md'),
    path.join(path.dirname(projectRoot), '.sysflow.md'), // parent dir
  ];
  
  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      memoryFiles.push(await readFile(candidate, 'utf-8'));
    }
  }
  return memoryFiles;
}
```

### Priority 6: Reactive Compact
When the model returns a "prompt too long" error:
1. Attempt microcompact (clear old tool results)
2. Attempt autocompact (summarize conversation)
3. If both fail, return `prompt_too_long` terminal reason
4. Never waste another API call on the same oversized context
