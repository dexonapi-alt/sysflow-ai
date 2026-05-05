/**
 * Cheap regex-based intent classifier. Runs BEFORE the LLM reasoner so we
 * can short-circuit obvious cases:
 *   - 'simple'    → no reasoning call needed (the agent just runs).
 *   - 'bug'       → bug pipeline.
 *   - 'summary'   → summary pipeline.
 *   - 'implement' → default; covers everything else.
 *
 * Returns a *hint* — the LLM reasoner can override this if it sees a stronger
 * signal in the full prompt + context. The hint exists to avoid burning a
 * round-trip on prompts that don't need reasoning at all.
 */

export type IntentHint = "simple" | "bug" | "summary" | "implement"

const SIMPLE_PATTERNS: RegExp[] = [
  /^\s*(list|show|display|cat|print)\s+(files?|dirs?|directory|folder|content)/i,
  /^\s*(what|which)\s+(file|dir|folder|module|function|class|export)s?\s+(is|are|does|do|exist)/i,
  /^\s*ls\b/i,
  /^\s*pwd\b/i,
  /^\s*find\s+(files?|all)/i,
  /^\s*open\s+\S+\s*$/i,
  /^\s*read\s+(the\s+)?\S+\s*$/i,
  /^\s*continue\s*$/i,
  /^\s*go\s+on\s*$/i,
]

const BUG_PATTERNS: RegExp[] = [
  /\b(fix|debug|broken|broke|fail(ed|ing|s)?|error|exception|crash(ed|ing)?|stack\s*trace)\b/i,
  /\b(not\s+working|doesn'?t\s+work|isn'?t\s+working)\b/i,
  /\b(typeerror|referenceerror|syntaxerror|enoent|eacces|etimedout|econnrefused|ehosturenreach|module\s+not\s+found)\b/i,
  /\bcannot\s+(find|read|access|resolve)\b/i,
  /\bunexpected\s+(token|behavi|error)/i,
  /^\s*why\s+(does|is|do|am|did)/i,
  /\bregression\b/i,
  /^\s*\S+\s*:\s*\S+error\b/i,  // looks like "foo: TypeError"
]

const SUMMARY_PATTERNS: RegExp[] = [
  /^\s*(explain|summari[sz]e|describe|recap|overview)\b/i,
  /\b(what\s+does|what\s+is)\s+(this|the|that)\s+(file|module|function|class|component|service|repo|project|code)/i,
  /\bwalk\s+me\s+through\b/i,
  /^\s*(tldr|tl;dr|tl\s+dr)\b/i,
  /\bgive\s+me\s+(a|an)\s+(summary|overview|breakdown)/i,
  /^\s*how\s+does\s+\S+\s+work\s*\??\s*$/i,
]

export function classifyIntent(userMessage: string): IntentHint {
  const msg = (userMessage || "").trim()
  if (msg.length === 0) return "simple"

  // 'bug' has the highest specificity — error keywords trump anything else.
  if (BUG_PATTERNS.some((re) => re.test(msg))) return "bug"

  // 'summary' before 'simple' — "explain X" looks shallow but needs the summary pipeline.
  if (SUMMARY_PATTERNS.some((re) => re.test(msg))) return "summary"

  // Trivial single-action prompts skip reasoning entirely.
  if (SIMPLE_PATTERNS.some((re) => re.test(msg)) && msg.length < 80) return "simple"

  // Default: implement pipeline.
  return "implement"
}
