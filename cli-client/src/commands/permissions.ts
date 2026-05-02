/**
 * /permissions slash command: list / clear persistent permission rules.
 * /mode <name> slash command: switch the active permission mode.
 */

import { colors, BOX } from "../cli/render.js"
import { getSysbasePath, getPermissionMode, setPermissionMode, getPlanMode } from "../lib/sysbase.js"
import { loadRules, removeRule, type PermissionMode } from "../agent/permissions.js"

export async function showPermissions(): Promise<void> {
  const sysbasePath = getSysbasePath()
  const mode = await getPermissionMode()
  const planOn = await getPlanMode()
  const rules = await loadRules(sysbasePath)

  console.log("")
  console.log("  " + colors.accent.bold("permissions"))
  console.log("  " + colors.muted("mode: ") + colors.bright(mode) + (planOn ? colors.muted("  · plan-mode: ") + colors.warning("ON") : ""))
  console.log("")
  if (rules.length === 0) {
    console.log("  " + colors.muted("no persistent rules"))
    console.log("  " + colors.muted("(rules accumulate when you choose 'allow always' or 'deny always')"))
    console.log("")
    return
  }
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i]
    const decisionColor = r.decision === "allow" ? colors.success : r.decision === "deny" ? colors.error : colors.warning
    console.log(`  ${colors.muted(`${i + 1}.`)} ${decisionColor(r.decision.padEnd(5))} ${colors.bright(r.tool)} ${colors.muted(r.pattern ?? "(any)")}`)
  }
  console.log("")
  console.log("  " + colors.muted(`/permissions remove <n>`) + colors.muted(" — drop rule by index"))
  console.log("  " + colors.muted(`/permissions clear`) + colors.muted(" — drop all rules"))
  console.log("  " + colors.muted(`/mode <default|auto|plan|bypass>`) + colors.muted(" — switch mode"))
  console.log("")
}

export async function removePermissionRule(indexArg: string): Promise<void> {
  const sysbasePath = getSysbasePath()
  const rules = await loadRules(sysbasePath)
  const index = parseInt(indexArg, 10)
  if (!Number.isFinite(index) || index < 1 || index > rules.length) {
    console.log("  " + colors.error(`bad index: ${indexArg}`))
    return
  }
  const target = rules[index - 1]
  const removed = await removeRule(sysbasePath, target.tool, target.pattern)
  if (removed) {
    console.log("  " + colors.success(`removed: ${target.decision} ${target.tool} ${target.pattern ?? "(any)"}`))
  } else {
    console.log("  " + colors.error("rule not found"))
  }
}

export async function clearAllPermissionRules(): Promise<void> {
  const sysbasePath = getSysbasePath()
  const rules = await loadRules(sysbasePath)
  for (const r of rules) {
    await removeRule(sysbasePath, r.tool, r.pattern)
  }
  console.log("  " + colors.success(`cleared ${rules.length} rule(s)`))
}

export async function changeMode(mode: string): Promise<void> {
  try {
    await setPermissionMode(mode as PermissionMode)
    console.log("  " + colors.success(`permission mode → ${mode}`))
    if (mode === "bypass") {
      console.log("  " + colors.warning(`⚠ bypass: every tool call will be auto-allowed. use only for trusted automation.`))
    } else if (mode === "plan") {
      console.log("  " + colors.muted(`plan: read-only tools allowed; everything else denied.`))
    }
    console.log("")
  } catch (err) {
    console.log("  " + colors.error((err as Error).message))
    console.log("")
  }
}

// Re-export the helpers used by parser/ui so they're available without
// consumers reaching back into sysbase.ts directly.
export { getPermissionMode } from "../lib/sysbase.js"
export { BOX }
