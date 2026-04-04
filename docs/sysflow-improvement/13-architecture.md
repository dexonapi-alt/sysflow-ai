# 13 — Architecture & Extensibility

## What Claude Code Has

### In-Process Monolith (Bun Runtime)
- Everything runs in a single Bun process
- CLI, model calling, tool execution, context management — all in-memory
- No network overhead in the inner loop
- Fast IPC between components
- Single deployment unit

### Event-Driven with Async Generators
- `queryLoop` is an async generator yielding `StreamEvent`
- Consumers (CLI, Web UI, SDK) subscribe to events
- Clean separation between core logic and presentation
- Each consumer decides how to render events
- Composable: generators can be piped, filtered, transformed

### Web UI + CLI + SDK
Three interfaces to the same core:
- **CLI** (`src/entrypoints/cli.tsx`) — terminal interface with Ink (React for CLI)
- **Web UI** (`web/`) — Next.js app with streaming, components, hooks
- **SDK** (`QueryEngine.ts`) — programmatic API for headless usage
- All share the same `queryLoop` core

### MCP (Model Context Protocol) Integration
- MCP server at `mcp-server/` for exploring the codebase
- MCP tools merged into the tool pool (`assembleToolPool`)
- `getMcpInstructions` injected into system prompt
- MCP auth error handling (set state to `needs-auth`)
- `ListMcpResources` / `ReadMcpResource` tools
- Delta MCP support for incremental tool additions

### Plugin Architecture
- `src/plugins/` directory
- Hooks system (pre/post tool use) acts as plugin interface
- Feature flags gate entire subsystems
- Skills as composable behavior units
- MCP as external tool integration

### Component Library (Ink/React)
- `src/components/` — React components for CLI rendering
- `src/hooks/` — React hooks for state management
- `src/screens/` — Screen-level compositions
- Clean separation of logic and presentation

### Configuration Schema (Zod v4)
- `src/schemas/` — Zod v4 schemas for all configuration
- Type-safe configuration validation
- Schema evolution via migrations (`src/migrations/`)
- Environment variable, settings file, and CLI flag sources

### Memory Directory System
- `src/memdir/` — persistent memory across sessions
- `loadMemoryPrompt` for memory injection
- Nested memory attachments in `ToolUseContext`
- Structured, not just flat text

### Coordinator Pattern
- Clear separation: coordinator assigns, workers execute
- `getCoordinatorSystemPrompt()` — different prompt for coordinators
- `getCoordinatorUserContext()` — different context for coordinators
- Workers get `ToolPermissionContext` from coordinator

### Bridge/Channel Communication
- `src/bridge/` — inter-component communication
- Bridge callbacks for permission decisions
- Channel-based message passing
- Enables CLI ↔ background process communication

---

## What Sysflow AI Has (Gaps)

### Client-Server Split Architecture
```
CLI (Node.js)  ←HTTP→  Server (Fastify)  ←HTTP→  Model API
    ↓                        ↓
  Tools                   Database
```
- **Two separate processes** communicating via HTTP
- Server handles model calls and orchestration logic
- CLI handles tool execution and user interaction
- **Every tool turn requires 2+ HTTP round-trips**
- State split between server (runs, sessions, context) and client (file system, git)

### No Event System
- No async generators
- No `StreamEvent` type
- SSE for phase updates, not true streaming
- No clean separation between core logic and presentation
- CLI directly manipulates console output in the agent loop

### Single Interface (CLI Only)
- No web UI
- No SDK/headless mode
- No programmatic API
- Can't embed Sysflow in other tools
- Can't run headless for CI/CD

### No MCP Integration
- No Model Context Protocol support
- Can't integrate external tools dynamically
- Tool set is fixed at build time
- No external tool discovery

### No Plugin Architecture
- No hooks system (action planner is not composable)
- No plugin directory
- No way to extend behavior without modifying core code
- Knowledge bases are hardcoded, not pluggable

### Hardcoded Configuration
- `.env` for secrets
- `MODELS` array hardcoded in `sysbase.ts`
- No Zod schema for configuration
- No configuration validation
- No migration system for config changes

### In-Memory State (Lost on Restart)
- `pipelines` Map — in-memory, lost on restart
- `projectMemories` Map — in-memory
- `runContexts` Map — in-memory
- Rate limit state — in-memory
- Only persistent state: database (runs, sessions, context entries, tasks)

### Tight Coupling
- `user-message.ts` calls 15+ different services directly
- `tool-result.ts` calls 20+ different services directly
- No dependency injection
- No clear module boundaries
- Changing one service requires understanding all callers

### No Migration System
- Database migrations exist (`001`-`012`)
- But no configuration migrations
- No state migrations
- No way to evolve in-memory data structures

---

## What to Implement

### Priority 1: Modularize the Handler Functions
```typescript
// Instead of 15+ direct service calls in user-message.ts:

interface MessagePipeline {
  stages: PipelineStage[];
}

interface PipelineStage {
  name: string;
  execute: (context: PipelineContext) => Promise<PipelineContext>;
  condition?: (context: PipelineContext) => boolean;
}

const userMessagePipeline: MessagePipeline = {
  stages: [
    { name: 'createRun', execute: createRunStage },
    { name: 'loadContext', execute: loadContextStage },
    { name: 'detectContinuation', execute: detectContinuationStage },
    { name: 'detectScaffolding', execute: detectScaffoldingStage, condition: ctx => !ctx.isContinuation },
    { name: 'detectErrors', execute: detectErrorsStage },
    { name: 'callModel', execute: callModelStage, condition: ctx => !ctx.earlyReturn },
    { name: 'interceptActions', execute: interceptActionsStage },
    { name: 'validateCompletion', execute: validateCompletionStage },
    { name: 'createPipeline', execute: createPipelineStage },
    { name: 'respond', execute: respondStage },
  ],
};

async function handleUserMessage(body: UserMessageBody): Promise<Response> {
  let context = initPipelineContext(body);
  
  for (const stage of userMessagePipeline.stages) {
    if (stage.condition && !stage.condition(context)) continue;
    context = await stage.execute(context);
    if (context.earlyReturn) return context.response;
  }
  
  return context.response;
}
```

### Priority 2: Event-Driven Core
```typescript
// Core event types
type AgentEvent =
  | { type: 'turn_start'; turnCount: number }
  | { type: 'model_start'; model: string; tokenEstimate: number }
  | { type: 'model_chunk'; text: string }
  | { type: 'model_complete'; usage: Usage }
  | { type: 'tool_start'; tool: string; input: unknown }
  | { type: 'tool_progress'; tool: string; message: string }
  | { type: 'tool_complete'; tool: string; result: unknown }
  | { type: 'tool_error'; tool: string; error: string }
  | { type: 'compaction'; type: string; summary: string }
  | { type: 'warning'; message: string }
  | { type: 'error'; message: string; recoverable: boolean }
  | { type: 'completed'; summary: string }
  | { type: 'aborted'; reason: string };

// Consumers
interface EventConsumer {
  onEvent(event: AgentEvent): void;
}

class CLIConsumer implements EventConsumer { /* render to terminal */ }
class WebConsumer implements EventConsumer { /* send via WebSocket */ }
class SDKConsumer implements EventConsumer { /* collect results */ }
class TelemetryConsumer implements EventConsumer { /* record metrics */ }
```

### Priority 3: In-Process Option
```typescript
// Allow running without HTTP server for local CLI use
class SysflowAgent {
  private tools: ToolRegistry;
  private model: ModelAdapter;
  private context: ContextManager;
  
  async *run(message: string, options: RunOptions): AsyncGenerator<AgentEvent> {
    // Direct model calling, no HTTP
    // Tool execution in-process
    // Context management in-memory
  }
}

// CLI mode: direct
const agent = new SysflowAgent({ model: 'gemini-pro' });
for await (const event of agent.run('Create a REST API')) {
  renderEvent(event);
}

// Server mode: via HTTP (existing behavior for multi-user)
```

### Priority 4: Configuration Schema
```typescript
import { z } from 'zod';

const SysflowConfigSchema = z.object({
  model: z.object({
    default: z.string().default('gemini-flash'),
    planMode: z.string().optional(),
    fallback: z.array(z.string()).default([]),
    maxRetries: z.number().default(10),
  }),
  tools: z.object({
    maxConcurrency: z.number().default(10),
    resultSizeLimit: z.number().default(50_000),
    enabledTools: z.array(z.string()).optional(),
    disabledTools: z.array(z.string()).optional(),
  }),
  permissions: z.object({
    mode: z.enum(['default', 'plan', 'auto', 'bypass']).default('default'),
    alwaysAllow: z.array(z.string()).default([]),
    alwaysDeny: z.array(z.string()).default([]),
  }),
  context: z.object({
    autocompactEnabled: z.boolean().default(true),
    microcompactEnabled: z.boolean().default(true),
    autocompactBuffer: z.number().default(13_000),
  }),
  features: z.record(z.boolean()).default({}),
});

type SysflowConfig = z.infer<typeof SysflowConfigSchema>;
```

### Priority 5: Memory System
```typescript
// File-based project memory (like CLAUDE.md)
// Location: .sysflow.md in project root

interface ProjectMemory {
  instructions: string[];     // Project-specific instructions
  patterns: string[];         // Code patterns to follow
  conventions: string[];      // Naming, style conventions
  knownIssues: string[];     // Known bugs/workarounds
  dependencies: string[];    // Key dependencies and versions
}

async function loadProjectMemory(projectRoot: string): Promise<ProjectMemory> {
  const memoryFile = path.join(projectRoot, '.sysflow.md');
  if (!await fileExists(memoryFile)) return emptyMemory();
  
  const content = await readFile(memoryFile, 'utf-8');
  return parseMemoryFile(content);
}
```

### Priority 6: Dependency Injection
```typescript
// Replace direct service imports with DI

interface ServiceContainer {
  modelAdapter: ModelAdapter;
  contextManager: ContextManager;
  toolRegistry: ToolRegistry;
  permissionService: PermissionService;
  compactionService: CompactionService;
  pipelineService: PipelineService;
  metricsCollector: MetricsCollector;
}

function createContainer(config: SysflowConfig): ServiceContainer {
  const modelAdapter = new ModelAdapter(config.model);
  const contextManager = new ContextManager(config.context);
  const toolRegistry = new ToolRegistry(config.tools);
  // ... wire up dependencies
  
  return { modelAdapter, contextManager, toolRegistry, /* ... */ };
}
```
