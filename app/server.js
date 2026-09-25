// Express entry point for TaskMind (React SPA frontend + JSON API + SSE chat).
//
// Shape:
//   /api/*                       -> JSON business endpoints (TaskMind routes)
//   /healthz                     -> provided
//   static files                 -> ../static (mounted AFTER api routes)
//   GET /* (fallback)            -> index.html (SPA history fallback for deep links)
//
// Rules enforced by structure:
//   - business data served as JSON, never inlined into the HTML shell
//   - express.static mounted directly (no app.use('*', ...) — that 301-loops)
//   - listens on 0.0.0.0:APP_PORT (platform-injected, never hardcoded)

const path = require("path");
const express = require("express");
const db = require("./services/db");
const ai = require("./services/ai");
const tasksRoutes = require("./routes/tasks");
const conversationsRoutes = require("./routes/conversations");
const depositionsRoutes = require("./routes/depositions");
const demo = require("./lib/demo");

const app = express();
if (process.env.NODE_ENV === "production" && (!db.isDbConfigured() || !ai.isAiEnabled())) {
  throw new Error("DATABASE_URL, AI_MODEL, and AI_API_KEY are required in production");
}
app.set("trust proxy", 1);
app.use(express.json({ limit: "32kb" }));

const STATIC_DIR = path.resolve(__dirname, "..", "static");

// Liveness endpoint.
app.get(["/health", "/healthz"], (_req, res) => res.json({ status: "ok" }));

// Module self-check: probes DB / AI and reports per-module status.
app.get("/api/health/modules", async (_req, res) => {
  res.json({
    db: await checkDb(),
    ai: checkAi(),
  });
});

async function checkDb() {
  if (!db.isDbConfigured()) {
    return { status: "not_configured" };
  }
  try {
    const pool = db.getPool();
    const m = await pool.query("SELECT count(*) AS n FROM schema_migrations");
    return { status: "ok", detail: `已连接；migrations=${m.rows[0].n}` };
  } catch (e) {
    return { status: "error", detail: `连接/查询失败：${e.code || e.message}` };
  }
}

function checkAi() {
  const textOk = ai.isAiEnabled();
  return { status: textOk ? "ok" : "not_configured" };
}

// --- TaskMind business routes ---
app.use("/api", demo.session);
app.use("/api/tasks", tasksRoutes);
app.use("/api/conversations", conversationsRoutes);
app.use("/api/depositions", depositionsRoutes);

// Static frontend — mounted directly AFTER all /api routes. Never use
// app.use('*', express.static(...)): that strips the path and 301-loops assets.
// index.html itself must not be cached (no-cache) so browsers always fetch the
// latest shell with the correct hashed asset references. Hashed /assets/* files
// keep their default public/max-age caching via express.static.
app.use((req, res, next) => {
  if (req.path === "/" || req.path.endsWith(".html")) {
    res.setHeader("Cache-Control", "no-cache");
  }
  next();
});
app.use(express.static(STATIC_DIR, { index: "index.html" }));

// SPA history fallback: deep links like /tasks/:id must serve the app shell.
// Unknown /api paths stay JSON 404s instead of leaking the HTML shell.
app.get(/.*/, (req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "not found" });
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(path.join(STATIC_DIR, "index.html"));
});

// Error handler: async route failures land here via next(err).
app.use((err, _req, res, _next) => {
  console.error("[api]", err);
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const status = err.status || 500;
  res.status(status).json({ error: status >= 500 ? "服务器内部错误" : err.message });
});

const PORT = parseInt(process.env.PORT || process.env.APP_PORT || "3000", 10);
const HOST = process.env.APP_HOSTNAME || "0.0.0.0";
app.listen(PORT, HOST, () => {
  console.log(`listening on ${HOST}:${PORT}`);
  // Startup recovery: a restart may have interrupted a running refine. Mark
  // stuck processing jobs as failed — the user can retry them (retry reuses
  // the job's frozen source snapshot, so no messages are lost or added).
  if (!db.isDbConfigured()) return;
  db.getPool()
    .query(
      "UPDATE deposition_jobs SET status='failed', error_message='服务重启中断，请重试', " +
        "updated_at=now() WHERE status='processing'"
    )
    .then((r) => {
      if (r.rowCount > 0) console.log(`[deposition] recovered ${r.rowCount} interrupted job(s) -> failed`);
    })
    .catch(() => {});
  const cleanup = () => db.getPool().query(
    "DELETE FROM tasks WHERE guest_id IS NOT NULL AND updated_at < now() - interval '7 days'"
  ).then(() => db.getPool().query("DELETE FROM demo_quotas WHERE day < current_date - 2"))
    .then(() => db.getPool().query("DELETE FROM guest_example_seeds WHERE created_at < now() - interval '30 days'"))
    .catch((e) => console.error("[cleanup]", e.message));
  cleanup();
  setInterval(cleanup, 24 * 60 * 60 * 1000).unref();
});
