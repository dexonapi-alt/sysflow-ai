// ─── Directory Tree ───

export interface DirectoryEntry {
  name: string
  type: "file" | "directory"
}

// ─── Provider Payload & Response ───

export interface ToolResult {
  tool: string
  result: Record<string, unknown>
}

export interface ToolCall {
  id: string
  tool: string
  args: Record<string, unknown>
}

export interface BatchToolResult {
  id: string
  tool: string
  result: Record<string, unknown>
}

export interface ProviderPayload {
  model: string
  runId: string
  userMessage: string
  directoryTree: DirectoryEntry[]
  context: ProviderContext
  toolResult?: ToolResult
  toolResults?: BatchToolResult[]
  task?: TaskMeta
  userId?: string | null
  chatId?: string | null
  command?: string
  /** Absolute path of the user's project root — used for project-memory discovery. */
  cwd?: string
  /** When true, the prompt's plan-mode section is injected and the agent stays read-only. */
  planMode?: boolean
  /** Phase 5 reasoning brief from preflight / on-error / on-completion. Untyped here to avoid an import cycle. */
  reasoningBrief?: unknown
  /** Phase 16 Stage 3 chained-preflight elaboration brief. Set only when the
   *  free-tier elaboration gate matches (free-tier model + complexity ≥
   *  medium + preflight confidence < HIGH); otherwise omitted. The prompt
   *  builder renders it as a "DEEPER REASONING" sub-block under the
   *  implement brief. Untyped to avoid an import cycle. */
  reasoningElaborationBrief?: unknown
  /** Phase 10 chunked-loop planner brief — when set, the prompt builder injects "files: [...]" so the model honours the chunk's file list exactly. Untyped to avoid an import cycle. */
  chunkPlanBrief?: unknown
}

export interface ProviderContext {
  sessionHistory?: string
  continueFrom?: ContinueFrom
  continueContext?: string
  projectMemory?: string[] | string
  projectKnowledge?: string
  /** Managed working context from ContextManager — compressed, verified facts only */
  workingContext?: string
  /** Frontend design patterns injected when a frontend task is detected */
  frontendPatterns?: string
}

export interface ContinueFrom {
  outcome: string
  prompt: string
  error?: string
  filesModified: string[]
  actions: Array<{ tool: string; path?: string }>
}

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  generationData?: Record<string, unknown> | null
}

export interface NormalizedResponse {
  kind: "needs_tool" | "completed" | "failed" | "waiting_for_user" | "rate_limited"
  content?: string
  reasoning?: string | null
  tool?: string
  args?: Record<string, unknown>
  tools?: ToolCall[]
  error?: string
  usage: TokenUsage
  summary?: string | null
  task?: TaskMeta | null
  taskStep?: string | null
  stepTransition?: { complete?: string; start?: string }
  pendingAction?: unknown
  /** AI-generated task plan from first response */
  taskPlan?: { title: string; steps: string[] } | null
  /** Phase 15 Stage 4: model-driven memory feedback. Lists entry ids the
   *  model confirms it used and ids it contradicts. The handler processes
   *  this via `applyMemoryFeedback`, which cross-validates each id
   *  against the response text before mutating the store. */
  memoryFeedback?: { confirmed?: string[]; contradicted?: string[] } | null
  /**
   * Stage 1.5 of command-first-investigation plan: per-turn plain-prose
   * deliberation produced by the MAIN model on each `needs_tool` /
   * `completed` response. Mirrors the preflight reasoner's
   * `reasoningChain[]` from Stage C of model-lock-and-portable-reasoning,
   * but populated turn-by-turn so the agent's deliberation streams as
   * one-thought-per-LLM-call. Each entry is a mid-to-long paragraph
   * (3-6 sentences). Cap of 6 entries per turn — per-turn deliberation
   * is lighter than preflight's 10-entry chain.
   *
   * Surfaces in the CLI as `log` events so the user sees the agent
   * reasoning between commands. Omitted on trivial turns where there's
   * nothing meaningful to deliberate about.
   */
  reasoningChain?: string[]
}

// ─── Task ───

export interface TaskStep {
  id: string
  label: string
  status: "pending" | "in_progress" | "completed" | "failed"
}

export interface TaskMeta {
  id: string
  runId: string
  projectId: string
  model: string
  title: string
  goal: string
  steps: TaskStep[]
  status: "running" | "completed" | "failed"
}

// ─── Run ───

export interface RunState {
  id: string
  taskId: string
  projectId: string
  model: string
  status: "running" | "completed" | "failed"
  userId?: string | null
  chatId?: string | null
}

// ─── Client Response ───

/** Stable error codes the CLI can switch on instead of string-matching `error`. */
export type ServerErrorCode =
  | "usage_limit"
  | "rate_limit"
  | "session_expired"
  | "prompt_too_long"
  | "malformed_response"
  | "unknown"

export interface ClientResponse {
  status: "needs_tool" | "completed" | "waiting_for_user" | "failed"
  runId: string
  tool?: string
  args?: Record<string, unknown>
  tools?: ToolCall[]
  content?: string | null
  reasoning?: string | null
  message?: string | null
  summary?: string | null
  task?: TaskMeta | null
  taskStep?: string | null
  stepTransition?: { complete?: string; start?: string }
  pendingAction?: unknown
  error?: string
  /** Stable code for the CLI; `error` remains the human-readable string. */
  errorCode?: ServerErrorCode
  /** Phase 5: optional reasoning brief produced by the pre-flight / on-error / on-completion / self-invoked triggers. */
  reasoningBrief?: unknown
  /**
   * Stage E of model-lock-and-portable-reasoning: which reasoner
   * backend served the run's Flash calls (`"gemini"` / `"anthropic"` /
   * `"openrouter"`). Attached by the user-message + tool-result
   * handlers when a brief was produced for the run; absent otherwise.
   * Telemetry-only — the CLI records it in `RunSummary` and writes the
   * `usage.jsonl` line at terminal exit. Constant for the duration of
   * a run (env doesn't shift mid-run), so observing it on any response
   * is sufficient.
   */
  reasonerBackend?: "gemini" | "anthropic" | "openrouter" | null
  /**
   * Phase 19: the classified intent for this run, computed by
   * `classifyIntent(content)` in user-message.ts. The CLI's reducer
   * reads this on the first response and stores it in `runIntent` so
   * the <AgentStream> gate can decide whether the task box renders.
   * Constant for the duration of a run; the value is the same as
   * what the preflight reasoner's `pickPipeline` chose so the cli
   * and server share one classification.
   */
  runIntent?: "simple" | "summary" | "bug" | "implement" | null
}

// ─── Database ───

export interface MigrationModule {
  default: {
    name: string
    up: string
  }
}

// ─── Subscription ───

export type PlanId = "free" | "lite" | "pro" | "team"

export interface Plan {
  id: PlanId
  label: string
  price: number
  creditsPerMonth: number
  stripePriceId: string | null
}

export interface Subscription {
  plan: PlanId
  credits_total_cents: number
  credits_used_cents: number
  stripe_customer_id: string | null
  stripe_subscription_id: string | null
}
