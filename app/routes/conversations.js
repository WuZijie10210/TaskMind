// app/routes/conversations.js — conversation & chat endpoints.
//
//   GET  /api/conversations/:id/messages   full persisted history (reload after refresh)
//   POST /api/conversations/:id/chat       streaming chat (SSE)
//
// Chat protocol (POST, body { content?: string }):
//   1. If content is non-empty it is persisted as a user message.
//   2. The AI context is assembled by app/lib/context.js — the single source
//      of truth for what the model receives:
//        main   -> the main conversation's own messages
//        branch -> the frozen main-history snapshot taken at branch creation
//                  + this branch's own messages
//   3. Deltas are streamed to the client as SSE `data:` frames:
//        {"type":"user","message":{...}}   saved user message (if any)
//        {"type":"start"}
//        {"type":"delta","text":"..."}
//        {"type":"done","message":{...},"task":{...}|null,"conversation":{...}|null}
//        {"type":"error","error":"...","message":{...}|null}
//   4. The final assistant message is persisted BEFORE "done" is emitted, so a
//      page refresh always shows the saved reply. If the client disconnects
//      mid-stream the server keeps consuming the model stream and still saves.
//
// Auto-naming (first exchange only, best effort):
//   main   -> the TASK title is refined by a small non-streaming AI call
//             (heuristic fallback title stays if it fails)
//   branch -> the CONVERSATION title is refined the same way; fallback is a
//             truncation of the branch's first user message. Never renamed again.

const express = require("express");
const db = require("../services/db");
const ai = require("../services/ai");
const demo = require("../lib/demo");
const { ah, isUuid, toTask, toConversation, toMessage, toMessageReferenceLite, fallbackTitle } = require("../lib/helpers");
const { buildAiMessages, inheritedCount } = require("../lib/context");
const { resolveReference, normalizeReferenceInputs } = require("../lib/reference");

const router = express.Router();
router.use("/:id", demo.protect(demo.ownsConversation, (req) => req.params.id));

const SYSTEM_PROMPT = [
  "你是 TaskMind，一个面向大学生学习任务的 AI 助手。用户会在任务里围绕课程汇报、论文、研究分析等复杂学习任务与你进行多轮对话。",
  "请遵守：",
  "1. 默认使用简体中文回答（用户明确切换语言时除外）。",
  "2. 回答使用 Markdown 排版：要点用列表、结构用小标题、对比用表格、代码用代码块。",
  "3. 内容具体、可操作：既给结构也给内容，必要时给出可直接使用的段落或讲稿。",
  "4. 面对复杂任务，主动拆解为清晰的推进步骤；用户目标不清晰时，先帮用户理清目标再展开。",
  "5. 不编造不存在的文献、数据或来源，不确定时明确说明。",
].join("\n");

async function findConversation(id) {
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

const INSERT_ASSISTANT =
  "INSERT INTO messages (conversation_id, role, content) VALUES ($1, 'assistant', $2) " +
  "RETURNING id, conversation_id, role, content, created_at";

// Generate a short title from the first user message. Best effort; caller
// supplies the fallback. Returns the cleaned title or null.
async function aiShortTitle(firstUserContent) {
  const raw = await ai.chat(
    [
      {
        role: "user",
        content:
          "请为下面的对话请求生成一个简短标题，要求：不超过 12 个字；概括请求的主题；只输出标题本身，不要引号、标点或任何解释。\n\n请求内容：\n" +
          firstUserContent,
      },
    ],
    { maxTokens: 100 }
  );
  return raw
    .trim()
    .split(/\r?\n/)[0]
    .replace(/^[“”"'「『]+|[””"'」』]+$/g, "")
    .slice(0, 24)
    .trim();
}

// References of a set of message ids, grouped by message id (DB rows).
async function referencesByMessage(messageIds) {
  if (!messageIds.length) return {};
  const { rows } = await db
    .getPool()
    .query("SELECT * FROM message_references WHERE message_id = ANY($1)", [messageIds]);
  const map = {};
  for (const r of rows) (map[r.message_id] || (map[r.message_id] = [])).push(r);
  return map;
}

// Branch origin locator (UX patch 2026-09-22): where in the main
// conversation this branch was spawned from. Pure read — snapshot semantics
// are NOT touched. Response:
//   { mainConversationId, originMessageId, excerpt, role, found }
// excerpt prefers the LIVE main message; if it was deleted we fall back to
// the frozen copy inside parent_context_snapshot (branches never lose it);
// a legacy branch with neither yields found:false + no excerpt and the UI
// shows a degraded line instead of an error.
router.get(
  "/:id/origin",
  ah(async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: "conversation not found" });
    const { rows } = await db
      .getPool()
      .query(
        "SELECT id, task_id, type, origin_main_message_id, parent_context_snapshot FROM conversations WHERE id = $1",
        [req.params.id]
      );
    const conv = rows[0];
    if (!conv) return res.status(404).json({ error: "conversation not found" });
    if (conv.type !== "branch") return res.status(400).json({ error: "not a branch" });

    const main = (
      await db
        .getPool()
        .query("SELECT id FROM conversations WHERE task_id = $1 AND type = 'main'", [conv.task_id])
    ).rows[0];

    let originMessageId = conv.origin_main_message_id || null;
    let excerpt = null;
    let role = null;
    let found = false;

    if (originMessageId) {
      const m = (
        await db
          .getPool()
          .query("SELECT role, content FROM messages WHERE id = $1", [originMessageId])
      ).rows[0];
      if (m) {
        found = true;
        excerpt = m.content;
        role = m.role;
      }
    }
    if (!found && conv.parent_context_snapshot) {
      const frozen = Array.isArray(conv.parent_context_snapshot.messages)
        ? conv.parent_context_snapshot.messages
        : [];
      const last = frozen[frozen.length - 1];
      if (last) {
        // origin message no longer live in main (deleted): still show the
        // frozen text; jumping back will fall back to a plain main switch.
        excerpt = last.content;
        role = last.role;
      }
    }
    res.json({
      mainConversationId: main ? main.id : null,
      originMessageId,
      excerpt: excerpt ? String(excerpt).replace(/\s+/g, " ").slice(0, 120) : null,
      role,
      found,
    });
  })
);

router.get(
  "/:id/messages",
  ah(async (req, res) => {
    const conversation = await findConversation(req.params.id);
    const { rows } = await db.getPool().query(
      "SELECT id, conversation_id, role, content, created_at FROM messages " +
        "WHERE conversation_id = $1 ORDER BY created_at ASC, id ASC",
      [conversation.id]
    );
    const refMap = await referencesByMessage(rows.map((r) => r.id));
    res.json({
      conversation: toConversation(conversation),
      messages: rows.map((m) => ({
        ...toMessage(m),
        references: (refMap[m.id] || []).map(toMessageReferenceLite),
      })),
    });
  })
);

router.post(
  "/:id/chat", demo.limit("chat"),
  ah(async (req, res) => {
    const conversation = await findConversation(req.params.id);
    const content =
      typeof (req.body || {}).content === "string" ? req.body.content.trim() : "";
    const refInputs = normalizeReferenceInputs((req.body || {}).references);
    if (refInputs.length > 0 && !content) {
      return res.status(400).json({ error: "引用时请同时输入消息内容" });
    }
    const pool = db.getPool();
    // One turn at a time per conversation, including the model stream. A
    // session advisory lock works across web workers and releases on failure.
    const turnClient = await pool.connect();
    const lockKey = `taskmind:chat:${conversation.id}`;
    let locked = false;
    try {
      locked = (await turnClient.query("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [lockKey])).rows[0].locked;
      if (!locked) return res.status(409).json({ error: "该对话正在生成回复，请稍后再试" });

    // 1. Conversation history BEFORE this turn (used as selector context).
    const prevHistory = (
      await pool.query(
        "SELECT role, content FROM messages WHERE conversation_id = $1 " +
          "ORDER BY created_at ASC, id ASC",
        [conversation.id]
      )
    ).rows.map((r) => ({ role: r.role, content: r.content }));

    // 2. Resolve @references BEFORE anything is persisted: direct @Artifact
    //    freezes the artifact; @Task runs the AI selector over that task's
    //    CONFIRMED artifacts only. A bad reference fails cleanly here.
    let resolvedRefs = [];
    if (refInputs.length > 0) {
      for (const input of refInputs) {
        resolvedRefs.push(await resolveReference(input, { history: prevHistory, userContent: content, guestId: req.guestId }));
      }
    }

    // 3. Persist the incoming user message (if any), then its references.
    let userMessage = null;
    if (content) {
      await turnClient.query("BEGIN");
      try {
      const { rows } = await turnClient.query(
        "INSERT INTO messages (conversation_id, role, content) VALUES ($1, 'user', $2) " +
          "RETURNING id, conversation_id, role, content, created_at",
        [conversation.id, content]
      );
      userMessage = rows[0];
      for (const ref of resolvedRefs) {
        await turnClient.query(
          "INSERT INTO message_references (message_id, reference_type, reference_id, " +
            "display_title, resolved_artifact_ids, artifact_snapshots) " +
            "VALUES ($1, $2, $3, $4, $5, $6)",
          [
            userMessage.id,
            ref.referenceType,
            ref.referenceId,
            ref.displayTitle,
            ref.resolvedArtifactIds,
            JSON.stringify(ref.artifactSnapshots),
          ]
        );
      }
      await turnClient.query("COMMIT");
      } catch (e) {
        await turnClient.query("ROLLBACK").catch(() => {});
        throw e;
      }
    }

    // 4. This conversation's OWN persisted messages (oldest first, with ids so
    //    references can attach) and ALL of its reference rows.
    const ownRows = (
      await pool.query(
        "SELECT id, role, content FROM messages WHERE conversation_id = $1 " +
          "ORDER BY created_at ASC, id ASC",
        [conversation.id]
      )
    ).rows;
    if (!content && ownRows.some((m) => m.role === "assistant")) {
      return res.status(409).json({ error: "这段对话已开始，请输入新消息" });
    }
    const refMap = await referencesByMessage(ownRows.map((r) => r.id));

    // 5. Assemble the model context: branch = frozen snapshot + own; main = own.
    //    User messages carrying references get their FROZEN artifact snapshots
    //    rendered in. This is the exact payload sent to the AI gateway —
    //    logged (counts only, never content, never credentials).
    const aiMessages = buildAiMessages(conversation, ownRows, refMap);
    const inherited = inheritedCount(conversation);
    const refCount = Object.values(refMap).reduce((n, arr) => n + arr.length, 0);
    console.log(
      `[chat] conv=${conversation.id.slice(0, 8)} type=${conversation.type} ` +
        `own=${ownRows.length} inherited=${inherited} refs=${refCount} sent=${aiMessages.length}`
    );

    // 4. SSE stream.
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();

    let clientGone = false;
    res.on("close", () => {
      clientGone = true;
    });
    const send = (obj) => {
      if (!clientGone) res.write(`data: ${JSON.stringify(obj)}\n\n`);
    };

    if (userMessage) {
      send({
        type: "user",
        message: toMessage(userMessage),
        references: resolvedRefs.map(toMessageReferenceLite),
      });
    }
    send({ type: "start" });

    let full = "";
    try {
      for await (const delta of ai.chatStream(aiMessages, {
        system: SYSTEM_PROMPT,
        maxTokens: 4096,
      })) {
        full += delta;
        send({ type: "delta", text: delta });
      }
    } catch (e) {
      console.error("[chat] stream error:", e.message);
      // Best effort: keep whatever partial content arrived.
      let saved = null;
      if (full.trim()) {
        saved = (await pool.query(INSERT_ASSISTANT, [conversation.id, full])).rows[0];
        await pool.query("UPDATE tasks SET updated_at = now() WHERE id = $1", [
          conversation.task_id,
        ]);
      }
      send({ type: "error", error: `AI 生成失败：${e.message}`, message: saved ? toMessage(saved) : null });
      if (!clientGone) res.end();
      return;
    }

    if (!full.trim()) {
      send({ type: "error", error: "AI 返回内容为空，请重试" });
      if (!clientGone) res.end();
      return;
    }

    // 5. Persist the final assistant reply, then confirm to the client.
    const saved = (await pool.query(INSERT_ASSISTANT, [conversation.id, full])).rows[0];
    await pool.query("UPDATE tasks SET updated_at = now() WHERE id = $1", [conversation.task_id]);

    // First exchange -> auto-naming, exactly once.
    let task = null;
    let conversationUpdate = null;
    const firstUser = ownRows.find((m) => m.role === "user");
    if (ownRows.length <= 2 && firstUser) {
      if (conversation.type === "main") {
        try {
          const cleaned = await aiShortTitle(firstUser.content);
          const title = cleaned || fallbackTitle(firstUser.content);
          await pool.query("UPDATE tasks SET title = $1 WHERE id = $2", [
            title,
            conversation.task_id,
          ]);
          task = { id: conversation.task_id, title };
        } catch (e) {
          console.error("[chat] task title refine failed:", e.message);
        }
      } else if (conversation.type === "branch") {
        let title = null;
        try {
          title = await aiShortTitle(firstUser.content);
        } catch (e) {
          console.error("[chat] branch title refine failed:", e.message);
        }
        title = title || fallbackTitle(firstUser.content);
        await pool.query("UPDATE conversations SET title = $1 WHERE id = $2", [
          title,
          conversation.id,
        ]);
        conversationUpdate = { id: conversation.id, title };
      }
    }

    send({ type: "done", message: toMessage(saved), task, conversation: conversationUpdate });
    if (!clientGone) res.end();
    } finally {
      if (locked) await turnClient.query("SELECT pg_advisory_unlock(hashtext($1))", [lockKey]).catch(() => {});
      turnClient.release();
    }
  })
);

module.exports = router;
