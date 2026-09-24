const crypto = require("crypto");
const db = require("../services/db");

const secret = process.env.SESSION_SECRET;
if (process.env.NODE_ENV === "production" && (!secret || secret.length < 32)) {
  throw new Error("SESSION_SECRET must contain at least 32 characters in production");
}
const signingKey = secret || crypto.randomBytes(32).toString("hex");
const limits = { chat: 20, deposition: 5, task: 10 };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function signature(id) {
  return crypto.createHmac("sha256", signingKey).update(id).digest("hex");
}
function validCookie(raw) {
  const match = raw && raw.match(/^([0-9a-f-]{36})\.([0-9a-f]{64})$/);
  if (!match) return null;
  const expected = Buffer.from(signature(match[1]), "hex");
  const actual = Buffer.from(match[2], "hex");
  return crypto.timingSafeEqual(expected, actual) ? match[1] : null;
}

function session(req, res, next) {
  const cookies = (req.headers.cookie || "").split(/;\s*/);
  const raw = cookies.find((x) => x.startsWith("tm_guest="))?.slice(9);
  req.guestId = validCookie(raw) || crypto.randomUUID();
  if (!validCookie(raw)) {
    const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
    res.setHeader("Set-Cookie", `tm_guest=${req.guestId}.${signature(req.guestId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${secure}`);
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.headers.origin) {
    const allowed = process.env.PUBLIC_ORIGIN || `${req.protocol}://${req.get("host")}`;
    if (req.headers.origin !== allowed) return res.status(403).json({ error: "请求来源不匹配" });
  }
  next();
}

async function ownsTask(id, guestId) {
  if (!uuid.test(id || "")) return false;
  const { rows } = await db.getPool().query("SELECT 1 FROM tasks WHERE id=$1 AND guest_id=$2", [id, guestId]);
  return rows.length > 0;
}
async function ownsConversation(id, guestId) {
  if (!uuid.test(id || "")) return false;
  const { rows } = await db.getPool().query(
    "SELECT 1 FROM conversations c JOIN tasks t ON t.id=c.task_id WHERE c.id=$1 AND t.guest_id=$2", [id, guestId]
  );
  return rows.length > 0;
}
async function ownsJob(id, guestId) {
  if (!uuid.test(id || "")) return false;
  const { rows } = await db.getPool().query(
    "SELECT 1 FROM deposition_jobs j JOIN tasks t ON t.id=j.task_id WHERE j.id=$1 AND t.guest_id=$2", [id, guestId]
  );
  return rows.length > 0;
}
function protect(check, key) {
  return async (req, res, next) => {
    try {
      if (!await check(key(req), req.guestId)) return res.status(404).json({ error: "not found" });
      next();
    } catch (e) { next(e); }
  };
}

async function count(subject, kind, max) {
  const result = await db.getPool().query(
    "INSERT INTO demo_quotas(subject,day,kind,used) VALUES ($1,(now() AT TIME ZONE 'UTC')::date,$2,1) " +
    "ON CONFLICT (subject,day,kind) DO UPDATE SET used=demo_quotas.used+1 " +
    "WHERE demo_quotas.used < $3 RETURNING used", [subject, kind, max]
  );
  return result.rowCount > 0;
}
async function quota(req, res, next, kind) {
  try {
    const max = limits[kind];
    // Hash network addresses before storing them. Counters are in PostgreSQL
    // so concurrent requests and multiple web workers share the same cap.
    const ipHash = crypto.createHmac("sha256", signingKey).update(req.ip || "unknown").digest("hex");
    if (!await count(`ip:${ipHash}`, kind, max * 3) || !await count(`guest:${req.guestId}`, kind, max)) {
      return res.status(429).json({ error: "公开演示今日体验次数已用完，请明天再试" });
    }
    next();
  } catch (e) { next(e); }
}
const limit = (kind) => (req, res, next) => quota(req, res, next, kind);

module.exports = { session, ownsTask, ownsConversation, ownsJob, protect, limit };
