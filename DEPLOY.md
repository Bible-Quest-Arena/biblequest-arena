# DEPLOY — BibleQuest Arena (click by click)

A ~10 minute deploy. This is a full app with serverless functions, so upload the
**whole folder**, not a single file. Netlify Drop now runs the build for you.

---

## 1. Put it live (2 min)
1. Unzip this download so you have the `bqa-backend` folder.
2. Go to **https://app.netlify.com/drop**.
3. Drag the **entire `bqa-backend` folder** onto the drop zone.
4. When prompted, **log in / sign up** — this is what lets Netlify install the
   dependencies and bundle the functions. Let it finish building.
5. Click **Claim** to keep the site. You now have a live URL like
   `https://your-name.netlify.app`.

> Prefer Git? Push `bqa-backend` to a repo and "Add new project → Import" it
> instead. Same result, better for ongoing updates.

## 2. Add the two required settings (2 min)
In your site: **Site configuration → Environment variables → Add a variable**

| Key | Value |
|-----|-------|
| `APP_SECRET` | any random string, **32+ characters** |
| `ADMIN_EMAIL` | the email that becomes admin (gets Premium free) |

Then **Deploys → Trigger deploy → Deploy site** to apply them.

## 3. Create your admin account (1 min)
1. Open your site, go to **/play**, tap **Sign in / Create account → Create account**.
2. Register using the **exact** `ADMIN_EMAIL` from step 2.
   That account is now admin **and** Premium — no purchase, ever.

✅ Sign-in, streaks, quests, leagues and the leaderboard are now live.

---

## 4. Turn on real payments (optional, ~5 min)
1. In **Stripe → Products**, create recurring Prices for Disciple+ monthly,
   Disciple+ yearly, and Church monthly. Copy each Price ID (`price_...`).
2. Add these environment variables in Netlify, then redeploy:
   - `STRIPE_SECRET_KEY`
   - `STRIPE_WEBHOOK_SECRET`
   - `STRIPE_PRICE_DISCIPLE_MONTHLY`
   - `STRIPE_PRICE_DISCIPLE_YEARLY`
   - `STRIPE_PRICE_CHURCH_MONTHLY`
3. In **Stripe → Developers → Webhooks → Add endpoint**:
   - URL: `https://YOUR-DOMAIN/api/stripe-webhook`
   - Events: `checkout.session.completed`, `customer.subscription.updated`,
     `customer.subscription.deleted`
   - Copy the signing secret into `STRIPE_WEBHOOK_SECRET`, then redeploy.

## 5. Add your Bible text (optional)
Open `public/play.html`, find the `SCRIPTURE` table near the top of the script,
and paste your **licensed** NKJV / NIV wording between the quotes. Leave any slot
empty and the game just shows the reference. The required credit lines are already
wired in. (Both publishers permit gratis use up to 500 verses with the notice —
confirm you're within their terms; this isn't legal advice.)

## 6. Before you publicise it (optional polish)
- Add a **social image**: upload a 1200×630 PNG named `og-cover.png` to `public/`
  so link previews show a thumbnail.
- In `public/index.html`, set your real `LAUNCH_DATE` and contact email, and
  replace the **sample** testimonials with real beta feedback.

---

## Quick checks
- `/` shows the landing page, `/play` shows the game.
- Create account works and returns you to the game.
- A ranked run posts a score and the dashboard shows streak/quests/league.
- Admin account shows the "ADMIN · PREMIUM" badge.

**Change the admin unlock code:** in `public/play.html`, edit `ADMIN_CODE`
(the offline unlock) to your own secret.
