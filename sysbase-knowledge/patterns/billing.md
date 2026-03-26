# Billing Pattern

## Plans

| Plan | Price | Details |
|------|-------|---------|
| Free | $0 | 10 prompts/day |
| Lite | $20/mo | Credit-based |
| Pro | $60/mo | Credit-based |
| Team | $200/mo | Credit-based |

## Flow

1. User selects plan via `sys billing` or `/billing` in UI
2. CLI shows plan picker (interactive select)
3. CLI sends `POST /billing/checkout { plan }`
4. Server creates Stripe checkout session
5. User completes payment in browser
6. Stripe sends webhook to `POST /billing/webhook`
7. Server updates `subscriptions` table

## Usage Tracking

- Every AI call logs tokens to `usage_logs` table
- Cost calculated per-model in `subscriptions.ts`
- Before each `/agent/run`, server checks usage against plan limits
- 429 response if over limit (CLI shows plan upgrade info)

## Key Files
- Billing routes: `server/src/routes/billing.ts`
- Subscription store: `server/src/store/subscriptions.ts`
- Usage store: `server/src/store/usage.ts`
- CLI billing UI: `cli-client/src/commands/billing.ts`
