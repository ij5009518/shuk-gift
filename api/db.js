// api/db.js — Postgres (Neon) data layer for Shuk Gift.
// Holds the program config + the store registry (rates, fees, POS settings).
// Money stays in Increase; per-user flags stay in Clerk. This module exists to
// get the shared "stores" registry out of a single Clerk metadata blob so writes
// are per-row (no clobbering) and POS API keys are encrypted at rest.

import { neon } from "@neondatabase/serverless";
import crypto from "crypto";

const CONN =
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  process.env.DATABASE_URL_UNPOOLED ||
  process.env.POSTGRES_PRISMA_URL ||
  "";

const sql = CONN ? neon(CONN) : null;

export function dbReady() { return !!sql; }

/* ---------------- encryption for the POS api key ---------------- */
// AES-256-GCM when APP_ENC_KEY is set (32-byte hex, or any string -> sha256).
// If no key is configured we store with a "plain:" marker (Neon still encrypts
// at rest); turning on APP_ENC_KEY later transparently upgrades new writes.
function encKey() {
  const k = process.env.APP_ENC_KEY || "";
  if (/^[0-9a-fA-F]{64}$/.test(k)) return Buffer.from(k, "hex");
  if (k) return crypto.createHash("sha256").update(k).digest();
  return null;
}
function enc(plain) {
  if (!plain) return "";
  const kk = encKey();
  if (!kk) return "plain:" + plain;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", kk, iv);
  const ct = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  const tag = c.getAuthTag();
  return "v1:" + Buffer.concat([iv, tag, ct]).toString("base64");
}
function dec(stored) {
  if (!stored) return "";
  if (stored.startsWith("plain:")) return stored.slice(6);
  if (stored.startsWith("v1:")) {
    const kk = encKey();
    if (!kk) return "";
    try {
      const raw = Buffer.from(stored.slice(3), "base64");
      const iv = raw.subarray(0, 12), tag = raw.subarray(12, 28), ct = raw.subarray(28);
      const d = crypto.createDecipheriv("aes-256-gcm", kk, iv);
      d.setAuthTag(tag);
      return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
    } catch { return ""; }
  }
  return stored;
}

/* ---------------- schema (lazy, once per cold start) ---------------- */
let _ready = null;
function ensureSchema() {
  if (!sql) return Promise.resolve();
  if (!_ready) {
    _ready = (async () => {
      await sql`CREATE TABLE IF NOT EXISTS shuk_config (
        key text PRIMARY KEY,
        value jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )`;
      await sql`CREATE TABLE IF NOT EXISTS shuk_stores (
        email text PRIMARY KEY,
        name text NOT NULL DEFAULT '',
        rewards_percent numeric NOT NULL DEFAULT 0,
        fee_percent numeric NOT NULL DEFAULT 0,
        active boolean NOT NULL DEFAULT true,
        note text NOT NULL DEFAULT '',
        pos_provider text NOT NULL DEFAULT 'decimal',
        pos_base_url text NOT NULL DEFAULT '',
        pos_key_enc text NOT NULL DEFAULT '',
        pos_location_id text NOT NULL DEFAULT '',
        reg_key_hash text NOT NULL DEFAULT '',
        updated_at timestamptz NOT NULL DEFAULT now()
      )`;
      // In case shuk_stores already existed without the register-key column.
      await sql`ALTER TABLE shuk_stores ADD COLUMN IF NOT EXISTS reg_key_hash text NOT NULL DEFAULT ''`;
      // Physical card number -> the customer's gift account (for register charges).
      await sql`CREATE TABLE IF NOT EXISTS shuk_cards (
        card_number text PRIMARY KEY,
        email text NOT NULL DEFAULT '',
        account_id text NOT NULL DEFAULT '',
        created_at timestamptz NOT NULL DEFAULT now()
      )`;
      // Register transaction log so a charge can be Voided by its integer id.
      await sql`CREATE TABLE IF NOT EXISTS shuk_pos_txns (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        store_email text NOT NULL DEFAULT '',
        card_number text NOT NULL DEFAULT '',
        account_id text NOT NULL DEFAULT '',
        amount_cents integer NOT NULL DEFAULT 0,
        fee_cents integer NOT NULL DEFAULT 0,
        points integer NOT NULL DEFAULT 0,
        sale_id text NOT NULL DEFAULT '',
        register text NOT NULL DEFAULT '',
        status text NOT NULL DEFAULT 'approved',
        created_at timestamptz NOT NULL DEFAULT now()
      )`;
    })().catch((e) => { _ready = null; throw e; });
  }
  return _ready;
}

/* ---------------- mapping ---------------- */
function rowToStore(r) {
  return {
    email: r.email,
    name: r.name || "",
    rewardsPercent: r.rewards_percent == null ? 0 : Number(r.rewards_percent),
    feePercent: r.fee_percent == null ? 0 : Number(r.fee_percent),
    active: r.active !== false,
    note: r.note || "",
    pos: {
      provider: r.pos_provider || "decimal",
      baseUrl: r.pos_base_url || "",
      key: dec(r.pos_key_enc || ""),
      locationId: r.pos_location_id || "",
    },
  };
}

/* ---------------- program config ---------------- */
export async function dbGetProgram() {
  if (!sql) return null;
  await ensureSchema();
  const rows = await sql`SELECT value FROM shuk_config WHERE key = 'program'`;
  return rows[0] ? rows[0].value : null;
}
export async function dbSaveProgram(program) {
  if (!sql) return;
  await ensureSchema();
  await sql`INSERT INTO shuk_config (key, value, updated_at)
    VALUES ('program', ${JSON.stringify(program)}::jsonb, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}

/* ---------------- store registry ---------------- */
export async function dbListStores() {
  if (!sql) return {};
  await ensureSchema();
  const rows = await sql`SELECT * FROM shuk_stores`;
  const out = {};
  for (const r of rows) out[String(r.email).toLowerCase()] = rowToStore(r);
  return out;
}
export async function dbGetStore(email) {
  if (!sql) return null;
  await ensureSchema();
  const rows = await sql`SELECT * FROM shuk_stores WHERE email = ${String(email).toLowerCase()}`;
  return rows[0] ? rowToStore(rows[0]) : null;
}
// s is a cleanStore-shaped object: { name, rewardsPercent, feePercent, active, note, pos:{provider,baseUrl,key,locationId} }
export async function dbSaveStore(email, s) {
  if (!sql) return;
  await ensureSchema();
  const em = String(email).toLowerCase();
  const pos = s.pos || {};
  await sql`INSERT INTO shuk_stores
      (email, name, rewards_percent, fee_percent, active, note, pos_provider, pos_base_url, pos_key_enc, pos_location_id, updated_at)
    VALUES (${em}, ${s.name || ""}, ${Number(s.rewardsPercent) || 0}, ${Number(s.feePercent) || 0},
            ${s.active !== false}, ${s.note || ""}, ${pos.provider || "decimal"}, ${pos.baseUrl || ""},
            ${enc(pos.key || "")}, ${pos.locationId || ""}, now())
    ON CONFLICT (email) DO UPDATE SET
      name = EXCLUDED.name, rewards_percent = EXCLUDED.rewards_percent, fee_percent = EXCLUDED.fee_percent,
      active = EXCLUDED.active, note = EXCLUDED.note, pos_provider = EXCLUDED.pos_provider,
      pos_base_url = EXCLUDED.pos_base_url, pos_key_enc = EXCLUDED.pos_key_enc,
      pos_location_id = EXCLUDED.pos_location_id, updated_at = now()`;
}
export async function dbDeleteStore(email) {
  if (!sql) return;
  await ensureSchema();
  await sql`DELETE FROM shuk_stores WHERE email = ${String(email).toLowerCase()}`;
}

/* ---------------- one-time seed from Clerk ---------------- */
// Runs the first time the DB is reached. If there is no program row and no
// stores yet, copy whatever was in Clerk so the cutover is invisible to users.
let _seeded = false;
export async function dbSeedIfEmpty(clerkProgram, clerkStores) {
  if (!sql || _seeded) return;
  await ensureSchema();
  const cfg = await sql`SELECT 1 FROM shuk_config WHERE key = 'program'`;
  const cnt = await sql`SELECT count(*)::int AS n FROM shuk_stores`;
  const storesEmpty = (cnt[0] ? cnt[0].n : 0) === 0;
  if (cfg.length === 0 && clerkProgram) await dbSaveProgram(clerkProgram);
  if (storesEmpty && clerkStores) {
    for (const k of Object.keys(clerkStores)) await dbSaveStore(k, clerkStores[k]);
  }
  _seeded = true;
}

/* ---------------- register (inbound POS) API keys ---------------- */
// The key that poswithlogic's register presents to us is stored only as a hash.
function keyHash(raw) { return crypto.createHash("sha256").update(String(raw || "")).digest("hex"); }
export async function dbSetRegKey(email, rawKey) {
  if (!sql) return;
  await ensureSchema();
  await sql`UPDATE shuk_stores SET reg_key_hash = ${keyHash(rawKey)}, updated_at = now() WHERE email = ${String(email).toLowerCase()}`;
}
export async function dbStoreEmailByRegKey(rawKey) {
  if (!sql || !rawKey) return null;
  await ensureSchema();
  const rows = await sql`SELECT email FROM shuk_stores WHERE reg_key_hash = ${keyHash(rawKey)} LIMIT 1`;
  return rows[0] ? rows[0].email : null;
}

/* ---------------- physical card mapping ---------------- */
export async function dbFindCard(cardNumber) {
  if (!sql || !cardNumber) return null;
  await ensureSchema();
  const rows = await sql`SELECT email, account_id FROM shuk_cards WHERE card_number = ${String(cardNumber)}`;
  return rows[0] ? { email: rows[0].email, accountId: rows[0].account_id } : null;
}
export async function dbLinkCard(cardNumber, email, accountId) {
  if (!sql) return;
  await ensureSchema();
  await sql`INSERT INTO shuk_cards (card_number, email, account_id)
    VALUES (${String(cardNumber)}, ${String(email).toLowerCase()}, ${String(accountId)})
    ON CONFLICT (card_number) DO UPDATE SET email = EXCLUDED.email, account_id = EXCLUDED.account_id`;
}

/* ---------------- register transaction log (for Void) ---------------- */
export async function dbCreatePosTxn(t) {
  if (!sql) return null;
  await ensureSchema();
  const rows = await sql`INSERT INTO shuk_pos_txns
      (store_email, card_number, account_id, amount_cents, fee_cents, points, sale_id, register, status)
    VALUES (${t.storeEmail || ""}, ${t.cardNumber || ""}, ${t.accountId || ""}, ${t.amountCents || 0},
            ${t.feeCents || 0}, ${t.points || 0}, ${t.saleId || ""}, ${t.register || ""}, 'approved')
    RETURNING id`;
  return rows[0] ? Number(rows[0].id) : null;
}
export async function dbGetPosTxn(id) {
  if (!sql) return null;
  await ensureSchema();
  const rows = await sql`SELECT * FROM shuk_pos_txns WHERE id = ${Number(id)}`;
  if (!rows[0]) return null;
  const r = rows[0];
  return { id: Number(r.id), storeEmail: r.store_email, cardNumber: r.card_number, accountId: r.account_id,
    amountCents: r.amount_cents, feeCents: r.fee_cents, points: r.points, saleId: r.sale_id, register: r.register, status: r.status };
}
export async function dbSetPosTxnStatus(id, status) {
  if (!sql) return;
  await ensureSchema();
  await sql`UPDATE shuk_pos_txns SET status = ${status} WHERE id = ${Number(id)}`;
}
