# 06 — File Editing & Code Quality

## What Claude Code Has

### Robust String-Replace Edit Model
Claude Code's `FileEditTool` uses a clean `old_string` → `new_string` replacement model:
- Input: `{ file_path, old_string, new_string, replace_all? }`
- Validated with Zod schema
- `old_string` must be found exactly (or via quote normalization)
- `new_string` replaces it
- `replace_all` flag for global replacements

### Smart Quote Normalization
- `normalizeQuotes` converts curly quotes ↔ straight quotes
- `findActualString` tries exact match first, then normalized match
- `preserveQuoteStyle` rewrites `new_string` to match the file's existing quote style
- This handles models that produce curly quotes when the file uses straight quotes (common LLM behavior)

### Input Sanitization
- `normalizeFileEditInput` strips trailing whitespace on `new_string` (except `.md`/`.mdx`)
- `DESANITIZATIONS` map undoes API-level token sanitization
- `stripTrailingWhitespace` behavior per file type

### Pre-Edit Validation
- **Team memory secrets check** — won't write secrets
- **Read-before-edit enforcement** — file must be in `readFileState` (the model must have read the file first)
- **Partial view detection** — if the file was only partially read, may reject edit
- **Mtime check** — compares file modification time vs when it was read (catches external modifications, with content comparison fallback on Windows)
- **Multiple match detection** — if `old_string` matches more than once and `replace_all` not set, returns error
- `.ipynb` routing — Jupyter notebooks routed to NotebookEditTool
- **Size cap** — 1 GiB limit
- **UNC path handling** — Windows network paths

### Structured Patch Generation
- `getPatchForEdit` → `getPatchForEdits` with ordering enforcement
- `getPatchFromContents` uses the `diff` package for structured hunks
- Atomic write via `writeTextContent`
- LSP + VS Code notifications after write
- Optional remote git diff for display
- `countLinesChanged` analytics
- Tab conversion for display

### Settings File Validation
- Special validation for settings/config files
- Prevents accidental corruption of critical files

### File History Integration
- `fileHistory` tracking for edits
- Can show diffs of changes
- `fetchSingleFileGitDiff` for git-aware diffs

---

## What Sysflow AI Has (Gaps)

### Multiple Edit Modes (Complexity without Reliability)
Sysflow's `editFileTool` in `tools.ts` supports multiple modes:
- Search/replace with fuzzy line matching
- Line range replacement
- Insert at line
- Patch application

This **looks** more capable but each mode is a separate code path with its own bugs:

### Fragile Fuzzy Matching
- `fuzzySearchReplace` attempts line-by-line matching
- No quote normalization
- No whitespace normalization
- When the model produces slightly different whitespace, the edit fails silently or matches the wrong location
- No fallback to normalized matching

### No Read-Before-Edit Enforcement
- The model can edit a file it has never read
- This is a primary source of hallucinated edits
- The model guesses file contents and produces `old_string` that doesn't exist
- Sysflow tries to compensate with action planner's "reconnaissance" rule, but it's a heuristic

### No Mtime Check
- If the file was modified externally between read and edit, the edit proceeds blindly
- Can corrupt files that are being edited by other tools/processes

### No Multiple Match Detection
- If `old_string` matches in multiple places, behavior is undefined
- Could replace the wrong occurrence

### Silent Edit Failures
- `editFileTool` returns `{ success: false, error: '...' }` but the calling code doesn't always check
- The model may believe an edit succeeded when it didn't
- No structured error with recovery hints

### Package.json Protection (Good but Limited)
- `protectPackageJson` preserves scaffold-generated dependencies
- Good idea, but only covers one file type
- No general settings/config file protection

### Import Sanitization (Anti-Pattern)
- `sanitizeImports` strips imports that reference non-existent files
- This can **remove valid imports for files that will be created later in the task**
- Overly aggressive — hides model errors instead of letting them surface as lint errors

### No Structured Patch Output
- Edit results don't include structured diffs
- The model and user can't see what exactly changed
- No `countLinesChanged` analytics
- No LSP/editor notifications

### No Notebook Support
- No `NotebookEditTool` equivalent
- Can't edit Jupyter notebooks cell-by-cell

---

## What to Implement

### Priority 1: Read-Before-Edit Enforcement
```typescript
const fileReadState = new Map<string, { 
  content: string; 
  mtime: number; 
  partial: boolean;
  readRange?: { start: number; end: number };
}>();

function validateEditPrerequisites(
  filePath: string, 
  oldString: string
): ValidationResult {
  const readInfo = fileReadState.get(path.resolve(filePath));
  
  if (!readInfo) {
    return {
      valid: false,
      error: `You must read "${filePath}" before editing it. Use read_file first.`,
    };
  }
  
  // Check mtime
  const currentMtime = fs.statSync(filePath).mtimeMs;
  if (currentMtime !== readInfo.mtime) {
    // Content comparison fallback (handles Windows mtime granularity)
    const currentContent = fs.readFileSync(filePath, 'utf-8');
    if (currentContent !== readInfo.content) {
      return {
        valid: false,
        error: `File "${filePath}" was modified since you last read it. Please read it again.`,
      };
    }
  }
  
  // Check partial read
  if (readInfo.partial && !readInfo.content.includes(oldString)) {
    return {
      valid: false,
      error: `You only partially read "${filePath}" (lines ${readInfo.readRange?.start}-${readInfo.readRange?.end}). The content you're trying to edit may not be in the portion you read. Read the full file or the relevant section first.`,
    };
  }
  
  return { valid: true };
}
```

### Priority 2: Quote Normalization
```typescript
const QUOTE_PAIRS: [string, string][] = [
  ['\u201C', '"'],  // " → "
  ['\u201D', '"'],  // " → "
  ['\u2018', "'"],  // ' → '
  ['\u2019', "'"],  // ' → '
  ['\u00AB', '"'],  // « → "
  ['\u00BB', '"'],  // » → "
];

function normalizeQuotes(text: string): string {
  let result = text;
  for (const [curly, straight] of QUOTE_PAIRS) {
    result = result.replaceAll(curly, straight);
  }
  return result;
}

function findActualString(fileContent: string, searchString: string): {
  found: boolean;
  actualString: string;
  matchType: 'exact' | 'normalized';
} {
  // Try exact match
  if (fileContent.includes(searchString)) {
    return { found: true, actualString: searchString, matchType: 'exact' };
  }
  
  // Try normalized match
  const normalizedFile = normalizeQuotes(fileContent);
  const normalizedSearch = normalizeQuotes(searchString);
  if (normalizedFile.includes(normalizedSearch)) {
    // Find the actual string in the original file
    const idx = normalizedFile.indexOf(normalizedSearch);
    const actual = fileContent.substring(idx, idx + searchString.length);
    return { found: true, actualString: actual, matchType: 'normalized' };
  }
  
  return { found: false, actualString: '', matchType: 'exact' };
}
```

### Priority 3: Multiple Match Detection
```typescript
function countMatches(fileContent: string, searchString: string): number {
  let count = 0;
  let pos = 0;
  while ((pos = fileContent.indexOf(searchString, pos)) !== -1) {
    count++;
    pos += searchString.length;
  }
  return count;
}

// In edit_file handler:
const matchCount = countMatches(content, oldString);
if (matchCount === 0) {
  return { success: false, error: `"${oldString.slice(0, 100)}..." not found in file. Read the file first to see current content.` };
}
if (matchCount > 1 && !replaceAll) {
  return { success: false, error: `Found ${matchCount} matches for "${oldString.slice(0, 100)}...". Use replace_all: true to replace all, or provide more context to make the match unique.` };
}
```

### Priority 4: Structured Diff Output
```typescript
import { createPatch } from 'diff';

function getEditDiff(
  filePath: string, 
  oldContent: string, 
  newContent: string
): { patch: string; linesAdded: number; linesRemoved: number } {
  const patch = createPatch(filePath, oldContent, newContent);
  const lines = patch.split('\n');
  const linesAdded = lines.filter(l => l.startsWith('+')).length - 1; // minus header
  const linesRemoved = lines.filter(l => l.startsWith('-')).length - 1;
  
  return { patch, linesAdded, linesRemoved };
}
```

### Priority 5: Remove Import Sanitization
- Delete `sanitizeImports` — it hides real errors
- Let the model see lint/import errors and fix them itself
- The verification/lint system should catch these naturally

### Priority 6: Simplify to Single Edit Mode
- Remove line-range, insert, and patch modes
- Use **only** `old_string` → `new_string` replacement (with `replace_all`)
- For new file creation, use `write_file`
- For insertions, `old_string` = surrounding context, `new_string` = context + insertion
- Simpler = fewer bugs = more reliable
