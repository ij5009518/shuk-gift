// POS connector. Records gift-card-paid sales into the store's POS and reads the
// catalog. The balance lives in our own ledger; the POS just records the sale,
// so this stays portable across any POS (this is the first connector).
const DK = process.env.DECIMAL_API_KEY;
const DB = process.env.DECIMAL_BASE_URL || "https://api.poswithlogic.dev";

async function pos(path, method = "GET", body) {
  const r = await fetch(DB + path, {
    method,
    headers: { "x-api-key": DK, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const loc = r.headers.get("location");
  const text = await r.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!r.ok) { const e = new Error((data && (data.title || data.detail)) || ("POS error " + r.status)); e.status = r.status; e.data = data; throw e; }
  return { data, location: loc, status: r.status };
}

export default async function handler(req, res) {
  if (!DK) return res.status(200).json({ needsKey: true });
  let body = {};
  try { body = typeof req.body === "object" && req.body ? req.body : JSON.parse(req.body || "{}"); } catch {}
  const action = body.action || "status";

  try {
    if (action === "status") {
      const { data } = await pos("/products?take=1");
      return res.status(200).json({ connected: true, total: data.total ?? null, sample: (data.data || []).length });
    }

    if (action === "products") {
      const take = Math.min(Number(body.take) || 20, 100);
      const { data } = await pos("/products?take=" + take);
      const products = (data.data || []).map(p => ({
        id: p.id, code: p.code ?? p.sku ?? null, name: p.name ?? p.description ?? null,
        price: p.price, priceQty: p.priceQty,
      }));
      return res.status(200).json({ products, total: data.total ?? null, raw: (data.data || [])[0] || null });
    }

    if (action === "product") {
      const code = body.code, id = body.id;
      const path = code ? "/products/code/" + encodeURIComponent(code) : "/products/id/" + encodeURIComponent(id);
      const { data } = await pos(path);
      return res.status(200).json({ product: data });
    }

    if (action === "recordSale") {
      // Records a completed, gift-card-paid sale in the POS. Pass a ready invoice
      // payload (items, taxAmount, customer/customerId, payments). The gift-card
      // deduction itself happens in our own ledger before this is called.
      if (!body.invoice) return res.status(200).json({ error: "Missing invoice payload." });
      const r = await pos("/invoices", "POST", body.invoice);
      return res.status(200).json({ ok: true, status: r.status, location: r.location });
    }

    return res.status(400).json({ error: "Unknown action." });
  } catch (e) {
    return res.status(200).json({ error: String((e && e.message) || e).slice(0, 200), data: (e && e.data) || null });
  }
}
