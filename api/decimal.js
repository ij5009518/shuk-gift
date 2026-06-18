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
      const arr = Array.isArray(data) ? data
        : (data.data || data.items || data.results || data.products || data.records || []);
      const products = arr.map(p => ({
        id: p.id ?? p.productId,
        code: p.code ?? p.sku ?? p.itemCode ?? p.productCode ?? null,
        name: p.name ?? p.description ?? p.productName ?? null,
        price: p.price, priceQty: p.priceQty,
      }));
      return res.status(200).json({ products, total: data.total ?? null, keys: Object.keys(data || {}), sampleRaw: arr[0] || null });
    }

    if (action === "product") {
      const code = body.code, id = body.id;
      const path = code ? "/products/code/" + encodeURIComponent(code) : "/products/id/" + encodeURIComponent(id);
      const { data } = await pos(path);
      return res.status(200).json({ product: data });
    }

    if (action === "customers") {
      const take = Math.min(Number(body.take) || 5, 100);
      const { data } = await pos("/customers?take=" + take);
      const arr = Array.isArray(data) ? data : (data.results || data.data || data.items || []);
      const customers = arr.map(c => ({
        id: c.id ?? c.customerId, name: c.name ?? [c.firstName, c.lastName].filter(Boolean).join(" ") ?? null,
        phone: c.phoneNumber ?? c.phone ?? null,
      }));
      return res.status(200).json({ customers, total: data.total ?? null, sampleRaw: arr[0] || null });
    }

    if (action === "recordSale") {
      // Build and post a real, paid sale to the POS. The gift-card deduction
      // happens in our own ledger before this; here we just record the sale.
      const listOf = d => Array.isArray(d) ? d : (d.results || d.data || d.items || d.records || []);
      const quantity = Number(body.quantity) || 1;

      // 1) Resolve the product + its price
      const pPath = body.productCode ? "/products/code/" + encodeURIComponent(body.productCode)
        : "/products/id/" + encodeURIComponent(body.productId);
      const { data: pd } = await pos(pPath);
      const product = Array.isArray(pd) ? pd[0] : (pd.results ? pd.results[0] : pd);
      if (!product) return res.status(200).json({ error: "Product not found." });
      const unitPrice = (product.prices && product.prices[0] && product.prices[0].price) ?? product.price ?? 0;
      const code = product.itemCode ?? product.primaryCode ?? body.productCode;
      const subtotal = Math.round(unitPrice * quantity * 100) / 100;
      const isTaxable = !!product.tax;
      const taxAmount = isTaxable ? Math.round(subtotal * (product.taxRate || 0)) / 100 : 0;
      const total = Math.round((subtotal + taxAmount) * 100) / 100;

      // 2) Resolve a customer (use provided, else first demo customer)
      let customerId = body.customerId;
      if (!customerId) {
        const { data: cd } = await pos("/customers?take=1");
        const c0 = listOf(cd)[0];
        customerId = c0 && (c0.id ?? c0.customerId);
      }
      if (!customerId) return res.status(200).json({ error: "No customer available to attach the sale to." });

      // 3) Build + post the invoice
      const now = new Date().toISOString();
      const externalInvoiceId = "SG" + Date.now().toString().slice(-16);
      const invoice = {
        externalInvoiceId, invoiceDate: now, orderMethod: "Pickup",
        taxAmount, taxableAmount: isTaxable ? subtotal : 0, customerId,
        items: [{ productCode: code, quantity, unitPrice, subtotal, isTaxable, discountAmount: 0 }],
        payments: [{ paymentMethod: "APICreditCard", amount: total, referenceNo: externalInvoiceId.slice(0, 15), dateTime: now }],
        memo: "Shuk Gift redemption",
      };
      const r = await pos("/invoices", "POST", invoice);
      return res.status(200).json({ ok: true, status: r.status, location: r.location, externalInvoiceId, total, product: { code, name: product.description ?? product.name, unitPrice }, customerId });
    }

    return res.status(400).json({ error: "Unknown action." });
  } catch (e) {
    return res.status(200).json({ error: String((e && e.message) || e).slice(0, 200), data: (e && e.data) || null });
  }
}
