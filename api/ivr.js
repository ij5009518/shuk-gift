// api/ivr.js — SignalWire phone (IVR) + SMS banking for Shuk Gift.
//
// This lives in the SAME Vercel app as api/gift.js and reuses the EXACT same
// Increase ledger conventions (account naming "Gift:<email>" / "Points:<email>",
// the operating-account exclusion rule, simulated load + ACH pull). Callers have
// no Clerk session, so they authenticate by caller-ID phone OR card number, then
// a 4-digit PIN. After the PIN verifies we mint an HMAC token that is carried in
// the SignalWire action URLs, so money steps stay protected across SignalWire's
// stateless webhook callbacks.
//
// SignalWire is configured to POST this endpoint for both Voice and Messaging.
// Voice requests carry CallSid/From/Digits; SMS requests carry MessageSid/Body.
// We respond with cXML (Twilio-compatible LaML) that SignalWire executes.

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

// ---- Increase (same wrapper as gift.js) ----
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

// Increase account discovery — mirrors gift.js (operating account excludes Gift:/Points:).
async function ctx() {
  const all = (await inc("/accounts?limit=100")).data || [];
  const operating = all.find(a => { const n = String(a.name || ""); return !n.startsWith("Gift:") && !n.startsWith("Points:"); }) || all[0];
  return { all, operating };
}
const findCard = (all, em) => all.find(a => a.name === "Gift:" + em);
const findPoints = (all, em) => all.find(a => a.name === "Points:" + em);
async function findBank(em) {
  try { const d = await inc("/external_accounts?limit=100"); return (d.data || []).find(x => (x.description || "") === "Bank:" + em && (x.status === undefined || x.status === "active")) || null; }
  catch { return null; }
}
// Deterministic 16-digit card number (identical to gift.js) so we can map a typed card -> email.
function cardNumber(acct) {
  const id = String(acct.id || "");
  let h = 0n;
  for (const ch of id) h = (h * 131n + BigInt(ch.charCodeAt(0))) % (10n ** 15n);
  const base = ("9" + h.toString().padStart(15, "0")).slice(0, 15);
  let sum = 0, dbl = true;
  for (let i = base.length - 1; i >= 0; i--) { let d = +base[i]; if (dbl) { d *= 2; if (d > 9) d -= 9; } sum += d; dbl = !dbl; }
  return base + ((10 - (sum % 10)) % 10);
}
function emailForCard(all, num) {
  const digits = String(num || "").replace(/\D/g, "");
  const acct = all.filter(a => String(a.name || "").startsWith("Gift:")).find(a => cardNumber(a) === digits);
  return acct ? acct.name.slice(5) : null;
}

// ---- Auth helpers ----
// PIN hash MUST match api/gift.js setIvr exactly.
const pinHash = (email, pin) => crypto.createHmac("sha256", SECRET).update("pin:" + String(email).toLowerCase() + ":" + String(pin)).digest("hex");
const authToken = (email) => crypto.createHmac("sha256", SECRET).update("ivrauth:" + String(email).toLowerCase()).digest("hex").slice(0, 32);
const checkToken = (email, t) => !!email && !!t && authToken(email) === t;
function e164(p) { let d = String(p || "").replace(/[^\d]/g, ""); if (d.length === 10) d = "1" + d; if (d.length === 11 && d[0] === "1") return "+" + d; return p ? ("+" + d) : ""; }

// ---- Clerk (phone->email index lives on the admin user; PIN lives on the customer) ----
let _clerk = null;
async function clerk() { if (_clerk) return _clerk; const { createClerkClient } = await import("@clerk/backend"); _clerk = createClerkClient({ secretKey: SECRET }); return _clerk; }
async function getUserByEmail(em) { try { const c = await clerk(); const r = await c.users.getUserList({ emailAddress: [em] }); const arr = Array.isArray(r) ? r : (r.data || []); return arr[0] || null; } catch { return null; } }
async function emailForPhone(p) { const u = await getUserByEmail(CONFIG_EMAIL); const idx = (u && u.privateMetadata && u.privateMetadata.phoneIndex) || {}; return idx[e164(p)] || null; }
async function customerMeta(em) { const u = await getUserByEmail(em); return (u && u.privateMetadata && u.privateMetadata.shuk) || {}; }

// ---- cXML helpers ----
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function xml(res, inner) { res.setHeader("Content-Type", "text/xml"); res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response>' + inner + "</Response>"); }
const ACTION = "/api/ivr";
function url(params) {
  const q = Object.entries(params || {}).map(([k, v]) => k + "=" + encodeURIComponent(v)).join("&");
  return ACTION + (q ? "?" + q : "");
}
const say = (t) => "<Say>" + esc(t) + "</Say>";
const hangup = "<Hangup/>";
const redirect = (u) => '<Redirect method="POST">' + esc(u) + "</Redirect>";
function gather(opts, prompt) {
  const a = esc(opts.action);
  return '<Gather input="dtmf"' + (opts.numDigits ? ' numDigits="' + opts.numDigits + '"' : "") + (opts.finishOnKey ? ' finishOnKey="' + opts.finishOnKey + '"' : "") + ' action="' + a + '" method="POST" timeout="8">' + say(prompt) + "</Gather>";
}
const dollars = (c) => (c / 100).toFixed(2);
function moneyWords(c) { const d = Math.floor(c / 100), cc = c % 100; return d + " dollar" + (d === 1 ? "" : "s") + (cc ? " and " + cc + " cent" + (cc === 1 ? "" : "s") : ""); }
function menu(em, t) { return gather({ numDigits: 1, action: url({ step: "menu", e: em, t }) }, "Main menu. Press 1 to hear your balance. Press 2 to add money. Press 0 to hang up."); }

export default async function handler(req, res) {
  if (!IK) return xml(res, say("Service is not configured.") + hangup);

  // Parse SignalWire's form-encoded body + the action URL query string.
  let body = {};
  try {
    if (typeof req.body === "string") body = Object.fromEntries(new URLSearchParams(req.body));
    else if (req.body && typeof req.body === "object") body = req.body;
  } catch {}
  const q = req.query || {};
  const get = (k) => (body[k] !== undefined ? body[k] : q[k]);
  const digits = String(get("Digits") || "").trim();
  const from = String(get("From") || "");
  const isSms = (get("Body") !== undefined) || !!get("MessageSid");
  const step = String(q.step || get("step") || "");

  try {
    // ---------- SMS (balance only) ----------
    if (isSms) {
      res.setHeader("Content-Type", "text/xml");
      const reply = (m) => res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response><Message>' + esc(m) + "</Message></Response>");
      const em = from ? await emailForPhone(from) : null;
      if (!em) return reply("We couldn't find a Shuk Gift account for this number. Add your phone in the app under Account to use text and phone banking.");
      const { all } = await ctx();
      const card = findCard(all, em), pts = findPoints(all, em);
      const bal = card ? await balance(card.id) : 0, p = pts ? await balance(pts.id) : 0;
      return reply("Shuk Gift: your balance is $" + dollars(bal) + " and you have " + p + " points.");
    }

    // ---------- VOICE (IVR) ----------
    if (!step) {
      // Entry: try to identify the caller by their phone number.
      const em = from ? await emailForPhone(from) : null;
      if (em) return xml(res, gather({ numDigits: 4, action: url({ step: "auth", e: em }) }, "Welcome to Shuk Gift. Please enter your 4 digit PIN.") + redirect(url({})));
      return xml(res, gather({ finishOnKey: "#", action: url({ step: "card" }) }, "Welcome to Shuk Gift. We could not match your phone number. Please enter your 16 digit card number, then press pound.") + redirect(url({})));
    }

    if (step === "card") {
      const { all } = await ctx();
      const em = emailForCard(all, digits);
      if (!em) return xml(res, say("We could not find that card.") + redirect(url({})));
      return xml(res, gather({ numDigits: 4, action: url({ step: "auth", e: em }) }, "Please enter your 4 digit PIN."));
    }

    if (step === "auth") {
      const em = String(get("e") || "").toLowerCase();
      const meta = await customerMeta(em);
      if (!meta.pinHash) return xml(res, say("No PIN is set for this account. Please set a PIN in the Shuk Gift app, under Account.") + hangup);
      if (pinHash(em, digits) !== meta.pinHash) return xml(res, gather({ numDigits: 4, action: url({ step: "auth", e: em }) }, "That PIN was incorrect. Please try again. Enter your 4 digit PIN."));
      return xml(res, menu(em, authToken(em)));
    }

    // Everything past auth requires a valid minted token.
    const em = String(get("e") || "").toLowerCase();
    const t = String(get("t") || "");
    if (!checkToken(em, t)) return xml(res, say("Your session has expired.") + redirect(url({})));

    if (step === "menu") {
      if (digits === "1") {
        const { all } = await ctx();
        const card = findCard(all, em), pts = findPoints(all, em);
        const bal = card ? await balance(card.id) : 0, p = pts ? await balance(pts.id) : 0;
        return xml(res, say("Your balance is " + moneyWords(bal) + ". You have " + p + " points.") + menu(em, t));
      }
      if (digits === "2") {
        return xml(res, gather({ numDigits: 1, action: url({ step: "addtype", e: em, t }) }, "To add money: press 1 for a test load, or press 2 to transfer from your linked bank."));
      }
      if (digits === "0") return xml(res, say("Goodbye.") + hangup);
      return xml(res, menu(em, t));
    }

    if (step === "addtype") {
      const ty = digits === "2" ? "ach" : "sim";
      return xml(res, gather({ finishOnKey: "#", action: url({ step: "addgo", e: em, t, ty }) }, "Enter the amount in whole dollars, then press pound."));
    }

    if (step === "addgo") {
      const ty = String(get("ty") || "sim");
      const amt = (parseInt(digits, 10) || 0) * 100;
      if (amt <= 0) return xml(res, say("That is not a valid amount.") + menu(em, t));
      if (amt > 200000) return xml(res, say("The maximum is 2000 dollars per transfer.") + menu(em, t));
      const { all } = await ctx();
      const card = findCard(all, em);
      if (!card) return xml(res, say("We could not find your card.") + hangup);
      if (ty === "ach") {
        const bank = await findBank(em);
        if (!bank) return xml(res, say("You have no linked bank account. Please link a bank in the app first.") + menu(em, t));
        try {
          const tr = await inc("/ach_transfers", "POST", { account_id: card.id, amount: -amt, statement_descriptor: "Shuk Gift", external_account_id: bank.id });
          if (tr && tr.status === "pending_approval" && tr.id) { try { await inc("/ach_transfers/" + tr.id + "/approve", "POST"); } catch {} }
          if (tr && tr.id && /sandbox/.test(IB)) { try { await inc("/simulations/ach_transfers/" + tr.id + "/settle", "POST"); } catch { try { await inc("/simulations/ach_transfers/" + tr.id + "/acknowledge", "POST"); } catch {} } }
        } catch { return xml(res, say("The bank transfer could not be completed right now.") + menu(em, t)); }
      } else {
        await inc("/simulations/interest_payments", "POST", { account_id: card.id, amount: amt });
      }
      const bal = await balance(card.id);
      return xml(res, say("Added " + moneyWords(amt) + ". Your new balance is " + moneyWords(bal) + ".") + menu(em, t));
    }

    return xml(res, say("Sorry, something went wrong.") + redirect(url({})));
  } catch (e) {
    return xml(res, say("Sorry, the system is unavailable right now. Please try again later.") + hangup);
  }
}
