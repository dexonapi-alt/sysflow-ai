import { query } from "../db/connection.js"

// ─── Types ───

interface SaveContextParams {
  projectId: string
  userId?: string | null
  category?: string
  title: string
  content: string
  tags?: string[]
  confidence?: "high" | "medium" | "low"
  lifecycle?: "candidate" | "verified" | "deprecated"
}

interface ContextEntry {
  id: number
  category: string
  title: string
  content: string
  tags: string[]
  confidence: string
  lifecycle: string
  created_at: string
}

interface QueryContextOpts {
  category?: string
  tags?: string[]
  limit?: number
  lifecycle?: string
}

// ─── Pattern categories ───
// api_pattern, db_pattern, migration_pattern, webhook_pattern,
// sync_pattern, bugfix_pattern, architecture_pattern, operational_pattern,
// memory, fix, pattern, preference, general

/**
 * Save a context entry with superseding logic.
 * If an existing entry in the same project+category has a similar title,
 * UPDATE it instead of creating a duplicate.
 */
export async function saveContext({ projectId, userId, category, title, content, tags, confidence, lifecycle }: SaveContextParams): Promise<{ id: number; title: string; category: string }> {
  const cat = category || "general"
  const builtContent = buildPatternContent(content, confidence, lifecycle)

  // ─── Supersede check: look for existing entry with similar title in same category ───
  const existing = await query(
    `SELECT id, title, content FROM context_entries
     WHERE project_id = $1 AND category = $2
     AND (title = $3 OR title LIKE $4)
     ORDER BY updated_at DESC LIMIT 1`,
    [projectId, cat, title, `${title.slice(0, 40)}%`]
  )

  if (existing.rows.length > 0) {
    const old = existing.rows[0]
    // Update the existing entry instead of creating a duplicate
    const res = await query(
      `UPDATE context_entries
       SET content = $1, tags = $2, updated_at = NOW()
       WHERE id = $3
       RETURNING id, title, category`,
      [builtContent, tags || [], old.id]
    )
    console.log(`[context] Superseded entry #${old.id} "${old.title.slice(0, 50)}" with updated content`)
    return res.rows[0]
  }

  // ─── No existing entry — create new ───
  const res = await query(
    `INSERT INTO context_entries (project_id, user_id, category, title, content, tags)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, title, category`,
    [projectId, userId || null, cat, title, builtContent, tags || []]
  )
  return res.rows[0]
}

/**
 * Deprecate old context entries that haven't been updated recently.
 * Call this periodically (e.g., at start of each new run) to prevent context rot.
 */
export async function deprecateStaleEntries(projectId: string, maxAgeDays: number = 30): Promise<number> {
  const res = await query(
    `UPDATE context_entries
     SET content = REPLACE(content, 'lifecycle: verified', 'lifecycle: deprecated')
     WHERE project_id = $1
       AND updated_at < NOW() - INTERVAL '1 day' * $2
       AND content LIKE '%lifecycle: verified%'
       AND content NOT LIKE '%lifecycle: deprecated%'
     RETURNING id`,
    [projectId, maxAgeDays]
  )

  if (res.rows.length > 0) {
    console.log(`[context] Deprecated ${res.rows.length} stale entries older than ${maxAgeDays} days`)
  }
  return res.rows.length
}

function buildPatternContent(content: string, confidence?: string, lifecycle?: string): string {
  const meta: string[] = []
  if (confidence) meta.push(`confidence: ${confidence}`)
  if (lifecycle) meta.push(`lifecycle: ${lifecycle}`)
  if (meta.length === 0) return content
  return `[${meta.join(", ")}]\n${content}`
}

export async function queryContext(projectId: string, opts: QueryContextOpts = {}): Promise<ContextEntry[]> {
  const { category, tags, limit = 10, lifecycle } = opts

  let sql = `SELECT id, category, title, content, tags, created_at
             FROM context_entries WHERE project_id = $1`
  const params: unknown[] = [projectId]
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

  // Filter out deprecated patterns by default
  if (lifecycle) {
    sql += ` AND content LIKE $${paramIdx}`
    params.push(`%lifecycle: ${lifecycle}%`)
    paramIdx++
  } else {
    sql += ` AND content NOT LIKE '%lifecycle: deprecated%'`
  }

  sql += ` ORDER BY updated_at DESC LIMIT $${paramIdx}`
  params.push(limit)

  const res = await query(sql, params)
  return res.rows
}

export async function getAllContext(projectId: string): Promise<ContextEntry[]> {
  const res = await query(
    `SELECT id, category, title, content, tags, created_at
     FROM context_entries WHERE project_id = $1
     ORDER BY updated_at DESC LIMIT 20`,
    [projectId]
  )
  return res.rows
}

export async function buildContextForPrompt(projectId: string, userPrompt: string): Promise<string | null> {
  const keywords = extractKeywords(userPrompt)

  // ─── Relevance-first loading: only fetch what matches the current task ───
  // Instead of loading from 8 categories, prioritize keyword-matched entries
  let relevant: ContextEntry[] = []

  if (keywords.length > 0) {
    // First: get entries that match the task keywords (most relevant)
    relevant = await queryContext(projectId, { tags: keywords, limit: 10 })
  }

  // Supplement with verified patterns if we don't have enough relevant context
  if (relevant.length < 5) {
    const verified = await queryContext(projectId, { lifecycle: "verified", limit: 8 })
    // Only add entries not already in relevant
    const seenIds = new Set(relevant.map((e) => e.id))
    for (const entry of verified) {
      if (!seenIds.has(entry.id)) {
        relevant.push(entry)
        seenIds.add(entry.id)
      }
    }
  }

  // Add bugfix patterns (high value, always useful)
  const bugfixes = await queryContext(projectId, { category: "bugfix_pattern", limit: 3 })
  const seenIds = new Set(relevant.map((e) => e.id))
  for (const entry of bugfixes) {
    if (!seenIds.has(entry.id)) {
      relevant.push(entry)
      seenIds.add(entry.id)
    }
  }

  if (relevant.length === 0) return null

  // Deduplicate by title similarity (not just by ID)
  const deduped = deduplicateByTitle(relevant)

  // Cap at 12 entries to prevent context bloat
  const capped = deduped.slice(0, 12)

  // Sort: verified first, then by recency
  capped.sort((a, b) => {
    const aVerified = a.content.includes("lifecycle: verified") ? 0 : 1
    const bVerified = b.content.includes("lifecycle: verified") ? 0 : 1
    if (aVerified !== bVerified) return aVerified - bVerified
    return 0
  })

  const lines = ["═══ LEARNED PATTERNS (from previous runs — verify before relying on these) ═══"]
  for (const entry of capped) {
    const staleTag = entry.content.includes("lifecycle: verified") ? "✓" : "?"
    lines.push(`  ${staleTag} [${entry.category}] ${entry.title}: ${entry.content.slice(0, 150)}`)
  }

  return lines.join("\n")
}

/** Deduplicate context entries by title similarity */
function deduplicateByTitle(entries: ContextEntry[]): ContextEntry[] {
  const seen = new Map<string, ContextEntry>()
  for (const entry of entries) {
    // Normalize title for comparison: lowercase, strip prefixes like "Fixed:", "Task completed:"
    const normalized = entry.title.toLowerCase()
      .replace(/^(fixed|task completed|failed|error):?\s*/i, "")
      .slice(0, 50)

    const existing = seen.get(normalized)
    if (!existing) {
      seen.set(normalized, entry)
    } else {
      // Keep the newer one (entries are already sorted by updated_at DESC)
      // But prefer verified over candidate
      const existingVerified = existing.content.includes("lifecycle: verified")
      const newVerified = entry.content.includes("lifecycle: verified")
      if (newVerified && !existingVerified) {
        seen.set(normalized, entry)
      }
    }
  }
  return [...seen.values()]
}

function extractKeywords(prompt: string): string[] {
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
