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
  /^\s*(list|show|display|cat|print)\s+(me\s+)?(the\s+)?(content\s+of\s+)?[\w./-]+\s*(content)?\s*$/i,
  /^\s*(what|which)\s+(file|dir|folder|module|function|class|export)s?\s+(is|are|does|do|exist)/i,
  /^\s*ls\b/i,
  /^\s*pwd\b/i,
  /^\s*find\s+(files?|all)/i,
  /^\s*open\s+\S+\s*$/i,
  /^\s*read\s+(the\s+)?\S+\s*$/i,
  /^\s*continue\s*$/i,
  /^\s*go\s+on\s*$/i,
  // Continuation phrasings — "continue the task", "keep going",
  // "carry on", "proceed", "finish it", "resume", "go ahead", optionally
  // followed by "the task / previous / work / job / build / implementation".
  // The server-side handler swaps these for the previous run's prompt,
  // so the request is "pick up where we left off" not a fresh implement.
  // No fake task pipeline should appear.
  /^\s*(continue|carry\s+on|keep\s+going|proceed|next|finish(\s+(it|up))?|resume|go\s+ahead)(\s+(the\s+)?((previous|prev|last|same)\s+)?(task|work|job|build|implementation))?\s*[.!?]?\s*$/i,
]

/**
 * Implement-lead anchor: strong build verbs at the very start of the
 * prompt followed by at least some content (`an`/`the`/`me` is allowed
 * between verb and noun). When this matches, the classifier returns
 * `implement` BEFORE the bug check runs.
 *
 * Closes the false-positive where a build prompt mentioning bug-class
 * vocabulary inside its FEATURE LIST mis-routed to the bug pipeline.
 * Concrete reported case (2026-05-15):
 *
 *   "build a Node.js Express PostgreSQL backend for a simple POS system
 *    ... validation middleware, error handling, pagination ..."
 *
 * The `\berror\b` in BUG_PATTERNS matched "error handling" — feature
 * list noun, not a bug report — and the bug pipeline asked the user
 * for symptom / boundary / fix context for an app that didn't exist.
 *
 * Bug-reports open with different verbs (`fix`, `debug`, `why is X
 * failing`) and a stack-trace shape; none of those trip this anchor.
 *
 * Keep the verb list small and specific — adding catch-alls like
 * "do" or "handle" would let bug-reports through (e.g. "do something
 * about this crash").
 */
const IMPLEMENT_LEAD_PATTERNS: RegExp[] = [
  /^\s*(build|create|implement|make|add|set\s+up|scaffold|construct|develop|generate|design|write|spin\s+up|stand\s+up|bootstrap|produce|craft|put\s+together)\b\s+(an?\s+|the\s+|me\s+(an?\s+|the\s+)?)?\w/i,
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
  // Allow one optional word between the article and the noun: "what does the action-planner service do"
  /\b(what\s+does|what\s+is)\s+(this|the|that)\s+(\S+\s+)?(file|module|function|class|component|service|repo|project|code|tool|hook|registry|store|module)/i,
  /\bwalk\s+me\s+through\b/i,
  /^\s*(tldr|tl;dr|tl\s+dr)\b/i,
  /\bgive\s+me\s+(a|an)\s+(summary|overview|breakdown|tour)/i,
  /^\s*how\s+does\s+\S+\s+work\s*\??\s*$/i,
  // "what's on / in / inside this repo / project / dir" — a tour request, not
  // an implementation request. Match "what's", "whats", and "what is".
  /^\s*what(?:'?s|s|\s+is)\s+(on|in|inside|under|at)\s+(this|the|my|our)\b/i,
  // "tell me about ...", "show me what ..."
  /^\s*tell\s+me\s+about\b/i,
  /^\s*show\s+me\s+what\b/i,
  // "any X here", "what kind of X"
  /^\s*what\s+kind\s+of\b/i,
  /^\s*anything\s+(special|interesting|notable)\s+(about|in)\b/i,
]

export function classifyIntent(userMessage: string): IntentHint {
  const msg = (userMessage || "").trim()
  if (msg.length === 0) return "simple"

  // Implement-anchor override: when the prompt opens with a strong
  // implement verb followed by something to build, classify as
  // implement BEFORE the bug check runs. Closes the regression where
  // feature-list nouns like "error handling" tripped `\berror\b` and
  // mis-routed long build prompts to the bug pipeline.
  if (IMPLEMENT_LEAD_PATTERNS.some((re) => re.test(msg))) return "implement"

  // 'bug' has the highest specificity — error keywords trump anything else.
  if (BUG_PATTERNS.some((re) => re.test(msg))) return "bug"

  // 'summary' before 'simple' — "explain X" looks shallow but needs the summary pipeline.
  if (SUMMARY_PATTERNS.some((re) => re.test(msg))) return "summary"

  // Trivial single-action prompts skip reasoning entirely.
  if (SIMPLE_PATTERNS.some((re) => re.test(msg)) && msg.length < 80) return "simple"

  // Default: implement pipeline.
  return "implement"
}
