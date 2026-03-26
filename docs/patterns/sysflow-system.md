# Sysflow System Pattern

> How the pattern-aware AI system works within Sysflow

## What is Sysflow's AI System

Sysflow's AI behavioral framework transforms the AI from a stateless code generator into a pattern-aware engineering system.

## Where It Lives in Code

| Component | File | What it does |
|-----------|------|-------------|
| System prompt | `server/src/providers/base-provider.ts` | AI identity, principles, pipeline, rules |
| Knowledge loader | `server/src/services/context.ts` | Loads `sysbase/` files into AI context |
| Pattern index | `server/src/services/pattern-index.ts` | Indexes sysbase knowledge files for fast lookup |
| Pattern store | `server/src/store/context.ts` | Saves/queries patterns with confidence + lifecycle |
| Auto-save | `server/src/handlers/tool-result.ts` | Creates patterns on task completion/failure |
| Task pipeline | `server/src/services/task.ts` | Aligns task steps with feature pipeline |

## Core Principles (embedded in system prompt)

1. **Pattern-first** — Read patterns before implementing, never invent if patterns exist
2. **No hallucination** — Infer from code, search, or ask — never fabricate
3. **Confidence-aware** — HIGH proceed, MEDIUM note assumptions, LOW ask user
4. **Codebase alignment** — Match repo conventions over "correct" code

## Knowledge Priority Order

1. Codebase (read files)
2. Existing patterns (sysbase knowledge + DB context)
3. Session history
4. Project context and fixes
5. User clarification

## Feature Pipeline

1. Inspect → 2. Retrieve patterns → 3. Analyze → 4. Detect unknowns → 5. Validate → 6. Plan → 7. Implement → 8. Verify → 9. Extract learnings

## Pattern Lifecycle

| State | Meaning |
|-------|---------|
| `candidate` | Newly discovered, not yet confirmed |
| `verified` | Confirmed by evidence or user |
| `deprecated` | Outdated or invalid (filtered from queries by default) |

## Pattern Categories

| Category | Use for |
|----------|---------|
| `api_pattern` | API route conventions |
| `db_pattern` | Database schema patterns |
| `migration_pattern` | Migration workflows |
| `webhook_pattern` | Webhook handling |
| `bugfix_pattern` | Errors and their fixes |
| `architecture_pattern` | System design decisions |
| `operational_pattern` | Commands, setup, deployment |
| `memory` | General task completion records |
| `fix` | Legacy fix category |
| `pattern` | General patterns |
| `preference` | User preferences |

## How Knowledge Flows

```
sysbase/ (per-project knowledge directory)
        │
        ▼
pattern-index.ts: buildPatternIndex()
  - Indexes architecture/, patterns/, conventions/, stack/, status/, decisions/, fixes/
  - Token-based search with boosting for key files
        │
        ▼
context.ts: loadSysbaseKnowledge()
  - Reads top 8 matches by relevance
  - Added to projectMemory[] → sent to AI in system context

context_entries (PostgreSQL, dynamic)
        │
        ▼
context store: buildContextForPrompt()
  - Queries by category + keyword tags
  - Filters deprecated patterns
  - Sorts verified first
        │
        ▼
Added as projectKnowledge → sent to AI in system context
```
