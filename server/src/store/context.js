/**
 * Context store — PostgreSQL-backed project context/patterns/memories.
 *
 * The AI writes patterns, fixes, and learnings here after each task.
 * Before implementing, the AI reads only RELEVANT context (filtered by tags/category).
 *
 * Categories:
 *   - "pattern"   — coding patterns, architectural decisions
 *   - "fix"       — bug fixes, gotchas, things that went wrong
 *   - "memory"    — general project knowledge, setup notes
 *   - "preference"— user preferences, coding style
 */

import { query } from "../db/connection.js"

/**
 * Save a context entry for a project.
 */
export async function saveContext({ projectId, userId, category, title, content, tags }) {
  const res = await query(
    `INSERT INTO context_entries (project_id, user_id, category, title, content, tags)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, title, category`,
    [projectId, userId || null, category || "general", title, content, tags || []]
  )
  return res.rows[0]
}

/**
 * Query relevant context entries for a project.
 * Filters by category and/or tags to avoid loading unrelated stuff.
 *
 * @param {string} projectId
 * @param {object} opts - { category, tags, limit }
 *   - category: filter by category (e.g. "pattern", "fix")
 *   - tags: array of tags to match (ANY match)
 *   - limit: max entries to return (default 10)
 */
export async function queryContext(projectId, opts = {}) {
  const { category, tags, limit = 10 } = opts

  let sql = `SELECT id, category, title, content, tags, created_at
             FROM context_entries WHERE project_id = $1`
  const params = [projectId]
  let paramIdx = 2

  if (category) {
    sql += ` AND category = $${paramIdx}`
    params.push(category)
    paramIdx++
  }

  if (tags && tags.length > 0) {
    sql += ` AND tags && $${paramIdx}`
    params.push(tags)
    paramIdx++
  }

  sql += ` ORDER BY updated_at DESC LIMIT $${paramIdx}`
  params.push(limit)

  const res = await query(sql, params)
  return res.rows
}

/**
 * Get ALL context for a project (used for full dump — limited to recent 20).
 */
export async function getAllContext(projectId) {
  const res = await query(
    `SELECT id, category, title, content, tags, created_at
     FROM context_entries WHERE project_id = $1
     ORDER BY updated_at DESC LIMIT 20`,
    [projectId]
  )
  return res.rows
}

/**
 * Build a compact context summary for injection into the AI prompt.
 * Only loads relevant context based on keywords from the user's prompt.
 *
 * @param {string} projectId
 * @param {string} userPrompt - the user's current prompt (for keyword extraction)
 */
export async function buildContextForPrompt(projectId, userPrompt) {
  // Extract simple keywords from the prompt for tag matching
  const keywords = extractKeywords(userPrompt)

  // Always load patterns and preferences (they're broadly useful)
  const patterns = await queryContext(projectId, { category: "pattern", limit: 5 })
  const preferences = await queryContext(projectId, { category: "preference", limit: 3 })

  // Load fixes and memories only if keywords match
  let fixes = []
  let memories = []

  if (keywords.length > 0) {
    fixes = await queryContext(projectId, { category: "fix", tags: keywords, limit: 5 })
    memories = await queryContext(projectId, { category: "memory", tags: keywords, limit: 5 })
  }

  // If no keyword-matched fixes/memories, load the most recent ones
  if (fixes.length === 0) {
    fixes = await queryContext(projectId, { category: "fix", limit: 3 })
  }
  if (memories.length === 0) {
    memories = await queryContext(projectId, { category: "memory", limit: 3 })
  }

  const all = [...patterns, ...preferences, ...fixes, ...memories]
  if (all.length === 0) return null

  // Deduplicate by id
  const seen = new Set()
  const unique = all.filter((e) => {
    if (seen.has(e.id)) return false
    seen.add(e.id)
    return true
  })

  const lines = ["Project context and learned patterns:"]
  for (const entry of unique) {
    lines.push(`[${entry.category}] ${entry.title}: ${entry.content.slice(0, 200)}`)
  }

  return lines.join("\n")
}

/**
 * Extract simple keywords from a prompt for tag matching.
 * Returns lowercase words that are likely meaningful.
 */
function extractKeywords(prompt) {
  if (!prompt) return []

  const stopWords = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "can", "shall", "to", "of", "in", "for",
    "on", "with", "at", "by", "from", "as", "into", "about", "like",
    "through", "after", "before", "between", "under", "above", "up",
    "down", "out", "off", "over", "again", "further", "then", "once",
    "here", "there", "when", "where", "why", "how", "all", "each",
    "every", "both", "few", "more", "most", "other", "some", "such",
    "no", "not", "only", "own", "same", "so", "than", "too", "very",
    "just", "because", "but", "and", "or", "if", "while", "that", "this",
    "it", "its", "i", "me", "my", "we", "our", "you", "your", "he",
    "she", "they", "them", "what", "which", "who", "whom", "make",
    "add", "create", "build", "fix", "update", "change", "modify",
    "implement", "write", "test", "run", "check", "use", "using",
    "please", "want", "need"
  ])

  return prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w))
    .slice(0, 10)
}
