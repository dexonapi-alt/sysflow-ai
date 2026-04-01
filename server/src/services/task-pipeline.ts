/**
 * Task Pipeline — manages AI-generated task plans.
 *
 * The AI generates its own task plan in its first response (taskPlan field).
 * This module stores the plan, tracks progress, and advances steps based
 * on tool execution patterns.
 *
 * Fallback: if the AI doesn't provide a plan, a minimal generic plan is used.
 */

import type { TaskMeta, TaskStep } from "../types.js"

// ─── Types ───

interface PipelineStep {
  id: string
  label: string
  status: "pending" | "in_progress" | "completed"
  toolCount: number
  writeCount: number
}

interface Pipeline {
  runId: string
  title: string
  goal: string
  steps: PipelineStep[]
  currentStepIndex: number
  startTime: number
  isAiGenerated: boolean
}

const pipelines = new Map<string, Pipeline>()

// ─── Create from AI Plan ───

export function createPipelineFromAiPlan(
  runId: string,
  prompt: string,
  aiPlan: { title: string; steps: string[] }
): Pipeline {
  const steps: PipelineStep[] = aiPlan.steps.map((label, i) => ({
    id: `step_${i}`,
    label,
    status: i === 0 ? "in_progress" as const : "pending" as const,
    toolCount: 0,
    writeCount: 0
  }))

  const pipeline: Pipeline = {
    runId,
    title: aiPlan.title || generateTitle(prompt),
    goal: prompt.length > 80 ? prompt.slice(0, 77) + "..." : prompt,
    steps,
    currentStepIndex: 0,
    startTime: Date.now(),
    isAiGenerated: true
  }

  pipelines.set(runId, pipeline)
  console.log(`[task-pipeline] Created AI-generated plan: "${pipeline.title}" (${steps.length} steps)`)
  return pipeline
}

// ─── Error context for specific pipeline steps ───

export interface ErrorInfo {
  sourceFile: string
  targetImport: string
}

// ─── Fallback: minimal generic plan ───

export function createFallbackPipeline(runId: string, prompt: string, errors?: ErrorInfo[]): Pipeline {
  const isErrorFix = /\b(fix|error|bug|issue|broken|not working|crash|fail)\b/i.test(prompt)

  let steps: PipelineStep[]

  if (errors && errors.length > 0) {
    // Error-specific pipeline: one step per error, deduplicated by file
    const fileErrors = new Map<string, string[]>()
    for (const err of errors) {
      const fileName = err.sourceFile.split("/").pop() || err.sourceFile
      const importName = err.targetImport.split("/").pop() || err.targetImport
      if (!fileErrors.has(fileName)) fileErrors.set(fileName, [])
      fileErrors.get(fileName)!.push(importName)
    }

    steps = []
    let idx = 0
    for (const [fileName, imports] of fileErrors) {
      const importList = imports.length === 1
        ? `"${imports[0]}"`
        : imports.map(i => `"${i}"`).join(", ")
      steps.push({
        id: `step_${idx}`,
        label: `Remove ${importList} from ${fileName}`,
        status: idx === 0 ? "in_progress" : "pending",
        toolCount: 0,
        writeCount: 0
      })
      idx++
    }
  } else if (isErrorFix) {
    // Generic error fix — try to extract specifics from the prompt
    const importMatch = prompt.match(/Failed to resolve import\s+["']?(\S+?)["']?\s+from\s+["']?(\S+?)["']?/i)
    if (importMatch) {
      const importName = importMatch[1].split("/").pop() || importMatch[1]
      const fileName = importMatch[2].split("/").pop() || importMatch[2]
      steps = [
        { id: "step_0", label: `Find ${fileName}`, status: "in_progress", toolCount: 0, writeCount: 0 },
        { id: "step_1", label: `Remove broken import "${importName}"`, status: "pending", toolCount: 0, writeCount: 0 },
        { id: "step_2", label: "Verify fix", status: "pending", toolCount: 0, writeCount: 0 },
      ]
    } else {
      const errSnippet = prompt.match(/(?:error|bug|issue|fix)[:\s]+(.{10,50}?)(?:\.|$|\n)/i)
      steps = [
        { id: "step_0", label: errSnippet ? `Investigate: ${errSnippet[1].trim()}` : "Investigate error", status: "in_progress", toolCount: 0, writeCount: 0 },
        { id: "step_1", label: "Apply fix", status: "pending", toolCount: 0, writeCount: 0 },
        { id: "step_2", label: "Verify fix", status: "pending", toolCount: 0, writeCount: 0 },
      ]
    }
  } else {
    steps = [
      { id: "step_0", label: "Setup project", status: "in_progress", toolCount: 0, writeCount: 0 },
      { id: "step_1", label: "Implement features", status: "pending", toolCount: 0, writeCount: 0 },
      { id: "step_2", label: "Polish & finalize", status: "pending", toolCount: 0, writeCount: 0 },
    ]
  }

  const pipeline: Pipeline = {
    runId,
    title: generateTitle(prompt),
    goal: prompt.length > 80 ? prompt.slice(0, 77) + "..." : prompt,
    steps,
    currentStepIndex: 0,
    startTime: Date.now(),
    isAiGenerated: false
  }

  pipelines.set(runId, pipeline)
  console.log(`[task-pipeline] Created fallback plan: "${pipeline.title}" (${steps.length} steps)`)
  return pipeline
}

// ─── Title from prompt (used as fallback if AI title is empty) ───

function generateTitle(prompt: string): string {
  const nameMatch = prompt.match(/(?:called|named|for)\s+(\w+(?:\s*\w+){0,2})/i)
  const name = nameMatch ? nameMatch[1].trim() : null

  if (/landing\s*page/i.test(prompt)) return name ? `${name} landing page` : "Landing page"
  if (/homepage|home\s*page/i.test(prompt)) return name ? `${name} homepage` : "Homepage"
  if (/portfolio/i.test(prompt)) return name ? `${name} portfolio` : "Portfolio"
  if (/dashboard/i.test(prompt)) return name ? `${name} dashboard` : "Dashboard"
  if (/fix|error|bug/i.test(prompt)) {
    const errMatch = prompt.match(/(?:fix|resolve)\s+(?:the\s+)?(.{10,40}?)(?:\.|$|—|>>)/i)
    return errMatch ? `Fix: ${errMatch[1].trim()}` : "Fix error"
  }

  const actionMatch = prompt.match(/^(create|build|make|design|implement)\s+(.{5,35}?)(?:\.|,|with|\s+using|\s+>>|$)/i)
  if (actionMatch) return actionMatch[2].trim()

  return prompt.length > 45 ? prompt.slice(0, 42) + "..." : prompt
}

// ─── Convert to client format ───

export function pipelineToTaskMeta(pipeline: Pipeline): TaskMeta {
  return {
    id: `task_${pipeline.runId}`,
    runId: pipeline.runId,
    projectId: "",
    model: "",
    title: pipeline.title,
    goal: pipeline.goal,
    steps: pipeline.steps.map((s) => ({
      id: s.id,
      label: s.label,
      status: s.status
    })),
    status: "running"
  }
}

// ─── Progress Tracking ───

/**
 * Advance pipeline progress based on tool execution.
 * Uses a simple strategy: count tools per step, advance after enough activity.
 * For AI-generated plans, each step advances after ~2 write operations.
 */
export function updatePipelineProgress(
  runId: string,
  tool: string,
  _toolArgs: Record<string, unknown>
): { task: TaskMeta; stepTransition?: { complete?: string; start?: string } } | null {
  const pipeline = pipelines.get(runId)
  if (!pipeline) return null

  let activeIndex = pipeline.steps.findIndex((s) => s.status === "in_progress")
  if (activeIndex === -1) activeIndex = pipeline.currentStepIndex
  if (activeIndex < 0 || activeIndex >= pipeline.steps.length) {
    return { task: pipelineToTaskMeta(pipeline) }
  }

  const currentStep = pipeline.steps[activeIndex]
  const isWrite = tool === "write_file" || tool === "edit_file" || tool === "create_directory"
  const isCommand = tool === "run_command"

  if (isWrite || isCommand || tool === "web_search") {
    currentStep.toolCount++
  }
  if (isWrite) {
    currentStep.writeCount++
  }

  // Advance heuristic: depends on step position
  let shouldAdvance = false
  const totalSteps = pipeline.steps.length
  const isFirstStep = activeIndex === 0
  const isLastStep = activeIndex === totalSteps - 1

  if (isFirstStep) {
    // First step (usually scaffold/setup): advance after a command or 2+ tool uses
    shouldAdvance = (isCommand && currentStep.toolCount >= 1) || currentStep.toolCount >= 3
  } else if (isLastStep) {
    // Last step (finalize/polish): advance after 2+ writes
    shouldAdvance = currentStep.writeCount >= 2
  } else {
    // Middle steps (build components): advance after 2 writes
    shouldAdvance = currentStep.writeCount >= 2
  }

  let transition: { complete?: string; start?: string } | undefined

  if (shouldAdvance) {
    currentStep.status = "completed"
    pipeline.currentStepIndex = activeIndex + 1

    if (pipeline.currentStepIndex < pipeline.steps.length) {
      pipeline.steps[pipeline.currentStepIndex].status = "in_progress"
      transition = {
        complete: currentStep.id,
        start: pipeline.steps[pipeline.currentStepIndex].id
      }
    } else {
      transition = { complete: currentStep.id }
    }
  }

  return { task: pipelineToTaskMeta(pipeline), stepTransition: transition }
}

// ─── Pipeline Management ───

export function completePipeline(runId: string): TaskMeta | null {
  const pipeline = pipelines.get(runId)
  if (!pipeline) return null
  for (const step of pipeline.steps) step.status = "completed"
  const meta = pipelineToTaskMeta(pipeline)
  meta.status = "completed"
  return meta
}

export function getPipeline(runId: string): Pipeline | null {
  return pipelines.get(runId) || null
}

export function clearPipeline(runId: string): void {
  pipelines.delete(runId)
}

export function hasPipeline(runId: string): boolean {
  return pipelines.has(runId)
}
