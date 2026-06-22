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
      await sql`CREATE TABLE IF NOT EXISTS app_config (
        key text PRIMARY KEY,
        value jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )`;
      await sql`CREATE TABLE IF NOT EXISTS stores (
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
        updated_at timestamptz NOT NULL DEFAULT now()
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
  const rows = await sql`SELECT value FROM app_config WHERE key = 'program'`;
  return rows[0] ? rows[0].value : null;
}
export async function dbSaveProgram(program) {
  if (!sql) return;
  await ensureSchema();
  await sql`INSERT INTO app_config (key, value, updated_at)
    VALUES ('program', ${JSON.stringify(program)}::jsonb, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}

/* ---------------- store registry ---------------- */
export async function dbListStores() {
  if (!sql) return {};
  await ensureSchema();
  const rows = await sql`SELECT * FROM stores`;
  const out = {};
  for (const r of rows) out[String(r.email).toLowerCase()] = rowToStore(r);
  return out;
}
export async function dbGetStore(email) {
  if (!sql) return null;
  await ensureSchema();
  const rows = await sql`SELECT * FROM stores WHERE email = ${String(email).toLowerCase()}`;
  return rows[0] ? rowToStore(rows[0]) : null;
}
// s is a cleanStore-shaped object: { name, rewardsPercent, feePercent, active, note, pos:{provider,baseUrl,key,locationId} }
export async function dbSaveStore(email, s) {
  if (!sql) return;
  await ensureSchema();
  const em = String(email).toLowerCase();
  const pos = s.pos || {};
  await sql`INSERT INTO stores
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
  await sql`DELETE FROM stores WHERE email = ${String(email).toLowerCase()}`;
}

/* ---------------- one-time seed from Clerk ---------------- */
// Runs the first time the DB is reached. If there is no program row and no
// stores yet, copy whatever was in Clerk so the cutover is invisible to users.
let _seeded = false;
export async function dbSeedIfEmpty(clerkProgram, clerkStores) {
  if (!sql || _seeded) return;
  await ensureSchema();
  const cfg = await sql`SELECT 1 FROM app_config WHERE key = 'program'`;
  const cnt = await sql`SELECT count(*)::int AS n FROM stores`;
  const storesEmpty = (cnt[0] ? cnt[0].n : 0) === 0;
  if (cfg.length === 0 && clerkProgram) await dbSaveProgram(clerkProgram);
  if (storesEmpty && clerkStores) {
    for (const k of Object.keys(clerkStores)) await dbSaveStore(k, clerkStores[k]);
  }
  _seeded = true;
}
