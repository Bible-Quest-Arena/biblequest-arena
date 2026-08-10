// api.mjs — BibleQuest Arena API (Netlify Functions v2)
import {
  stores, json, uid, setupNeeded, isAdmin, ADMIN_EMAIL,
  hashPassword, verifyPassword, sessionCookie, clearCookie, sessionUserId, requireUser,
  newPlayer, refreshEnergy, rolloverWindows, applyRun, claimChest, upsertBoard, publicUser, CONSTS,
} from "./_shared.mjs";

const bad  = (m, s = 400) => json({ error: m }, s);
const okEmail = e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

async function loadPlayer(id) {
  let p = await stores.players().get(id, { type: "json" });
  return p;
}
async function savePlayer(p) { await stores.players().set(p.userId, JSON.stringify(p)); }

/* keep admin premium in sync every time we load a user */
function syncAdmin(user, p) {
  if (p && isAdmin(user.email) && !p.premium) { p.premium = true; p.plan = "admin"; }
  return p;
}

export default async (req) => {
  const url = new URL(req.url);
  const route = url.pathname.split("/api/").pop().replace(/\/+$/, "");
  const method = req.method.toUpperCase();
  let body = {};
  if (method === "POST") { try { body = await req.json(); } catch { body = {}; } }

  try {
    /* ---- config / setup banner ---- */
    if (route === "config" && method === "GET") {
      return json({
        setupNeeded: setupNeeded(),
        stripeEnabled: !!process.env.STRIPE_SECRET_KEY,
        adminEmailSet: !!ADMIN_EMAIL,
        energyMax: CONSTS.ENERGY_MAX,
      });
    }

    /* ---- register ---- */
    if (route === "register" && method === "POST") {
      if (setupNeeded()) return bad("Server not configured. Add APP_SECRET and ADMIN_EMAIL.", 503);
      const name = String(body.name || "").trim().slice(0, 50);
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      if (!name || !okEmail(email) || password.length < 8) return bad("Provide a name, valid email and 8+ char password.");
      const idx = await stores.users().get("email:" + email, { type: "json" });
      if (idx) return bad("An account with that email already exists.", 409);

      const id = uid();
      const { salt, hash } = await hashPassword(password);
      const role = isAdmin(email) ? "admin" : "player";
      const user = { id, email, name, salt, hash, role, createdAt: Date.now() };
      await stores.users().set("id:" + id, JSON.stringify(user));
      await stores.users().set("email:" + email, JSON.stringify({ id }));

      const p = newPlayer(id, { displayName: name, country: body.country });
      if (typeof body.showOnLeaderboard === "boolean") p.showOnLeaderboard = body.showOnLeaderboard;
      syncAdmin(user, p);
      rolloverWindows(p);
      await savePlayer(p);
      await upsertBoard(p);
      return json({ user: publicUser(user, p) }, 201, { "set-cookie": sessionCookie(id) });
    }

    /* ---- login ---- */
    if (route === "login" && method === "POST") {
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      const idx = await stores.users().get("email:" + email, { type: "json" });
      if (!idx) return bad("Email or password is incorrect.", 401);
      const user = await stores.users().get("id:" + idx.id, { type: "json" });
      if (!user || !(await verifyPassword(password, user.salt, user.hash))) return bad("Email or password is incorrect.", 401);
      let p = await loadPlayer(user.id); if (!p) p = newPlayer(user.id, { displayName: user.name });
      syncAdmin(user, p); refreshEnergy(p); rolloverWindows(p); await savePlayer(p);
      return json({ user: publicUser(user, p) }, 200, { "set-cookie": sessionCookie(user.id) });
    }

    /* ---- logout ---- */
    if (route === "logout" && method === "POST") return json({ ok: true }, 200, { "set-cookie": clearCookie() });

    /* ---- me ---- */
    if (route === "me" && method === "GET") {
      const user = await requireUser(req);
      if (!user) return bad("Not signed in.", 401);
      let p = await loadPlayer(user.id); if (!p) p = newPlayer(user.id, { displayName: user.name });
      syncAdmin(user, p); refreshEnergy(p); rolloverWindows(p); await savePlayer(p);
      return json({ user: publicUser(user, p) });
    }

    /* ---- start a run (energy gate) ---- */
    if (route === "start-run" && method === "POST") {
      const user = await requireUser(req);
      if (!user) return bad("Sign in to play scored runs.", 401);
      const p = await loadPlayer(user.id); syncAdmin(user, p); refreshEnergy(p); rolloverWindows(p);
      if (!p.premium && p.energy <= 0) return bad("Out of energy — it refills over time, or go Disciple+ for unlimited.", 402);
      if (!p.premium) { p.energy -= 1; if (p.energy === CONSTS.ENERGY_MAX - 1) p.energyUpdatedAt = Date.now(); }
      await savePlayer(p);
      return json({ ok: true, energy: p.energy, premium: p.premium });
    }

    /* ---- submit a validated run ---- */
    if (route === "submit-score" && method === "POST") {
      const user = await requireUser(req);
      if (!user) return bad("Sign in to record scores.", 401);
      let p = await loadPlayer(user.id); if (!p) p = newPlayer(user.id, { displayName: user.name });
      syncAdmin(user, p);
      const { player, rewards, score } = applyRun(p, body);
      await savePlayer(player);
      await upsertBoard(player);
      return json({ score, rewards, user: publicUser(user, player) });
    }

    /* ---- daily chest ---- */
    if (route === "claim-chest" && method === "POST") {
      const user = await requireUser(req);
      if (!user) return bad("Sign in to claim rewards.", 401);
      const p = await loadPlayer(user.id); syncAdmin(user, p); rolloverWindows(p);
      const res = claimChest(p); await savePlayer(p);
      return json({ ...res, user: publicUser(user, p) });
    }

    /* ---- leaderboard ---- */
    if (route === "leaderboard" && method === "GET") {
      const top = (await stores.board().get("top", { type: "json" })) || [];
      return json({ leaderboard: top.slice(0, 50).map((e, i) => ({ rank: i + 1, name: e.name, country: e.country, best: e.best, league: e.league })) });
    }

    /* ---- launch-list subscribe ---- */
    if (route === "subscribe" && method === "POST") {
      const email = String(body.email || "").trim().toLowerCase();
      if (!okEmail(email)) return bad("Enter a valid email.");
      await stores.meta().set("launch:" + email, JSON.stringify({ email, at: Date.now() }));
      return json({ ok: true });
    }

    /* ---- Stripe checkout ---- */
    if (route === "checkout" && method === "POST") {
      const user = await requireUser(req);
      if (!user) return bad("Sign in before subscribing.", 401);
      if (!process.env.STRIPE_SECRET_KEY) return bad("Payments are not configured yet.", 503);
      const priceMap = {
        disciple_monthly: process.env.STRIPE_PRICE_DISCIPLE_MONTHLY,
        disciple_yearly:  process.env.STRIPE_PRICE_DISCIPLE_YEARLY,
        church_monthly:   process.env.STRIPE_PRICE_CHURCH_MONTHLY,
      };
      const price = priceMap[body.plan];
      if (!price) return bad("Unknown plan.");
      const { default: Stripe } = await import("stripe");
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
      const origin = url.origin;
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        line_items: [{ price, quantity: 1 }],
        customer_email: user.email,
        client_reference_id: user.id,
        metadata: { userId: user.id, plan: body.plan },
        success_url: `${origin}/play?upgraded=1`,
        cancel_url: `${origin}/#pricing`,
        allow_promotion_codes: true,
      });
      return json({ url: session.url });
    }

    /* ---- admin ---- */
    if (route.startsWith("admin/")) {
      const user = await requireUser(req);
      if (!user || user.role !== "admin") return bad("Administrators only.", 403);

      if (route === "admin/overview") {
        const { blobs } = await stores.players().list();
        let players = 0, premium = 0, totalRuns = 0, totalScore = 0, active7 = 0;
        const wk = Date.now() - 7 * 86400000;
        for (const b of blobs) {
          const p = await stores.players().get(b.key, { type: "json" }); if (!p) continue;
          players++; if (p.premium) premium++; totalRuns += p.gamesPlayed; totalScore += p.totalScore;
          if (p.updatedAt >= wk) active7++;
        }
        return json({ players, premium, active7, totalRuns, totalScore, mrrEstimate: premium * 4.99 });
      }

      if (route === "admin/players") {
        const { blobs } = await stores.players().list();
        const rows = [];
        for (const b of blobs) { const p = await stores.players().get(b.key, { type: "json" }); if (p) rows.push({
          name: p.displayName, country: p.country, level: p.level, best: p.bestScore, streak: p.streak,
          plan: p.plan, premium: p.premium, games: p.gamesPlayed, league: p.league }); }
        rows.sort((a, b) => b.best - a.best);
        return json({ players: rows });
      }

      if (route === "admin/export") {
        const { blobs } = await stores.players().list();
        const head = "name,country,level,xp,coins,best,total,games,streak,league,plan,premium";
        const lines = [head];
        for (const b of blobs) { const p = await stores.players().get(b.key, { type: "json" }); if (!p) continue;
          const c = s => `"${String(s ?? "").replace(/"/g, '""')}"`;
          lines.push([c(p.displayName),c(p.country),p.level,p.xp,p.coins,p.bestScore,p.totalScore,p.gamesPlayed,p.streak,c(p.league),c(p.plan),p.premium].join(",")); }
        return new Response(lines.join("\n"), { status: 200, headers: { "content-type": "text/csv", "content-disposition": 'attachment; filename="biblequest-players.csv"' } });
      }
    }

    return bad("Not found.", 404);
  } catch (err) {
    return json({ error: "Server error", detail: String(err && err.message || err) }, 500);
  }
};
