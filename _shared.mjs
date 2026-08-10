// _shared.mjs — BibleQuest Arena backend core (auth, storage, retention engine)
import { getStore } from "@netlify/blobs";
import { scrypt, randomBytes, timingSafeEqual, createHmac } from "node:crypto";
import { promisify } from "node:util";
const scryptAsync = promisify(scrypt);

/* ---------------- config ---------------- */
export const APP_SECRET  = process.env.APP_SECRET || "";
export const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "").toLowerCase();
export const setupNeeded = () => APP_SECRET.length < 32 || !ADMIN_EMAIL;
export const isAdmin = email => !!ADMIN_EMAIL && String(email).toLowerCase() === ADMIN_EMAIL;

const COOKIE = "bqa_session";
const ENERGY_MAX = 5;
const ENERGY_REGEN_MS = 30 * 60 * 1000;         // one run every 30 min
const CHEST_COINS = [25, 40, 60, 90, 130, 180, 300]; // 7-day escalating cycle
const LEAGUES = [[0,"Bronze"],[300,"Silver"],[800,"Gold"],[1600,"Platinum"],[3200,"Kingdom"]];

/* ---------------- stores ---------------- */
export const stores = {
  users:   () => getStore("users"),        // key: email -> user
  players: () => getStore("players"),       // key: userId -> player state
  board:   () => getStore("leaderboard"),   // key: "top" -> array
  meta:    () => getStore("meta"),          // customers map, launch list, etc.
};

/* ---------------- helpers ---------------- */
export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });

export const uid = () => randomBytes(12).toString("hex");
export const dayKey  = (d = new Date()) => d.toISOString().slice(0, 10);              // YYYY-MM-DD (UTC)
export const weekKey = (d = new Date()) => { const t = new Date(d); const day = (t.getUTCDay()+6)%7; t.setUTCDate(t.getUTCDate()-day); return t.toISOString().slice(0,10); };
export const seasonKey = (d = new Date()) => `${d.getUTCFullYear()}-S${Math.floor(d.getUTCMonth()/1)+1}`; // monthly seasons

/* ---------------- passwords ---------------- */
export async function hashPassword(pw) {
  const salt = randomBytes(16).toString("hex");
  const buf = await scryptAsync(pw, salt, 64);
  return { salt, hash: buf.toString("hex") };
}
export async function verifyPassword(pw, salt, hash) {
  const buf = await scryptAsync(pw, salt, 64);
  const a = Buffer.from(hash, "hex");
  return a.length === buf.length && timingSafeEqual(a, buf);
}

/* ---------------- signed session cookie ---------------- */
function sign(userId) {
  const body = Buffer.from(userId).toString("base64url");
  const sig = createHmac("sha256", APP_SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}
function unsign(token) {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const good = createHmac("sha256", APP_SECRET).update(body).digest("base64url");
  if (sig.length !== good.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  return Buffer.from(body, "base64url").toString();
}
export function sessionCookie(userId) {
  return `${COOKIE}=${sign(userId)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${60*60*24*30}`;
}
export const clearCookie = () => `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
export function sessionUserId(req) {
  const raw = req.headers.get("cookie") || "";
  const m = raw.match(new RegExp(`${COOKIE}=([^;]+)`));
  return m ? unsign(decodeURIComponent(m[1])) : null;
}
export async function requireUser(req) {
  const id = sessionUserId(req);
  if (!id) return null;
  const user = await stores.users().get("id:" + id, { type: "json" });
  return user || null;
}

/* ---------------- player state ---------------- */
export function newPlayer(userId, extra = {}) {
  const now = Date.now();
  return {
    userId, level: 1, xp: 0, coins: 50,
    energy: ENERGY_MAX, energyUpdatedAt: now,
    streak: 0, longestStreak: 0, lastPlayDay: null, streakFreeze: 1,
    bestScore: 0, totalScore: 0, gamesPlayed: 0,
    league: "Bronze", leaguePoints: 0, weekKey: weekKey(), season: seasonKey(),
    achievements: [], versesMastered: [],
    quests: null, questDay: null, questWeek: null,
    chestDay: null, chestIndex: 0,
    plan: "free", premium: false, subStatus: null, stripeCustomerId: null, subscriptionId: null,
    showOnLeaderboard: true, displayName: extra.displayName || "Player", country: extra.country || "United Kingdom",
    createdAt: now, updatedAt: now,
  };
}

function freshQuests() {
  return {
    daily: [
      { id: "d_play",  label: "Play 1 run",            need: 1, have: 0, reward: 30,  done: false },
      { id: "d_catch", label: "Gather 25 good items",  need: 25, have: 0, reward: 40, done: false },
      { id: "d_gate",  label: "Answer a Wisdom Gate",  need: 1, have: 0, reward: 50,  done: false },
    ],
    weekly: [
      { id: "w_play",  label: "Play 10 runs",          need: 10, have: 0, reward: 150, done: false },
      { id: "w_combo", label: "Reach a x5 combo",      need: 5,  have: 0, reward: 120, done: false },
      { id: "w_verse", label: "Master 3 verses",       need: 3,  have: 0, reward: 200, done: false },
    ],
  };
}

/* recompute energy for free players based on elapsed time */
export function refreshEnergy(p) {
  if (p.premium) { p.energy = ENERGY_MAX; return p; }
  const elapsed = Date.now() - (p.energyUpdatedAt || Date.now());
  const gained = Math.floor(elapsed / ENERGY_REGEN_MS);
  if (gained > 0 && p.energy < ENERGY_MAX) {
    p.energy = Math.min(ENERGY_MAX, p.energy + gained);
    p.energyUpdatedAt = Date.now() - (elapsed % ENERGY_REGEN_MS);
  }
  return p;
}
export function energyEtaMs(p) {
  if (p.premium || p.energy >= ENERGY_MAX) return 0;
  return ENERGY_REGEN_MS - ((Date.now() - p.energyUpdatedAt) % ENERGY_REGEN_MS);
}

/* roll quests/chest windows forward if the day/week changed */
export function rolloverWindows(p) {
  const d = dayKey(), w = weekKey();
  if (p.questDay !== d || !p.quests) { const q = freshQuests(); if (p.quests && p.questWeek === w) q.weekly = p.quests.weekly; p.quests = q; p.questDay = d; }
  if (p.questWeek !== w) { p.quests.weekly = freshQuests().weekly; p.questWeek = w; }
  if (p.weekKey !== w) { p.weekKey = w; p.leaguePoints = 0; p.league = "Bronze"; } // weekly league reset
  if (p.season !== seasonKey()) { p.season = seasonKey(); }
  return p;
}

function leagueFor(points) { let n = "Bronze"; for (const [m, l] of LEAGUES) if (points >= m) n = l; return n; }
function levelFor(xp) { return Math.floor(Math.sqrt(xp / 60)) + 1; }

/* core: apply a validated run result to the player, return a reward summary */
export function applyRun(p, run) {
  refreshEnergy(p); rolloverWindows(p);
  const rewards = { coins: 0, xp: 0, questsDone: [], achievements: [], streakUp: false, leagueUp: false, levelUp: false, bestUp: false };

  // score sanity clamp
  const score = Math.max(0, Math.min(1_000_000, Math.floor(Number(run.score) || 0)));
  const items = Math.max(0, Math.min(5000, Math.floor(Number(run.items) || 0)));
  const maxCombo = Math.max(0, Math.min(999, Math.floor(Number(run.maxCombo) || 0)));
  const gates = Math.max(0, Math.min(50, Math.floor(Number(run.gatesCorrect) || 0)));
  const verses = Array.isArray(run.versesMastered) ? run.versesMastered.slice(0, 20).map(String) : [];

  // streak
  const today = dayKey();
  if (p.lastPlayDay !== today) {
    const yesterday = dayKey(new Date(Date.now() - 86400000));
    if (p.lastPlayDay === yesterday) { p.streak += 1; rewards.streakUp = true; }
    else if (p.lastPlayDay) { if (p.streakFreeze > 0) { p.streakFreeze -= 1; p.streak += 1; rewards.streakUp = true; } else p.streak = 1; }
    else p.streak = 1;
    p.lastPlayDay = today;
    p.longestStreak = Math.max(p.longestStreak, p.streak);
    if (p.streak % 7 === 0) { p.streakFreeze = Math.min(3, p.streakFreeze + 1); rewards.coins += 50; }
  }

  // xp / coins / totals
  const prevLevel = p.level;
  p.xp += Math.round(score / 4) + gates * 15;
  p.coins += Math.round(score / 20);
  p.totalScore += score;
  p.gamesPlayed += 1;
  p.level = levelFor(p.xp);
  if (p.level > prevLevel) { rewards.levelUp = true; rewards.coins += 20 * (p.level - prevLevel); }
  rewards.xp = p.xp;

  // best
  if (score > p.bestScore) { p.bestScore = score; rewards.bestUp = true; }

  // verses mastered
  for (const v of verses) if (!p.versesMastered.includes(v)) p.versesMastered.push(v);

  // league (weekly points)
  const prevLeague = p.league;
  p.leaguePoints += score;
  p.league = leagueFor(p.leaguePoints);
  if (p.league !== prevLeague) rewards.leagueUp = true;

  // quests
  const bump = (arr) => arr.forEach(q => { if (q.done) return;
    if (q.id === "d_play" || q.id === "w_play") q.have += 1;
    if (q.id === "d_catch") q.have += items;
    if (q.id === "d_gate") q.have += gates;
    if (q.id === "w_combo") q.have = Math.max(q.have, maxCombo);
    if (q.id === "w_verse") q.have += verses.length;
    if (q.have >= q.need) { q.done = true; p.coins += q.reward; rewards.coins += q.reward; rewards.questsDone.push(q.label); }
  });
  bump(p.quests.daily); bump(p.quests.weekly);

  // achievements
  const grant = (id, coins = 0) => { if (!p.achievements.includes(id)) { p.achievements.push(id); rewards.achievements.push(id); p.coins += coins; rewards.coins += coins; } };
  if (p.gamesPlayed >= 1) grant("first_run", 20);
  if (p.streak >= 7) grant("week_streak", 60);
  if (p.bestScore >= 1000) grant("scholar_1k", 80);
  if (maxCombo >= 10) grant("combo_master", 40);
  if (p.versesMastered.length >= 25) grant("librarian", 100);

  p.updatedAt = Date.now();
  return { player: p, rewards, score };
}

/* daily chest */
export function claimChest(p) {
  const today = dayKey();
  if (p.chestDay === today) return { ok: false, reason: "already", coins: 0 };
  const yesterday = dayKey(new Date(Date.now() - 86400000));
  p.chestIndex = p.chestDay === yesterday ? (p.chestIndex + 1) % 7 : 0;
  p.chestDay = today;
  const coins = CHEST_COINS[p.chestIndex];
  p.coins += coins;
  p.updatedAt = Date.now();
  return { ok: true, coins, day: p.chestIndex + 1 };
}

/* leaderboard upsert (top 100) */
export async function upsertBoard(p) {
  if (!p.showOnLeaderboard) return;
  const board = stores.board();
  let top = (await board.get("top", { type: "json" })) || [];
  top = top.filter(e => e.userId !== p.userId);
  top.push({ userId: p.userId, name: p.displayName, country: p.country, best: p.bestScore, league: p.league });
  top.sort((a, b) => b.best - a.best);
  top = top.slice(0, 100);
  await board.set("top", JSON.stringify(top));
}

/* safe public view */
export function publicUser(user, p) {
  return {
    id: user.id, email: user.email, name: user.name, role: user.role,
    player: p && {
      level: p.level, xp: p.xp, coins: p.coins, energy: p.energy, energyMax: ENERGY_MAX,
      energyEtaMs: energyEtaMs(p),
      streak: p.streak, longestStreak: p.longestStreak, streakFreeze: p.streakFreeze,
      bestScore: p.bestScore, totalScore: p.totalScore, gamesPlayed: p.gamesPlayed,
      league: p.league, leaguePoints: p.leaguePoints, season: p.season,
      achievements: p.achievements, versesMastered: p.versesMastered.length,
      quests: p.quests, chestDay: p.chestDay, chestIndex: p.chestIndex,
      plan: p.plan, premium: p.premium, showOnLeaderboard: p.showOnLeaderboard,
      displayName: p.displayName, country: p.country,
    },
  };
}

export const CONSTS = { ENERGY_MAX, ENERGY_REGEN_MS, CHEST_COINS, LEAGUES };
