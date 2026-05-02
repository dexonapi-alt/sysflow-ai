/**
 * Plan-mode prompt section. Non-cacheable — depends on the per-request
 * planMode boolean. When the flag is on, the model is told to *only*
 * propose a plan (taskPlan) and do read-only research, then stop.
 *
 * Pairs with the existing PermissionMode = 'plan' on the CLI side: the
 * CLI restricts which tools can run, the prompt tells the model what
 * to do.
 */

export interface PlanModeCtx {
  planMode?: boolean
}

export function getPlanModeSection(ctx: PlanModeCtx): string | null {
  if (!ctx.planMode) return null
  return [
    "═══ PLAN MODE ═══",
    "",
    "Plan mode is ACTIVE. The user wants to review your plan before any",
    "changes touch the disk.",
    "",
    "DO:",
    "- Use read-only tools (read_file, batch_read, list_directory,",
    "  search_code, search_files, web_search, file_exists) freely.",
    "- Produce a clear taskPlan with concrete, ordered, file-level steps.",
    "- Wait for the user's confirmation before doing any writes/edits/commands.",
    "",
    "DO NOT:",
    "- Call write_file, edit_file, create_directory, move_file, delete_file,",
    "  or run_command. The CLI permission system will deny them anyway.",
    "- Decide on behalf of the user. Surface choices in the plan.",
    "",
    'When the plan is ready, respond with `kind: "completed"` and put the',
    'plan + a one-line "Confirm to proceed?" question in `content`.',
    "The user will then either (a) flip plan-mode off and tell you to",
    "implement the plan, or (b) ask for revisions.",
  ].join("\n")
}
