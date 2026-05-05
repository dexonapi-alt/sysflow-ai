/**
 * Few-shot examples for the reasoning pipelines. Grouped by pipeline so each
 * pipeline's system prompt only loads its own.
 *
 * Each example is { prompt, expectedOutput, note }. expectedOutput is a
 * pre-stringified envelope that demonstrates the schema; the reasoner is
 * told to mimic the structure. note is in-context only — never sent to the
 * model — to remind future maintainers why the example was added.
 */

export interface Example {
  prompt: string
  expectedOutput: string
  note: string
}

const stringify = (v: unknown): string => JSON.stringify(v, null, 2)

// ─── Implement examples (12) ───
export const IMPLEMENT_EXAMPLES: Example[] = [
  {
    prompt: "create an automation for my spreadsheet that sums column B by category",
    expectedOutput: stringify({
      pipeline: "implement",
      confidence: "MEDIUM",
      decision: "ask_user",
      missingContext: [
        { field: "google_sheet_id", whyCritical: "needed to target the correct sheet via gspread", suggestedQuestion: "What's the Google Sheet ID? (the long token in the sheet URL)", exampleValue: "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789" },
        { field: "service_account_json", whyCritical: "gspread needs auth credentials; service account is the lowest-friction path", suggestedQuestion: "Path to a Google service-account JSON key file? If you don't have one, I can walk you through creating it in GCP console.", exampleValue: "./credentials.json" },
      ],
      implementBrief: {
        intent: "Automated per-category sum of column B in a Google Sheet, reproducibly.",
        subcomponents: [
          { name: "auth client", kind: "config" },
          { name: "sheet reader", kind: "logic" },
          { name: "category aggregator", kind: "logic" },
          { name: "result writer", kind: "logic" },
        ],
        recommendedStack: { language: "Python", frameworks: [], libraries: ["gspread", "google-auth"], runtime: "python3.11", rationale: "gspread is the most stable Sheets client; google-auth handles service-account JSON natively. Python avoids a build step for a one-shot script." },
        architectureSketch: "Single script: load creds → open sheet by ID → read range → group by col A → sum col B → write to a 'Summary' tab.",
        buildPlan: [
          { step: "scaffold script + requirements.txt", deliverable: "main.py, requirements.txt", blockedBy: [] },
          { step: "auth + open sheet", deliverable: "auth helper", blockedBy: ["service_account_json", "google_sheet_id"] },
          { step: "read + aggregate", deliverable: "aggregator function", blockedBy: ["auth"] },
          { step: "write Summary tab", deliverable: "writer function", blockedBy: ["aggregator"] },
        ],
        edgeCases: ["empty rows in col A", "non-numeric values in col B", "Summary tab already exists (overwrite vs append)"],
        consistencyNotes: ["Remind user to share the sheet with the service-account email (client_email in the JSON) — required or gspread.open() returns 403."],
      },
      reasoningTrace: "User mentioned spreadsheet + automation; classified as implement. Python+gspread is the canonical stack. Sheet ID and credentials are HIGH-criticality; can't proceed without them.",
    }),
    note: "Canonical 'asks before guessing' example. The share-with reminder is the key value-add the user explicitly called out.",
  },
  {
    prompt: "scrape product prices from competitor.com daily",
    expectedOutput: stringify({
      pipeline: "implement",
      confidence: "MEDIUM",
      decision: "ask_user",
      missingContext: [
        { field: "target_urls_or_pattern", whyCritical: "scraper needs to know which pages to hit", suggestedQuestion: "Which URLs (or URL pattern, e.g. /products/*) should it scrape?", exampleValue: "https://competitor.com/products/*" },
        { field: "auth_required", whyCritical: "auth-walled pages need cookies or a logged-in session", suggestedQuestion: "Are these pages public or behind a login?" },
        { field: "schedule_host", whyCritical: "daily cron needs a runtime host (local cron, GitHub Actions, server)", suggestedQuestion: "Where should the daily run happen — local cron, GitHub Actions, or a server?" },
      ],
      implementBrief: {
        intent: "Daily price-monitoring scraper for a competitor site.",
        subcomponents: [
          { name: "fetcher", kind: "logic" },
          { name: "parser", kind: "logic" },
          { name: "store", kind: "db" },
          { name: "scheduler", kind: "infra" },
        ],
        recommendedStack: { language: "Python", frameworks: [], libraries: ["playwright", "beautifulsoup4", "sqlite3 (stdlib)"], runtime: "python3.11", rationale: "Playwright handles JS-rendered sites; BS4 parses static HTML cheaply; sqlite needs no setup for a daily-snapshot store." },
        architectureSketch: "scrape() function loops urls → playwright fetch → parse price → upsert into sqlite. Cron triggers it daily.",
        buildPlan: [
          { step: "scaffold + deps", deliverable: "main.py + requirements.txt", blockedBy: [] },
          { step: "fetch + parse one URL", deliverable: "single-URL flow", blockedBy: ["target_urls_or_pattern"] },
          { step: "loop + dedupe", deliverable: "multi-URL flow", blockedBy: [] },
          { step: "sqlite schema + writer", deliverable: "prices.db", blockedBy: [] },
          { step: "cron / GH Actions YAML", deliverable: "schedule config", blockedBy: ["schedule_host"] },
        ],
        edgeCases: ["site blocks scraping (rate limit / 403)", "price format varies per page", "currency conversion"],
        consistencyNotes: ["Add a User-Agent + courteous rate limit. If the user owns competitor.com, this is fine; if not, document the legal/ToS risk."],
      },
      reasoningTrace: "Web scraper task. Python+Playwright is robust for JS sites; BS4 for parsing; sqlite for a daily-snapshot store. URLs and auth are critical context.",
    }),
    note: "Three missing-context items consolidated into one ask in the CLI.",
  },
  {
    prompt: "add a button to the navbar",
    expectedOutput: stringify({
      pipeline: "implement",
      confidence: "HIGH",
      decision: "proceed",
      missingContext: [],
      implementBrief: {
        intent: "Insert a new button into the existing Navbar component.",
        subcomponents: [{ name: "Navbar", kind: "ui" }],
        recommendedStack: { language: "TypeScript", frameworks: ["React"], libraries: [], rationale: "Existing project uses React + TypeScript per package.json + Navbar.tsx; stay consistent." },
        architectureSketch: "Locate Navbar.tsx, insert <button> with the same Tailwind class pattern as siblings, wire onClick.",
        buildPlan: [
          { step: "read Navbar.tsx", deliverable: "current state", blockedBy: [] },
          { step: "add button JSX following sibling pattern", deliverable: "edited Navbar.tsx", blockedBy: [] },
          { step: "wire handler if behaviour was specified", deliverable: "handler stub", blockedBy: [] },
        ],
        edgeCases: ["button needs onClick — if not specified, stub with TODO + console.log"],
        consistencyNotes: ["Match the existing button styling pattern; don't introduce new design tokens for a single button."],
      },
      reasoningTrace: "Existing project context (React, Navbar.tsx) makes the stack obvious; no missing critical context. Proceed.",
    }),
    note: "Existing-project signal overrides the few-shot stack defaults.",
  },
  {
    prompt: "build a discord bot that posts daily memes",
    expectedOutput: stringify({
      pipeline: "implement",
      confidence: "MEDIUM",
      decision: "ask_user",
      missingContext: [
        { field: "discord_bot_token", whyCritical: "discord.js can't connect without a token", suggestedQuestion: "Discord bot token? (create one at https://discord.com/developers/applications)", exampleValue: "MTIz...[redact]" },
        { field: "guild_or_channel_id", whyCritical: "bot needs to know where to post", suggestedQuestion: "Which guild + channel ID should it post in?" },
        { field: "meme_source", whyCritical: "scraping reddit, hitting an API, or a static list — different deps", suggestedQuestion: "Where do the memes come from? r/memes via Reddit API, an RSS feed, or a folder of URLs?" },
      ],
      implementBrief: {
        intent: "Discord bot that posts a meme to a configured channel daily.",
        subcomponents: [
          { name: "discord client", kind: "config" },
          { name: "meme fetcher", kind: "logic" },
          { name: "scheduler", kind: "infra" },
        ],
        recommendedStack: { language: "TypeScript", frameworks: [], libraries: ["discord.js", "node-cron"], runtime: "node20", rationale: "discord.js is the canonical SDK; node-cron handles the daily schedule in-process." },
        architectureSketch: "Client logs in → cron fires daily → fetcher gets meme → channel.send(). Single file is fine.",
        buildPlan: [
          { step: "scaffold + deps + .env loader", deliverable: "package.json + index.ts + .env.example", blockedBy: [] },
          { step: "auth + ready event", deliverable: "client connects", blockedBy: ["discord_bot_token"] },
          { step: "fetch meme function", deliverable: "fetcher", blockedBy: ["meme_source"] },
          { step: "schedule + post", deliverable: "daily flow", blockedBy: ["guild_or_channel_id"] },
        ],
        edgeCases: ["bot lacks 'Send Messages' permission in target channel", "meme source returns NSFW content"],
        consistencyNotes: ["Token goes in .env, not source. Remind user to add the bot to the guild via the OAuth URL."],
      },
      reasoningTrace: "Discord automation. discord.js + node-cron. Token + channel + meme-source are critical.",
    }),
    note: "Three asks, one consolidated question; covers credential + target + data source.",
  },
  {
    prompt: "dockerise this node app for production",
    expectedOutput: stringify({
      pipeline: "implement",
      confidence: "HIGH",
      decision: "proceed",
      missingContext: [],
      implementBrief: {
        intent: "Production-ready Dockerfile for the Node app in this repo.",
        subcomponents: [
          { name: "Dockerfile", kind: "infra" },
          { name: ".dockerignore", kind: "infra" },
        ],
        recommendedStack: { language: "Dockerfile", frameworks: [], libraries: [], runtime: "node20-alpine", rationale: "node20-alpine is small + LTS. Multi-stage build keeps the final image lean." },
        architectureSketch: "Multi-stage: builder installs + builds, runner copies dist + prod deps, runs as non-root.",
        buildPlan: [
          { step: "read package.json for entry + scripts", deliverable: "scaffold inputs", blockedBy: [] },
          { step: "write Dockerfile (builder + runner)", deliverable: "Dockerfile", blockedBy: [] },
          { step: "write .dockerignore", deliverable: ".dockerignore", blockedBy: [] },
        ],
        edgeCases: ["native deps need build-base in the builder stage", "if there's no build script, single-stage is enough"],
        consistencyNotes: ["Use explicit USER node so prod doesn't run as root.", "EXPOSE the port from package.json scripts."],
      },
      reasoningTrace: "Existing Node project context. Multi-stage Alpine is the standard prod pattern. No missing context.",
    }),
    note: "HIGH-confidence proceed when context is fully derivable from the repo.",
  },
  {
    prompt: "make me a simple cli tool to convert csv to json",
    expectedOutput: stringify({
      pipeline: "implement",
      confidence: "HIGH",
      decision: "proceed",
      missingContext: [],
      implementBrief: {
        intent: "Single-file CLI that converts a CSV input to JSON output.",
        subcomponents: [{ name: "main", kind: "logic" }],
        recommendedStack: { language: "Python", frameworks: [], libraries: ["csv (stdlib)", "json (stdlib)"], runtime: "python3.11", rationale: "Stdlib-only Python script — no install, runs anywhere with python3." },
        architectureSketch: "argparse for input/output paths; csv.DictReader → list → json.dump.",
        buildPlan: [
          { step: "scaffold csv2json.py", deliverable: "main.py", blockedBy: [] },
          { step: "argparse + read + write", deliverable: "working CLI", blockedBy: [] },
        ],
        edgeCases: ["BOM in CSV", "stdin/stdout streaming variant"],
        consistencyNotes: ["Document usage in a docstring at the top."],
      },
      reasoningTrace: "Trivial CLI; Python stdlib is the cheapest stack. No external context needed.",
    }),
    note: "Distinguishes 'simple CLI' (Python stdlib) from 'binary distribution CLI' (Go/Rust) by the absence of a 'binary' / 'distribute' / 'install' keyword.",
  },
  {
    prompt: "i want a single binary cli tool to fuzz HTTP endpoints I can ship to my team",
    expectedOutput: stringify({
      pipeline: "implement",
      confidence: "HIGH",
      decision: "proceed",
      missingContext: [],
      implementBrief: {
        intent: "Distributable single-binary HTTP fuzzer.",
        subcomponents: [
          { name: "argparse", kind: "logic" },
          { name: "request engine", kind: "logic" },
          { name: "report formatter", kind: "logic" },
        ],
        recommendedStack: { language: "Go", frameworks: [], libraries: ["net/http (stdlib)"], runtime: "go1.22", rationale: "Single static binary, cross-compile, no runtime deps. 'ship to my team' is the deciding signal." },
        architectureSketch: "main.go parses flags → goroutines hit endpoints → report.",
        buildPlan: [
          { step: "scaffold go module", deliverable: "go.mod, main.go", blockedBy: [] },
          { step: "flag parsing + URL list ingest", deliverable: "CLI surface", blockedBy: [] },
          { step: "concurrent fetch + collector", deliverable: "engine", blockedBy: [] },
          { step: "Makefile for cross-compile (linux/mac/win)", deliverable: "Makefile", blockedBy: [] },
        ],
        edgeCases: ["rate-limited targets need backoff", "auth headers per endpoint"],
        consistencyNotes: ["Document `make build-all` produces three binaries to ship."],
      },
      reasoningTrace: "'Single binary' + 'ship to my team' triggers Go (or Rust) over Python. Go has the lighter learning curve.",
    }),
    note: "Distinguishes binary-distribution from script-CLI based on user intent keywords.",
  },
  {
    prompt: "build a stripe checkout integration for a saas",
    expectedOutput: stringify({
      pipeline: "implement",
      confidence: "MEDIUM",
      decision: "ask_user",
      missingContext: [
        { field: "stripe_product_id_and_price_id", whyCritical: "Stripe Checkout requires a price_id; product_id alone isn't enough", suggestedQuestion: "What's the Stripe price_id (looks like price_xxx) for the plan you want to sell?" },
        { field: "success_and_cancel_urls", whyCritical: "Checkout sessions need redirect URLs", suggestedQuestion: "Where should Stripe redirect on success vs cancel?" },
      ],
      implementBrief: {
        intent: "Stripe Checkout flow for a SaaS subscription.",
        subcomponents: [
          { name: "create-session endpoint", kind: "api" },
          { name: "webhook handler", kind: "api" },
          { name: "success page", kind: "ui" },
        ],
        recommendedStack: { language: "TypeScript", frameworks: [], libraries: ["stripe"], runtime: "node20", rationale: "Stripe's official SDK is well-typed; webhook signing helpers are first-class." },
        architectureSketch: "POST /checkout creates session → redirect to Stripe → webhook on checkout.session.completed activates the user's subscription.",
        buildPlan: [
          { step: "deps + env vars", deliverable: ".env.example + stripe SDK install", blockedBy: [] },
          { step: "create-session route", deliverable: "POST /checkout", blockedBy: ["stripe_product_id_and_price_id", "success_and_cancel_urls"] },
          { step: "webhook handler with signature verify", deliverable: "POST /stripe/webhook", blockedBy: [] },
        ],
        edgeCases: ["webhook delivery is at-least-once — handler must be idempotent", "test mode vs live mode keys"],
        consistencyNotes: ["Never trust the redirect — only the webhook proves payment. Use the Stripe CLI to test webhooks locally."],
      },
      reasoningTrace: "SaaS Stripe integration. Webhook + Checkout pattern. price_id and redirect URLs are HIGH-criticality.",
    }),
    note: "Webhook-idempotency note is the high-value consistency reminder.",
  },
  {
    prompt: "create a react landing page for a fintech startup",
    expectedOutput: stringify({
      pipeline: "implement",
      confidence: "MEDIUM",
      decision: "ask_user",
      missingContext: [
        { field: "brand_name", whyCritical: "real copy beats lorem ipsum; need the actual product name", suggestedQuestion: "What's the company/product name?" },
        { field: "value_proposition", whyCritical: "the hero needs a real one-line pitch", suggestedQuestion: "One sentence: what does the product do for users?" },
      ],
      implementBrief: {
        intent: "Single-page React landing page tuned for fintech (trust signals, conversion-focused hero).",
        subcomponents: [
          { name: "Navbar", kind: "ui" },
          { name: "Hero", kind: "ui" },
          { name: "Features", kind: "ui" },
          { name: "Trust", kind: "ui" },
          { name: "CTA", kind: "ui" },
          { name: "Footer", kind: "ui" },
        ],
        recommendedStack: { language: "TypeScript", frameworks: ["React", "Vite", "Tailwind"], libraries: ["framer-motion"], runtime: "node20", rationale: "Vite is the fastest scaffold; Tailwind ships polished UI quickly; framer-motion adds the polish that fintech buyers expect." },
        architectureSketch: "One App.tsx assembles section components. Each section is a separate file under src/components.",
        buildPlan: [
          { step: "Vite + Tailwind + framer scaffold", deliverable: "package.json, tailwind config", blockedBy: [] },
          { step: "Navbar + Hero with real copy", deliverable: "Navbar.tsx, Hero.tsx", blockedBy: ["brand_name", "value_proposition"] },
          { step: "Features + Trust", deliverable: "two more sections", blockedBy: [] },
          { step: "CTA + Footer", deliverable: "two more sections", blockedBy: [] },
        ],
        edgeCases: ["fintech requires a regulatory disclaimer in the footer (e.g., FDIC/registered)"],
        consistencyNotes: ["Use a dark theme by default per the existing frontend pattern. No lorem ipsum."],
      },
      reasoningTrace: "Frontend marketing page. Real copy beats placeholders, hence asking for brand + pitch.",
    }),
    note: "Frontend tasks ask for brand + pitch instead of inventing them.",
  },
  {
    prompt: "set up postgres with prisma in this nest project",
    expectedOutput: stringify({
      pipeline: "implement",
      confidence: "HIGH",
      decision: "proceed",
      missingContext: [],
      implementBrief: {
        intent: "Wire Prisma + Postgres into the existing NestJS project.",
        subcomponents: [
          { name: "PrismaModule", kind: "config" },
          { name: "schema.prisma", kind: "db" },
        ],
        recommendedStack: { language: "TypeScript", frameworks: ["NestJS", "Prisma"], libraries: ["@prisma/client", "@nestjs/config"], runtime: "node20", rationale: "Stay on the existing Nest stack. Prisma is the standard ORM for Nest + Postgres in 2026." },
        architectureSketch: "PrismaService wraps PrismaClient as a singleton; PrismaModule exports it; schema.prisma defines the model.",
        buildPlan: [
          { step: "install @prisma/client + prisma (dev)", deliverable: "deps", blockedBy: [] },
          { step: "init schema.prisma + first model placeholder", deliverable: "schema.prisma", blockedBy: [] },
          { step: "PrismaService + PrismaModule", deliverable: "src/prisma/*", blockedBy: [] },
          { step: "DATABASE_URL in .env.example", deliverable: ".env.example", blockedBy: [] },
        ],
        edgeCases: ["existing migrations folder? — don't clobber"],
        consistencyNotes: ["Run `prisma generate` in postinstall so CI doesn't forget. Note: don't run `prisma migrate dev` automatically — let the user choose."],
      },
      reasoningTrace: "Existing Nest project + clear stack request. Prisma is the conventional choice; no missing context.",
    }),
    note: "Defers `prisma migrate dev` to the user — destructive operations need explicit consent.",
  },
  {
    prompt: "make a small ML script to classify customer reviews as positive or negative",
    expectedOutput: stringify({
      pipeline: "implement",
      confidence: "MEDIUM",
      decision: "ask_user",
      missingContext: [
        { field: "training_data_source", whyCritical: "fine-tuning needs labelled examples; zero-shot doesn't but accuracy varies", suggestedQuestion: "Do you have a labelled dataset (CSV with text + label), or should I use a zero-shot pre-trained model?" },
        { field: "deployment_target", whyCritical: "Python script vs HTTP service vs batch job — different file structure", suggestedQuestion: "Will this run as a one-off batch script, a HTTP service, or both?" },
      ],
      implementBrief: {
        intent: "Sentiment classifier for customer reviews.",
        subcomponents: [
          { name: "data loader", kind: "logic" },
          { name: "model wrapper", kind: "logic" },
          { name: "predict + report", kind: "logic" },
        ],
        recommendedStack: { language: "Python", frameworks: [], libraries: ["transformers", "torch"], runtime: "python3.11", rationale: "HuggingFace transformers ship pre-trained sentiment models off-the-shelf. Torch is the runtime." },
        architectureSketch: "Either: (a) zero-shot — load distilbert-base-uncased-finetuned-sst-2 + run inference; or (b) fine-tune on the user's dataset.",
        buildPlan: [
          { step: "scaffold + requirements", deliverable: "main.py + requirements.txt", blockedBy: [] },
          { step: "data loader (CSV → list)", deliverable: "loader fn", blockedBy: ["training_data_source"] },
          { step: "model load + predict", deliverable: "predict fn", blockedBy: [] },
          { step: "output report (CSV / API endpoint)", deliverable: "report fn", blockedBy: ["deployment_target"] },
        ],
        edgeCases: ["GPU vs CPU runtime", "non-English reviews"],
        consistencyNotes: ["For zero-shot, document the model's licence."],
      },
      reasoningTrace: "ML classification task. Transformers is the canonical stack. Dataset + deployment shape are HIGH-criticality.",
    }),
    note: "ML defaults to zero-shot before suggesting fine-tuning; latter requires data.",
  },
  {
    prompt: "create a chrome extension that highlights all email addresses on a page",
    expectedOutput: stringify({
      pipeline: "implement",
      confidence: "HIGH",
      decision: "proceed",
      missingContext: [],
      implementBrief: {
        intent: "Browser extension that finds + visually highlights email addresses on any page.",
        subcomponents: [
          { name: "manifest", kind: "config" },
          { name: "content_script", kind: "logic" },
          { name: "icon assets", kind: "ui" },
        ],
        recommendedStack: { language: "JavaScript", frameworks: [], libraries: [], runtime: "Manifest V3", rationale: "MV3 is required for new Chrome extensions. Vanilla JS is sufficient — no framework needed for a content script." },
        architectureSketch: "manifest.json declares content_script on <all_urls>; the script does a TreeWalker scan + wraps email matches in a styled <mark>.",
        buildPlan: [
          { step: "manifest.json (MV3, content_scripts)", deliverable: "manifest.json", blockedBy: [] },
          { step: "content.js with regex + DOM walker", deliverable: "content.js", blockedBy: [] },
          { step: "minimal icon + readme for sideload install", deliverable: "icon + README", blockedBy: [] },
        ],
        edgeCases: ["already-highlighted re-runs (idempotency)", "iframes (CSP)"],
        consistencyNotes: ["Use a non-greedy regex; emails inside scripts/styles should be skipped via the TreeWalker filter."],
      },
      reasoningTrace: "Browser extension scope. Manifest V3 required by Chrome; vanilla JS keeps the footprint tiny. No external context needed.",
    }),
    note: "Browser extension default is MV3 + vanilla JS unless the user mentions a framework.",
  },
]

// ─── Bug examples (8) ───
export const BUG_EXAMPLES: Example[] = [
  {
    prompt: "the api 500s after the latest deploy. logs show 'Cannot read property of undefined'",
    expectedOutput: stringify({
      pipeline: "bug",
      confidence: "MEDIUM",
      decision: "proceed",
      missingContext: [],
      bugBrief: {
        symptom: "API returns 500 after deploy; logs show 'Cannot read property of undefined'.",
        expectedVsActual: { expected: "API responds 2xx as before deploy.", actual: "500 with TypeError on a property access." },
        suspectedBoundary: "config",
        hypotheses: [
          { hypothesis: "Env var missing in prod (was set locally, not in deploy config).", supportingEvidence: "'undefined' is the canonical symptom of a missing env value.", probability: "HIGH", invalidatingTest: "Check the prod env config; compare to .env.example. If all listed vars are set, this isn't it." },
          { hypothesis: "API response shape changed; client code accesses a property that no longer exists.", supportingEvidence: "Recent deploy is the change-driver.", probability: "MEDIUM", invalidatingTest: "Diff the response payload before/after deploy." },
          { hypothesis: "DB migration ran and renamed/dropped a column the code still reads.", supportingEvidence: "Schema changes paired with deploys often cause this.", probability: "MEDIUM", invalidatingTest: "Check migration log + the failing line's column reference." },
        ],
        rootCauseGuess: "Missing env var in production deploy config.",
        proposedFix: { description: "Add a startup check that throws on missing required env vars (fail fast). Then set the missing var.", scope: "minimal", filesAffected: ["src/config.ts", "deploy/config.yaml or wherever env is sourced"] },
        sideEffects: ["startup check itself can crash if envs are bad — wrap with a clear error"],
        verificationSteps: ["Reproduce locally with the env var unset; confirm it throws the new helpful error.", "After fix, hit the failing endpoint in staging."],
      },
      reasoningTrace: "Classic post-deploy 500 + 'undefined' = config drift. Listed three ranked hypotheses; HIGH on env var.",
    }),
    note: "Hypothesis ranking with HIGH/MEDIUM/LOW + invalidatingTest is the core value.",
  },
  {
    prompt: "tests pass locally but fail in CI",
    expectedOutput: stringify({
      pipeline: "bug",
      confidence: "MEDIUM",
      decision: "ask_user",
      missingContext: [
        { field: "ci_test_log", whyCritical: "without the actual failure log we're guessing at boundary", suggestedQuestion: "Paste the CI failure log, or the last 30 lines of the failing test's output?" },
      ],
      bugBrief: {
        symptom: "Test suite green locally, red on CI.",
        expectedVsActual: { expected: "Same pass/fail in both envs.", actual: "Local pass, CI fail." },
        suspectedBoundary: "infra",
        hypotheses: [
          { hypothesis: "Race / timing — tests assume order or filesystem timing that CI's slower runners expose.", supportingEvidence: "Most common local-vs-CI divergence.", probability: "HIGH", invalidatingTest: "Re-run with --runInBand or --max-workers=1 locally; if still passing, suspect another category." },
          { hypothesis: "Env var difference (NODE_ENV=test, missing secret).", supportingEvidence: "CI envs intentionally differ from local.", probability: "MEDIUM", invalidatingTest: "Diff env between local + CI; especially DB URL + feature flags." },
          { hypothesis: "Filesystem case-sensitivity (Mac local, Linux CI).", supportingEvidence: "Import casing issues silently work on Mac/Win, fail on Linux.", probability: "MEDIUM", invalidatingTest: "Search for imports with mixed case; or run on a Linux container locally." },
        ],
        rootCauseGuess: null,
        proposedFix: { description: "Need the CI log to narrow this. Once we have it, the highest-probability hypothesis dictates the fix.", scope: "minimal", filesAffected: [] },
        sideEffects: [],
        verificationSteps: ["Re-run CI after the fix; ideally also reproduce locally with the case-sensitivity / single-worker setup."],
      },
      reasoningTrace: "Local-vs-CI divergence is a known-pattern bucket. Three top hypotheses; need the actual log to commit.",
    }),
    note: "Bug pipeline can ask for context (the log) like implement does.",
  },
  {
    prompt: "fix the build",
    expectedOutput: stringify({
      pipeline: "bug",
      confidence: "MEDIUM",
      decision: "ask_user",
      missingContext: [
        { field: "build_command_output", whyCritical: "'fix the build' is too vague to act on without seeing what's broken", suggestedQuestion: "What does `npm run build` output? Paste the last error block." },
      ],
      bugBrief: {
        symptom: "Build broken — exact failure unknown.",
        expectedVsActual: { expected: "build exits 0", actual: "build exits non-zero" },
        suspectedBoundary: "unknown",
        hypotheses: [
          { hypothesis: "tsc error from a recent edit.", supportingEvidence: "Most common cause of a sudden break.", probability: "MEDIUM", invalidatingTest: "Check the build log's first error." },
          { hypothesis: "Missing dependency after a package.json change without npm install.", supportingEvidence: "Common after pulling a branch.", probability: "MEDIUM", invalidatingTest: "Compare node_modules to package.json; npm ci." },
        ],
        rootCauseGuess: null,
        proposedFix: { description: "Need the build output. Then minimal-scope fix on the offending file.", scope: "minimal", filesAffected: [] },
        sideEffects: [],
        verificationSteps: ["Re-run build; expect exit 0."],
      },
      reasoningTrace: "Vague 'fix the build' → ask for the log. Don't guess.",
    }),
    note: "When prompt is too vague to be useful, the bug pipeline asks for log instead of inventing.",
  },
  {
    prompt: "ENOENT after I renamed src/utils to src/lib",
    expectedOutput: stringify({
      pipeline: "bug",
      confidence: "HIGH",
      decision: "proceed",
      missingContext: [],
      bugBrief: {
        symptom: "ENOENT errors after renaming src/utils → src/lib.",
        expectedVsActual: { expected: "imports resolve from new path.", actual: "imports still pointing at old path." },
        suspectedBoundary: "config",
        hypotheses: [
          { hypothesis: "Imports across the codebase still reference src/utils.", supportingEvidence: "ENOENT immediately after rename.", probability: "HIGH", invalidatingTest: "grep -r 'src/utils' src/ — any hits = unfixed." },
          { hypothesis: "Build cache holds the old path (Vite/Webpack).", supportingEvidence: "Possible if grep returns no matches.", probability: "LOW", invalidatingTest: "rm -rf node_modules/.cache dist/ + restart." },
        ],
        rootCauseGuess: "Stale imports referencing the old directory name.",
        proposedFix: { description: "grep-driven find/replace 'src/utils' → 'src/lib' across all .ts/.tsx files. Then re-run build.", scope: "moderate", filesAffected: ["all files with `from '.../utils/...'` imports"] },
        sideEffects: ["If 'src/utils' substring appears in non-import contexts (comments, strings), the find/replace catches them too — review the diff."],
        verificationSteps: ["grep returns no hits", "build / dev server starts clean"],
      },
      reasoningTrace: "Rename + ENOENT = stale imports. HIGH-confidence root cause.",
    }),
    note: "HIGH-confidence proceed when symptom maps cleanly to a known root cause.",
  },
  {
    prompt: "the page is blank in production but works locally",
    expectedOutput: stringify({
      pipeline: "bug",
      confidence: "MEDIUM",
      decision: "ask_user",
      missingContext: [
        { field: "browser_console_errors", whyCritical: "blank page = JS error pre-render; the console will say which", suggestedQuestion: "Open devtools on the prod URL — what errors does the console show?" },
      ],
      bugBrief: {
        symptom: "Blank page in production; works locally.",
        expectedVsActual: { expected: "Same render in both envs.", actual: "Local renders, prod blank." },
        suspectedBoundary: "frontend",
        hypotheses: [
          { hypothesis: "Asset path / base href mismatch — prod CDN has a different base than dev server.", supportingEvidence: "Most common 'blank in prod' cause.", probability: "HIGH", invalidatingTest: "Check Network tab — 404 on JS bundle = base path issue." },
          { hypothesis: "CSP blocks the prod bundle.", supportingEvidence: "Possible if you've set CSP headers in prod only.", probability: "MEDIUM", invalidatingTest: "Console will show CSP violations." },
          { hypothesis: "Env var only set locally; runtime config crashes the bootstrap.", supportingEvidence: "Local-vs-prod env divergence.", probability: "MEDIUM", invalidatingTest: "Compare envs; check the bundle's first executed line." },
        ],
        rootCauseGuess: null,
        proposedFix: { description: "Need the console errors. Most likely an asset-path fix in vite.config.ts (base: '/your-subpath/').", scope: "minimal", filesAffected: ["vite.config.ts (or build-tool config)"] },
        sideEffects: [],
        verificationSteps: ["After fix, hit prod URL with devtools open — no console errors."],
      },
      reasoningTrace: "Frontend blank-in-prod has three top buckets. Need console output to commit.",
    }),
    note: "Frontend-bucket bug; asks for console output as the discriminating evidence.",
  },
  {
    prompt: "memory keeps growing in our node service. think there's a leak somewhere",
    expectedOutput: stringify({
      pipeline: "bug",
      confidence: "LOW",
      decision: "ask_user",
      missingContext: [
        { field: "heap_snapshot_or_growth_rate", whyCritical: "leak diagnosis without snapshots is guessing", suggestedQuestion: "Can you share two heap snapshots taken N minutes apart? Or at least the growth rate (MB/hour) and the service's main responsibilities?" },
      ],
      bugBrief: {
        symptom: "Steady-state memory growth in a Node service.",
        expectedVsActual: { expected: "Memory plateaus after warmup.", actual: "Memory monotonically increases." },
        suspectedBoundary: "backend",
        hypotheses: [
          { hypothesis: "Closure retains a large object (event handler in a loop).", supportingEvidence: "Most common Node leak.", probability: "MEDIUM", invalidatingTest: "Heap snapshot diff shows the retainer." },
          { hypothesis: "Listener accumulation on a global emitter.", supportingEvidence: "Frequent for HTTP handlers attaching to req.", probability: "MEDIUM", invalidatingTest: "EventEmitter listenerCount over time." },
          { hypothesis: "Cache with no eviction (Map keyed by request id).", supportingEvidence: "Common pattern leak.", probability: "MEDIUM", invalidatingTest: "Find Maps that grow with traffic; check for removal logic." },
        ],
        rootCauseGuess: null,
        proposedFix: { description: "Need heap data first. Once retainer is known, fix is usually a 1-line listener removal or Map eviction.", scope: "minimal", filesAffected: [] },
        sideEffects: [],
        verificationSteps: ["After fix, take a snapshot; memory should plateau within N minutes of load."],
      },
      reasoningTrace: "Memory leak — LOW confidence without snapshots. Three top patterns; need data to commit.",
    }),
    note: "LOW confidence is allowed; the brief still lists patterns to investigate.",
  },
  {
    prompt: "intermittent test failure on order-processing.test.ts. fails maybe 1 in 10 runs",
    expectedOutput: stringify({
      pipeline: "bug",
      confidence: "HIGH",
      decision: "proceed",
      missingContext: [],
      bugBrief: {
        symptom: "Intermittent failure (~10% rate) on order-processing.test.ts.",
        expectedVsActual: { expected: "Test deterministic.", actual: "Non-deterministic." },
        suspectedBoundary: "race_condition",
        hypotheses: [
          { hypothesis: "Async order — test asserts before a promise settles.", supportingEvidence: "Order processing usually involves async I/O.", probability: "HIGH", invalidatingTest: "Add awaits before assertion; if the rate drops to 0, confirmed." },
          { hypothesis: "Shared mutable state across tests (order id reuse).", supportingEvidence: "Common in CRUD test suites.", probability: "MEDIUM", invalidatingTest: "Run with --runInBand; if still flaky, not it." },
          { hypothesis: "Time-based assertion (Date.now() comparison).", supportingEvidence: "Tests asserting on timestamps flake on slow runners.", probability: "LOW", invalidatingTest: "grep for Date.now / new Date() in the test." },
        ],
        rootCauseGuess: "Unawaited async in the test or in the SUT.",
        proposedFix: { description: "Read the test; find the most-likely missing await; add it.", scope: "minimal", filesAffected: ["order-processing.test.ts (and possibly its SUT)"] },
        sideEffects: ["Adding awaits where they weren't expected may surface real race conditions in the SUT."],
        verificationSteps: ["Run the test 100× — failure rate should be 0."],
      },
      reasoningTrace: "Intermittent + 'order processing' + ~10% rate = classic async race. HIGH confidence proceed.",
    }),
    note: "Pattern-match on the symptom shape gives HIGH confidence even without the test code.",
  },
  {
    prompt: "PostgreSQL query is slow",
    expectedOutput: stringify({
      pipeline: "bug",
      confidence: "MEDIUM",
      decision: "ask_user",
      missingContext: [
        { field: "the_query_and_explain_analyze", whyCritical: "without the query + plan we're shooting in the dark", suggestedQuestion: "Paste the SQL + EXPLAIN ANALYZE output." },
      ],
      bugBrief: {
        symptom: "Postgres query running slower than expected.",
        expectedVsActual: { expected: "Sub-100ms (or whatever the SLO is).", actual: "Slow." },
        suspectedBoundary: "db",
        hypotheses: [
          { hypothesis: "Missing index on a WHERE / JOIN column.", supportingEvidence: "Most common cause of slow Postgres queries.", probability: "HIGH", invalidatingTest: "EXPLAIN ANALYZE shows Seq Scan on the suspect column." },
          { hypothesis: "N+1 from an ORM (generates many small queries).", supportingEvidence: "Common with Prisma/TypeORM relations.", probability: "MEDIUM", invalidatingTest: "Enable query log; count queries per request." },
          { hypothesis: "Stale statistics — ANALYZE not run after a big load.", supportingEvidence: "Possible after data backfills.", probability: "LOW", invalidatingTest: "Run ANALYZE; re-time." },
        ],
        rootCauseGuess: null,
        proposedFix: { description: "Need the query + EXPLAIN. Most likely add a CREATE INDEX.", scope: "minimal", filesAffected: [] },
        sideEffects: ["CREATE INDEX on a hot table can briefly lock — use CONCURRENTLY in prod."],
        verificationSteps: ["EXPLAIN ANALYZE again post-fix — confirm Index Scan + lower cost."],
      },
      reasoningTrace: "DB perf bug. Three top patterns; need the query/plan to commit.",
    }),
    note: "DB-bucket bug with the canonical CREATE INDEX CONCURRENTLY safety reminder.",
  },
]

// ─── Summary examples (4) ───
export const SUMMARY_EXAMPLES: Example[] = [
  {
    prompt: "explain this codebase",
    expectedOutput: stringify({
      pipeline: "summary",
      confidence: "HIGH",
      decision: "proceed",
      missingContext: [],
      summaryBrief: {
        audienceLevel: "dev",
        keyFacts: [
          "TypeScript monorepo: cli-client (interactive REPL) + server (Fastify orchestrator).",
          "Server fronts multiple LLM providers (Gemini live; Claude/SWE mocked).",
          "PostgreSQL via node-pg-migrate; in-memory stores reset on restart.",
        ],
        clusters: [
          { heading: "Architecture", points: ["CLI ↔ HTTP ↔ Server ↔ Provider Adapter ↔ LLM", "Phase 5 added a reasoning module that pre-flights every prompt", "Tools execute locally on the CLI; results POST back to the server"] },
          { heading: "Surfaces", points: ["12 built-in agent tools (read/write/edit/search/run_command/etc.)", "Slash commands: /model, /mode, /permissions, /plan-mode", "Auth via JWT; billing via Stripe + per-plan credit ledger"] },
        ],
        constraints: ["Server timeout 5min", "run_command timeout 30s", "Free plan rate-limited via free_prompts_today"],
        whatMatters: ["The pipeline (CLI → server → provider → CLI executes tools) is the core flow.", "The reasoning module is what makes responses non-trivial."],
        whatDoesnt: ["Specific provider class internals — they all conform to BaseProvider."],
        hallucinationCheck: { suspect: [], verified: ["fastify version", "package layout", "auth + billing presence"] },
      },
      reasoningTrace: "High-level summary for a dev audience. Grouped into Architecture + Surfaces; constraints noted.",
    }),
    note: "Summary respects audience; clusters > flat list; calls out what NOT to fixate on.",
  },
  {
    prompt: "summarise what changed on this branch",
    expectedOutput: stringify({
      pipeline: "summary",
      confidence: "HIGH",
      decision: "proceed",
      missingContext: [],
      summaryBrief: {
        audienceLevel: "dev",
        keyFacts: ["32 commits since main on this branch.", "Touches both packages.", "Adds 4 new directories (reasoning/, prompt/, cli/, store/)."],
        clusters: [
          { heading: "Server changes", points: ["Reasoning module under server/src/reasoning/", "Modular prompt sections", "Microcompact + autocompact"] },
          { heading: "CLI changes", points: ["Permission system + slash commands", "Plan mode", "Vitest test suite"] },
        ],
        constraints: ["No DB migration changes."],
        whatMatters: ["The reasoning module is the largest behavioural change.", "Permission system is the largest UX change."],
        whatDoesnt: ["Internal helper splits in agent.ts — same behaviour, refactored."],
        hallucinationCheck: { suspect: [], verified: [] },
      },
      reasoningTrace: "Branch-diff summary. Grouped by package, surfaced the two highest-impact buckets.",
    }),
    note: "Diff-driven summary; calls out internal refactors as 'doesn't matter' so reviewers don't focus there.",
  },
  {
    prompt: "what does the action-planner service do, in plain English",
    expectedOutput: stringify({
      pipeline: "summary",
      confidence: "MEDIUM",
      decision: "proceed",
      missingContext: [],
      summaryBrief: {
        audienceLevel: "mixed",
        keyFacts: [
          "It's a server-side guardrail that runs after the LLM returns a tool call.",
          "It can override the LLM's chosen tool, inject extra context, or detect loops.",
        ],
        clusters: [
          { heading: "What it intercepts", points: ["Bad arguments (e.g., tool with no path)", "Suspicious loops (same tool called 3+ times)", "Incomplete reconnaissance (writes before any read)"] },
          { heading: "What it does", points: ["Replaces the bad call with a safer one", "Injects a context message into the next prompt", "Marks fatal cases so downstream guards don't waste cycles"] },
        ],
        constraints: ["Only operates on a single LLM response at a time — it doesn't see the full chat history."],
        whatMatters: ["Treat it as the seatbelt that keeps the LLM from doing obviously wrong things."],
        whatDoesnt: ["The exact regex patterns it uses internally — those evolve."],
        hallucinationCheck: { suspect: [], verified: ["intercept method exists", "fatal-termination flag present"] },
      },
      reasoningTrace: "Mixed audience. Two clusters: what it intercepts vs what it does. Avoided regex internals.",
    }),
    note: "Mixed-audience summary uses a safety analogy ('seatbelt').",
  },
  {
    prompt: "tldr this PR description so I can decide if it's worth reviewing",
    expectedOutput: stringify({
      pipeline: "summary",
      confidence: "HIGH",
      decision: "proceed",
      missingContext: [],
      summaryBrief: {
        audienceLevel: "dev",
        keyFacts: ["Adds X feature", "Touches Y area", "No DB changes"],
        clusters: [
          { heading: "Why it exists", points: ["Solves use case Z that previously needed A workaround"] },
          { heading: "Risk", points: ["Touches the hot path; review the X module carefully"] },
        ],
        constraints: ["No tests added — flagged in PR comments"],
        whatMatters: ["Whether you trust the X-module change."],
        whatDoesnt: ["The 5 cosmetic moves in unrelated files."],
        hallucinationCheck: { suspect: ["Whether the PR has tests — verify by checking the files list"], verified: [] },
      },
      reasoningTrace: "Reviewer-decision tldr. Surfaces the question they're actually asking ('worth my time?').",
    }),
    note: "tldr respects the meta-question (decide-to-review) instead of producing a generic summary.",
  },
]

// ─── Decision examples (self-invoked) ───
export const DECISION_EXAMPLES: Example[] = [
  {
    prompt: "Which ORM should I use for this Postgres setup?",
    expectedOutput: stringify({
      pipeline: "decision",
      confidence: "HIGH",
      decision: "proceed",
      missingContext: [],
      decisionBrief: {
        recommendation: "Drizzle",
        alternatives: [
          { option: "Drizzle", prosCons: "Lightweight, SQL-like, smaller bundle, fast cold start. Less ecosystem than Prisma.", fitScore: "HIGH" },
          { option: "Prisma", prosCons: "Most mature ecosystem, generated types, strong migrations. Larger client; cold start cost.", fitScore: "MEDIUM" },
          { option: "Kysely", prosCons: "Pure query-builder, no client generation. Less batteries-included.", fitScore: "MEDIUM" },
        ],
        riskNotes: ["If the project later needs a visual schema editor, Prisma's tooling is stronger."],
        proceedHint: "Install drizzle-orm + drizzle-kit; define schema in src/db/schema.ts; wire DATABASE_URL.",
      },
      reasoningTrace: "Drizzle for a fresh Postgres setup with no existing ORM commitment. Smaller deps, faster.",
    }),
    note: "Decision pipeline returns one recommendation + ranked alternatives + a proceed hint.",
  },
  {
    prompt: "Is it safe to delete legacy/old-auth.ts? It has no inbound imports per my search.",
    expectedOutput: stringify({
      pipeline: "decision",
      confidence: "MEDIUM",
      decision: "proceed",
      missingContext: [],
      decisionBrief: {
        recommendation: "Keep — rename to legacy/old-auth.ts.bak instead",
        alternatives: [
          { option: "Delete", prosCons: "Clean removal, smaller tree. Risk if dynamic imports / tests / scripts reference it outside the static graph.", fitScore: "MEDIUM" },
          { option: "Rename to .bak", prosCons: "Reversible. Lets the next test/build run reveal hidden references via missing-file errors.", fitScore: "HIGH" },
          { option: "Keep as-is", prosCons: "Zero risk; perpetual code rot.", fitScore: "LOW" },
        ],
        riskNotes: ["search_files / grep misses dynamic require() and string-built import paths."],
        proceedHint: "Rename now; if no test/build error in the next two days, delete.",
      },
      reasoningTrace: "Deletion looks safe by static analysis but dynamic refs evade grep. Rename-first is the minimal safe move.",
    }),
    note: "When safety > speed, the recommendation is the cautious option even with HIGH alternatives.",
  },
  {
    prompt: "monorepo or single repo for a small new project (one CLI + one server)?",
    expectedOutput: stringify({
      pipeline: "decision",
      confidence: "HIGH",
      decision: "proceed",
      missingContext: [],
      decisionBrief: {
        recommendation: "Two folders in one repo (no monorepo tooling)",
        alternatives: [
          { option: "Two folders, one repo (no workspaces)", prosCons: "Simplest. Two package.jsons, no shared deps tooling.", fitScore: "HIGH" },
          { option: "npm workspaces (or pnpm)", prosCons: "Shared deps + scripts. Worth it once you share code or have 3+ packages.", fitScore: "MEDIUM" },
          { option: "Separate repos", prosCons: "Maximum isolation. Coordinated changes need two PRs.", fitScore: "LOW" },
        ],
        riskNotes: ["If you start sharing types/utils between CLI and server, switch to workspaces."],
        proceedHint: "Two folders, one repo. Each has its own package.json + tsconfig. Keep it boring.",
      },
      reasoningTrace: "Small (2 packages, no shared code) → simple two-folder layout. Workspaces is overkill at this scale.",
    }),
    note: "Decision pipeline can recommend the BORING option; that's the meta-rule of minimal-safe-changes applied to architecture.",
  },
  {
    prompt: "Should this run as a cron or as a long-lived process with setInterval?",
    expectedOutput: stringify({
      pipeline: "decision",
      confidence: "HIGH",
      decision: "proceed",
      missingContext: [],
      decisionBrief: {
        recommendation: "Cron",
        alternatives: [
          { option: "Cron (system-level or GH Actions)", prosCons: "OS-managed; survives crashes; explicit schedule. Needs a host with cron available.", fitScore: "HIGH" },
          { option: "Long-lived setInterval", prosCons: "Self-contained. Loses progress on crash; drifts on long sleeps; needs supervisor.", fitScore: "LOW" },
          { option: "Job queue (BullMQ / similar)", prosCons: "Retries + observability for free. Overkill for a single daily job.", fitScore: "MEDIUM" },
        ],
        riskNotes: ["If the host doesn't have cron (some serverless platforms), GitHub Actions is the simplest cron substitute."],
        proceedHint: "system cron or a GH Actions schedule trigger. Avoid setInterval for periodic jobs.",
      },
      reasoningTrace: "Periodic job → cron is the right primitive; setInterval is fragile against crashes and drift.",
    }),
    note: "Architectural decision with clear primitive recommendation.",
  },
]
