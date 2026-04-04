# 05 — Prompt Engineering

## What Claude Code Has

### Modular, Sectioned System Prompt
Claude Code's system prompt is built from **discrete, named sections** assembled by `getSystemPrompt()`:

1. **Intro Section** (`getSimpleIntroSection`) — identity, cyber risk instruction, URL rules
2. **System Section** (`getSimpleSystemSection`) — markdown rules, permissions, tags, hooks, compression behavior
3. **Doing Tasks Section** (`getSimpleToneAndStyleSection`) — task norms, code style, security, ant-specific bullets
4. **Actions Section** (`getActionsSection`) — careful execution guidelines
5. **Tools Section** (`getUsingYourToolsSection`) — tool-specific guidance, parallel calls, when to use which tool
6. **Tone & Style Section** (`getSimpleToneAndStyleSection`)
7. **Output Efficiency Section** (`getOutputEfficiencySection`)
8. **`SYSTEM_PROMPT_DYNAMIC_BOUNDARY`** — cache split marker for global vs non-global cache scope

Then **dynamic sections** via `resolveSystemPromptSections`:
- `session_guidance` — context-specific guidance (AskUserQuestion, shell tips, agent/explore/skills)
- `memory` — loaded from CLAUDE.md files
- `ant_model_override` — model-specific instructions (ant builds)
- `env_info_simple` — cwd, git info, platform, shell, OS, model, knowledge cutoff
- `language` — user's preferred language
- `output_style` — configured output style
- `mcp_instructions` — MCP server instructions
- `scratchpad` — scratchpad instructions
- `frc` — function result clearing section
- `summarize_tool_results` — tool result summarization rules
- `token_budget` — optional budget constraints
- `brief` — optional brevity mode

### Prompt Cache Optimization
- **`SYSTEM_PROMPT_DYNAMIC_BOUNDARY`** explicitly marks where the static (cacheable) portion ends
- Tool list sorted by name within partitions for **prompt-cache stability**
- Three-part cache key: system prompt array + userContext + systemContext
- Comments reference `api.ts` / `claude.ts` for cache coordination
- This means repeated calls with the same tools/context reuse cached prompt tokens

### System Prompt Priority System (`buildEffectiveSystemPrompt`)
1. **Override** → replaces everything
2. **Coordinator prompt** → when coordinator mode is active
3. **Agent prompt** → built-in or custom agent definitions
4. **Proactive mode** → appends to default (doesn't replace)
5. **Custom system prompt** → user-provided
6. **Default** → assembled from sections above
7. **`appendSystemPrompt`** → always appended at end (unless override)

### Dynamic Context Injection
- `fetchSystemPromptParts()` runs in parallel: `getSystemPrompt()` + `getUserContext()` + `getSystemContext()`
- Git status (branch, recent commits) injected unless remote mode
- Date string always included
- CLAUDE.md content discovered and injected
- Cache breaker for explicit cache busting when needed

### Environment-Aware Prompting
- `computeSimpleEnvInfo` provides: cwd, git info, worktree status, platform, shell, OS, model name, knowledge cutoff, family IDs, product channels, fast mode status
- Different sections for ant vs external users
- Model-aware instructions (different guidance per model family)

### Output Style System
- `getOutputStyleSection` configures how the model formats responses
- Configurable per user/session
- Affects coding instruction inclusion

### Proactive/Autonomous Mode
- `getProactiveSection` — autonomous tick behavior, sleep tool, pacing
- `BRIEF_PROACTIVE_SECTION` for embedded briefing
- `getSystemRemindersSection` with "unlimited context via summarization"

---

## What Sysflow AI Has (Gaps)

### Monolithic System Prompt
- `SHARED_SYSTEM_PROMPT` in `base-provider.ts` is a **single massive string** (~800+ lines)
- Not modular — can't swap sections, can't cache portions
- Mixes concerns: tool definitions, code style, JSON schema, editing rules, frontend conventions, completion expectations — all in one blob
- No section boundaries or markers

### No Prompt Cache Optimization
- The entire system prompt is sent with every request
- No cache boundary markers
- Tool list not sorted for stability
- Every edit to any part of the prompt invalidates the entire thing
- With Gemini's context caching API, this is wasted money and latency

### Provider-Specific Prompt Bolted On
- Gemini appends a `GEMINI-SPECIFIC: ARGS FORMAT` section
- This is done via string concatenation, not a composable system
- Claude/OpenRouter providers don't have equivalent sections
- No unified way to add model-specific instructions

### Limited Dynamic Injection
- `buildInitialUserMessage` injects: session history, continue context, directory tree, project memory, knowledge, frontend patterns, pipeline
- `buildToolResultMessage` injects: action planner context, working context, frontend patterns, pipeline step, original task reminder, complexity progress hints, scaffold warnings
- BUT: injection is **hardcoded in handler functions**, not a composable section system
- No parallel fetch of context parts
- No environment info (platform, shell, OS, git status)

### No Prompt Priority System
- No equivalent to `buildEffectiveSystemPrompt`'s priority chain
- No agent/coordinator mode switching
- No custom system prompt support
- No append-only system prompt option

### Inconsistent Schema Across Providers
- System prompt defines `waiting_for_user` as a valid `kind` 
- Gemini's `RESPONSE_SCHEMA` enum **doesn't include `waiting_for_user`**
- System prompt defines `taskPlan` in the response schema
- Gemini's `RESPONSE_SCHEMA` **doesn't include `taskPlan` property**
- This means the model is told to produce output that its schema rejects

### Frontend-Heavy Bias
- Significant prompt real estate devoted to frontend/Tailwind conventions
- `knowledge/frontend-patterns.ts`, `knowledge/design-system.ts`, `knowledge/component-templates.ts`
- These are injected on every frontend task, consuming context
- No equivalent depth for backend, CLI, API, or infrastructure tasks

### No Output Efficiency Guidance
- No section telling the model to be concise
- No brief mode
- No output style system
- Models tend to be verbose, wasting both output tokens and context space

---

## What to Implement

### Priority 1: Modular Prompt System
```typescript
interface PromptSection {
  id: string;
  name: string;
  content: string | (() => string);
  cacheable: boolean;       // Can this be included in prompt cache?
  priority: number;         // Lower = earlier in prompt
  condition?: () => boolean; // Only include if true
}

const PROMPT_SECTIONS: PromptSection[] = [
  {
    id: 'identity',
    name: 'Identity',
    content: getIdentitySection,
    cacheable: true,
    priority: 0,
  },
  {
    id: 'system_rules',
    name: 'System Rules',
    content: getSystemRulesSection,
    cacheable: true,
    priority: 10,
  },
  {
    id: 'tools',
    name: 'Available Tools',
    content: () => getToolsSection(enabledTools),
    cacheable: true,  // Sort tools for cache stability
    priority: 20,
  },
  {
    id: 'task_guidelines',
    name: 'Task Guidelines',
    content: getTaskGuidelinesSection,
    cacheable: true,
    priority: 30,
  },
  // CACHE BOUNDARY HERE
  {
    id: 'env_info',
    name: 'Environment',
    content: () => computeEnvInfo(),
    cacheable: false,
    priority: 100,
  },
  {
    id: 'project_memory',
    name: 'Project Memory',
    content: () => loadProjectMemory(),
    cacheable: false,
    priority: 110,
  },
  {
    id: 'session_context',
    name: 'Session Context',
    content: () => getSessionContext(),
    cacheable: false,
    priority: 120,
  },
];

function buildSystemPrompt(sections: PromptSection[]): string {
  const active = sections
    .filter(s => !s.condition || s.condition())
    .sort((a, b) => a.priority - b.priority);
  
  const cacheable = active.filter(s => s.cacheable);
  const dynamic = active.filter(s => !s.cacheable);
  
  const cacheableText = cacheable.map(s => 
    typeof s.content === 'function' ? s.content() : s.content
  ).join('\n\n');
  
  const dynamicText = dynamic.map(s =>
    typeof s.content === 'function' ? s.content() : s.content
  ).join('\n\n');
  
  return cacheableText + '\n\n---DYNAMIC---\n\n' + dynamicText;
}
```

### Priority 2: Environment Info Section
```typescript
function computeEnvInfo(): string {
  const info = [
    `Working directory: ${process.cwd()}`,
    `Platform: ${process.platform}`,
    `OS: ${os.type()} ${os.release()}`,
    `Shell: ${process.env.SHELL || process.env.COMSPEC}`,
    `Node: ${process.version}`,
    `Date: ${new Date().toISOString().split('T')[0]}`,
  ];
  
  // Git info
  try {
    const branch = execSync('git branch --show-current').toString().trim();
    const status = execSync('git status --short').toString().trim();
    info.push(`Git branch: ${branch}`);
    if (status) info.push(`Git status:\n${status.slice(0, 500)}`);
  } catch {}
  
  return `# Environment\n${info.map(i => `- ${i}`).join('\n')}`;
}
```

### Priority 3: Fix Schema Inconsistencies
```typescript
// Gemini RESPONSE_SCHEMA must match system prompt claims
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    kind: { 
      type: 'string', 
      enum: ['needs_tool', 'completed', 'failed', 'waiting_for_user'] // ADD waiting_for_user
    },
    taskPlan: {  // ADD taskPlan
      type: 'object',
      properties: {
        steps: { type: 'array', items: { type: 'string' } },
      },
    },
    // ... rest
  },
};
```

### Priority 4: Model-Specific Prompt Sections
```typescript
function getModelSpecificSection(model: string): string {
  if (model.startsWith('gemini')) {
    return `
# Model-Specific: Gemini
- Use args_json (string) for tool arguments, not args (object)
- For large files, use skeleton + insert_at strategy
- Prefer structured JSON output format
`;
  }
  if (model.startsWith('claude')) {
    return `
# Model-Specific: Claude
- Use native tool calling format
- Thinking/reasoning blocks are supported
`;
  }
  // OpenRouter models
  return `
# Model-Specific: General
- Always respond with valid JSON matching the schema
- Do not include markdown fences in your response
`;
}
```

### Priority 5: Output Efficiency Section
```typescript
function getOutputEfficiencySection(): string {
  return `
# Output Efficiency
- Be concise. Don't repeat information the user already knows.
- Don't narrate what you're about to do — just do it.
- When editing files, show only the changed portion, not the entire file.
- Use tool calls instead of explaining what tool calls you would make.
- Skip pleasantries and filler phrases.
- If a task is complete, say so briefly. Don't over-explain.
`;
}
```

### Priority 6: Remove Frontend Bias
- Move frontend-specific patterns out of the base system prompt
- Only inject frontend knowledge when the task is frontend-related
- Create equivalent knowledge bases for backend, API, CLI, DevOps
- Use `condition` on prompt sections to gate by task type
