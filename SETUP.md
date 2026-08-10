# BibleQuest Arena — backend setup

## Deploy
1. Push this folder to a Git repo and connect it in Netlify (recommended), or drag the folder into Netlify.
   Netlify installs dependencies and bundles the functions automatically — no build command needed.
2. In **Site configuration → Environment variables**, add:
   - `APP_SECRET` — a random string, 32+ characters.
   - `ADMIN_EMAIL` — the email that becomes administrator (and gets Premium free).
3. Deploy. Register with the exact `ADMIN_EMAIL`; that account is admin + Premium at no cost.

## Turn on real payments
Create recurring Prices in Stripe, then add:
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRICE_DISCIPLE_MONTHLY`, `STRIPE_PRICE_DISCIPLE_YEARLY`, `STRIPE_PRICE_CHURCH_MONTHLY`

Add a Stripe webhook endpoint at `https://YOUR-DOMAIN/api/stripe-webhook` subscribed to:
`checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`.

## Endpoints (all under /api)
config · register · login · logout · me · start-run · submit-score · claim-chest ·
leaderboard · subscribe · checkout · admin/overview · admin/players · admin/export

## What is live on deploy
- Accounts (scrypt + signed HttpOnly sessions), admin free-Premium
- Stripe Checkout + webhook subscription lifecycle
- Retention persisted server-side: energy, streaks (+freeze), daily chests, daily/weekly quests, weekly leagues + seasons, XP/levels, achievements, verse library, top-50 leaderboard

## Still to wire (next pass)
The in-game client (`public/play.html`) still runs its own local state.
Point it at `/api/start-run` and `/api/submit-score` so the retention engine drives real play.

## Storage note
Netlify Blobs suits this launch MVP. At scale, move gameplay/analytics to a relational DB.
