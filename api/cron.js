// Vercel Cron endpoint: processes customer auto top-up rules.
// Scheduled daily in vercel.json. For each customer gift card it:
//   - fires a low-balance reload if the balance has dropped below the threshold, or
//   - fires a scheduled (weekly/monthly) reload when it comes due.
// Rules live in each customer's Clerk private metadata under shuk.autoReload and are
// the same shape the in-app /api/gift setAutoReload action writes.
//
// Security: invoked by Vercel Cron (which sends `Authorization: Bearer <CRON_SECRET>`
// when CRON_SECRET is set) or manually with `?key=<CRON_SECRET>`.

const IK = process.env.INCREASE_API_KEY;
const IB = process.env.INCREASE_BASE_URL || "https://sandbox.increase.com";

async function inc(path, method = "GET", body) {
  const r = await fetch(IB + path, {
    method,
    headers: { Authorization: "Bearer " + IK, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!r.ok) { const e = new Error((data && (data.title || data.detail)) || ("Provider error " + r.status)); e.data = data; throw e; }
  return data;
}
const cents = v => (typeof v === "number" ? v : parseInt(v || "0", 10)) || 0;
async function balance(id) { try { const b = await inc("/accounts/" + id + "/balance"); return cents(b.current_balance); } catch { return 0; } }
async function findBank(em) {
  try {
    const d = await inc("/external_accounts?limit=100");
    return (d.data || []).find(x => (x.description || "") === "Bank:" + em && (x.status === undefined || x.status === "active")) || null;
  } catch { return null; }
}
function nextRunFrom(mode, from) {
  const d = new Date(from || Date.now());
  if (mode === "weekly") { d.setDate(d.getDate() + 7); return d.getTime(); }
  if (mode === "monthly") { d.setMonth(d.getMonth() + 1); return d.getTime(); }
  return 0;
}
async function achPull(cardId, bankId, amount) {
  let tr;
  try { tr = await inc("/ach_transfers", "POST", { account_id: cardId, amount: -amount, statement_descriptor: "Shuk Auto", external_account_id: bankId }); }
  catch { return { ok: false }; }
  if (tr && tr.status === "pending_approval" && tr.id) { try { await inc("/ach_transfers/" + tr.id + "/approve", "POST"); } catch {} }
  if (tr && tr.id && /sandbox/.test(IB)) {
    try { await inc("/simulations/ach_transfers/" + tr.id + "/settle", "POST"); }
    catch { try { await inc("/simulations/ach_transfers/" + tr.id + "/acknowledge", "POST"); } catch {} }
  }
  return { ok: true };
}

export default async function handler(req, res) {
  const SECRET = process.env.CRON_SECRET;
  const auth = req.headers.authorization || "";
  const byBearer = SECRET && auth === "Bearer " + SECRET;
  const byQuery = SECRET && (req.query && req.query.key) === SECRET;
  const byVercel = !!req.headers["x-vercel-cron"];
  if (!(byBearer || byQuery || byVercel)) return res.status(401).json({ error: "Unauthorized." });
  if (!IK) return res.status(200).json({ error: "Increase not configured." });
  const secret = process.env.CLERK_SECRET_KEY;
  if (!secret) return res.status(200).json({ error: "Clerk not configured." });

  const { createClerkClient } = await import("@clerk/backend");
  const clerk = createClerkClient({ secretKey: secret });
  const now = Date.now();
  const out = { checked: 0, reloaded: 0, items: [] };

  try {
    const all = (await inc("/accounts?limit=100")).data || [];
    const cards = all.filter(a => String(a.name || "").startsWith("Gift:"));
    for (const a of cards) {
      const email = a.name.slice(5);
      let user = null;
      try { const r = await clerk.users.getUserList({ emailAddress: [email] }); const arr = Array.isArray(r) ? r : (r.data || []); user = arr[0] || null; } catch {}
      if (!user) continue;
      const cfg = (user.privateMetadata && user.privateMetadata.shuk && user.privateMetadata.shuk.autoReload) || null;
      if (!cfg || !cfg.enabled || !(cfg.amountCents > 0)) continue;
      out.checked++;
      if (cfg.lastRun && now - cfg.lastRun < 60000) continue;
      const mode = ["low", "weekly", "monthly"].includes(cfg.mode) ? cfg.mode : "low";
      let due = false, advance = false;
      if (mode === "low") { if ((await balance(a.id)) < (cfg.thresholdCents || 0)) due = true; }
      else if (!cfg.nextRun || now >= cfg.nextRun) { due = true; advance = true; }
      if (!due) continue;
      const bank = await findBank(email);
      if (!bank) continue;
      const r = await achPull(a.id, bank.id, cfg.amountCents);
      if (!r.ok) continue;
      const patch = { lastRun: now };
      if (advance) patch.nextRun = nextRunFrom(mode, now);
      try {
        const shuk = (user.privateMetadata && user.privateMetadata.shuk) || {};
        await clerk.users.updateUserMetadata(user.id, { privateMetadata: { shuk: { ...shuk, autoReload: { ...(shuk.autoReload || {}), ...patch } } } });
      } catch {}
      out.reloaded++;
      out.items.push({ email, mode, amount: cfg.amountCents });
    }
  } catch (e) {
    return res.status(200).json({ error: String((e && e.message) || e), ...out });
  }
  return res.status(200).json({ ok: true, ...out });
}
