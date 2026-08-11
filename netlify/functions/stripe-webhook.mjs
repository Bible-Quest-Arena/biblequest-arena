// stripe-webhook.mjs — keeps player Premium status in sync with Stripe
import { stores } from "./_shared.mjs";

const planFromPrice = plan =>
  plan === "church_monthly" ? "church" : "disciple";

async function loadPlayer(id) { return stores.players().get(id, { type: "json" }); }
async function savePlayer(p) { await stores.players().set(p.userId, JSON.stringify(p)); }
async function userIdForCustomer(customer) {
  const rec = await stores.meta().get("customer:" + customer, { type: "json" });
  return rec && rec.userId;
}

export default async (req) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!secret || !key) return new Response("Stripe not configured", { status: 503 });

  const sig = req.headers.get("stripe-signature");
  const raw = await req.text();
  const { default: Stripe } = await import("stripe");
  const stripe = new Stripe(key);

  let event;
  try { event = await stripe.webhooks.constructEventAsync(raw, sig, secret); }
  catch (err) { return new Response("Invalid signature: " + err.message, { status: 400 }); }

  try {
    if (event.type === "checkout.session.completed") {
      const s = event.data.object;
      const userId = s.client_reference_id || (s.metadata && s.metadata.userId);
      if (userId) {
        const p = await loadPlayer(userId);
        if (p) {
          p.premium = true;
          p.plan = planFromPrice(s.metadata && s.metadata.plan);
          p.stripeCustomerId = s.customer;
          p.subscriptionId = s.subscription;
          p.subStatus = "active";
          p.updatedAt = Date.now();
          await savePlayer(p);
          if (s.customer) await stores.meta().set("customer:" + s.customer, JSON.stringify({ userId }));
        }
      }
    }

    if (event.type === "customer.subscription.updated") {
      const sub = event.data.object;
      const userId = await userIdForCustomer(sub.customer);
      if (userId) {
        const p = await loadPlayer(userId);
        if (p) {
          p.subStatus = sub.status;
          p.premium = ["active", "trialing", "past_due"].includes(sub.status);
          if (!p.premium && p.plan !== "admin") p.plan = "free";
          p.updatedAt = Date.now();
          await savePlayer(p);
        }
      }
    }

    if (event.type === "customer.subscription.deleted") {
      const sub = event.data.object;
      const userId = await userIdForCustomer(sub.customer);
      if (userId) {
        const p = await loadPlayer(userId);
        if (p && p.plan !== "admin") { p.premium = false; p.plan = "free"; p.subStatus = "canceled"; p.updatedAt = Date.now(); await savePlayer(p); }
      }
    }
  } catch (err) {
    return new Response("Handler error: " + err.message, { status: 500 });
  }
  return new Response("ok", { status: 200 });
};
