// Shuk Gift backend. Auth via Clerk session; balances/ledger held as real bank
// accounts (one per customer) with the banking provider. No provider names exposed.
const IB = process.env.INCREASE_BASE_URL || "https://sandbox.increase.com";
const IK = process.env.INCREASE_API_KEY;

function merchantList() {
  return (process.env.MERCHANT_EMAILS || "ij5009518@gmail.com")
    .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
}

// ---- Program configuration (admin-editable, stored in Clerk metadata) ----
// The canonical store admin's Clerk user holds the program config so every
// request (customer or merchant) reads the same settings.
const CONFIG_EMAIL = merchantList()[0];
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
async function loadProgram(clerk, knownUser) {
  let holder = null;
  if (knownUser && (knownUser.emailAddresses || []).some(e => (e.emailAddress || "").toLowerCase() === CONFIG_EMAIL)) holder = knownUser;
  if (!holder && clerk) {
    try { const r = await clerk.users.getUserList({ emailAddress: [CONFIG_EMAIL] }); const arr = Array.isArray(r) ? r : (r.data || []); holder = arr[0] || null; } catch {}
  }
  const saved = (holder && holder.privateMetadata && holder.privateMetadata.program) || {};
  return { holder, program: cleanProgram({ ...PROGRAM_DEFAULTS, ...saved }) };
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
  const isMerchant = merchantList().includes(email.toLowerCase());

  try {
    // ---- Program context: existing accounts give us entity + program + operating acct ----
    const all = (await inc("/accounts?limit=100")).data || [];
    const operating = all.find(a => { const n = String(a.name || ""); return !n.startsWith("Gift:") && !n.startsWith("Points:"); }) || all[0];
    if (!operating) return res.status(200).json({ error: "No operating account found." });
    const { entity_id, program_id, id: opId } = operating;

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

    // ---- Program config + per-customer reward flags ----
    const { holder: cfgHolder, program } = await loadProgram(clerk, meUser);
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
      if (isMerchant) {
        const cardAccts = all.filter(a => String(a.name || "").startsWith("Gift:"));
        const cards = await Promise.all(cardAccts.map(async a => ({
          id: a.id, email: a.name.slice(5), code: codeFor(a), cardNumber: cardNumber(a), balance: await balance(a.id),
        })));
        cards.sort((x, y) => y.balance - x.balance);
        // Per-customer transaction report, built from each gift card's ledger history.
        // On a card: a negative entry is a redemption (sale), a positive entry is a load.
        const lists = await Promise.all(cardAccts.map(async a => {
          const list = await txns(a.id, 25);
          return list.map(t => ({ email: a.name.slice(5), code: codeFor(a), amount: t.amount, when: t.when, at: t.at, who: t.amount < 0 ? "Sale" : "Load" }));
        }));
        const transactions = lists.flat().sort((x, y) => new Date(y.at || 0) - new Date(x.at || 0)).slice(0, 60);
        const ptsAccts = all.filter(a => String(a.name || "").startsWith("Points:"));
        const pointsIssued = (await Promise.all(ptsAccts.map(a => balance(a.id)))).reduce((x, y) => x + y, 0);
        return res.status(200).json({ role: "merchant", email, name, cards, transactions, posConnected: !!DK, pointsIssued, program });
      }
      const card = await ensureCard(email);
      const pts = await ensurePoints(email);
      // One-time signup bonus in points (if configured and not yet granted).
      if (program.signupBonusPoints > 0 && !myFlags.signupBonus) {
        try { await inc("/simulations/interest_payments", "POST", { account_id: pts.id, amount: program.signupBonusPoints }); await setMyFlag({ signupBonus: true }); } catch {}
      }
      return res.status(200).json({
        role: "customer", email, name, cardId: card.id, code: codeFor(card), cardNumber: cardNumber(card),
        balance: await balance(card.id), points: await balance(pts.id), transactions: await txns(card.id, 12),
        program, firstLoadBonusUsed: !!myFlags.firstLoadBonus,
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
      const b = await findBank(email);
      return res.status(200).json({ linked: !!b, last4: b ? String(b.account_number || "").slice(-4) : null });
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
      if (!isMerchant) return res.status(200).json({ error: "Only merchants can charge cards." });
      const amount = Math.round(Number(body.amount) || 0);
      const cardId = body.cardId;
      if (!cardId) return res.status(200).json({ error: "Pick a card." });
      if (amount <= 0) return res.status(200).json({ error: "Enter a sale amount." });
      const bal = await balance(cardId);
      if (amount > bal) return res.status(200).json({ error: "Card balance is only $" + (bal / 100).toFixed(2) + "." });
      const t = await inc("/account_transfers", "POST", {
        account_id: cardId, destination_account_id: opId, amount, description: "Shuk purchase",
      });
      if (t && t.status === "pending_approval" && t.id) {
        try { await inc("/account_transfers/" + t.id + "/approve", "POST"); } catch {}
      }
      return res.status(200).json({ ok: true, balance: await balance(cardId) });
    }

    if (action === "issueCard") {
      if (!isMerchant) return res.status(200).json({ error: "Merchants only." });
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
      if (!isMerchant) return res.status(200).json({ error: "Merchants only." });
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
      if (!isMerchant) return res.status(200).json({ error: "Only merchants can charge cards." });
      const cardId = body.cardId;
      const amountCents = Math.round(Number(body.amount) || 0);
      if (!cardId) return res.status(200).json({ error: "Pick a customer." });
      if (amountCents <= 0) return res.status(200).json({ error: "Enter a sale amount." });
      const bal = await balance(cardId);
      if (amountCents > bal) return res.status(200).json({ error: "Card balance is only $" + (bal / 100).toFixed(2) + "." });
      const total = amountCents / 100;

      // 1) Deduct the gift balance in our ledger
      const t = await inc("/account_transfers", "POST", { account_id: cardId, destination_account_id: opId, amount: amountCents, description: "Shuk Gift purchase" });
      if (t && t.status === "pending_approval" && t.id) { try { await inc("/account_transfers/" + t.id + "/approve", "POST"); } catch {} }

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
          pointsAwarded = Math.floor(total * program.rewardsPercent);
          if (pointsAwarded > 0) {
            const pts = await ensurePoints(em);
            await inc("/simulations/interest_payments", "POST", { account_id: pts.id, amount: pointsAwarded });
          }
        }
      } catch {}

      return res.status(200).json({ ok: true, balance: await balance(cardId), total, posInvoice, posError, pointsAwarded });
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
      if (!isMerchant) return res.status(200).json({ error: "Merchants only." });
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

    if (action === "customerSnapshot") {
      // Merchant-only: returns the customer-facing view for one card (for the preview).
      if (!isMerchant) return res.status(200).json({ error: "Merchants only." });
      const acct = all.find(a => a.id === body.cardId && String(a.name || "").startsWith("Gift:"));
      if (!acct) return res.status(200).json({ error: "Card not found." });
      const em = acct.name.slice(5);
      const pts = await ensurePoints(em);
      return res.status(200).json({ email: em, code: codeFor(acct), cardNumber: cardNumber(acct), balance: await balance(acct.id), points: await balance(pts.id), transactions: await txns(acct.id, 12) });
    }

    return res.status(200).json({ error: "Unknown action." });
  } catch (e) {
    return res.status(200).json({ error: String((e && e.message) || e).slice(0, 180) });
  }
}
