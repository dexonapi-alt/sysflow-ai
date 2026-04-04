# 10 — Multi-Agent & Task System

## What Claude Code Has

### Coordinator Mode
- `coordinatorMode.ts` — dedicated coordinator role
- `getCoordinatorSystemPrompt()` defines how the coordinator orchestrates workers
- `getCoordinatorUserContext()` injects worker tool lists and MCP/scratchpad context
- Coordinator can spawn workers, assign tasks, collect results
- Activated via `CLAUDE_CODE_COORDINATOR_MODE` env/flag

### Agent Tool (Sub-Agents)
- `AgentTool` — spawn autonomous sub-agents for complex subtasks
- Each agent gets its own context, tools, and conversation
- `SendMessageTool` — communicate between agents
- `ListPeers` — discover available agents
- Agents can work in parallel on different parts of a task

### Task Management System
- `TaskCreateTool` — create background tasks
- `TaskGetTool` — check task status
- `TaskUpdateTool` — update task progress
- `TaskListTool` — list all tasks
- `TaskOutputTool` — get task output
- `TaskStop` — stop a running task
- Full CRUD for tasks with status tracking

### Background Task Execution
- Tasks can run in the background while the user interacts
- `taskBudgetRemaining` tracking with adjustments on compaction
- `taskSummaryModule` for background session summaries
- Token budget management per task

### Swarm Mode
- `isAgentSwarmsEnabled()` feature flag
- Team tools: create/delete team members
- `handleSwarmWorkerPermission` for worker permission decisions
- Workers can be assigned specialized roles

### Skill System
- `Skill` tool for discovering and using skills
- `startSkillDiscoveryPrefetch` — prefetch skill data each iteration
- Skills are composable, reusable task patterns
- `resolveSkillModelOverride` for model-specific skill behavior

### Plan Mode as a Tool
- `EnterPlanModeTool` / `ExitPlanModeV2Tool`
- Model can **choose** to enter plan mode when facing complex tasks
- In plan mode: read-only tools only, reasoning without side effects
- After planning, exit to execute
- Model routing changes in plan mode (can upgrade to stronger model)

### Workflow System
- `Workflow` tool for scripted multi-step flows
- Reusable workflow definitions
- Can be triggered by schedule or event

### Proactive/Autonomous Mode
- `PROACTIVE` feature flag
- Autonomous ticks for background processing
- `Sleep` tool for pacing
- Push notifications for user attention
- Monitor tool for observing system state

---

## What Sysflow AI Has (Gaps)

### No Multi-Agent System
- Single agent only — no coordinator, no workers, no swarms
- No `AgentTool` for spawning sub-agents
- No inter-agent communication
- Complex tasks must be solved by a single conversation thread

### No Task Management
- No background task system
- No task creation, tracking, or completion
- `task-pipeline.ts` is **pipeline display** (progress tracking), not a task execution system
- Pipeline is in-memory only — lost on restart
- No token budget per task

### No Plan Mode
- The model can only act, never "just plan"
- No `EnterPlanMode` / `ExitPlanMode` tools
- No read-only mode for reasoning
- The `taskPlan` in the first response is the closest equivalent, but:
  - It's a one-shot plan, not an iterative planning mode
  - The model can't re-enter planning mid-task
  - No model upgrade during planning

### No Skill System
- `knowledge/` directory has frontend patterns, design system, component templates
- These are hardcoded knowledge bases, not composable skills
- No skill discovery, no skill prefetching
- No user-defined skills

### No Workflow System
- No scripted multi-step flows
- `SweProvider` is a deterministic mock flow, not a real workflow engine
- No reusable workflow definitions

### No Autonomous/Proactive Mode
- Entirely reactive — waits for user input
- No background processing
- No monitoring or notifications

### Scaffold System is a Weak Substitute
- `detectScaffoldingNeed` / `scaffold-options.ts` — detects when scaffolding is needed
- Returns `waiting_for_user` for scaffold choice
- This is a one-time decision, not an ongoing planning system
- Once scaffolding is chosen, no further planning support

---

## What to Implement

### Priority 1: Plan Mode
```typescript
// Plan mode tools
const enterPlanModeTool = buildTool({
  name: 'enter_plan_mode',
  description: 'Enter plan mode to reason about the task without making changes. Only read-only tools are available.',
  inputSchema: z.object({
    reason: z.string().describe('Why you are entering plan mode'),
  }),
  call: async (input, context) => {
    context.mode = 'plan';
    return { success: true, message: 'Now in plan mode. Only read-only tools available. Use exit_plan_mode when ready to execute.' };
  },
});

const exitPlanModeTool = buildTool({
  name: 'exit_plan_mode',
  description: 'Exit plan mode and return to normal execution mode.',
  inputSchema: z.object({
    plan: z.string().describe('Your execution plan'),
  }),
  call: async (input, context) => {
    context.mode = 'normal';
    return { success: true, message: 'Exited plan mode. Executing plan.', plan: input.plan };
  },
});
```

### Priority 2: Sub-Agent System
```typescript
interface SubAgent {
  id: string;
  task: string;
  status: 'running' | 'completed' | 'failed';
  result?: string;
  messages: Message[];
  tools: string[];
}

const agentTool = buildTool({
  name: 'spawn_agent',
  description: 'Spawn a sub-agent to handle a specific subtask autonomously.',
  inputSchema: z.object({
    task: z.string().describe('The task for the sub-agent'),
    tools: z.array(z.string()).optional().describe('Tools available to the sub-agent'),
    maxTurns: z.number().optional().default(20),
  }),
  call: async (input, context) => {
    const agent = createSubAgent(input);
    const result = await runSubAgent(agent);
    return result;
  },
});
```

### Priority 3: Task Management
```typescript
interface Task {
  id: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled';
  parentTaskId?: string;
  result?: string;
  createdAt: Date;
  updatedAt: Date;
  tokenBudget?: number;
  tokensUsed?: number;
}

class TaskManager {
  private tasks = new Map<string, Task>();
  
  create(description: string, parentId?: string): Task { /* ... */ }
  update(id: string, updates: Partial<Task>): Task { /* ... */ }
  get(id: string): Task | undefined { /* ... */ }
  list(filter?: { status?: string; parentId?: string }): Task[] { /* ... */ }
  cancel(id: string): void { /* ... */ }
}
```

### Priority 4: Skill System
```typescript
interface Skill {
  name: string;
  description: string;
  pattern: string;         // When to suggest this skill
  steps: SkillStep[];      // Ordered steps
  tools: string[];         // Required tools
}

interface SkillStep {
  description: string;
  tool: string;
  inputTemplate: Record<string, string>; // Template with {{variables}}
  condition?: string;      // Only run if condition met
}

// Example skill: "Add a new API endpoint"
const addEndpointSkill: Skill = {
  name: 'add-api-endpoint',
  description: 'Add a new REST API endpoint',
  pattern: 'add.*endpoint|create.*route|new.*api',
  steps: [
    { description: 'Find existing routes', tool: 'search_code', inputTemplate: { pattern: 'router\\.' } },
    { description: 'Read route file', tool: 'read_file', inputTemplate: { path: '{{routeFile}}' } },
    { description: 'Add route handler', tool: 'edit_file', inputTemplate: { /* ... */ } },
    { description: 'Add tests', tool: 'write_file', inputTemplate: { /* ... */ } },
  ],
  tools: ['search_code', 'read_file', 'edit_file', 'write_file'],
};
```

### Priority 5: Background Processing
- Allow tasks to run asynchronously
- Report progress via events
- Support cancellation
- Token budget per background task
