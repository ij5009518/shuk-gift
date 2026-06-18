// Vercel serverless function: talks to Increase using a server-side API key.
// The key (secret) lives only in the INCREASE_API_KEY env var, never in the browser.
// Defaults to the Sandbox base URL; set INCREASE_BASE_URL to switch.
export default async function handler(req, res) {
  const key = process.env.INCREASE_API_KEY;
  if (!key) return res.status(200).json({ needsKey: true });

  const base = process.env.INCREASE_BASE_URL || "https://sandbox.increase.com";
  let body = {};
  try { body = typeof req.body === "object" && req.body ? req.body : JSON.parse(req.body || "{}"); } catch {}
  const action = body.action || "status";
  const h = { Authorization: "Bearer " + key, "Content-Type": "application/json" };

  try {
    if (action === "status") {
      // Prove the connection by listing accounts; report the first account + its balance.
      const r = await fetch(base + "/accounts?limit=1", { headers: h });
      if (!r.ok) return res.status(200).json({ connected: false, error: `status ${r.status}` });
      const data = await r.json();
      const acct = data && data.data && data.data[0];
      let balance = null;
      if (acct && acct.id) {
        const br = await fetch(base + "/accounts/" + acct.id + "/balance", { headers: h }).catch(() => null);
        if (br && br.ok) { const b = await br.json(); balance = (b && (b.current_balance ?? b.available_balance)) ?? null; }
      }
      return res.status(200).json({ connected: true, accountId: acct ? acct.id : null, accountName: acct ? acct.name : null, balance });
    }

    if (action === "load") {
      // In production this creates an ACH debit pulling from the customer's linked bank
      // into your Increase account. Left as an acknowledged stub for the sandbox demo,
      // since a real debit requires a verified External Account first.
      return res.status(200).json({ ok: true, note: "ACH load is stubbed in demo; wire create-ACH-debit here in production." });
    }

    return res.status(400).json({ error: "unknown action" });
  } catch (e) {
    return res.status(200).json({ connected: false, error: String((e && e.message) || e) });
  }
}
