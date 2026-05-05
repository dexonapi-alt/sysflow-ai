/**
 * Project name extractor. Pulls a kebab-case name out of the user's prompt;
 * falls back to the cwd basename when the prompt doesn't suggest one.
 */

import path from "node:path"

const STOPWORDS = new Set([
  "a", "an", "the", "for", "to", "of", "with", "and", "or",
  "build", "create", "make", "set", "up", "init", "new", "start",
  "scaffold", "bootstrap", "initialize", "give", "me", "my",
  "want", "need", "please", "called", "named",
  "app", "application", "project", "thing",
])

const TRIGGER = /\b(?:create|build|make|set\s+up|initialize|init|new|start|bootstrap|scaffold)\b\s+(?:a\s+|an\s+|the\s+|me\s+a\s+|me\s+an\s+)?(.+?)(?:\s+(?:that|which|to|using|with)\s+|[.!?]|$)/i

const NAMED_AS = /(?:called|named|name(?:d)?\s+(?:it\s+)?(?:["']?))(["'`]?)([a-z][a-z0-9._-]*)\1/i

export function extractProjectName(userMessage: string, cwd?: string | null): string {
  const explicit = explicitName(userMessage)
  if (explicit) return explicit

  const phraseName = inferFromTriggerPhrase(userMessage)
  if (phraseName) return phraseName

  if (cwd) {
    const base = path.basename(cwd).replace(/[^a-z0-9-_]/gi, "-").toLowerCase()
    if (base && base.length > 1) return base
  }

  return "my-app"
}

function explicitName(msg: string): string | null {
  const m = msg.match(NAMED_AS)
  if (!m) return null
  return slug(m[2])
}

function inferFromTriggerPhrase(msg: string): string | null {
  const m = msg.match(TRIGGER)
  if (!m) return null
  const phrase = m[1] || ""

  const tokens = phrase
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((t) => !STOPWORDS.has(t))
    .slice(0, 4)

  if (tokens.length === 0) return null
  return slug(tokens.join("-"))
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 60) || "my-app"
}
