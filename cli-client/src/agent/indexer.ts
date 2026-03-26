import fs from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"

// ─── Types ───

export interface IndexedFile {
  path: string
  ext: string
  dir: string
  size: number
  mtime: number
}

export interface FileIndex {
  version: number
  root: string
  builtAt: string
  checksum: string
  totalFiles: number
  totalDirs: number
  files: IndexedFile[]
  /** extension → file paths */
  byExt: Record<string, string[]>
  /** directory → file count */
  byDir: Record<string, number>
  /** keyword tokens from file paths → file paths (inverted index) */
  byToken: Record<string, string[]>
}

export interface DirectoryEntry {
  name: string
  type: "file" | "directory"
}

const INDEX_VERSION = 1
const IGNORE_DIRS = new Set([
  ".git", ".svn", ".hg", "node_modules", "sysbase",
  ".next", ".nuxt", "dist", "build", ".cache",
  "__pycache__", ".tox", "venv", ".venv",
  "vendor", "target", ".idea", ".vscode"
])
const IGNORE_FILES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"])

// ─── Build index ───

export async function buildFileIndex(rootDir: string): Promise<FileIndex> {
  const files: IndexedFile[] = []
  const byExt: Record<string, string[]> = {}
  const byDir: Record<string, number> = {}
  const byToken: Record<string, string[]> = {}
  const dirs = new Set<string>()

  await walkDirectory(rootDir, "", files, dirs)

  // Build extension index
  for (const file of files) {
    if (file.ext) {
      if (!byExt[file.ext]) byExt[file.ext] = []
      byExt[file.ext].push(file.path)
    }
  }

  // Build directory index
  for (const file of files) {
    const dir = file.dir || "."
    byDir[dir] = (byDir[dir] || 0) + 1
  }

  // Build inverted token index from file paths
  for (const file of files) {
    const tokens = tokenizePath(file.path)
    for (const token of tokens) {
      if (!byToken[token]) byToken[token] = []
      byToken[token].push(file.path)
    }
  }

  const checksum = computeChecksum(files)

  return {
    version: INDEX_VERSION,
    root: rootDir,
    builtAt: new Date().toISOString(),
    checksum,
    totalFiles: files.length,
    totalDirs: dirs.size,
    files,
    byExt,
    byDir,
    byToken
  }
}

async function walkDirectory(
  rootDir: string,
  prefix: string,
  files: IndexedFile[],
  dirs: Set<string>
): Promise<void> {
  const fullPath = prefix ? path.join(rootDir, prefix) : rootDir

  let entries
  try {
    entries = await fs.readdir(fullPath, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".") && IGNORE_DIRS.has(entry.name)) continue
    if (IGNORE_DIRS.has(entry.name)) continue
    if (IGNORE_FILES.has(entry.name)) continue

    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name

    if (entry.isDirectory()) {
      dirs.add(relativePath)
      await walkDirectory(rootDir, relativePath, files, dirs)
    } else if (entry.isFile()) {
      let stat
      try {
        stat = await fs.stat(path.join(rootDir, relativePath))
      } catch {
        continue
      }

      const ext = path.extname(entry.name).toLowerCase()
      const dir = prefix || "."

      files.push({
        path: relativePath,
        ext,
        dir,
        size: stat.size,
        mtime: stat.mtimeMs
      })
    }
  }
}

// ─── Persist / load index ───

export async function saveIndex(index: FileIndex, indexPath: string): Promise<void> {
  await fs.mkdir(path.dirname(indexPath), { recursive: true })
  await fs.writeFile(indexPath, JSON.stringify(index), "utf8")
}

export async function loadIndex(indexPath: string): Promise<FileIndex | null> {
  try {
    const raw = await fs.readFile(indexPath, "utf8")
    const index = JSON.parse(raw) as FileIndex
    if (index.version !== INDEX_VERSION) return null
    return index
  } catch {
    return null
  }
}

// ─── Staleness check ───

export async function isIndexStale(index: FileIndex, rootDir: string): Promise<boolean> {
  // Quick check: sample 20 random files for mtime changes
  const sampleSize = Math.min(20, index.files.length)
  const step = Math.max(1, Math.floor(index.files.length / sampleSize))

  for (let i = 0; i < index.files.length; i += step) {
    const file = index.files[i]
    try {
      const stat = await fs.stat(path.join(rootDir, file.path))
      if (Math.abs(stat.mtimeMs - file.mtime) > 1000) return true
    } catch {
      return true // file deleted
    }
  }

  // Check if new top-level entries exist
  try {
    const topEntries = await fs.readdir(rootDir, { withFileTypes: true })
    const topDirs = topEntries
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !IGNORE_DIRS.has(e.name))
      .map((e) => e.name)
    const indexTopDirs = new Set(Object.keys(index.byDir).map((d) => d.split("/")[0]))

    for (const d of topDirs) {
      if (!indexTopDirs.has(d) && d !== ".") return true
    }
  } catch {
    return true
  }

  return false
}

// ─── Get or rebuild index ───

export async function getOrBuildIndex(rootDir: string, sysbasePath: string): Promise<FileIndex> {
  const indexPath = path.join(sysbasePath, ".meta", "file-index.json")

  const existing = await loadIndex(indexPath)
  if (existing && existing.root === rootDir) {
    const stale = await isIndexStale(existing, rootDir)
    if (!stale) return existing
  }

  const index = await buildFileIndex(rootDir)
  await saveIndex(index, indexPath)
  return index
}

// ─── Search the index ───

export interface SearchResult {
  path: string
  score: number
}

/** Search files by name, extension, directory, or keyword */
export function searchIndex(index: FileIndex, query: string, limit: number = 30): SearchResult[] {
  const queryLower = query.toLowerCase()
  const queryTokens = tokenizePath(query)
  const scores = new Map<string, number>()

  // Exact extension match (e.g. ".ts", "ts")
  const extQuery = queryLower.startsWith(".") ? queryLower : `.${queryLower}`
  if (index.byExt[extQuery]) {
    for (const p of index.byExt[extQuery]) {
      scores.set(p, (scores.get(p) || 0) + 1)
    }
  }

  // Token match from inverted index
  for (const token of queryTokens) {
    const matches = index.byToken[token]
    if (matches) {
      for (const p of matches) {
        scores.set(p, (scores.get(p) || 0) + 3) // tokens score higher
      }
    }

    // Prefix match for partial tokens
    for (const [key, paths] of Object.entries(index.byToken)) {
      if (key.startsWith(token) && key !== token) {
        for (const p of paths) {
          scores.set(p, (scores.get(p) || 0) + 1)
        }
      }
    }
  }

  // Substring match on full path
  for (const file of index.files) {
    if (file.path.toLowerCase().includes(queryLower)) {
      scores.set(file.path, (scores.get(file.path) || 0) + 5) // direct match scores highest
    }
  }

  // Sort by score descending, then alphabetically
  return Array.from(scores.entries())
    .map(([p, score]) => ({ path: p, score }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, limit)
}

/** Search files by glob-like pattern */
export function searchByGlob(index: FileIndex, pattern: string): string[] {
  const regex = globToRegex(pattern)
  return index.files
    .filter((f) => regex.test(f.path))
    .map((f) => f.path)
}

/** List files in a specific directory (non-recursive) */
export function listDirectory(index: FileIndex, dir: string): string[] {
  const normalized = dir === "." || dir === "" ? "." : dir.replace(/\/$/, "")
  return index.files
    .filter((f) => f.dir === normalized)
    .map((f) => f.path)
}

/** Get compact tree summary — directories with file counts */
export function compactTree(index: FileIndex, maxEntries: number = 200): DirectoryEntry[] {
  const entries: DirectoryEntry[] = []

  if (index.totalFiles <= maxEntries) {
    // Small repo: return full tree
    const dirs = new Set<string>()
    for (const file of index.files) {
      // Add parent directories
      const parts = file.path.split("/")
      for (let i = 1; i < parts.length; i++) {
        const dir = parts.slice(0, i).join("/")
        if (!dirs.has(dir)) {
          dirs.add(dir)
          entries.push({ name: dir, type: "directory" })
        }
      }
      entries.push({ name: file.path, type: "file" })
    }
    return entries.sort((a, b) => a.name.localeCompare(b.name))
  }

  // Large repo: return directories with file counts, and top-level files
  const sortedDirs = Object.entries(index.byDir)
    .sort(([a], [b]) => a.localeCompare(b))

  for (const [dir, count] of sortedDirs) {
    if (dir === ".") continue
    entries.push({ name: `${dir}/ (${count} files)`, type: "directory" })
  }

  // Include root-level files
  const rootFiles = index.files.filter((f) => f.dir === ".")
  for (const file of rootFiles) {
    entries.push({ name: file.path, type: "file" })
  }

  // If still too large, collapse deep directories
  if (entries.length > maxEntries) {
    const collapsed: DirectoryEntry[] = []
    const topLevel = new Map<string, number>()

    for (const [dir, count] of sortedDirs) {
      const top = dir.split("/")[0]
      topLevel.set(top, (topLevel.get(top) || 0) + count)
    }

    for (const [dir, count] of topLevel.entries()) {
      collapsed.push({ name: `${dir}/ (${count} files)`, type: "directory" })
    }

    for (const file of rootFiles) {
      collapsed.push({ name: file.path, type: "file" })
    }

    return collapsed.sort((a, b) => a.name.localeCompare(b.name))
  }

  return entries.sort((a, b) => a.name.localeCompare(b.name))
}

// ─── Utilities ───

function tokenizePath(filePath: string): string[] {
  return filePath
    .toLowerCase()
    .replace(/[^a-z0-9]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1)
}

function computeChecksum(files: IndexedFile[]): string {
  const data = files.map((f) => `${f.path}:${f.mtime}`).join("|")
  return crypto.createHash("md5").update(data).digest("hex").slice(0, 12)
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\{\{GLOBSTAR\}\}/g, ".*")
  return new RegExp(`^${escaped}$`, "i")
}
