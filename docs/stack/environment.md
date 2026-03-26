# Environment Variables

## Server (`server/.env`)

### Database
| Var | Default | Description |
|-----|---------|-------------|
| `DB_HOST` | `localhost` | PostgreSQL host |
| `DB_PORT` | `5432` | PostgreSQL port |
| `DB_USER` | `postgres` | Database user |
| `DB_PASSWORD` | `postgres` | Database password |
| `DB_NAME` | `sysflow` | Database name |

### AI Providers
| Var | Required | Description |
|-----|----------|-------------|
| `GEMINI_API_KEY` | For Gemini models | Google AI API key |
| `OPENROUTER_API_KEY` | For OpenRouter models | OpenRouter API key |
| `ANTHROPIC_API_KEY` | For Claude models | Anthropic API key |

### Auth
| Var | Default | Description |
|-----|---------|-------------|
| `JWT_SECRET` | `sysflow-secret-change-me` | JWT signing secret |

### Stripe (Optional)
| Var | Description |
|-----|-------------|
| `STRIPE_SECRET_KEY` | Stripe API key |
| `STRIPE_WEBHOOK_SECRET` | Webhook verification |
| `STRIPE_SUCCESS_URL` | Post-checkout redirect |
| `STRIPE_CANCEL_URL` | Checkout cancel redirect |
| `STRIPE_PRICE_ID_LITE` | Lite plan price ID |
| `STRIPE_PRICE_ID_PRO` | Pro plan price ID |
| `STRIPE_PRICE_ID_TEAM` | Team plan price ID |

## CLI Client

| Var | Default | Description |
|-----|---------|-------------|
| `SYS_SERVER_URL` | `http://localhost:3000` | Server URL |
| `SYS_TOKEN` | — | Auth token fallback (if not in auth.json) |
