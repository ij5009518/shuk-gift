// api/ivr.js — SignalWire phone (IVR) + SMS banking for Shuk Gift.
//
// Same Vercel app as api/gift.js; reuses the same Increase ledger conventions
// (Gift:<slug> / Points:<slug> accounts, operating-account exclusion, simulated
// load + ACH pull). Two kinds of caller identity, unified on a "slug":
//   • Phone-native pre-printed card  -> slug = the 16-digit card number; its
//     PIN / phone / linked-bank live in Upstash (the "card store"). A blank card
//     is activated entirely by phone: enter number, set a PIN, link a bank.
//   • Web-registered customer        -> slug = email; PIN/phone live in Clerk
//     metadata (set in the app's Account page). Kept as a fallback.
//
// After the PIN verifies we mint an HMAC token carried in the action URLs so the
// money steps stay protected across SignalWire's stateless callbacks. Sensitive
// bank digits are never placed in a URL — mid-enrollment they live in a short
// scratch key in the card store keyed by the SignalWire CallSid.

import crypto from "crypto";

const IB = process.env.INCREASE_BASE_URL || "https://sandbox.increase.com";
const IK = process.env.INCREASE_API_KEY;
const SECRET = process.env.CLERK_SECRET_KEY || "shuk-ivr";

function emailList(v) { return String(v || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean); }
function adminList() {
  const a = emailList(process.env.ADMIN_EMAILS);
  if (a.length) return a;
  const m = emailList(process.env.MERCHANT_EMAILS);
  return m.length ? m : ["ij5009518@gmail.com"];
}
const CONFIG_EMAIL = adminList()[0];

// ---- Increase ----
async function inc(path, method = "GET", body) {
  const r = await fetch(IB + path, {
    method,
    headers: { Authorization: "Bearer " + IK, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!r.ok) { const e = new Error((data && (data.title || data.detail || data.message)) || ("Provider error " + r.status)); e.status = r.status; throw e; }
  return data;
}
const numCents = (a) => (typeof a === "number" ? a : 0);
async function balance(id) { try { const b = await inc("/accounts/" + id + "/balance"); return numCents(b.current_balance); } catch { return 0; } }
async function ctx() {
  const all = (await inc("/accounts?limit=100")).data || [];
  const operating = all.find(a => { const n = String(a.name || ""); return !n.startsWith("Gift:") && !n.startsWith("Points:"); }) || all[0];
  return { all, operating };
}
// Find-or-create the Gift account for a slug (email or card number).
async function ensureGift(slug, all, operating) {
  let a = all.find(x => x.name === "Gift:" + slug);
  if (!a) { a = await inc("/accounts", "POST", { name: "Gift:" + slug, entity_id: operating.entity_id, program_id: operating.program_id }); all.push(a); }
  return a;
}
const findPoints = (all, slug) => all.find(a => a.name === "Points:" + slug);
async function findBank(slug) {
  try { const d = await inc("/external_accounts?limit=100"); return (d.data || []).find(x => (x.description || "") === "Bank:" + slug && (x.status === undefined || x.status === "active")) || null; }
  catch { return null; }
}
// Deterministic card number for web customers (matches gift.js) — used only for the
// Clerk fallback so a web customer can also identify by card over the phone.
function derivedCardNumber(acct) {
  const id = String(acct.id || "");
  let h = 0n;
  for (const ch of id) h = (h * 131n + BigInt(ch.charCodeAt(0))) % (10n ** 15n);
  const base = ("9" + h.toString().padStart(15, "0")).slice(0, 15);
  let sum = 0, dbl = true;
  for (let i = base.length - 1; i >= 0; i--) { let d = +base[i]; if (dbl) { d *= 2; if (d > 9) d -= 9; } sum += d; dbl = !dbl; }
  return base + ((10 - (sum % 10)) % 10);
}
function emailForDerivedCard(all, num) {
  const digits = String(num || "").replace(/\D/g, "");
  const acct = all.filter(a => String(a.name || "").startsWith("Gift:")).find(a => derivedCardNumber(a) === digits);
  return acct ? acct.name.slice(5) : null;
}

// ---- Card store (Upstash Redis REST) ----
const RURL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const RTOK = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const cardStoreOn = () => !!(RURL && RTOK);
async function redis(cmd) {
  const r = await fetch(RURL, { method: "POST", headers: { Authorization: "Bearer " + RTOK, "Content-Type": "application/json" }, body: JSON.stringify(cmd) });
  const d = await r.json();
  if (d && d.error) throw new Error(d.error);
  return d ? d.result : null;
}
const rGet = async (k) => { try { const v = await redis(["GET", k]); return v ? JSON.parse(v) : null; } catch { return null; } };
const rSet = (k, v) => redis(["SET", k, JSON.stringify(v)]);
const rSetEx = (k, v, ttl) => redis(["SET", k, JSON.stringify(v), "EX", String(ttl)]);
const rDel = (k) => redis(["DEL", k]);
async function cardRec(num) { return cardStoreOn() ? await rGet("card:" + num) : null; }
async function cardPhoneLookup(phoneE164) { if (!cardStoreOn()) return null; try { const v = await redis(["GET", "cardphone:" + phoneE164]); return v || null; } catch { return null; } }

// ---- Clerk (web-customer fallback: PIN + phone index live in Clerk metadata) ----
let _clerk = null;
async function clerk() { if (_clerk) return _clerk; const { createClerkClient } = await import("@clerk/backend"); _clerk = createClerkClient({ secretKey: SECRET }); return _clerk; }
async function getUserByEmail(em) { try { const c = await clerk(); const r = await c.users.getUserList({ emailAddress: [em] }); const arr = Array.isArray(r) ? r : (r.data || []); return arr[0] || null; } catch { return null; } }
async function emailForPhone(p) { const u = await getUserByEmail(CONFIG_EMAIL); const idx = (u && u.privateMetadata && u.privateMetadata.phoneIndex) || {}; return idx[p] || null; }
async function clerkMeta(em) { const u = await getUserByEmail(em); return (u && u.privateMetadata && u.privateMetadata.shuk) || {}; }

// ---- Auth helpers ----
const pinHash = (key, pin) => crypto.createHmac("sha256", SECRET).update("pin:" + String(key).toLowerCase() + ":" + String(pin)).digest("hex");
const authToken = (key) => crypto.createHmac("sha256", SECRET).update("ivrauth:" + String(key).toLowerCase()).digest("hex").slice(0, 32);
const checkToken = (key, t) => !!key && !!t && authToken(key) === t;
function e164(p) { let d = String(p || "").replace(/[^\d]/g, ""); if (d.length === 10) d = "1" + d; if (d.length === 11 && d[0] === "1") return "+" + d; return p ? ("+" + d) : ""; }

// ---- cXML helpers ----
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function xml(res, inner) { res.setHeader("Content-Type", "text/xml"); res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response>' + inner + "</Response>"); }
const ACTION = "/api/ivr";
function url(params) { const q = Object.entries(params || {}).map(([k, v]) => k + "=" + encodeURIComponent(v)).join("&"); return ACTION + (q ? "?" + q : ""); }
const say = (t) => "<Say>" + esc(t) + "</Say>";
const hangup = "<Hangup/>";
const redirect = (u) => '<Redirect method="POST">' + esc(u) + "</Redirect>";
function gather(opts, prompt) {
  const a = esc(opts.action);
  return '<Gather input="dtmf"' + (opts.numDigits ? ' numDigits="' + opts.numDigits + '"' : "") + (opts.finishOnKey ? ' finishOnKey="' + opts.finishOnKey + '"' : "") + ' action="' + a + '" method="POST" timeout="' + (opts.timeout || 8) + '">' + say(prompt) + "</Gather>";
}
const dollars = (c) => (c / 100).toFixed(2);
function moneyWords(c) { const d = Math.floor(c / 100), cc = c % 100; return d + " dollar" + (d === 1 ? "" : "s") + (cc ? " and " + cc + " cent" + (cc === 1 ? "" : "s") : ""); }
// id = { slug, src }  (src: "card" | "clerk"); token signs the slug.
function menu(slug, t) { return gather({ numDigits: 1, action: url({ step: "menu", k: slug, t }) }, "Main menu. Press 1 to hear your balance. Press 2 to add money. Press 3 to link a bank account. Press 0 to hang up."); }

export default async function handler(req, res) {
  if (!IK) return xml(res, say("Service is not configured.") + hangup);

  let body = {};
  try {
    if (typeof req.body === "string") body = Object.fromEntries(new URLSearchParams(req.body));
    else if (req.body && typeof req.body === "object") body = req.body;
  } catch {}
  const q = req.query || {};
  const get = (k) => (body[k] !== undefined ? body[k] : q[k]);
  const digits = String(get("Digits") || "").trim();
  const from = e164(String(get("From") || ""));
  const callSid = String(get("CallSid") || get("MessageSid") || "");
  const isSms = (get("Body") !== undefined) || !!get("MessageSid");
  const step = String(q.step || get("step") || "");

  try {
    // ---------- SMS (balance only) ----------
    if (isSms) {
      res.setHeader("Content-Type", "text/xml");
      const reply = (m) => res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response><Message>' + esc(m) + "</Message></Response>");
      let slug = await cardPhoneLookup(from);
      if (!slug && from) slug = await emailForPhone(from);
      if (!slug) return reply("We couldn't find a Shuk Gift card for this number. Call us to activate your card, or add your phone in the app under Account.");
      const { all, operating } = await ctx();
      const card = await ensureGift(slug, all, operating);
      const pts = findPoints(all, slug);
      const bal = await balance(card.id), p = pts ? await balance(pts.id) : 0;
      return reply("Shuk Gift: your balance is $" + dollars(bal) + " and you have " + p + " points.");
    }

    // ---------- VOICE ----------
    if (!step) {
      // Identify by caller ID: card store first, then web-customer index.
      let slug = await cardPhoneLookup(from);
      let src = slug ? "card" : "";
      if (!slug && from) { const em = await emailForPhone(from); if (em) { slug = em; src = "clerk"; } }
      if (slug) return xml(res, gather({ numDigits: 4, action: url({ step: "auth", k: slug, s: src }) }, "Welcome to Shuk Gift. Please enter your 4 digit PIN.") + redirect(url({})));
      return xml(res, gather({ finishOnKey: "#", action: url({ step: "card" }) }, "Welcome to Shuk Gift. Please enter your 16 digit card number, then press pound.") + redirect(url({})));
    }

    if (step === "card") {
      const num = digits.replace(/\D/g, "");
      const rec = await cardRec(num);
      if (rec) {
        if (rec.status === "unclaimed") {
          // Activate this blank card by phone: set a PIN.
          return xml(res, gather({ numDigits: 4, action: url({ step: "setpin", k: num }) }, "Welcome. This card is not active yet. Let's set it up. Create a 4 digit PIN."));
        }
        return xml(res, gather({ numDigits: 4, action: url({ step: "auth", k: num, s: "card" }) }, "Please enter your 4 digit PIN."));
      }
      // Web-customer fallback (card number derived from their account).
      const { all } = await ctx();
      const em = emailForDerivedCard(all, num);
      if (em) return xml(res, gather({ numDigits: 4, action: url({ step: "auth", k: em, s: "clerk" }) }, "Please enter your 4 digit PIN."));
      return xml(res, say("We could not find that card.") + redirect(url({})));
    }

    // ----- Activation: set + confirm PIN (only the PIN's HMAC travels in the URL) -----
    if (step === "setpin") {
      const num = String(get("k") || "");
      if (!/^\d{4}$/.test(digits)) return xml(res, gather({ numDigits: 4, action: url({ step: "setpin", k: num }) }, "Please enter a 4 digit PIN."));
      const h = pinHash(num, digits);
      return xml(res, gather({ numDigits: 4, action: url({ step: "setpin2", k: num, h }) }, "Please enter the same 4 digit PIN again to confirm."));
    }
    if (step === "setpin2") {
      const num = String(get("k") || "");
      const h = String(get("h") || "");
      if (pinHash(num, digits) !== h) return xml(res, gather({ numDigits: 4, action: url({ step: "setpin", k: num }) }, "Those PINs did not match. Let's try again. Create a 4 digit PIN."));
      // Persist activation in the card store and create the ledger account.
      const { all, operating } = await ctx();
      await ensureGift(num, all, operating);
      const rec = (await cardRec(num)) || {};
      rec.status = "active"; rec.pinHash = h; rec.claimedAt = Date.now();
      if (from) { rec.phone = from; try { await redis(["SET", "cardphone:" + from, num]); } catch {} }
      await rSet("card:" + num, rec);
      const t = authToken(num);
      // Bank linking by keypad (the chosen flow). Skippable with # for no digits.
      return xml(res, say("Your PIN is set.") + gather({ finishOnKey: "#", action: url({ step: "bankrt", k: num, t }) }, "Now let's link your bank so you can add money. Enter your 9 digit bank routing number, then press pound. Or just press pound to skip."));
    }

    // Everything below requires a valid minted token.
    const slug = String(get("k") || "");
    const tok = String(get("t") || "");

    // ----- Bank linking by keypad (routing then account; digits kept in a call-scoped scratch key, never the URL) -----
    if (step === "bankrt") {
      if (!checkToken(slug, tok)) return xml(res, say("Your session expired.") + redirect(url({})));
      const rt = digits.replace(/\D/g, "");
      if (!rt) return xml(res, say("Skipping bank setup. You can link a bank later from the menu.") + menu(slug, tok));
      if (rt.length !== 9) return xml(res, gather({ finishOnKey: "#", action: url({ step: "bankrt", k: slug, t: tok }) }, "That routing number was not 9 digits. Please enter your 9 digit routing number, then press pound. Or press pound to skip."));
      if (callSid) { try { await rSetEx("pend:" + callSid, { rt }, 600); } catch {} }
      return xml(res, gather({ finishOnKey: "#", action: url({ step: "bankacct", k: slug, t: tok }) }, "Now enter your bank account number, then press pound."));
    }
    if (step === "bankacct") {
      if (!checkToken(slug, tok)) return xml(res, say("Your session expired.") + redirect(url({})));
      const acct = digits.replace(/\D/g, "");
      const pend = callSid ? await rGet("pend:" + callSid) : null;
      const rt = pend && pend.rt;
      if (!rt) return xml(res, say("Sorry, we lost the routing number.") + gather({ finishOnKey: "#", action: url({ step: "bankrt", k: slug, t: tok }) }, "Let's try again. Enter your 9 digit routing number, then press pound."));
      if (acct.length < 4) return xml(res, gather({ finishOnKey: "#", action: url({ step: "bankacct", k: slug, t: tok }) }, "That account number was too short. Please enter your bank account number, then press pound."));
      try {
        const ext = await inc("/external_accounts", "POST", { routing_number: rt, account_number: acct, funding: "checking", description: "Bank:" + slug });
        if (cardStoreOn()) { const rec = (await cardRec(slug)) || {}; rec.bankId = ext.id; rec.bankLast4 = acct.slice(-4); await rSet("card:" + slug, rec); }
      } catch { if (callSid) { try { await rDel("pend:" + callSid); } catch {} } return xml(res, say("We could not link that bank account.") + menu(slug, tok)); }
      if (callSid) { try { await rDel("pend:" + callSid); } catch {} }
      return xml(res, say("Your bank is linked. You're all set.") + menu(slug, tok));
    }

    // ----- Authenticated zone -----
    if (step === "auth") {
      const src = String(get("s") || "card");
      let stored = "";
      if (src === "card") { const rec = await cardRec(slug); stored = rec && rec.pinHash; }
      else { const m = await clerkMeta(slug); stored = m && m.pinHash; }
      if (!stored) return xml(res, say("No PIN is set for this card. Please set one by calling and entering your card number, or in the app.") + hangup);
      if (pinHash(slug, digits) !== stored) return xml(res, gather({ numDigits: 4, action: url({ step: "auth", k: slug, s: src }) }, "That PIN was incorrect. Please try again. Enter your 4 digit PIN."));
      return xml(res, menu(slug, authToken(slug)));
    }

    if (!checkToken(slug, tok)) return xml(res, say("Your session has expired.") + redirect(url({})));

    if (step === "menu") {
      if (digits === "1") {
        const { all, operating } = await ctx();
        const card = await ensureGift(slug, all, operating);
        const pts = findPoints(all, slug);
        const bal = await balance(card.id), p = pts ? await balance(pts.id) : 0;
        return xml(res, say("Your balance is " + moneyWords(bal) + ". You have " + p + " points.") + menu(slug, tok));
      }
      if (digits === "2") return xml(res, gather({ numDigits: 1, action: url({ step: "addtype", k: slug, t: tok }) }, "To add money: press 1 for a test load, or press 2 to transfer from your linked bank."));
      if (digits === "3") return xml(res, gather({ finishOnKey: "#", action: url({ step: "bankrt", k: slug, t: tok }) }, "Enter your 9 digit bank routing number, then press pound. Or press pound to cancel."));
      if (digits === "0") return xml(res, say("Goodbye.") + hangup);
      return xml(res, menu(slug, tok));
    }

    if (step === "addtype") {
      const ty = digits === "2" ? "ach" : "sim";
      return xml(res, gather({ finishOnKey: "#", action: url({ step: "addgo", k: slug, t: tok, ty }) }, "Enter the amount in whole dollars, then press pound."));
    }

    if (step === "addgo") {
      const ty = String(get("ty") || "sim");
      const amt = (parseInt(digits, 10) || 0) * 100;
      if (amt <= 0) return xml(res, say("That is not a valid amount.") + menu(slug, tok));
      if (amt > 200000) return xml(res, say("The maximum is 2000 dollars per transfer.") + menu(slug, tok));
      const { all, operating } = await ctx();
      const card = await ensureGift(slug, all, operating);
      if (ty === "ach") {
        const bank = await findBank(slug);
        if (!bank) return xml(res, say("You have no linked bank. Press 3 at the menu to link one first.") + menu(slug, tok));
        try {
          const tr = await inc("/ach_transfers", "POST", { account_id: card.id, amount: -amt, statement_descriptor: "Shuk Gift", external_account_id: bank.id });
          if (tr && tr.status === "pending_approval" && tr.id) { try { await inc("/ach_transfers/" + tr.id + "/approve", "POST"); } catch {} }
          if (tr && tr.id && /sandbox/.test(IB)) { try { await inc("/simulations/ach_transfers/" + tr.id + "/settle", "POST"); } catch { try { await inc("/simulations/ach_transfers/" + tr.id + "/acknowledge", "POST"); } catch {} } }
        } catch { return xml(res, say("The bank transfer could not be completed right now.") + menu(slug, tok)); }
      } else {
        await inc("/simulations/interest_payments", "POST", { account_id: card.id, amount: amt });
      }
      const bal = await balance(card.id);
      return xml(res, say("Added " + moneyWords(amt) + ". Your new balance is " + moneyWords(bal) + ".") + menu(slug, tok));
    }

    return xml(res, say("Sorry, something went wrong.") + redirect(url({})));
  } catch (e) {
    return xml(res, say("Sorry, the system is unavailable right now. Please try again later.") + hangup);
  }
}
