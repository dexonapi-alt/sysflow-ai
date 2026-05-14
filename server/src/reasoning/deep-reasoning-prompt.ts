/**
 * Stage C of model-lock-and-portable-reasoning plan: shared deliberation
 * directive injected into every pipeline that involves a real decision
 * (implement / bug / decision / chunk_plan / chunk_reflect / divergence /
 * implement_elaborate). NOT injected into summary — summary output is
 * user-facing prose and doesn't need the structured deliberation chain.
 *
 * User feedback that drove this addition: *"the reasoning feels like just
 * so structured and straightforward, it doesn't reason over and over again
 * like normal ai would and in plain. and it doesnt ask why, trades offs,
 * root causes, needed to investigate."*
 *
 * The addendum tells the reasoner to populate `reasoningChain[]` with
 * multi-paragraph plain prose BEFORE producing the structured brief.
 * Renders into the main model's prompt as a `═══ THINKING ═══` block so the
 * model sees deliberation, not just a form-like summary. Reasoner-backend-
 * agnostic — works the same whether Flash, Anthropic Haiku (Stage D), or
 * an OpenRouter free reasoner is serving the call.
 */

export const DEEP_REASONING_PROMPT = `═══ DEEP REASONING REQUIRED ═══

BE SMART ABOUT DEPTH. Gauge the complexity of the ask FIRST.

- If the task is genuinely trivial / obvious / one-line (e.g. "add a console.log
  here", "rename this variable", "fix this typo"): write 1-2 brief
  \`reasoningChain\` entries and move on. Do NOT manufacture deliberation
  where none is needed — over-thinking simple work wastes budget AND
  trains the main model to second-guess obvious moves.
- If the task is real engineering work — choosing a stack, naming a bug's
  root cause, planning multi-file scope, deciding architecture — write a
  FULL 5-10 paragraph chain following the moves below.

The line between "trivial" and "real" is your judgement call. When in
doubt, prefer the longer chain — under-reasoning on a real task is more
expensive than over-reasoning on a simple one. But don't fake depth.

BEFORE populating the structured brief fields, populate \`reasoningChain[]\`
with 1-10 paragraphs of plain-language deliberation. Each entry is ONE
round of thinking, written as a MID-TO-LONG paragraph (3-6 sentences,
≈300-800 chars). One-liners read as form-fill; flowing paragraphs read
as thinking. Write naturally, the way a senior engineer thinks out loud
— commit to a thought, follow its consequences, then move on.

For non-trivial tasks, cover these moves across your chain (one or two
paragraphs each — for simpler tasks, pick the 1-3 moves that actually
matter and skip the rest):

1. RESTATE — What is the user actually asking? Quote the prompt and
   identify what's ambiguous, under-specified, or hidden behind defaults.

2. ALTERNATIVES — List 2-3 different approaches you considered. Don't
   skip this. Even when one approach is obviously right, naming the
   alternatives forces you to articulate WHY it's right.

3. TRADE-OFFS — For each alternative, write one trade-off (pro / con).
   Pick one with an explicit "I'm choosing X because Y, accepting cost Z".

4. ROOT CAUSE (for bugs / errors / mismatches) — Ask "why" three times.
   Don't stop at the surface symptom. Chase the cause down to its source.

5. INVESTIGATION LEADS — What would you check if you could run a command
   right now? List the 2-3 things that, if confirmed/disconfirmed, would
   change your approach. The agent will use these to investigate before
   acting.

6. SELF-CRITIQUE — What's WRONG with the brief you're about to produce?
   Where might you be over-confident? Which assumption haven't you
   verified? Be honest — this is the most important entry.

7. FINAL JUSTIFICATION — Restate the chosen approach in one paragraph,
   acknowledging the trade-off and the risk surfaced by self-critique.

This chain renders into the main model's prompt verbatim as a
\`═══ THINKING ═══\` block. A form-like structured brief is not enough —
the chain is what makes the model understand WHY, not just WHAT. Write
in plain prose; bullets are NOT a substitute for the deliberation.

═══`
