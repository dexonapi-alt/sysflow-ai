/**
 * Plan `2026-05-15-forced-error-reasoning-and-recovery.md` Stage 4.
 *
 * Pure validator that decides whether the model's response after a
 * tool error ACKNOWLEDGED the error or silently moved on. Two pass
 * conditions: (a) the response's `reasoningChain` (or `content` as
 * fallback) has meaningful token-overlap with the error text or the
 * reasoner's root cause, OR (b) the next action is structurally
 * different from the failed one (i.e. the agent pivoted).
 *
 * One hard-fail condition: the next action is the SAME (tool, args)
 * tuple as the failure. That's the canonical user-reported behavior
 * — agent emits `ls -R`, gets the cmd.exe error, then issues `ls -R`
 * again because it didn't read the failure. The validator catches
 * this even when the chain ALSO has acknowledgement text (defensive
 * — same-action-retry is unambiguously wrong).
 *
 * Companion to the inject block (Stage 3): the block tells the model
 * what to do; the validator catches the case where the model didn't
 * do it. Pattern mirrors `validateCompletion` for the completed-
 * without-doing-the-work case.
 */

export interface ErrorAcknowledgementContext {
  /** Verbatim error text from the prior tool failure. */
  errorText: string
  /** Reasoner's root-cause hypothesis (when chain committed). When
   *  the chain didn't run / returned null, this is the empty string
   *  — the validator falls back to just the errorText. */
  rootCause: string
  /** Tool that failed. The validator hard-fails if the next action
   *  uses the same tool + same primary arg (path / command). */
  failedTool: string
  /** The failed call's primary identifying arg — for `run_command`
   *  this is the `command` string, for `write_file` / `edit_file`
   *  it's the `path`. Used to detect same-action retries. */
  failedPrimaryArg: string | undefined
}

export interface ErrorAcknowledgementCheck {
  /** True when the response addressed the error in some form. */
  ok: boolean
  /** When `ok === false`, a one-line description suitable for the
   *  reject-prompt header. */
  reason?: string
}

export interface ErrorAcknowledgementInput {
  /** The model's response — most fields are loose-typed because the
   *  validator is provider-agnostic. */
  responseKind: string | null
  reasoningChain: string[]
  content: string | null
  responseTool: string | null
  responseArgs: Record<string, unknown> | null
  /** The prior error context this validation is gating against. */
  context: ErrorAcknowledgementContext
}

/**
 * Token-overlap fraction (0.0 – 1.0). When the response's reasoning
 * mentions enough of the error / root-cause vocabulary, we count it
 * as acknowledged. 25% is slightly looser than `validateConfirmation`'s
 * 30% in `memory-store/feedback.ts` — error vocab is small (often
 * 6-10 tokens) so 2 hits out of 8 should already count as engagement.
 */
const ACK_OVERLAP_THRESHOLD = 0.25

/** Minimum token count for the error/cause vocabulary to even
 *  participate in the overlap check. Below this we don't trust the
 *  signal — too few tokens means random overlap is too easy. */
const MIN_VOCAB_TOKENS = 3

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "have", "has", "had",
  "are", "was", "were", "will", "would", "could", "should", "been", "being",
  "but", "not", "yes", "any", "all", "you", "your", "our", "their", "its",
  "into", "onto", "upon", "than", "then", "what", "when", "where", "which",
  "who", "why", "how", "out", "off", "over", "under", "between",
])

/**
 * Tokenise a string into normalised words usable for overlap
 * comparison. Lower-case, strip punctuation, drop short / stop
 * words. Same convention as `validateConfirmation` so the two
 * heuristics agree on what counts as a "meaningful" token.
 */
export function tokenise(s: string): string[] {
  return s.toLowerCase()
    .replace(/[^a-z0-9_\s./\-:]+/g, " ")
    .split(/\s+/)
    .map((tok) => tok.replace(/^[.\-/:]+|[.\-/:]+$/g, ""))
    .filter((tok) => tok.length >= 4 && !STOP_WORDS.has(tok))
}

/**
 * True when the response's reasoning vocabulary overlaps the error
 * vocabulary at or above the threshold. Pure; exported for tests.
 */
export function hasMeaningfulOverlap(reasoningText: string, errorText: string, rootCause: string): boolean {
  const errorTokens = new Set([...tokenise(errorText), ...tokenise(rootCause)])
  if (errorTokens.size < MIN_VOCAB_TOKENS) return true  // can't measure — pass through

  const reasoningTokens = new Set(tokenise(reasoningText))
  if (reasoningTokens.size === 0) return false

  let matches = 0
  for (const t of errorTokens) {
    if (reasoningTokens.has(t)) matches += 1
  }
  return matches / errorTokens.size >= ACK_OVERLAP_THRESHOLD
}

/**
 * Pick the primary identifying arg for a tool call. Same shape as
 * `same_action_repeated_in_session`'s key construction so the two
 * heuristics agree on what counts as "the same action".
 */
export function primaryArg(tool: string, args: Record<string, unknown> | null | undefined): string | undefined {
  if (!args || typeof args !== "object") return undefined
  if (tool === "run_command") {
    return typeof args.command === "string" ? args.command : undefined
  }
  if (tool === "write_file" || tool === "edit_file" || tool === "batch_write" || tool === "read_file" || tool === "create_directory") {
    return typeof args.path === "string" ? args.path : undefined
  }
  return undefined
}

/**
 * Top-level validator. Returns `{ ok: false, reason }` ONLY when the
 * model both (a) failed the acknowledgement-text check AND (b)
 * didn't pivot to a structurally different action. Hard-fails
 * unconditionally on a same-(tool, primaryArg) retry — that's the
 * canonical user-reported behaviour we're catching.
 *
 * `completed` / `failed` / `waiting_for_user` responses pass through
 * — the model isn't trying to issue a corrective tool call, so the
 * gate doesn't apply.
 */
export function validateErrorAcknowledgement(input: ErrorAcknowledgementInput): ErrorAcknowledgementCheck {
  const { responseKind, reasoningChain, content, responseTool, responseArgs, context } = input

  // Non-tool responses: pass through. Agent may be completing,
  // failing, or asking the user — none of those are "ignoring the
  // error to issue another broken command".
  if (responseKind !== "needs_tool") return { ok: true }

  // Hard-fail: same tool + same primary arg = retrying the broken
  // command without changes. The inject block was clear; this is
  // ignoring it.
  if (responseTool === context.failedTool) {
    const responsePrimary = primaryArg(responseTool, responseArgs)
    if (responsePrimary && context.failedPrimaryArg && responsePrimary === context.failedPrimaryArg) {
      return {
        ok: false,
        reason: `Re-issued the same failed ${context.failedTool} call without changes. The inject block explicitly told you not to do this.`,
      }
    }
  }

  // Acknowledgement-text check: combine reasoningChain + content
  // because the model may put the acknowledgement in either.
  const ackText = [
    ...reasoningChain.filter((p) => typeof p === "string"),
    content ?? "",
  ].join(" ")

  if (hasMeaningfulOverlap(ackText, context.errorText, context.rootCause)) {
    return { ok: true }
  }

  // Acknowledgement-by-pivot: if the model didn't say it in words
  // but DID switch to a structurally different action, that counts
  // as engaging with the error. (Less ideal than explicit
  // acknowledgement, but the model "got the message" implicitly.)
  if (responseTool && responseTool !== context.failedTool) {
    return { ok: true }
  }

  // Same-tool-different-arg-with-empty-reasoning case: when the chain
  // has no meaningful tokens at all (e.g. the model emitted a one-char
  // placeholder), we don't have a signal that it's actively ignoring.
  // Give benefit of the doubt — a different primary arg is at least
  // a structural attempt to fix the call. This distinguishes from the
  // soft-fail below, which fires when the reasoning DID say things,
  // they just had nothing to do with the error.
  const ackTokens = tokenise(ackText)
  if (ackTokens.length === 0 && responseTool === context.failedTool) {
    const responsePrimary = primaryArg(responseTool, responseArgs)
    if (responsePrimary && context.failedPrimaryArg && responsePrimary !== context.failedPrimaryArg) {
      return { ok: true }
    }
  }

  // Same tool, no acknowledgement text, primary arg may or may not
  // differ. Subtle case: e.g. agent retries `npm install pkg-a` after
  // `npm install pkg-b` failed. Different arg, same tool, no
  // mention. Treat as a soft-fail.
  return {
    ok: false,
    reason: `Response did not acknowledge the prior ${context.failedTool} error in reasoningChain or content, and did not switch to a different tool.`,
  }
}

/**
 * Pure helper: build the reject-prompt body that gets injected when
 * the validator fails. Stronger framing than Stage 3's regular
 * inject block — this fires AFTER the model already ignored the
 * Stage 3 block, so the language is more direct.
 */
export function buildErrorAcknowledgementRejectPrompt(
  check: ErrorAcknowledgementCheck,
  context: ErrorAcknowledgementContext,
  rejectionCount: number,
  rejectionCap: number,
): string {
  const remaining = rejectionCap - rejectionCount
  return `═══ RESPONSE REJECTED — ACKNOWLEDGE THE ERROR ═══

Your previous response did NOT engage with the prior tool error.
${check.reason ?? "(no specific reason)"}

This is rejection ${rejectionCount} of ${rejectionCap}. You have ${remaining} ${remaining === 1 ? "retry" : "retries"} left
before the system gives up and lets the run proceed silently.

REQUIRED:
1. In your \`reasoningChain[]\`, QUOTE the exact error text from the
   prior tool result and say what went wrong.
2. Address the reasoner's root-cause hypothesis: ${context.rootCause || "(no hypothesis — derive your own)"}
3. Either pick a DIFFERENT command/approach OR (if you have a
   strong reason) explain WHY retrying with changes will succeed.

Do NOT switch topics. Do NOT issue the same \`${context.failedTool}\`
call. Stop, reason, then act.

═══ END REJECTION ═══`
}
