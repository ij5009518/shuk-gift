// Shuk Gift backend. Auth via Clerk session; balances/ledger held as real bank
// accounts (one per customer) with the banking provider. No provider names exposed.
import crypto from "crypto";
const IB = process.env.INCREASE_BASE_URL || "https://sandbox.increase.com";
const IK = process.env.INCREASE_API_KEY;

function emailList(v) { return String(v || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean); }
// Platform admin(s) — the business owner. Sets rewards/branding, sees everything.
// Falls back to MERCHANT_EMAILS for backward compatibility, then a default.
function adminList() {
  const a = emailList(process.env.ADMIN_EMAILS);
  if (a.length) return a;
  const m = emailList(process.env.MERCHANT_EMAILS);
  return m.length ? m : ["ij5009518@gmail.com"];
}
// Store operator(s) — run a store: charge/issue cards, view transactions. No config.
function storeList() { return emailList(process.env.STORE_EMAILS); }

// ---- Program configuration (admin-editable, stored in Clerk metadata) ----
// The canonical store admin's Clerk user holds the program config so every
// request (customer or merchant) reads the same settings.
const CONFIG_EMAIL = adminList()[0];
const PROGRAM_DEFAULTS = {
  storeName: "Shuk",                // brand shown to customers
  programName: "Shuk Gift",         // wallet / card name
  rewardsPercent: 1,                // % back earned as points (1 point = 1¢)
  firstLoadBonusPercent: 5,         // bonus % on a customer's first load
  firstLoadBonusCapCents: 2500,     // cap on the first-load bonus ($25)
  firstLoadMinCents: 5000,          // minimum load to qualify ($50)
  signupBonusPoints: 0,             // points granted once at signup
  redeemMinPoints: 100,             // 100 points = $1.00
};
function cleanProgram(p) {
  const o = p || {};
  const num = (v, d, max) => { let n = Number(v); if (!isFinite(n) || n < 0) n = d; if (max != null && n > max) n = max; return n; };
  const str = (v, d) => { const s = String(v == null ? d : v).trim().slice(0, 40); return s || d; };
  return {
    storeName: str(o.storeName, PROGRAM_DEFAULTS.storeName),
    programName: str(o.programName, PROGRAM_DEFAULTS.programName),
    rewardsPercent: num(o.rewardsPercent, PROGRAM_DEFAULTS.rewardsPercent, 25),
    firstLoadBonusPercent: num(o.firstLoadBonusPercent, PROGRAM_DEFAULTS.firstLoadBonusPercent, 50),
    firstLoadBonusCapCents: Math.round(num(o.firstLoadBonusCapCents, PROGRAM_DEFAULTS.firstLoadBonusCapCents, 100000)),
    firstLoadMinCents: Math.round(num(o.firstLoadMinCents, PROGRAM_DEFAULTS.firstLoadMinCents, 200000)),
    signupBonusPoints: Math.round(num(o.signupBonusPoints, PROGRAM_DEFAULTS.signupBonusPoints, 100000)),
    redeemMinPoints: Math.max(1, Math.round(num(o.redeemMinPoints, PROGRAM_DEFAULTS.redeemMinPoints, 100000))),
  };
}
// Per-store config (admin-managed). Each store can set its own rewards rate.
function cleanStore(s, email) {
  const o = s || {};
  const num = (v, d, max) => { let n = Number(v); if (!isFinite(n) || n < 0) n = d; if (max != null && n > max) n = max; return n; };
  const nm = String(o.name == null ? "" : o.name).trim().slice(0, 60) || String(email || "").split("@")[0];
  return {
    name: nm,
    rewardsPercent: num(o.rewardsPercent, PROGRAM_DEFAULTS.rewardsPercent, 25),
    feePercent: num(o.feePercent, 0, 100),   // platform's fee charged to this store per transaction
    active: o.active === false ? false : true,
    note: String(o.note == null ? "" : o.note).trim().slice(0, 120),
  };
}
async function loadProgram(clerk, knownUser) {
  let holder = null;
  if (knownUser && (knownUser.emailAddresses || []).some(e => (e.emailAddress || "").toLowerCase() === CONFIG_EMAIL)) holder = knownUser;
  if (!holder && clerk) {
    try { const r = await clerk.users.getUserList({ emailAddress: [CONFIG_EMAIL] }); const arr = Array.isArray(r) ? r : (r.data || []); holder = arr[0] || null; } catch {}
  }
  const saved = (holder && holder.privateMetadata && holder.privateMetadata.program) || {};
  const savedStores = (holder && holder.privateMetadata && holder.privateMetadata.stores) || {};
  const stores = {};
  for (const k of Object.keys(savedStores)) { const em = k.toLowerCase(); stores[em] = cleanStore(savedStores[k], em); }
  return { holder, program: cleanProgram({ ...PROGRAM_DEFAULTS, ...saved }), stores };
}

async function inc(path, method = "GET", body) {
  const r = await fetch(IB + path, {
    method,
    headers: { Authorization: "Bearer " + IK, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!r.ok) {
    const msg = (data && (data.title || data.detail || data.message)) || ("Provider error " + r.status);
    const e = new Error(msg); e.status = r.status; e.data = data; throw e;
  }
  return data;
}

const cents = (a) => (typeof a === "number" ? a : 0);
const when = (iso) => { try { return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" }); } catch { return ""; } };
const codeFor = (acct) => String(acct.id || "").replace(/[^a-zA-Z0-9]/g, "").slice(-4).toUpperCase() || "····";
// Stable 16-digit card number derived from the account id, with a Luhn check digit.
function cardNumber(acct) {
  const id = String(acct.id || "");
  let h = 0n;
  for (const ch of id) h = (h * 131n + BigInt(ch.charCodeAt(0))) % (10n ** 15n);
  const base = ("9" + h.toString().padStart(15, "0")).slice(0, 15); // 15 digits, leading 9
  let sum = 0, dbl = true;
  for (let i = base.length - 1; i >= 0; i--) { let d = +base[i]; if (dbl) { d *= 2; if (d > 9) d -= 9; } sum += d; dbl = !dbl; }
  return base + ((10 - (sum % 10)) % 10);
}

async function balance(id) { try { const b = await inc("/accounts/" + id + "/balance"); return cents(b.current_balance); } catch { return 0; } }
async function txns(id, limit) {
  try {
    const d = await inc("/transactions?account_id=" + id + "&limit=" + (limit || 12));
    return (d.data || []).map(t => ({ amount: cents(t.amount), when: when(t.created_at), at: t.created_at, cat: (t.source && t.source.category) || "", desc: t.description || "" }));
  } catch { return []; }
}

// Find a customer's linked bank (External Account), tagged by description.
async function findBank(em) {
  try {
    const d = await inc("/external_accounts?limit=100");
    return (d.data || []).find(x => (x.description || "") === "Bank:" + em && (x.status === undefined || x.status === "active")) || null;
  } catch { return null; }
}

// List ALL of a customer's linked banks (active external accounts tagged for them).
async function listBanks(em) {
  try {
    const d = await inc("/external_accounts?limit=100");
    return (d.data || [])
      .filter(x => (x.description || "") === "Bank:" + em && (x.status === undefined || x.status === "active"))
      .map(x => ({
        id: x.id,
        last4: String(x.account_number || "").slice(-4),
        routingLast4: String(x.routing_number || "").slice(-4),
        funding: x.funding || "checking",
        created: x.created_at || null,
      }));
  } catch { return []; }
}

// ---- Auto top-up (recurring / low-balance auto-reload) ----
// Rule lives in the customer's Clerk private metadata under shuk.autoReload:
//   { enabled, mode: "low"|"weekly"|"monthly", thresholdCents, amountCents, nextRun, lastRun }
function autoCfg(user) {
  const a = (user && user.privateMetadata && user.privateMetadata.shuk && user.privateMetadata.shuk.autoReload) || null;
  if (!a) return null;
  return {
    enabled: !!a.enabled,
    mode: ["low", "weekly", "monthly"].includes(a.mode) ? a.mode : "low",
    thresholdCents: Math.max(0, Math.round(Number(a.thresholdCents) || 0)),
    amountCents: Math.max(0, Math.round(Number(a.amountCents) || 0)),
    nextRun: Number(a.nextRun) || 0,
    lastRun: Number(a.lastRun) || 0,
  };
}
function nextRunFrom(mode, from) {
  const d = new Date(from || Date.now());
  if (mode === "weekly") { d.setDate(d.getDate() + 7); return d.getTime(); }
  if (mode === "monthly") { d.setMonth(d.getMonth() + 1); return d.getTime(); }
  return 0;
}
// Pull funds from a linked bank into a card via ACH debit (sandbox auto-settles).
async function achPull(cardId, bankId, amount, descriptor) {
  let tr;
  try { tr = await inc("/ach_transfers", "POST", { account_id: cardId, amount: -amount, statement_descriptor: descriptor || "Shuk Auto", external_account_id: bankId }); }
  catch { return { ok: false }; }
  if (tr && tr.status === "pending_approval" && tr.id) { try { await inc("/ach_transfers/" + tr.id + "/approve", "POST"); } catch {} }
  let settled = false;
  if (tr && tr.id && /sandbox/.test(IB)) {
    try { await inc("/simulations/ach_transfers/" + tr.id + "/settle", "POST"); settled = true; }
    catch { try { await inc("/simulations/ach_transfers/" + tr.id + "/acknowledge", "POST"); } catch {} }
  }
  return { ok: true, settled, status: (tr && tr.status) || "pending" };
}
// Evaluate a customer's auto-reload rule and fire it if due. Persists nextRun/lastRun.
// `currentBalance` lets the caller supply a known balance to avoid an extra fetch.
async function runAutoReload(clerk, user, em, cardId, currentBalance) {
  const cfg = autoCfg(user);
  if (!cfg || !cfg.enabled || cfg.amountCents <= 0) return { ran: false };
  const bank = await findBank(em);
  if (!bank) return { ran: false, reason: "nobank" };
  const now = Date.now();
  if (cfg.lastRun && now - cfg.lastRun < 60000) return { ran: false }; // throttle
  let due = false, advance = false;
  if (cfg.mode === "low") { if (currentBalance < cfg.thresholdCents) due = true; }
  else if (!cfg.nextRun || now >= cfg.nextRun) { due = true; advance = true; }
  if (!due) return { ran: false };
  const r = await achPull(cardId, bank.id, cfg.amountCents);
  if (!r.ok) return { ran: false };
  const patch = { lastRun: now };
  if (advance) patch.nextRun = nextRunFrom(cfg.mode, now);
  try {
    const shuk = (user.privateMetadata && user.privateMetadata.shuk) || {};
    const merged = { ...shuk, autoReload: { ...(shuk.autoReload || {}), ...patch } };
    await clerk.users.updateUserMetadata(user.id, { privateMetadata: { shuk: merged } });
    if (user.privateMetadata) user.privateMetadata.shuk = merged;
  } catch {}
  return { ran: true, amount: cfg.amountCents, settled: r.settled };
}

// ---- IVR / phone & SMS banking ----
// IVR/SMS PIN hash. MUST stay identical to api/ivr.js pinHash().
function ivrPinHash(em, pin) { return crypto.createHmac("sha256", process.env.CLERK_SECRET_KEY || "shuk-ivr").update("pin:" + String(em).toLowerCase() + ":" + String(pin)).digest("hex"); }
// Normalize a US phone number to E.164 (+1XXXXXXXXXX).
function e164(p) { let d = String(p || "").replace(/[^\d]/g, ""); if (d.length === 10) d = "1" + d; if (d.length === 11 && d[0] === "1") return "+" + d; return ""; }

// ---- Card store (Upstash Redis REST) — pre-printed, phone-activated cards ----
const RURL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const RTOK = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const cardStoreOn = () => !!(RURL && RTOK);
async function redis(cmd) {
  if (!RURL || !RTOK) throw new Error("Card store not configured.");
  const r = await fetch(RURL, { method: "POST", headers: { Authorization: "Bearer " + RTOK, "Content-Type": "application/json" }, body: JSON.stringify(cmd) });
  const d = await r.json();
  if (d && d.error) throw new Error(d.error);
  return d ? d.result : null;
}
const rGet = async (k) => { const v = await redis(["GET", k]); return v ? JSON.parse(v) : null; };
const rSet = (k, v) => redis(["SET", k, JSON.stringify(v)]);
// Random 16-digit Luhn-valid card number (leading 9, matching the derived ones).
function randCardNumber() {
  let base = "9";
  for (let i = 0; i < 14; i++) base += Math.floor(Math.random() * 10);
  let sum = 0, dbl = true;
  for (let i = base.length - 1; i >= 0; i--) { let d = +base[i]; if (dbl) { d *= 2; if (d > 9) d -= 9; } sum += d; dbl = !dbl; }
  return base + ((10 - (sum % 10)) % 10);
}

// ---- POS connector (records sales in the store's point-of-sale) ----
const DK = process.env.DECIMAL_API_KEY;
const DB = process.env.DECIMAL_BASE_URL || "https://api.poswithlogic.dev";
async function pos(path, method = "GET", body) {
  const r = await fetch(DB + path, {
    method, headers: { "x-api-key": DK, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text(); let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!r.ok) { const e = new Error((data && (data.title || data.detail)) || ("POS error " + r.status)); e.status = r.status; e.data = data; throw e; }
  return data;
}
const posList = (d) => Array.isArray(d) ? d : (d.results || d.data || d.items || d.records || []);
async function posCustomerId() { try { const c = posList(await pos("/customers?take=1"))[0]; return c && (c.id ?? c.customerId); } catch { return null; } }

export default async function handler(req, res) {
  if (!IK) return res.status(200).json({ error: "Service not configured." });
  const secret = process.env.CLERK_SECRET_KEY;

  let body = {};
  try { body = typeof req.body === "object" && req.body ? req.body : JSON.parse(req.body || "{}"); } catch {}
  const action = body.action || "bootstrap";

  // ---- Auth (Clerk) ----
  let email = null, name = null, clerk = null, meUser = null;
  if (secret) {
    const auth = req.headers.authorization || "";
    const tok = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!tok) return res.status(200).json({ needsAuth: true });
    try {
      const { verifyToken, createClerkClient } = await import("@clerk/backend");
      const claims = await verifyToken(tok, { secretKey: secret });
      clerk = createClerkClient({ secretKey: secret });
      meUser = await clerk.users.getUser(claims.sub);
      email = (meUser.emailAddresses.find(e => e.id === meUser.primaryEmailAddressId) || meUser.emailAddresses[0] || {}).emailAddress || null;
      name = [meUser.firstName, meUser.lastName].filter(Boolean).join(" ") || meUser.username || email;
    } catch (e) {
      return res.status(200).json({ needsAuth: true, error: "Session invalid." });
    }
  } else {
    return res.status(200).json({ error: "Sign-in not configured." });
  }
  if (!email) return res.status(200).json({ error: "No email on account." });
  const emLower = (email || "").toLowerCase();
  const isAdmin = adminList().includes(emLower);
  // isStore / role are finalized below, after the admin's store registry loads.

  try {
    // ---- Program context: existing accounts give us entity + program + operating acct ----
    const all = (await inc("/accounts?limit=100")).data || [];
    const operating = all.find(a => { const n = String(a.name || ""); return !n.startsWith("Gift:") && !n.startsWith("Points:") && !n.startsWith("Store:"); }) || all[0];
    if (!operating) return res.status(200).json({ error: "No operating account found." });
    const { entity_id, program_id, id: opId } = operating;

    // Per-store settlement account: holds what the platform owes the store (sales net of fees).
    async function ensureStoreAcct(em) {
      let c = all.find(a => a.name === "Store:" + em);
      if (!c) { c = await inc("/accounts", "POST", { name: "Store:" + em, entity_id, program_id }); all.push(c); }
      return c;
    }

    const findCard = (em) => all.find(a => a.name === "Gift:" + em);
    async function ensureCard(em) {
      let c = findCard(em);
      if (!c) {
        c = await inc("/accounts", "POST", { name: "Gift:" + em, entity_id, program_id });
        all.push(c);
      }
      return c;
    }
    // Loyalty points: a separate account per customer; balance = points earned.
    async function ensurePoints(em) {
      let c = all.find(a => a.name === "Points:" + em);
      if (!c) {
        c = await inc("/accounts", "POST", { name: "Points:" + em, entity_id, program_id });
        all.push(c);
      }
      return c;
    }

    // ---- Program config + store registry + per-customer reward flags ----
    const { holder: cfgHolder, program, stores } = await loadProgram(clerk, meUser);
    // Finalize role: a store is anyone in the admin's store registry (or legacy STORE_EMAILS env).
    const isStore = !isAdmin && (!!stores[emLower] || storeList().includes(emLower));
    const isOperator = isAdmin || isStore;
    const role = isAdmin ? "admin" : isStore ? "store" : "customer";
    // A store's checkout awards that store's own rate; otherwise the global default.
    const effRewards = (opEmail) => { const s = stores[(opEmail || "").toLowerCase()]; return (s && s.rewardsPercent != null) ? s.rewardsPercent : program.rewardsPercent; };
    // Sales are tagged in the ledger description as "SALE|<storeEmail>" so every
    // redemption can be attributed back to the store that rang it up.
    const saleTag = () => "SALE|" + (isStore ? emLower : "platform");
    const resolveStore = (t) => { const m = /^SALE\|(.+)$/i.exec(t.desc || ""); if (!m) return {}; const se = m[1].toLowerCase(); return { store: se, storeName: (stores[se] && stores[se].name) || (se === "platform" ? "Platform" : se) }; };
    const myFlags = (meUser && meUser.privateMetadata && meUser.privateMetadata.shuk) || {};
    async function setMyFlag(patch) {
      try {
        const merged = { ...((meUser.privateMetadata && meUser.privateMetadata.shuk) || {}), ...patch };
        await clerk.users.updateUserMetadata(meUser.id, { privateMetadata: { shuk: merged } });
        meUser.privateMetadata = { ...(meUser.privateMetadata || {}), shuk: merged };
      } catch {}
    }
    // First-load bonus: store credit added the first time a customer loads enough.
    async function applyFirstLoadBonus(card, loadedCents) {
      if (myFlags.firstLoadBonus) return 0;
      if (program.firstLoadBonusPercent <= 0) return 0;
      if (loadedCents < program.firstLoadMinCents) return 0;
      let bonus = Math.round(loadedCents * program.firstLoadBonusPercent / 100);
      if (program.firstLoadBonusCapCents > 0) bonus = Math.min(bonus, program.firstLoadBonusCapCents);
      if (bonus <= 0) return 0;
      await inc("/simulations/interest_payments", "POST", { account_id: card.id, amount: bonus });
      await setMyFlag({ firstLoadBonus: true });
      return bonus;
    }

    // ---- Actions ----
    if (action === "bootstrap") {
      if (isOperator) {
        const cardAccts = all.filter(a => String(a.name || "").startsWith("Gift:"));
        const ptsAccts = all.filter(a => String(a.name || "").startsWith("Points:"));
        const ptsBalForEmail = async (em) => { const p = all.find(x => x.name === "Points:" + em); return p ? await balance(p.id) : 0; };
        const cards = await Promise.all(cardAccts.map(async a => {
          const em = a.name.slice(5);
          const obj = { id: a.id, email: em, code: codeFor(a), cardNumber: cardNumber(a), balance: await balance(a.id) };
          if (isAdmin) obj.points = await ptsBalForEmail(em);
          return obj;
        }));
        cards.sort((x, y) => y.balance - x.balance);
        // Per-customer transaction report, built from each gift card's ledger history.
        // On a card: a negative entry is a redemption (sale), a positive entry is a load.
        // Sales carry a "SALE|<store>" tag so we can attribute them.
        const lists = await Promise.all(cardAccts.map(async a => {
          const em = a.name.slice(5);
          const list = await txns(a.id, 25);
          return list.map(t => ({ email: em, code: codeFor(a), amount: t.amount, when: t.when, at: t.at, who: t.amount < 0 ? "Sale" : "Load", ...resolveStore(t) }));
        }));
        const allTx = lists.flat().sort((x, y) => new Date(y.at || 0) - new Date(x.at || 0));
        const pointsIssued = (await Promise.all(ptsAccts.map(a => balance(a.id)))).reduce((x, y) => x + y, 0);
        const isToday = (at) => { try { return new Date(at).toDateString() === new Date().toDateString(); } catch { return false; } };

        if (isAdmin) {
          const fundsHeld = cards.reduce((s, c) => s + (c.balance || 0), 0);
          // Roll sales up by store.
          const byStore = {};
          for (const t of allTx) { if (t.amount < 0 && t.store) { const s = byStore[t.store] || (byStore[t.store] = { count: 0, total: 0 }); s.count++; s.total += Math.abs(t.amount); } }
          let storesArr = await Promise.all(Object.keys(stores).map(async k => {
            const sa = all.find(a => a.name === "Store:" + k);
            const owed = sa ? await balance(sa.id) : 0;                // settlement owed to the store (net of fees), in our ledger
            const salesTotal = (byStore[k] || {}).total || 0;
            const feePercent = Number(stores[k].feePercent) || 0;
            const feesCollected = Math.round(salesTotal * feePercent / 100); // platform fee revenue from this store
            return { email: k, ...stores[k], salesCount: (byStore[k] || {}).count || 0, salesTotal, owed, feesCollected };
          }));
          storesArr.sort((a, b) => (b.salesTotal - a.salesTotal) || a.name.localeCompare(b.name));
          const sales = allTx.filter(t => t.amount < 0);
          const stats = {
            fundsHeld, pointsIssued, activeCards: cards.filter(c => c.balance > 0).length,
            customerCount: cards.length, storeCount: storesArr.length,
            salesCount: sales.length, salesTotal: sales.reduce((s, t) => s + Math.abs(t.amount), 0),
            salesTodayTotal: sales.filter(t => isToday(t.at)).reduce((s, t) => s + Math.abs(t.amount), 0),
            feeRevenue: storesArr.reduce((s, x) => s + (x.feesCollected || 0), 0),
          };
          return res.status(200).json({ role, isAdmin: true, email, name, cards, transactions: allTx.slice(0, 80), posConnected: !!DK, pointsIssued, program, stores: storesArr, stats });
        }

        // Store: its own sales only, plus store-level stats, its rate, and its settlement.
        const mySales = allTx.filter(t => t.amount < 0 && t.store === emLower);
        const myToday = mySales.filter(t => isToday(t.at));
        const myStore = stores[emLower] || { name: name || emLower, rewardsPercent: program.rewardsPercent, feePercent: 0, active: true };
        const mySalesTotal = mySales.reduce((s, t) => s + Math.abs(t.amount), 0);
        const sAcct = all.find(a => a.name === "Store:" + emLower);
        const owed = sAcct ? await balance(sAcct.id) : 0;
        const stats = {
          salesCount: mySales.length, salesTotal: mySalesTotal,
          salesTodayCount: myToday.length, salesTodayTotal: myToday.reduce((s, t) => s + Math.abs(t.amount), 0),
          activeCards: cards.filter(c => c.balance > 0).length,
          owed, feesPaid: Math.round(mySalesTotal * (Number(myStore.feePercent) || 0) / 100),
        };
        return res.status(200).json({ role, isAdmin: false, email, name, cards, transactions: mySales.slice(0, 80), posConnected: !!DK, program: { ...program, rewardsPercent: effRewards(emLower) }, store: { email: emLower, ...myStore, owed }, stats });
      }
      const card = await ensureCard(email);
      const pts = await ensurePoints(email);
      // One-time signup bonus in points (if configured and not yet granted).
      if (program.signupBonusPoints > 0 && !myFlags.signupBonus) {
        try { await inc("/simulations/interest_payments", "POST", { account_id: pts.id, amount: program.signupBonusPoints }); await setMyFlag({ signupBonus: true }); } catch {}
      }
      // Auto top-up: fire any due low-balance / scheduled reload before reporting balance.
      let bal = await balance(card.id);
      let autoReloaded = null;
      try {
        const auto = await runAutoReload(clerk, meUser, email, card.id, bal);
        if (auto.ran) { bal = await balance(card.id); autoReloaded = { amount: auto.amount, settled: auto.settled }; }
      } catch {}
      const ctx = (await txns(card.id, 50)).map(t => ({ ...t, ...resolveStore(t) }));
      // Lifetime summary on the card: loaded in (any credit) vs spent (any debit/sale).
      const spent = ctx.filter(t => t.amount < 0).reduce((s, t) => s + Math.abs(t.amount), 0);
      const loaded = ctx.filter(t => t.amount > 0).reduce((s, t) => s + t.amount, 0);
      return res.status(200).json({
        role: "customer", email, name, cardId: card.id, code: codeFor(card), cardNumber: cardNumber(card),
        balance: bal, points: await balance(pts.id), transactions: ctx.slice(0, 15),
        summary: { loaded, spent }, program, firstLoadBonusUsed: !!myFlags.firstLoadBonus,
        phone: myFlags.phone || null, ivrPinSet: !!myFlags.pinHash,
        autoReload: autoCfg(meUser) || { enabled: false, mode: "low", thresholdCents: 0, amountCents: 0 },
        autoReloaded,
      });
    }

    if (action === "load") {
      const amount = Math.round(Number(body.amount) || 0);
      if (amount <= 0) return res.status(200).json({ error: "Enter a valid amount." });
      if (amount > 200000) return res.status(200).json({ error: "Max $2,000 per load." });
      const card = await ensureCard(email);
      await inc("/simulations/interest_payments", "POST", { account_id: card.id, amount });
      const bonus = await applyFirstLoadBonus(card, amount);
      return res.status(200).json({ ok: true, balance: await balance(card.id), bonus });
    }

    if (action === "bankStatus") {
      const banks = await listBanks(email);
      const b = banks[0] || null;
      return res.status(200).json({ linked: banks.length > 0, last4: b ? b.last4 : null, banks });
    }

    if (action === "removeBank") {
      // Archive one of THIS customer's linked external accounts.
      const id = String(body.bankId || "");
      const mine = await listBanks(email);
      if (!id || !mine.some(b => b.id === id)) return res.status(200).json({ error: "Bank account not found." });
      try { await inc("/external_accounts/" + id, "PATCH", { status: "archived" }); }
      catch { return res.status(200).json({ error: "Could not remove bank." }); }
      return res.status(200).json({ ok: true, banks: await listBanks(email) });
    }

    if (action === "setAutoReload") {
      // Customer configures auto top-up: low-balance threshold or weekly/monthly schedule.
      const enabled = !!body.enabled;
      const mode = ["low", "weekly", "monthly"].includes(body.mode) ? body.mode : "low";
      const amountCents = Math.min(200000, Math.max(0, Math.round(Number(body.amountCents) || 0)));
      const thresholdCents = Math.min(200000, Math.max(0, Math.round(Number(body.thresholdCents) || 0)));
      if (enabled && amountCents <= 0) return res.status(200).json({ error: "Enter a reload amount." });
      if (enabled && mode === "low" && thresholdCents <= 0) return res.status(200).json({ error: "Enter a low-balance threshold." });
      if (enabled) { const bank = await findBank(email); if (!bank) return res.status(200).json({ error: "Link a bank account first." }); }
      const prev = autoCfg(meUser) || {};
      let nextRun = 0;
      if (enabled && mode !== "low") nextRun = (prev.nextRun && prev.mode === mode) ? prev.nextRun : nextRunFrom(mode, Date.now());
      const cfg = { enabled, mode, amountCents, thresholdCents, nextRun, lastRun: prev.lastRun || 0 };
      await setMyFlag({ autoReload: cfg });
      return res.status(200).json({ ok: true, autoReload: cfg });
    }

    if (action === "setIvr") {
      // Customer registers a phone number + 4-digit PIN for phone/SMS banking.
      // PIN is stored hashed in the customer's private metadata; the phone -> email
      // mapping is kept in a phoneIndex on the admin user so the IVR can resolve callers.
      const pin = String(body.pin || "").replace(/\D/g, "");
      const phone = e164(body.phone);
      if (!phone) return res.status(200).json({ error: "Enter a valid US phone number." });
      if (pin.length !== 4) return res.status(200).json({ error: "PIN must be 4 digits." });
      await setMyFlag({ phone, pinHash: ivrPinHash(emLower, pin) });
      try {
        let holder = cfgHolder;
        if (!holder) { const r = await clerk.users.getUserList({ emailAddress: [CONFIG_EMAIL] }); const arr = Array.isArray(r) ? r : (r.data || []); holder = arr[0] || null; }
        if (holder) {
          const idx = { ...((holder.privateMetadata && holder.privateMetadata.phoneIndex) || {}) };
          for (const k of Object.keys(idx)) { if (idx[k] === emLower) delete idx[k]; }
          idx[phone] = emLower;
          await clerk.users.updateUserMetadata(holder.id, { privateMetadata: { ...(holder.privateMetadata || {}), phoneIndex: idx } });
        }
      } catch {}
      return res.status(200).json({ ok: true, phone, ivrPinSet: true });
    }

    if (action === "linkBank") {
      // Register the customer's bank account so we can pull funds from it by ACH.
      const routing = String(body.routingNumber || "").replace(/\D/g, "");
      const account = String(body.accountNumber || "").replace(/\D/g, "");
      const funding = body.funding === "savings" ? "savings" : "checking";
      if (routing.length !== 9) return res.status(200).json({ error: "Enter a valid 9-digit routing number." });
      if (account.length < 4) return res.status(200).json({ error: "Enter a valid account number." });
      await inc("/external_accounts", "POST", { routing_number: routing, account_number: account, funding, description: "Bank:" + email });
      return res.status(200).json({ ok: true, last4: account.slice(-4) });
    }

    if (action === "addFundsAch") {
      // Pull funds from the customer's linked bank into their gift card account via an
      // ACH debit (negative amount originates a debit, pulling funds in).
      const amount = Math.round(Number(body.amount) || 0);
      if (amount <= 0) return res.status(200).json({ error: "Enter a valid amount." });
      if (amount > 200000) return res.status(200).json({ error: "Max $2,000 per transfer." });
      const bank = await findBank(email);
      if (!bank) return res.status(200).json({ error: "Link a bank account first." });
      const card = await ensureCard(email);
      let tr;
      try {
        tr = await inc("/ach_transfers", "POST", { account_id: card.id, amount: -amount, statement_descriptor: "Shuk Gift", external_account_id: bank.id });
      } catch (e) {
        return res.status(200).json({ error: String((e && e.message) || e).slice(0, 160) });
      }
      if (tr && tr.status === "pending_approval" && tr.id) { try { await inc("/ach_transfers/" + tr.id + "/approve", "POST"); } catch {} }
      // Sandbox: simulate settlement so the balance reflects immediately (ignored in production).
      let settled = false;
      if (tr && tr.id && /sandbox/.test(IB)) {
        try { await inc("/simulations/ach_transfers/" + tr.id + "/settle", "POST"); settled = true; }
        catch { try { await inc("/simulations/ach_transfers/" + tr.id + "/acknowledge", "POST"); } catch {} }
      }
      const bonus = settled ? await applyFirstLoadBonus(card, amount) : 0;
      return res.status(200).json({ ok: true, status: (tr && tr.status) || "pending", settled, bonus, balance: await balance(card.id) });
    }

    if (action === "charge") {
      if (!isOperator) return res.status(200).json({ error: "Only a store can charge cards." });
      const amount = Math.round(Number(body.amount) || 0);
      const cardId = body.cardId;
      if (!cardId) return res.status(200).json({ error: "Pick a card." });
      if (amount <= 0) return res.status(200).json({ error: "Enter a sale amount." });
      const bal = await balance(cardId);
      if (amount > bal) return res.status(200).json({ error: "Card balance is only $" + (bal / 100).toFixed(2) + "." });
      const t = await inc("/account_transfers", "POST", {
        account_id: cardId, destination_account_id: opId, amount, description: saleTag(),
      });
      if (t && t.status === "pending_approval" && t.id) {
        try { await inc("/account_transfers/" + t.id + "/approve", "POST"); } catch {}
      }
      return res.status(200).json({ ok: true, balance: await balance(cardId) });
    }

    if (action === "issueCard") {
      if (!isOperator) return res.status(200).json({ error: "Store access only." });
      const em = String(body.email || "").trim().toLowerCase();
      const amount = Math.round(Number(body.amount) || 0);
      if (!/.+@.+\..+/.test(em)) return res.status(200).json({ error: "Enter a valid customer email." });
      if (amount > 200000) return res.status(200).json({ error: "Max $2,000 per load." });
      const card = await ensureCard(em);
      await ensurePoints(em);
      if (amount > 0) await inc("/simulations/interest_payments", "POST", { account_id: card.id, amount });
      return res.status(200).json({ ok: true, cardId: card.id, code: codeFor(card), email: em, balance: await balance(card.id) });
    }

    if (action === "posProduct") {
      if (!isOperator) return res.status(200).json({ error: "Store access only." });
      if (!DK) return res.status(200).json({ error: "POS not connected." });
      const code = String(body.code || "").trim();
      if (!code) return res.status(200).json({ error: "Enter a product code." });
      const data = await pos("/products/code/" + encodeURIComponent(code));
      const p = Array.isArray(data) ? data[0] : (data.results ? data.results[0] : data);
      if (!p || !(p.itemCode || p.id)) return res.status(200).json({ error: "Product not found." });
      const price = (p.prices && p.prices[0] && p.prices[0].price) ?? p.price ?? 0;
      return res.status(200).json({ product: { code: p.itemCode ?? p.primaryCode ?? code, name: p.description ?? p.name ?? code, price, taxable: !!p.tax, taxRate: p.taxRate || 0 } });
    }

    if (action === "checkout") {
      // Amount-based redemption. The store rings up the order in its own POS; here we
      // just charge the gift card for the order total (no item detail needed).
      if (!isOperator) return res.status(200).json({ error: "Only a store can charge cards." });
      const cardId = body.cardId;
      const amountCents = Math.round(Number(body.amount) || 0);
      if (!cardId) return res.status(200).json({ error: "Pick a customer." });
      if (amountCents <= 0) return res.status(200).json({ error: "Enter a sale amount." });
      const bal = await balance(cardId);
      if (amountCents > bal) return res.status(200).json({ error: "Card balance is only $" + (bal / 100).toFixed(2) + "." });
      const total = amountCents / 100;

      // 1) Deduct the gift balance in our ledger (tagged with the store)
      const t = await inc("/account_transfers", "POST", { account_id: cardId, destination_account_id: opId, amount: amountCents, description: saleTag() });
      if (t && t.status === "pending_approval" && t.id) { try { await inc("/account_transfers/" + t.id + "/approve", "POST"); } catch {} }

      // 1b) Settle the store: move (total − platform fee) from operating into the store's
      //     settlement account. The platform fee % stays in operating as revenue.
      let feeCents = 0, netCents = amountCents;
      try {
        if (isStore && stores[emLower]) {
          const feePct = Number(stores[emLower].feePercent) || 0;
          feeCents = Math.round(amountCents * feePct / 100);
          netCents = amountCents - feeCents;
          if (netCents > 0) {
            const sa = await ensureStoreAcct(emLower);
            const st2 = await inc("/account_transfers", "POST", { account_id: opId, destination_account_id: sa.id, amount: netCents, description: "Settlement|" + emLower });
            if (st2 && st2.status === "pending_approval" && st2.id) { try { await inc("/account_transfers/" + st2.id + "/approve", "POST"); } catch {} }
          }
        }
      } catch (e) { /* settlement is best-effort; the sale itself already succeeded */ }

      // 2) Record the redemption total in the store's POS (total only, best effort)
      let posInvoice = null, posError = null;
      if (DK) {
        try {
          const custId = await posCustomerId();
          if (!custId) throw new Error("No POS customer available.");
          const now = new Date().toISOString();
          const ext = "SG" + Date.now().toString().slice(-16);
          await pos("/invoices", "POST", {
            externalInvoiceId: ext, invoiceDate: now, orderMethod: "Pickup", taxAmount: 0, taxableAmount: 0, customerId: custId,
            items: [{ productCode: "GIFT", quantity: 1, unitPrice: total, subtotal: total, isTaxable: false, discountAmount: 0, description: "Gift card redemption" }],
            payments: [{ paymentMethod: "APICreditCard", amount: total, referenceNo: ext.slice(0, 15), dateTime: now, cardholderName: "Shuk Gift", authorizationCode: ext.slice(0, 10), maskedCreditCardNumber: "************GIFT" }],
            memo: "Shuk Gift redemption",
          });
          posInvoice = ext;
        } catch (e) { posError = String((e && e.message) || e).slice(0, 140); }
      }

      // 3) Award loyalty points to the customer (1 point per $1 spent)
      let pointsAwarded = 0;
      try {
        const cardAcct = all.find(a => a.id === cardId);
        const em = cardAcct && String(cardAcct.name || "").startsWith("Gift:") ? cardAcct.name.slice(5) : null;
        if (em) {
          pointsAwarded = Math.floor(total * effRewards(emLower));
          if (pointsAwarded > 0) {
            const pts = await ensurePoints(em);
            await inc("/simulations/interest_payments", "POST", { account_id: pts.id, amount: pointsAwarded });
          }
        }
      } catch {}

      return res.status(200).json({ ok: true, balance: await balance(cardId), total, posInvoice, posError, pointsAwarded, fee: feeCents / 100, net: netCents / 100 });
    }

    if (action === "redeem") {
      // Customer redeems loyalty points for store credit. 100 points = $1.00 (1 point = 1¢).
      const points = Math.floor(Number(body.points) || 0);
      const minPts = program.redeemMinPoints || 100;
      if (points < minPts) return res.status(200).json({ error: "Redeem at least " + minPts + " points ($" + (minPts / 100).toFixed(2) + ")." });
      const pts = await ensurePoints(email);
      const have = await balance(pts.id);
      if (points > have) return res.status(200).json({ error: "You only have " + have + " points." });
      const card = await ensureCard(email);
      const creditCents = points; // 100 pts -> 100¢ -> $1.00
      const t = await inc("/account_transfers", "POST", { account_id: pts.id, destination_account_id: opId, amount: points, description: "Points redeemed for credit" });
      if (t && t.status === "pending_approval" && t.id) { try { await inc("/account_transfers/" + t.id + "/approve", "POST"); } catch {} }
      await inc("/simulations/interest_payments", "POST", { account_id: card.id, amount: creditCents });
      return res.status(200).json({ ok: true, points: await balance(pts.id), balance: await balance(card.id), credited: creditCents });
    }

    if (action === "setProgram") {
      // Admin-only: save the program configuration (rates, bonuses, branding).
      if (!isAdmin) return res.status(200).json({ error: "Platform admin only." });
      if (!clerk) return res.status(200).json({ error: "Sign-in not configured." });
      let holder = cfgHolder;
      if (!holder) { try { const r = await clerk.users.getUserList({ emailAddress: [CONFIG_EMAIL] }); const arr = Array.isArray(r) ? r : (r.data || []); holder = arr[0] || null; } catch {} }
      if (!holder) return res.status(200).json({ error: "Could not locate the store admin account." });
      const merged = cleanProgram({ ...program, ...(body.program || {}) });
      try {
        await clerk.users.updateUserMetadata(holder.id, { privateMetadata: { ...(holder.privateMetadata || {}), program: merged } });
      } catch (e) {
        return res.status(200).json({ error: "Could not save settings: " + String((e && e.message) || e).slice(0, 120) });
      }
      return res.status(200).json({ ok: true, program: merged });
    }

    if (action === "setStore" || action === "removeStore") {
      // Admin-only: manage the store registry (per-store rewards). Adding a store
      // email here also grants it the store role (no redeploy needed).
      if (!isAdmin) return res.status(200).json({ error: "Platform admin only." });
      if (!clerk) return res.status(200).json({ error: "Sign-in not configured." });
      let holder = cfgHolder;
      if (!holder) { try { const r = await clerk.users.getUserList({ emailAddress: [CONFIG_EMAIL] }); const arr = Array.isArray(r) ? r : (r.data || []); holder = arr[0] || null; } catch {} }
      if (!holder) return res.status(200).json({ error: "Could not locate the platform admin account." });
      const reg = { ...((holder.privateMetadata && holder.privateMetadata.stores) || {}) };
      const sem = String(body.email || "").trim().toLowerCase();
      if (!/.+@.+\..+/.test(sem)) return res.status(200).json({ error: "Enter a valid store email." });
      if (adminList().includes(sem)) return res.status(200).json({ error: "That email is the platform admin." });
      if (action === "removeStore") { delete reg[sem]; }
      else { reg[sem] = cleanStore({ ...(reg[sem] || {}), ...(body.store || {}) }, sem); }
      try {
        await clerk.users.updateUserMetadata(holder.id, { privateMetadata: { ...(holder.privateMetadata || {}), stores: reg } });
      } catch (e) {
        return res.status(200).json({ error: "Could not save store: " + String((e && e.message) || e).slice(0, 120) });
      }
      const out = Object.keys(reg).map(k => ({ email: k, ...cleanStore(reg[k], k) })).sort((a, b) => a.name.localeCompare(b.name));
      return res.status(200).json({ ok: true, stores: out });
    }

    if (action === "customerSnapshot") {
      // Operator-only: returns the customer-facing view for one card (for the preview).
      if (!isOperator) return res.status(200).json({ error: "Store access only." });
      const acct = all.find(a => a.id === body.cardId && String(a.name || "").startsWith("Gift:"));
      if (!acct) return res.status(200).json({ error: "Card not found." });
      const em = acct.name.slice(5);
      const pts = await ensurePoints(em);
      const ctx = (await txns(acct.id, 12)).map(t => ({ ...t, ...resolveStore(t) }));
      return res.status(200).json({ email: em, code: codeFor(acct), cardNumber: cardNumber(acct), balance: await balance(acct.id), points: await balance(pts.id), transactions: ctx });
    }

    if (action === "generateCards") {
      // Admin-only: mint pre-printed, phone-activatable card numbers in the card store.
      if (!isAdmin) return res.status(200).json({ error: "Platform admin only." });
      if (!cardStoreOn()) return res.status(200).json({ error: "Card store not configured. Connect Upstash and set UPSTASH_REDIS_REST_URL / _TOKEN in Vercel." });
      const count = Math.min(Math.max(parseInt(body.count, 10) || 0, 1), 200);
      const made = [];
      for (let i = 0; i < count; i++) {
        let num = "";
        for (let t = 0; t < 6; t++) { num = randCardNumber(); if (!(await rGet("card:" + num))) break; }
        await rSet("card:" + num, { status: "unclaimed", createdAt: Date.now() });
        await redis(["SADD", "cards:all", num]);
        made.push(num);
      }
      return res.status(200).json({ ok: true, count: made.length, cards: made });
    }

    if (action === "listCards") {
      // Admin-only: list pre-printed cards and their activation status.
      if (!isAdmin) return res.status(200).json({ error: "Platform admin only." });
      if (!cardStoreOn()) return res.status(200).json({ error: "Card store not configured." });
      const nums = (await redis(["SMEMBERS", "cards:all"])) || [];
      const cards = [];
      for (const n of nums) {
        const rec = (await rGet("card:" + n)) || {};
        cards.push({ cardNumber: n, status: rec.status || "unknown", phone: rec.phone || null, claimedAt: rec.claimedAt || null });
      }
      cards.sort((a, b) => (a.claimedAt || 0) - (b.claimedAt || 0));
      return res.status(200).json({ ok: true, cards });
    }

    return res.status(200).json({ error: "Unknown action." });
  } catch (e) {
    return res.status(200).json({ error: String((e && e.message) || e).slice(0, 180) });
  }
}
