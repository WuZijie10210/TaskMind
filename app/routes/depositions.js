// app/routes/depositions.js — deposition (沉淀) endpoints.
//
//   POST /api/depositions                click 沉淀: freeze the stage source,
//                                        create a processing job, return at
//                                        once; the AI refine keeps running in
//                                        the background.
//   GET  /api/depositions/:id            job detail (candidates + frozen
//                                        source messages) for the confirm UI.
//   POST /api/depositions/:id/confirm    save user-edited candidates as
//                                        artifacts (>=1 required); job =
//                                        confirmed. The ONLY path that
//                                        advances the stage cursor.
//   POST /api/depositions/:id/discard    give up this deposition (ready or
//                                        failed); job = discarded/abandoned.
//                                        Cut-off NOT advanced.
//   POST /api/depositions/:id/reanalyze  ready -> processing again, keeping
//                                        the frozen source unchanged.
//   POST /api/depositions/:id/retry      failed -> processing again, reusing
//                                        the ORIGINAL frozen source snapshot.
//
// NOTE: the explicit "skip" endpoint was removed (UX patch 2026-09-21):
// nothing but confirm advances the stage cursor anymore. Discarding a failed
// job (abandoned) is the way to clear a stuck attempt — it does not advance
// the cursor, the same source can be re-deposited later.
//
// Concurrency: at most one processing|ready job per conversation (also
// enforced by a partial unique index in migration 003).

const express = require("express");
const db = require("../services/db");
const demo = require("../lib/demo");
const { ah, isUuid, toDepositionJob } = require("../lib/helpers");
const { latestCursor, messagesAfter, runDeposition, ARTIFACT_TYPES } = require("../lib/deposition");

const router = express.Router();
router.use("/:id", demo.protect(demo.ownsJob, (req) => req.params.id));

async function findConversationRow(id) {
  if (!isUuid(id)) {
    const err = new Error("conversation not found");
    err.status = 404;
    throw err;
  }
  const { rows } = await db.getPool().query("SELECT * FROM conversations WHERE id = $1", [id]);
  if (!rows[0]) {
    const err = new Error("conversation not found");
    err.status = 404;
    throw err;
  }
  return rows[0];
}

async function findJob(id) {
  if (!isUuid(id)) {
    const err = new Error("deposition job not found");
    err.status = 404;
    throw err;
  }
  const { rows } = await db.getPool().query("SELECT * FROM deposition_jobs WHERE id = $1", [id]);
  if (!rows[0]) {
    const err = new Error("deposition job not found");
    err.status = 404;
    throw err;
  }
  return rows[0];
}

router.post(
  "/", demo.protect(demo.ownsConversation, (req) => (req.body || {}).conversationId), demo.limit("deposition"),
  ah(async (req, res) => {
    const conversation = await findConversationRow((req.body || {}).conversationId);
    const pool = db.getPool();

    const active = (
      await pool.query(
        "SELECT id, status FROM deposition_jobs WHERE conversation_id = $1 " +
          "AND status IN ('processing','ready')",
        [conversation.id]
      )
    ).rows[0];
    if (active) {
      return res
        .status(409)
        .json({ error: active.status === "ready" ? "已有待确认的成果，请先确认或放弃" : "该对话正在整理成果" });
    }

    const cursor = await latestCursor(pool, conversation.id);
    const source = await messagesAfter(pool, conversation.id, cursor);
    if (source.length === 0) {
      return res.status(400).json({ error: "没有新的可沉淀消息" });
    }

    const snapshot = {
      conversationId: conversation.id,
      taskId: conversation.task_id,
      capturedAt: new Date().toISOString(),
      cursorMessageId: cursor,
      messageCount: source.length,
      messages: source.map((m) => ({
        messageId: m.id,
        role: m.role,
        content: m.content,
        createdAt: m.created_at,
      })),
    };
    const job = (
      await pool.query(
        "INSERT INTO deposition_jobs (task_id, conversation_id, source_message_ids, " +
          "source_snapshot, cursor_message_id) VALUES ($1, $2, $3, $4, $5) RETURNING *",
        [
          conversation.task_id,
          conversation.id,
          source.map((m) => m.id),
          JSON.stringify(snapshot),
          source[source.length - 1].id,
        ]
      )
    ).rows[0];
    console.log(
      `[deposition] job=${job.id.slice(0, 8)} created conv=${conversation.id.slice(0, 8)} ` +
        `type=${conversation.type} source=${source.length}`
    );

    // Background refine — never awaited; the client polls the job state.
    runDeposition(job.id).catch((e) => console.error("[deposition] run crashed:", e.message));
    res.status(201).json({ job: toDepositionJob(job) });
  })
);

router.get(
  "/:id",
  ah(async (req, res) => {
    const job = await findJob(req.params.id);
    const conv = (
      await db.getPool().query(
        "SELECT id, task_id, type, title FROM conversations WHERE id = $1",
        [job.conversation_id]
      )
    ).rows[0];
    const snapshot = job.source_snapshot || {};
    const sourceMessages = (Array.isArray(snapshot.messages) ? snapshot.messages : []).map((m) => ({
      id: m.messageId,
      role: m.role,
      content: String(m.content || "").length > 1200 ? String(m.content).slice(0, 1200) + "…" : m.content,
    }));
    res.json({
      job: toDepositionJob(job),
      candidates: Array.isArray(job.candidate_artifacts) ? job.candidate_artifacts : [],
      sourceMessages,
      conversation: conv || null,
    });
  })
);

router.post(
  "/:id/confirm",
  ah(async (req, res) => {
    const job = await findJob(req.params.id);
    if (job.status !== "ready") {
      return res.status(409).json({ error: "该沉淀不在待确认状态" });
    }
    const list = Array.isArray((req.body || {}).artifacts) ? req.body.artifacts : [];
    if (list.length === 0) return res.status(400).json({ error: "没有可保存的候选成果，请放弃本次沉淀" });
    if (list.length > 20) return res.status(400).json({ error: "成果数量异常" });

    const validIds = new Set(job.source_message_ids || []);
    const sourceTitle = (await db.getPool().query(
      "SELECT title FROM conversations WHERE id=$1", [job.conversation_id]
    )).rows[0]?.title || null;
    const frozenById = new Map(
      (Array.isArray(job.source_snapshot?.messages) ? job.source_snapshot.messages : [])
        .map((m) => [m.messageId, m])
    );
    const pool = db.getPool();
    const client = await pool.connect();
    const saved = [];
    try {
      await client.query("BEGIN");
      const claim = await client.query(
        "UPDATE deposition_jobs SET status='confirmed', completed_at=now(), updated_at=now() " +
        "WHERE id=$1 AND status='ready' RETURNING id", [job.id]
      );
      if (!claim.rowCount) {
        const err = new Error("该沉淀已被处理");
        err.status = 409;
        throw err;
      }
      for (const a of list) {
        if (!a || typeof a !== "object") continue;
        const title = String(a.title || "").trim().slice(0, 100);
        const content = String(a.content || "").trim();
        if (!title || !content) continue;
        const ids = Array.isArray(a.sourceMessageIds)
          ? a.sourceMessageIds.filter((id) => validIds.has(id))
          : [];
        if (ids.length === 0) continue;
        const type = ARTIFACT_TYPES.includes(a.type) ? a.type : "结论";
        const sourceSnapshot = ids.map((id) => frozenById.get(id)).filter(Boolean).map((m) => ({
          id: m.messageId, role: m.role, content: m.content,
        }));
        const row = (
          await client.query(
            "INSERT INTO artifacts (task_id, source_conversation_id, title, type, summary, " +
              "content, source_message_ids, source_snapshot, source_conversation_title) " +
              "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) " +
              "RETURNING id, task_id, source_conversation_id, title, type, summary, content, " +
              "source_message_ids, created_at, updated_at",
            [
              job.task_id,
              job.conversation_id,
              title,
              type,
              String(a.summary || "").trim().slice(0, 300),
              content,
              ids,
              JSON.stringify(sourceSnapshot),
              sourceTitle,
            ]
          )
        ).rows[0];
        saved.push(row);
      }
      if (!saved.length) {
        const err = new Error("没有有效的成果可保存");
        err.status = 400;
        throw err;
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
      throw e;
    }
    client.release();
    console.log(`[deposition] job=${job.id.slice(0, 8)} confirmed artifacts=${saved.length}`);
    res.status(201).json({
      artifacts: saved.map((r) => ({
        id: r.id,
        taskId: r.task_id,
        sourceConversationId: r.source_conversation_id,
        title: r.title,
        type: r.type,
        summary: r.summary,
        content: r.content,
        sourceMessageIds: r.source_message_ids || [],
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    });
  })
);

router.post(
  "/:id/discard",
  ah(async (req, res) => {
    const job = await findJob(req.params.id);
    if (!["ready", "failed"].includes(job.status)) {
      return res.status(409).json({ error: "该沉淀不在可放弃状态" });
    }
    // 放弃 — does NOT advance the stage cursor; the user can re-deposit the
    // same source later. ready: give up the candidates; failed: give up the
    // attempt (replaces the removed skip entry as the way to clear a stuck
    // job without advancing the cursor).
    const changed = await db
      .getPool()
      .query(
        "UPDATE deposition_jobs SET status='discarded', outcome='abandoned', completed_at=now(), updated_at=now() WHERE id=$1 AND status IN ('ready','failed')",
        [job.id]
      );
    if (!changed.rowCount) return res.status(409).json({ error: "该沉淀已被处理" });
    console.log(`[deposition] job=${job.id.slice(0, 8)} abandoned by user (cursor NOT advanced)`);
    res.json({ job: { id: job.id, status: "discarded" } });
  })
);

// Re-analyze: for a ready job, restart AI analysis keeping the frozen source unchanged.
router.post(
  "/:id/reanalyze", demo.limit("deposition"),
  ah(async (req, res) => {
    const job = await findJob(req.params.id);
    if (job.status !== "ready") {
      return res.status(409).json({ error: "只有待确认状态的沉淀可以重新分析" });
    }
    const changed = await db
      .getPool()
      .query(
        "UPDATE deposition_jobs SET status='processing', candidate_artifacts=NULL, error_message=NULL, updated_at=now() WHERE id=$1 AND status='ready'",
        [job.id]
      );
    if (!changed.rowCount) return res.status(409).json({ error: "该沉淀已被处理" });
    runDeposition(job.id).catch((e) => console.error("[deposition] reanalyze crashed:", e.message));
    console.log(`[deposition] job=${job.id.slice(0, 8)} re-analyzing (frozen source reused)`);
    res.json({ job: { id: job.id, status: "processing" } });
  })
);

router.post(
  "/:id/retry", demo.limit("deposition"),
  ah(async (req, res) => {
    const job = await findJob(req.params.id);
    if (job.status !== "failed") {
      return res.status(409).json({ error: "只有失败的沉淀可以重试" });
    }
    const changed = await db
      .getPool()
      .query(
        "UPDATE deposition_jobs SET status='processing', error_message=NULL, updated_at=now() WHERE id=$1 AND status='failed'",
        [job.id]
      );
    if (!changed.rowCount) return res.status(409).json({ error: "该沉淀已被处理" });
    // Reuses the job's ORIGINAL frozen source_snapshot (no new messages).
    runDeposition(job.id).catch((e) => console.error("[deposition] retry crashed:", e.message));
    console.log(`[deposition] job=${job.id.slice(0, 8)} retrying (frozen source reused)`);
    res.json({ job: { id: job.id, status: "processing" } });
  })
);

module.exports = router;
