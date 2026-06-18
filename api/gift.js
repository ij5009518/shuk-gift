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
    const operating = all.find(a => !String(a.name || "").startsWith("Gift:")) || all[0];
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

    // ---- Actions ----
    if (action === "bootstrap") {
      if (isMerchant) {
        const cardAccts = all.filter(a => String(a.name || "").startsWith("Gift:"));
        const cards = await Promise.all(cardAccts.map(async a => ({
          id: a.id, email: a.name.slice(5), code: codeFor(a), balance: await balance(a.id),
        })));
        cards.sort((x, y) => y.balance - x.balance);
        const activity = (await txns(opId, 12)).map(t => ({ ...t, who: t.amount > 0 ? "Sale received" : "Transfer out" }));
        return res.status(200).json({ role: "merchant", email, name, cards, transactions: activity });
      }
      const card = await ensureCard(email);
      return res.status(200).json({
        role: "customer", email, name, cardId: card.id, code: codeFor(card),
        balance: await balance(card.id), transactions: await txns(card.id, 12),
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

    return res.status(200).json({ error: "Unknown action." });
  } catch (e) {
    return res.status(200).json({ error: String((e && e.message) || e).slice(0, 180) });
  }
}
