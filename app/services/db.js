// PostgreSQL connection, migrations, and optional small-file storage.
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const MIG_DIR = path.join(PROJECT_ROOT, "db", "migrations");
const SEED_DIR = path.join(PROJECT_ROOT, "app", "seed");

// table -> natural key column for ON CONFLICT. The column MUST have a UNIQUE
// constraint in some migration. Maintain per business reality.
const NATURAL_KEY = {};

let _pool = null;

function isDbConfigured() { return Boolean(process.env.DATABASE_URL); }
function getPool() {
  if (_pool) return _pool;
  if (!isDbConfigured()) throw new Error("DATABASE_URL is required");
  _pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10, keepAlive: true });
  _pool.on("error", (err) => console.error("[db] idle connection:", err.code || err.message));
  return _pool;
}

async function migrate() {
  // Apply db/migrations/NNN_*.sql once each, tracked. Append-only.
  const pool = getPool();
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version    TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`
  );
  const { rows } = await pool.query("SELECT version FROM schema_migrations");
  const applied = new Set(rows.map((r) => r.version));

  if (!fs.existsSync(MIG_DIR)) {
    console.log("[migrate] no migrations dir");
    return;
  }
  const files = fs
    .readdirSync(MIG_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const f of files) {
    const version = f.replace(/\.sql$/, "");
    if (applied.has(version)) {
      console.log(`[migrate] skip ${version}`);
      continue;
    }
    const sql = fs.readFileSync(path.join(MIG_DIR, f), "utf-8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // pg supports multiple statements in one query() call.
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations(version) VALUES ($1)", [version]);
      await client.query("COMMIT");
      console.log(`[migrate] apply ${version}`);
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }
  console.log("[migrate] done");
}

async function seedStructured() {
  // app/seed/<table>.json -> INSERT ... ON CONFLICT (natural key) DO NOTHING
  if (!fs.existsSync(SEED_DIR)) return;
  const pool = getPool();
  const files = fs
    .readdirSync(SEED_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();
  for (const f of files) {
    const table = f.replace(/\.json$/, "");
    const rows = JSON.parse(fs.readFileSync(path.join(SEED_DIR, f), "utf-8"));
    if (!rows.length) continue;
    const key = NATURAL_KEY[table];
    if (!key) {
      throw new Error(
        `[seed] ${table}.json present but no NATURAL_KEY mapping; add it to ` +
          `app/services/db.js NATURAL_KEY and a UNIQUE constraint`
      );
    }
    const cols = Object.keys(rows[0]);
    for (const row of rows) {
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
      const sql = `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${placeholders}) ON CONFLICT (${key}) DO NOTHING`;
      await pool.query(sql, cols.map((c) => row[c]));
    }
    console.log(`[seed] ${table}: ${rows.length} rows ensured`);
  }
}

// --- File storage: BYTEA column (business tables store only attachments.id) - //
// Plain standard SQL — no `lo` extension, no superuser, works on any PG. Fine
// for small/medium files; the whole payload lives in memory per request, so do
// not use this for very large (100MB+) uploads.

const crypto = require("crypto");

async function uploadFile({ name, mime, data, ownerId = null }) {
  // data: Buffer. Returns attachments.id. sha256-dedup.
  const pool = getPool();
  const sha = crypto.createHash("sha256").update(data).digest("hex");
  const existing = await pool.query("SELECT id FROM attachments WHERE sha256=$1", [sha]);
  if (existing.rows.length) return existing.rows[0].id;
  const { rows } = await pool.query(
    `INSERT INTO attachments (name, mime, size_bytes, sha256, owner_id, content)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (sha256) DO UPDATE SET sha256 = attachments.sha256
     RETURNING id`,
    [name, mime, data.length, sha, ownerId, data]
  );
  return rows[0].id;
}

async function readFile(id) {
  // Returns { name, mime, data: Buffer } or null.
  const pool = getPool();
  const { rows } = await pool.query(
    "SELECT name, mime, content FROM attachments WHERE id=$1",
    [id]
  );
  if (!rows.length) return null;
  const { name, mime, content } = rows[0];
  return { name, mime, data: content };
}

module.exports = {
  isDbConfigured,
  getPool,
  migrate,
  seedStructured,
  uploadFile,
  readFile,
  NATURAL_KEY,
};
