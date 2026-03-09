export default {
  name: "009_alter_subscriptions_numeric",
  up: `
    ALTER TABLE subscriptions
      ALTER COLUMN credits_cents TYPE NUMERIC(10, 4) USING credits_cents::NUMERIC(10, 4),
      ALTER COLUMN credits_used_cents TYPE NUMERIC(10, 4) USING credits_used_cents::NUMERIC(10, 4);
  `
}
