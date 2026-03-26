# Sysflow Knowledge Base

**AI Knowledge Base for the Sysflow Project**

This folder is a living knowledge base that any AI assistant can read to understand the project accurately — no guessing, no hallucinations. It stays in the repo so the knowledge travels with the code.

## How It Works

- **AI reads** these files before making decisions about the codebase.
- **AI updates** these files as tasks are implemented (new routes, new tools, schema changes, etc.).
- **Any user, any AI** — the knowledge persists in the repo, not in a conversation.

## Folder Structure

```
docs/
├── README.md              # You are here
├── INDEX.md               # Master index of all knowledge files
├── architecture/          # System design, data flow, component relationships
├── patterns/              # Code patterns, conventions the codebase follows
├── conventions/           # Naming, file organization, commit style rules
├── stack/                 # Technologies, dependencies, config details
└── status/                # Current state — what's done, what's in progress
```

## Rules for AI

1. **Read before acting.** Check relevant files here before modifying the codebase.
2. **Update after acting.** When you add a route, tool, migration, or change architecture — update the relevant files here.
3. **Don't duplicate code.** These files describe *what* and *why*, not the code itself. Point to file paths.
4. **Keep it current.** If something here contradicts the code, the code wins. Fix the knowledge file.
5. **Be concise.** Short, scannable entries. No essays.
