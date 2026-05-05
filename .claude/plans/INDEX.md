# Plans

Managed by `memex-md`. Each plan is a design artifact written before implementation. Plans travel with the repo so the team shares context.

## Plans

- [2026-05-02-phase-6-scaffold-first.md](2026-05-02-phase-6-scaffold-first.md) — Phase 6: scaffold-first project init. New `server/src/scaffold/` registry covering 15+ stacks; reasoning-driven recommender that auto-runs the scaffolder + auto-installs deps for HIGH-confidence single-scaffolder cases; rewrites the COMMANDS prompt section that previously forbade scaffolders.  *(in-progress)*

## Applied

- [applied/2026-05-02-phase-5-pre-flight-reasoning.md](applied/2026-05-02-phase-5-pre-flight-reasoning.md) — Phase 5 reasoning system: four-trigger architecture (pre-flight / self-invoked via `reason` tool / on-error / on-completion) with four pipelines (implement / bug / summary / decision), Zod-validated discriminated envelope, sha256 cache, four-shape CLI rendering, 37 new test cases.  *(implemented 2026-05-02)*
- [applied/2026-05-02-phase-4-productionisation.md](applied/2026-05-02-phase-4-productionisation.md) — Phase 4 productionisation: typed feature flag system, plan-mode toggle + slash command + status visibility, daily-rotated audit log with retention pruning, per-run CLI usage telemetry, vitest setup with ~30 cases across pure modules.  *(implemented 2026-05-02)*
- [applied/2026-05-02-phase-3-capabilities.md](applied/2026-05-02-phase-3-capabilities.md) — Phase 3 capabilities: Zod input schemas + validation pipeline, permission system (modes + per-tool gate + interactive prompt + persistent rules + slash commands), hook registry with pre/post events + built-in audit + secrets-block hooks.  *(implemented 2026-05-02)*
- [applied/2026-05-02-phase-2-foundation.md](applied/2026-05-02-phase-2-foundation.md) — Phase 2 foundation: real autocompact + circuit breaker, .sysflow.md project memory, max-output-token recovery, concurrency partitioning + sibling abort, tool-result persistence, structured tool-error classifier.  *(implemented 2026-05-02)*
- [applied/2026-05-02-phase-1-reasoning-and-cli-ux.md](applied/2026-05-02-phase-1-reasoning-and-cli-ux.md) — Phase 1 reasoning + CLI UX pass: modular cacheable prompt sections, token guard + microcompact + tool-result budget, schema fix, agent.ts split into renderer/state-machine/retry, tool-result preview.  *(implemented 2026-05-02)*
