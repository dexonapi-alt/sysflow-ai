# 11 — Search & Codebase Navigation

## What Claude Code Has

### Dedicated GrepTool (Ripgrep Integration)
- `GrepTool.ts` — Zod-validated input schema
- Uses `ripgrep` (`rg`) for fast regex search
- Parameters: `pattern`, `path`, `glob` filter, `head_limit` (default 250), `offset` (pagination)
- Excludes VCS directories automatically
- `head_limit: 0` for unlimited results (with explicit warning)
- Pagination via `offset` — can browse through large result sets
- Structured output with file paths, line numbers, match context

### Dedicated GlobTool (Pattern-Based File Discovery)
- File discovery by glob patterns (e.g., `src/**/*.ts`)
- Complements Grep — find files by name, search files by content
- Fast filesystem traversal
- Feature-flag gated (`!hasEmbeddedSearchTools()`)

### WebFetch Tool
- Fetch URL content and convert to readable format
- The model can read documentation, API references, changelogs
- Useful for setup tasks, dependency research, error troubleshooting

### WebBrowser Tool
- Full browser automation capability
- Navigate pages, interact with elements, fill forms, take screenshots
- For testing web applications, verifying UI changes

### LSP Integration
- `LSP` tool when `ENABLE_LSP_TOOL` is set
- Language Server Protocol for code intelligence
- Go to definition, find references, hover info, diagnostics
- Much more accurate than text search for code navigation

### Embedded Search Tools
- `hasEmbeddedSearchTools()` — ant builds may alias shell find/grep
- Can omit Glob/Grep tools when native search is available
- Adaptive tool set based on platform capabilities

### ToolSearch
- `isToolSearchEnabledOptimistic()` — search for the right tool
- Meta-tool: helps the model discover available tools
- Useful when the tool set is large (40+ tools)

### Terminal Capture
- `TerminalCapture` tool for reading terminal output
- Can inspect running processes, command output
- Useful for debugging and monitoring

---

## What Sysflow AI Has (Gaps)

### Weak Search Implementation
- `search_code`: grep (Unix) or PowerShell `Select-String` with exclusions
- Windows PowerShell one-liner is complex and may fail or be slow
- No ripgrep integration
- No pagination (`head_limit`, `offset`)
- No structured output (just raw text)
- Results can be enormous with no cap

### Basic File Search
- `search_files`: uses project index + glob from `indexer.ts`
- Depends on pre-built index — may be stale
- No dedicated glob tool for on-demand pattern matching
- Index must be rebuilt manually

### Fragile Web Search
- `web_search`: fetches DuckDuckGo HTML and parses it
- Depends on DuckDuckGo's HTML structure — **brittle**
- Falls back to npm search — very limited
- No URL fetching (can't read documentation pages)
- No browser automation

### No LSP Integration
- No language server support
- Can't "go to definition" or "find references"
- Code navigation relies entirely on text search
- This means the model has to guess where symbols are defined

### No Terminal Capture
- Can't inspect running processes
- Can't read command output from other terminals
- Limited to synchronous command execution

### No Tool Discovery
- Fixed tool set, no meta-search
- Model must know all tools from the system prompt
- No way to discover new tools mid-conversation

---

## What to Implement

### Priority 1: Ripgrep Integration
```typescript
const grepTool = buildTool({
  name: 'grep',
  description: 'Search file contents using regex patterns (powered by ripgrep)',
  inputSchema: z.object({
    pattern: z.string().describe('Regex pattern to search for'),
    path: z.string().optional().describe('Directory or file to search in'),
    glob: z.string().optional().describe('Glob pattern to filter files (e.g., "*.ts")'),
    headLimit: z.number().optional().default(250).describe('Max results to return'),
    offset: z.number().optional().default(0).describe('Skip first N results (for pagination)'),
    caseSensitive: z.boolean().optional().default(true),
    contextLines: z.number().optional().default(2).describe('Lines of context around matches'),
  }),
  isConcurrencySafe: () => true,
  isReadOnly: true,
  maxResultSizeChars: 30_000,
  call: async (input, ctx) => {
    const args = ['--json', '--line-number'];
    
    if (!input.caseSensitive) args.push('-i');
    if (input.glob) args.push('--glob', input.glob);
    if (input.contextLines) args.push('-C', String(input.contextLines));
    
    args.push('--max-count', String(input.headLimit + input.offset));
    args.push('--', input.pattern);
    if (input.path) args.push(input.path);
    
    const result = await execFile('rg', args, { cwd: ctx.cwd });
    
    // Parse JSON output, apply offset/limit, format
    const matches = parseRipgrepJSON(result.stdout);
    const paged = matches.slice(input.offset, input.offset + input.headLimit);
    
    return {
      matches: paged,
      totalMatches: matches.length,
      hasMore: matches.length > input.offset + input.headLimit,
    };
  },
});
```

### Priority 2: Glob Tool
```typescript
const globTool = buildTool({
  name: 'glob',
  description: 'Find files by name pattern',
  inputSchema: z.object({
    pattern: z.string().describe('Glob pattern (e.g., "src/**/*.test.ts")'),
    path: z.string().optional().describe('Base directory'),
  }),
  isConcurrencySafe: () => true,
  isReadOnly: true,
  maxResultSizeChars: 20_000,
  call: async (input, ctx) => {
    const files = await fastGlob(input.pattern, {
      cwd: input.path ?? ctx.cwd,
      ignore: ['node_modules/**', '.git/**', 'dist/**', 'build/**'],
      onlyFiles: true,
    });
    
    return {
      files: files.sort(),
      count: files.length,
    };
  },
});
```

### Priority 3: WebFetch Tool
```typescript
const webFetchTool = buildTool({
  name: 'web_fetch',
  description: 'Fetch a URL and return its content as readable text/markdown',
  inputSchema: z.object({
    url: z.string().url().describe('URL to fetch'),
    maxLength: z.number().optional().default(50_000).describe('Max content length'),
  }),
  isConcurrencySafe: () => true,
  isReadOnly: true,
  maxResultSizeChars: 50_000,
  call: async (input) => {
    const response = await fetch(input.url, {
      headers: { 'User-Agent': 'SysflowAI/1.0' },
      signal: AbortSignal.timeout(30_000),
    });
    
    const html = await response.text();
    const readable = htmlToMarkdown(html); // Use turndown or similar
    
    return {
      content: readable.slice(0, input.maxLength),
      url: input.url,
      status: response.status,
      truncated: readable.length > input.maxLength,
    };
  },
});
```

### Priority 4: Improve Existing web_search
```typescript
// Replace DuckDuckGo HTML scraping with a proper search API
// Options: SearXNG (self-hosted), Brave Search API, Tavily API

async function webSearch(query: string): Promise<SearchResult[]> {
  // Try SearXNG first (self-hosted, no API key needed)
  try {
    const response = await fetch(`${SEARXNG_URL}/search?q=${encodeURIComponent(query)}&format=json`);
    const data = await response.json();
    return data.results.map(r => ({
      title: r.title,
      url: r.url,
      snippet: r.content,
    }));
  } catch {
    // Fallback to Brave Search API
    const response = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}`, {
      headers: { 'X-Subscription-Token': BRAVE_API_KEY },
    });
    const data = await response.json();
    return data.web.results;
  }
}
```

### Priority 5: Result Size Caps and Pagination
For all search tools:
- Default `headLimit` of 250 results
- `offset` parameter for pagination
- `maxResultSizeChars` enforced per tool
- Clear indicators when results are truncated
- "Has more" flag in response
