# Knowledge base

Project-level knowledge that travels with the repo. Edit these files directly; do not store the same facts in machine-local auto-memory.

## Scope files

- [architecture.md](architecture.md) — system shape, services, data flow, cross-cutting loops
- [decisions.md](decisions.md) — non-obvious choices and their rationale
- [gotchas.md](gotchas.md) — past bugs and non-obvious constraints
- [patterns.md](patterns.md) — reusable code patterns
- [glossary.md](glossary.md) — project-specific terminology _(not yet populated)_

## Conventions

- One H2 heading per entry. Cite the source plan/PR in the entry's first line so future contributors can trace the decision.
- Append, don't rewrite — old entries are still useful even when superseded; mark them `**Superseded by:**` instead of deleting.
- When a plan in `.claude/plans/` lands, its design rationale should distill into 1-3 entries here.
