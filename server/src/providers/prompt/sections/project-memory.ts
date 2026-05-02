/**
 * Project memory section. Non-cacheable — depends on the per-request cwd
 * and the on-disk .sysflow.md / CLAUDE.md content.
 *
 * The actual discovery happens in services/project-memory.ts; this
 * section just renders pre-discovered content into the prompt.
 */

export interface ProjectMemoryCtx {
  /** Pre-discovered project memory content. */
  projectMemory?: string
  /** Files that contributed (for the header). */
  projectMemoryFiles?: string[]
}

export function getProjectMemorySection(ctx: ProjectMemoryCtx): string | null {
  if (!ctx.projectMemory || !ctx.projectMemory.trim()) return null
  const fileList = ctx.projectMemoryFiles && ctx.projectMemoryFiles.length > 0
    ? ` (${ctx.projectMemoryFiles.length} file${ctx.projectMemoryFiles.length === 1 ? "" : "s"})`
    : ""
  return [
    `═══ PROJECT MEMORY${fileList} ═══`,
    "",
    "User-maintained instructions for THIS project. Treat as authoritative;",
    "they override generic guidance when they conflict.",
    "",
    ctx.projectMemory,
  ].join("\n")
}
