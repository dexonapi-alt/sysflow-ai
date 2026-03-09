import Stripe from "stripe"
import { query } from "../db/connection.js"
import { extractUser } from "./auth.js"
import { getSubscription, updateSubscriptionFromStripe, getUsageSummary, PLANS } from "../store/subscriptions.js"
import { onCheckoutComplete, removeCheckoutListener, emitCheckoutComplete } from "../store/checkout-events.js"

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)

// Safely parse Stripe unix timestamps into Date objects
function stripeDate(ts) {
  if (!ts || typeof ts !== "number") return new Date()
  return new Date(ts * 1000)
}

// Map Stripe price IDs to plan names
const PRICE_TO_PLAN = {
  [process.env.STRIPE_PRICE_ID_LITE]: "lite",
  [process.env.STRIPE_PRICE_ID_PRO]:  "pro",
  [process.env.STRIPE_PRICE_ID_TEAM]: "team"
}

export async function stripeRoutes(fastify) {
  // ─── Get plans ───
  fastify.get("/billing/plans", async () => {
    return {
      plans: [
        { id: "free", label: "Free",  price: "$0/mo",  desc: "10 prompts/day",       priceId: null },
        { id: "lite", label: "Lite",  price: "$20/mo", desc: "$20 of AI credits/mo",  priceId: process.env.STRIPE_PRICE_ID_LITE },
        { id: "pro",  label: "Pro",   price: "$60/mo", desc: "$60 of AI credits/mo",  priceId: process.env.STRIPE_PRICE_ID_PRO },
        { id: "team", label: "Team",  price: "$200/mo", desc: "$200 of AI credits/mo", priceId: process.env.STRIPE_PRICE_ID_TEAM }
      ]
    }
  })

  // ─── Get current usage / subscription status ───
  // Also reconciles Stripe subscriptions for users who paid but sub wasn't synced
  fastify.get("/billing/usage", async (request, reply) => {
    const user = extractUser(request)
    if (!user) return reply.code(401).send({ error: "Not authenticated" })

    // Safety net: if user has a Stripe customer but is still on free, check for active subs
    const sub = await getSubscription(user.userId)
    if (sub.plan === "free" && sub.stripe_customer_id) {
      try {
        const subs = await stripe.subscriptions.list({
          customer: sub.stripe_customer_id,
          status: "active",
          limit: 1
        })
        if (subs.data.length > 0) {
          const activeSub = subs.data[0]
          const priceId = activeSub.items?.data?.[0]?.price?.id
          const plan = PRICE_TO_PLAN[priceId]
          if (plan) {
            await updateSubscriptionFromStripe(user.userId, {
              plan,
              stripeCustomerId: sub.stripe_customer_id,
              stripeSubscriptionId: activeSub.id,
              periodStart: stripeDate(activeSub.current_period_start),
              periodEnd: stripeDate(activeSub.current_period_end),
              status: "active"
            })
            console.log(`[stripe] Reconciled: activated ${plan} for user ${user.userId}`)
          }
        }
      } catch (err) {
        console.error("[stripe] Reconciliation check failed:", err.message)
      }
    }

    const summary = await getUsageSummary(user.userId)
    return { status: "ok", ...summary }
  })

  // ─── Create Stripe checkout session ───
  fastify.post("/billing/checkout", async (request, reply) => {
    const user = extractUser(request)
    if (!user) return reply.code(401).send({ error: "Not authenticated" })

    const { priceId } = request.body || {}
    if (!priceId) return reply.code(400).send({ error: "priceId is required" })

    const plan = PRICE_TO_PLAN[priceId]
    if (!plan) return reply.code(400).send({ error: "Invalid price ID" })

    // Get or create Stripe customer
    const sub = await getSubscription(user.userId)
    let customerId = sub.stripe_customer_id

    if (!customerId) {
      const userRow = await query("SELECT username FROM users WHERE id = $1", [user.userId])
      const customer = await stripe.customers.create({
        metadata: { userId: String(user.userId), username: userRow.rows[0].username }
      })
      customerId = customer.id
      await query("UPDATE subscriptions SET stripe_customer_id = $1 WHERE user_id = $2", [customerId, user.userId])
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${process.env.STRIPE_SUCCESS_URL || "http://localhost:3000/billing/success"}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.STRIPE_CANCEL_URL || "http://localhost:3000/billing/cancel"}`,
      metadata: { userId: String(user.userId), plan }
    })

    return { status: "ok", url: session.url, sessionId: session.id }
  })

  // ─── Stripe webhook ───
  fastify.post("/billing/webhook", async (request, reply) => {
    const sig = request.headers["stripe-signature"]
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET

    let event
    try {
      // rawBody is set by our custom JSON parser in index.js
      const rawBody = request.rawBody || JSON.stringify(request.body)
      event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret)
    } catch (err) {
      console.error("[stripe] Webhook signature verification failed:", err.message)
      return reply.code(400).send({ error: "Invalid signature" })
    }

    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object
        const userId = parseInt(session.metadata?.userId)
        const plan = session.metadata?.plan
        if (userId && plan) {
          const subscription = await stripe.subscriptions.retrieve(session.subscription)
          await updateSubscriptionFromStripe(userId, {
            plan,
            stripeCustomerId: session.customer,
            stripeSubscriptionId: session.subscription,
            periodStart: stripeDate(subscription.current_period_start),
            periodEnd: stripeDate(subscription.current_period_end),
            status: "active"
          })
          console.log(`[stripe] User ${userId} subscribed to ${plan}`)
        }
        break
      }

      case "invoice.paid": {
        // Renewal — reset credits
        const invoice = event.data.object
        const subId = invoice.subscription
        if (subId) {
          const subRow = await query(
            "SELECT user_id, plan FROM subscriptions WHERE stripe_subscription_id = $1",
            [subId]
          )
          if (subRow.rowCount > 0) {
            const { user_id, plan } = subRow.rows[0]
            const planDef = PLANS[plan]
            if (planDef) {
              const subscription = await stripe.subscriptions.retrieve(subId)
              await query(
                `UPDATE subscriptions SET
                   credits_used_cents = 0,
                   credits_cents = $1,
                   period_start = $2,
                   period_end = $3,
                   updated_at = NOW()
                 WHERE stripe_subscription_id = $4`,
                [
                  planDef.creditsCents,
                  stripeDate(subscription.current_period_start),
                  stripeDate(subscription.current_period_end),
                  subId
                ]
              )
              console.log(`[stripe] Renewed credits for user ${user_id} on ${plan} plan`)
            }
          }
        }
        break
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object
        const subRow = await query(
          "SELECT user_id FROM subscriptions WHERE stripe_subscription_id = $1",
          [sub.id]
        )
        if (subRow.rowCount > 0) {
          await query(
            `UPDATE subscriptions SET plan = 'free', credits_cents = 0, credits_used_cents = 0,
             stripe_subscription_id = NULL, status = 'cancelled', updated_at = NOW()
             WHERE stripe_subscription_id = $1`,
            [sub.id]
          )
          console.log(`[stripe] Subscription cancelled for user ${subRow.rows[0].user_id}`)
        }
        break
      }

      default:
        break
    }

    return { received: true }
  })

  // ─── SSE: CLI waits here for checkout completion (no polling, no WS) ───
  fastify.get("/billing/checkout-stream", { logLevel: "warn" }, async (request, reply) => {
    const { sessionId } = request.query
    if (!sessionId) return reply.code(400).send({ error: "sessionId required" })

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    })

    // Keep connection alive with heartbeat
    const heartbeat = setInterval(() => {
      reply.raw.write(": heartbeat\n\n")
    }, 15000)

    onCheckoutComplete(sessionId, (result) => {
      clearInterval(heartbeat)
      reply.raw.write(`data: ${JSON.stringify(result)}\n\n`)
      reply.raw.end()
    })

    // Cleanup on client disconnect
    request.raw.on("close", () => {
      clearInterval(heartbeat)
      removeCheckoutListener(sessionId)
    })
  })

  // ─── Success page — fulfills subscription + notifies CLI via WS ───
  fastify.get("/billing/success", async (request) => {
    const sessionId = request.query.session_id
    if (sessionId) {
      try {
        const session = await stripe.checkout.sessions.retrieve(sessionId)
        const userId = parseInt(session.metadata?.userId)
        const plan = session.metadata?.plan

        if (userId && plan && session.subscription) {
          const subscription = await stripe.subscriptions.retrieve(session.subscription)
          await updateSubscriptionFromStripe(userId, {
            plan,
            stripeCustomerId: session.customer,
            stripeSubscriptionId: session.subscription,
            periodStart: stripeDate(subscription.current_period_start),
            periodEnd: stripeDate(subscription.current_period_end),
            status: "active"
          })
          console.log(`[stripe] Success page: activated ${plan} for user ${userId}`)

          // Notify CLI WebSocket instantly
          emitCheckoutComplete(sessionId, { status: "paid", plan })
        }
      } catch (err) {
        console.error("[stripe] Success page fulfillment error:", err.message)
      }
    }

    return { status: "ok", message: "Subscription activated! You can close this page and return to the terminal." }
  })

  fastify.get("/billing/cancel", async () => {
    return { status: "ok", message: "Checkout cancelled. No charges were made." }
  })
}
