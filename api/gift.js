// Shuk Gift backend. Auth via Clerk session; balances/ledger held as real bank
// accounts (one per customer) with the banking provider. No provider names exposed.
const IB = process.env.INCREASE_BASE_URL || "https://sandbox.increase.com";
const IK = process.env.INCREASE_API_KEY;

function merchantList() {
  return (process.env.MERCHANT_EMAILS || "ij5009518@gmail.com")
    .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
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

async function balance(id) { try { const b = await inc("/accounts/" + id + "/balance"); return cents(b.current_balance); } catch { return 0; } }
async function txns(id, limit) {
  try {
    const d = await inc("/transactions?account_id=" + id + "&limit=" + (limit || 12));
    return (d.data || []).map(t => ({ amount: cents(t.amount), when: when(t.created_at) }));
  } catch { return []; }
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
  let email = null, name = null;
  if (secret) {
    const auth = req.headers.authorization || "";
    const tok = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!tok) return res.status(200).json({ needsAuth: true });
    try {
      const { verifyToken, createClerkClient } = await import("@clerk/backend");
      const claims = await verifyToken(tok, { secretKey: secret });
      const clerk = createClerkClient({ secretKey: secret });
      const u = await clerk.users.getUser(claims.sub);
      email = (u.emailAddresses.find(e => e.id === u.primaryEmailAddressId) || u.emailAddresses[0] || {}).emailAddress || null;
      name = [u.firstName, u.lastName].filter(Boolean).join(" ") || u.username || email;
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

    // ---- Actions ----
    if (action === "bootstrap") {
      if (isMerchant) {
        const cardAccts = all.filter(a => String(a.name || "").startsWith("Gift:"));
        const cards = await Promise.all(cardAccts.map(async a => ({
          id: a.id, email: a.name.slice(5), code: codeFor(a), balance: await balance(a.id),
        })));
        cards.sort((x, y) => y.balance - x.balance);
        const activity = (await txns(opId, 12)).map(t => ({ ...t, who: t.amount > 0 ? "Sale received" : "Transfer out" }));
        const ptsAccts = all.filter(a => String(a.name || "").startsWith("Points:"));
        const pointsIssued = (await Promise.all(ptsAccts.map(a => balance(a.id)))).reduce((x, y) => x + y, 0);
        return res.status(200).json({ role: "merchant", email, name, cards, transactions: activity, posConnected: !!DK, pointsIssued });
      }
      const card = await ensureCard(email);
      const pts = await ensurePoints(email);
      return res.status(200).json({
        role: "customer", email, name, cardId: card.id, code: codeFor(card),
        balance: await balance(card.id), points: await balance(pts.id), transactions: await txns(card.id, 12),
      });
    }

    if (action === "load") {
      const amount = Math.round(Number(body.amount) || 0);
      if (amount <= 0) return res.status(200).json({ error: "Enter a valid amount." });
      if (amount > 200000) return res.status(200).json({ error: "Max $2,000 per load." });
      const card = await ensureCard(email);
      await inc("/simulations/interest_payments", "POST", { account_id: card.id, amount });
      return res.status(200).json({ ok: true, balance: await balance(card.id) });
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
      if (!isMerchant) return res.status(200).json({ error: "Only merchants can charge cards." });
      const cardId = body.cardId;
      const items = Array.isArray(body.items) ? body.items : [];
      if (!cardId) return res.status(200).json({ error: "Pick a card." });
      if (!items.length) return res.status(200).json({ error: "Add at least one item." });
      let subtotal = 0, taxAmount = 0;
      const invItems = items.map(it => {
        const q = Number(it.quantity) || 1;
        const line = Math.round(Number(it.price) * q * 100) / 100;
        subtotal += line;
        if (it.taxable) taxAmount += Math.round(line * (Number(it.taxRate) || 0)) / 100;
        return { productCode: String(it.code), quantity: q, unitPrice: Number(it.price), subtotal: line, isTaxable: !!it.taxable, discountAmount: 0 };
      });
      subtotal = Math.round(subtotal * 100) / 100;
      taxAmount = Math.round(taxAmount * 100) / 100;
      const total = Math.round((subtotal + taxAmount) * 100) / 100;
      const totalCents = Math.round(total * 100);
      const bal = await balance(cardId);
      if (totalCents > bal) return res.status(200).json({ error: "Card balance is only $" + (bal / 100).toFixed(2) + "." });

      // 1) Deduct the gift balance in our ledger
      const t = await inc("/account_transfers", "POST", { account_id: cardId, destination_account_id: opId, amount: totalCents, description: "Shuk Gift purchase" });
      if (t && t.status === "pending_approval" && t.id) { try { await inc("/account_transfers/" + t.id + "/approve", "POST"); } catch {} }

      // 2) Record the sale in the store's POS (best effort)
      let posInvoice = null, posError = null;
      if (DK) {
        try {
          const custId = await posCustomerId();
          if (!custId) throw new Error("No POS customer available.");
          const now = new Date().toISOString();
          const ext = "SG" + Date.now().toString().slice(-16);
          await pos("/invoices", "POST", {
            externalInvoiceId: ext, invoiceDate: now, orderMethod: "Pickup", taxAmount, taxableAmount: subtotal, customerId: custId,
            items: invItems,
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
          pointsAwarded = Math.floor(total);
          if (pointsAwarded > 0) {
            const pts = await ensurePoints(em);
            await inc("/simulations/interest_payments", "POST", { account_id: pts.id, amount: pointsAwarded });
          }
        }
      } catch {}

      return res.status(200).json({ ok: true, balance: await balance(cardId), total, posInvoice, posError, pointsAwarded });
    }

    return res.status(200).json({ error: "Unknown action." });
  } catch (e) {
    return res.status(200).json({ error: String((e && e.message) || e).slice(0, 180) });
  }
}
