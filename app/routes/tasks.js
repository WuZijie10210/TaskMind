// app/routes/tasks.js — Task endpoints.
//
//   GET  /api/tasks        list all tasks (most recently active first)
//   POST /api/tasks        home-page creation flow: atomically creates
//                          task + main conversation + first user message
//   GET  /api/tasks/:id    task detail + its conversations (sidebar data)
//   PATCH /api/tasks/:taskId/artifacts/:artifactId   rename an artifact
//   DELETE /api/tasks/:taskId/artifacts/:artifactId  delete an artifact

const express = require("express");
const db = require("../services/db");
const demo = require("../lib/demo");
const { seedGuestExamples } = require("../lib/guest-examples");
const { ah, isUuid, toTask, toConversation, toMessage, toArtifact, toDepositionJob, fallbackTitle } = require("../lib/helpers");

const router = express.Router();
router.use("/:id", demo.protect(demo.ownsTask, (req) => req.params.id));

router.get(
  "/",
  ah(async (req, res) => {
    await seedGuestExamples(req.guestId);
    const { rows } = await db
      .getPool()
      .query("SELECT id, title, created_at, updated_at FROM tasks WHERE guest_id=$1 ORDER BY updated_at DESC", [req.guestId]);
    res.json({ tasks: rows.map(toTask) });
  })
);

router.post(
  "/", demo.limit("task"),
  ah(async (req, res) => {
    const firstMessage =
      typeof (req.body || {}).firstMessage === "string" ? req.body.firstMessage.trim() : "";
    if (!firstMessage) return res.status(400).json({ error: "firstMessage 不能为空" });
    if (firstMessage.length > 20000) return res.status(400).json({ error: "消息过长" });

    const client = await db.getPool().connect();
    try {
      await client.query("BEGIN");
      const t = (
        await client.query(
          "INSERT INTO tasks (title, guest_id) VALUES ($1, $2) RETURNING id, title, created_at, updated_at",
          [fallbackTitle(firstMessage), req.guestId]
        )
      ).rows[0];
      const c = (
        await client.query(
          "INSERT INTO conversations (task_id, type, title) VALUES ($1, 'main', '主线对话') " +
            "RETURNING id, task_id, type, title, created_at",
          [t.id]
        )
      ).rows[0];
      const m = (
        await client.query(
          "INSERT INTO messages (conversation_id, role, content) VALUES ($1, 'user', $2) " +
            "RETURNING id, conversation_id, role, content, created_at",
          [c.id, firstMessage]
        )
      ).rows[0];
      await client.query("COMMIT");
      res.status(201).json({
        task: toTask(t),
        conversation: toConversation(c),
        messages: [toMessage(m)],
      });
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  })
);

router.get(
  "/:id",
  ah(async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: "task not found" });
    const t = (
      await db
        .getPool()
        .query("SELECT id, title, created_at, updated_at FROM tasks WHERE id = $1", [req.params.id])
    ).rows[0];
    if (!t) return res.status(404).json({ error: "task not found" });
    const convs = (
      await db
        .getPool()
        .query(
          "SELECT id, task_id, type, title, created_at, origin_main_message_id FROM conversations " +
            "WHERE task_id = $1 ORDER BY created_at ASC",
          [t.id]
        )
    ).rows;
    res.json({ task: toTask(t), conversations: convs.map(toConversation) });
  })
);

// Create a branch conversation for this task.
//
// The branch inherits a FROZEN snapshot of the main line's history at this
// exact moment (all current user/assistant messages, in order). Later main
// messages never reach this branch. Runs in a transaction so the snapshot is
// consistent even if the main line is being written concurrently.
router.post(
  "/:id/branches",
  ah(async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: "task not found" });
    const client = await db.getPool().connect();
    let branchLock = null;
    try {
      await client.query("BEGIN");
      const t = (
        await client.query("SELECT id FROM tasks WHERE id = $1 FOR SHARE", [req.params.id])
      ).rows[0];
      if (!t) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "task not found" });
      }
      const main = (
        await client.query(
          "SELECT id FROM conversations WHERE task_id = $1 AND type = 'main'",
          [t.id]
        )
      ).rows[0];
      if (!main) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "主线对话不存在" });
      }
      branchLock = `taskmind:chat:${main.id}`;
      const acquired = (await client.query("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [branchLock])).rows[0].locked;
      if (!acquired) {
        branchLock = null;
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "主线正在生成回复，请完成后创建支线" });
      }
      const mainMsgs = (
        await client.query(
          "SELECT id, role, content, created_at FROM messages WHERE conversation_id = $1 " +
            "ORDER BY created_at ASC, id ASC",
          [main.id]
        )
      ).rows;
      const snapshot = {
        conversationId: main.id,
        taskId: t.id,
        capturedAt: new Date().toISOString(),
        messageCount: mainMsgs.length,
        messages: mainMsgs.map((m) => ({
          messageId: m.id,
          role: m.role,
          content: m.content,
          createdAt: m.created_at,
        })),
      };
      const b = (
        await client.query(
          "INSERT INTO conversations (task_id, type, title, parent_context_snapshot, origin_main_message_id) " +
            "VALUES ($1, 'branch', '新支线', $2, $3) " +
            "RETURNING id, task_id, type, title, created_at, origin_main_message_id",
          [t.id, JSON.stringify(snapshot), mainMsgs.length ? mainMsgs[mainMsgs.length - 1].id : null]
        )
      ).rows[0];
      await client.query("COMMIT");
      res.status(201).json({ conversation: toConversation(b) });
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      if (branchLock) await client.query("SELECT pg_advisory_unlock(hashtext($1))", [branchLock]).catch(() => {});
      client.release();
    }
  })
);

// Deposition jobs of this task (sidebar poll: processing/ready/failed states).
router.get(
  "/:id/depositions",
  ah(async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: "task not found" });
    const t = (
      await db.getPool().query("SELECT id FROM tasks WHERE id = $1", [req.params.id])
    ).rows[0];
    if (!t) return res.status(404).json({ error: "task not found" });
    const { rows } = await db
      .getPool()
      .query(
        "SELECT * FROM deposition_jobs WHERE task_id = $1 ORDER BY created_at DESC LIMIT 30",
        [t.id]
      );
    res.json({ jobs: rows.map(toDepositionJob) });
  })
);

// Confirmed artifacts of this task (成果 view, read-only for now).
router.get(
  "/:id/artifacts",
  ah(async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: "task not found" });
    const t = (
      await db.getPool().query("SELECT id FROM tasks WHERE id = $1", [req.params.id])
    ).rows[0];
    if (!t) return res.status(404).json({ error: "task not found" });
    const { rows } = await db
      .getPool()
      .query(
        "SELECT a.*, c.title AS source_conversation_title, c.type AS source_conversation_type " +
          "FROM artifacts a LEFT JOIN conversations c ON c.id = a.source_conversation_id " +
          "WHERE a.task_id = $1 ORDER BY a.created_at DESC",
        [t.id]
      );
    res.json({
      artifacts: rows.map((r) => ({
        ...toArtifact(r),
        sourceConversationTitle: r.source_conversation_title || "已删除对话",
        sourceConversationType: r.source_conversation_type || null,
      })),
    });
  })
);

// Rename an artifact (title only; type/summary/content/provenance unchanged).
router.patch(
  "/:taskId/artifacts/:artifactId",
  ah(async (req, res) => {
    if (!isUuid(req.params.taskId)) return res.status(404).json({ error: "task not found" });
    if (!isUuid(req.params.artifactId)) return res.status(404).json({ error: "artifact not found" });
    const title = typeof (req.body || {}).title === "string" ? req.body.title.trim() : "";
    if (!title) return res.status(400).json({ error: "title 不能为空" });
    if (title.length > 100) return res.status(400).json({ error: "title 过长" });
    const { rows } = await db
      .getPool()
      .query(
        "UPDATE artifacts SET title=$3, updated_at=now() WHERE id=$2 AND task_id=$1 " +
          "RETURNING id, task_id, source_conversation_id, title, type, summary, content, " +
          "source_message_ids, created_at, updated_at",
        [req.params.taskId, req.params.artifactId, title]
      );
    if (!rows[0]) return res.status(404).json({ error: "artifact not found" });
    res.json({ artifact: toArtifact(rows[0]) });
  })
);

// Delete an artifact. Frozen snapshots inside message_references are
// intentionally KEPT — historical AI context must never be rewritten
// (same freezing principle as branch snapshots).
router.delete(
  "/:taskId/artifacts/:artifactId",
  ah(async (req, res) => {
    if (!isUuid(req.params.taskId)) return res.status(404).json({ error: "task not found" });
    if (!isUuid(req.params.artifactId)) return res.status(404).json({ error: "artifact not found" });
    const { rowCount } = await db
      .getPool()
      .query("DELETE FROM artifacts WHERE id=$1 AND task_id=$2", [
        req.params.artifactId,
        req.params.taskId,
      ]);
    if (!rowCount) return res.status(404).json({ error: "artifact not found" });
    res.json({ deleted: true });
  })
);

// Rename a task.
router.patch(
  "/:id",
  ah(async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: "task not found" });
    const title = typeof (req.body || {}).title === "string" ? req.body.title.trim() : "";
    if (!title) return res.status(400).json({ error: "title 不能为空" });
    if (title.length > 200) return res.status(400).json({ error: "title 过长" });
    const { rows } = await db
      .getPool()
      .query("UPDATE tasks SET title=$2, updated_at=now() WHERE id=$1 RETURNING id, title, created_at, updated_at", [req.params.id, title]);
    if (!rows[0]) return res.status(404).json({ error: "task not found" });
    res.json({ task: toTask(rows[0]) });
  })
);

// Delete a task (cascades to all conversations, messages, artifacts, etc.).
router.delete(
  "/:id",
  ah(async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: "task not found" });
    const { rowCount } = await db.getPool().query("DELETE FROM tasks WHERE id=$1", [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: "task not found" });
    res.json({ deleted: true });
  })
);

// Rename a branch conversation.
router.patch(
  "/:taskId/branches/:branchId",
  ah(async (req, res) => {
    if (!isUuid(req.params.taskId)) return res.status(404).json({ error: "task not found" });
    if (!isUuid(req.params.branchId)) return res.status(404).json({ error: "conversation not found" });
    const title = typeof (req.body || {}).title === "string" ? req.body.title.trim() : "";
    if (!title) return res.status(400).json({ error: "title 不能为空" });
    if (title.length > 200) return res.status(400).json({ error: "title 过长" });
    const { rows } = await db
      .getPool()
      .query(
        "UPDATE conversations SET title=$3 WHERE id=$2 AND task_id=$1 AND type='branch' " +
          "RETURNING id, task_id, type, title, created_at",
        [req.params.taskId, req.params.branchId, title]
      );
    if (!rows[0]) return res.status(404).json({ error: "conversation not found" });
    res.json({ conversation: toConversation(rows[0]) });
  })
);

// Delete a branch conversation (only branches; main is immutable).
// Does NOT cascade-delete confirmed Artifacts (FK is ON DELETE SET NULL).
router.delete(
  "/:taskId/branches/:branchId",
  ah(async (req, res) => {
    if (!isUuid(req.params.taskId)) return res.status(404).json({ error: "task not found" });
    if (!isUuid(req.params.branchId)) return res.status(404).json({ error: "conversation not found" });
    const { rowCount } = await db
      .getPool()
      .query("DELETE FROM conversations WHERE id=$1 AND task_id=$2 AND type='branch'", [
        req.params.branchId,
        req.params.taskId,
      ]);
    if (!rowCount) return res.status(404).json({ error: "conversation not found or is main" });
    res.json({ deleted: true });
  })
);

// Reference picker options for @-mentions: all confirmed artifacts (current
// task first) + all tasks that HAVE confirmed artifacts. Tasks without
// artifacts are not useful @Task candidates.
router.get(
  "/:id/reference-options",
  ah(async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: "task not found" });
    const t = (
      await db.getPool().query("SELECT id FROM tasks WHERE id = $1", [req.params.id])
    ).rows[0];
    if (!t) return res.status(404).json({ error: "task not found" });
    const arts = (
      await db.getPool().query(
        "SELECT a.id, a.title, a.type, a.summary, a.task_id, tk.title AS task_title " +
          "FROM artifacts a JOIN tasks tk ON tk.id = a.task_id " +
          "WHERE tk.guest_id=$2 ORDER BY (a.task_id = $1) DESC, a.created_at DESC",
        [t.id, req.guestId]
      )
    ).rows;
    // LEFT JOIN: every task shows up even with 0 confirmed artifacts — the
    // picker must list them ("暂无成果" + 前往任务沉淀), since @Task is only
    // offered when there is something to select from.
    const tasks = (
      await db.getPool().query(
        "SELECT tk.id, tk.title, count(a.id)::int AS artifact_count " +
          "FROM tasks tk LEFT JOIN artifacts a ON a.task_id = tk.id WHERE tk.guest_id=$2 " +
          "GROUP BY tk.id, tk.title, tk.updated_at " +
          "ORDER BY (tk.id = $1) DESC, tk.updated_at DESC",
        [t.id, req.guestId]
      )
    ).rows;
    res.json({
      artifacts: arts.map((a) => ({
        id: a.id,
        title: a.title,
        type: a.type,
        summary: a.summary || "",
        taskId: a.task_id,
        taskTitle: a.task_title,
      })),
      tasks: tasks.map((x) => ({ id: x.id, title: x.title, artifactCount: x.artifact_count })),
    });
  })
);

module.exports = router;
