// app/lib/deposition.js - deposition (沉淀) core logic.
//
// The refine model's input is strictly organised into three blocks:
//
//   Background Context  - only for understanding the stage's context:
//                         branch -> frozen inherited main snapshot + this
//                         conversation's own messages BEFORE the stage cut-off;
//                         main   -> its own messages before the cut-off.
//   Existing Artifacts  - the task's confirmed artifacts (id/title/type/
//                         summary), only for avoiding duplicates.
//   Source Messages     - the stage's NEW messages (frozen in the job).
//                         ONLY these may produce new candidates.
//
// Stage rule: each new job covers only messages produced after the cut-off of
// the latest confirmed job of the same conversation. failed/discarded jobs do
// NOT advance the cut-off.

const db = require("../services/db");
const ai = require("../services/ai");
const { readSnapshot } = require("./context");

const ARTIFACT_TYPES = ["结论", "案例", "资料", "框架", "判断", "模板", "方法"];
const MAX_CANDIDATES = 4;
const MAX_BACKGROUND_MESSAGES = 40;

const REFINE_SYSTEM_PROMPT = [
  "你是 TaskMind 的阶段成果提炼器。",
  "",
  "你的任务不是总结聊天过程，而是识别本阶段对话中已经形成、未来继续推进当前任务或处理类似任务时值得再次调用的成果。",
  "",
  "成果按价值分为四类，七个底层类型归属如下：",
  "1. 内容成果（结论 / 案例 / 资料）——回答\u201c我已经得到了什么可继续使用的内容？\u201d：已形成的关键结论、洞察或重要信息，有完整使用价值的案例、资料或关键片段。",
  "2. 结构成果（框架）——回答\u201c我已经形成了怎样的组织、分析或论证结构？\u201d：提纲、分析框架、论证结构或分类方式。",
  "3. 判断成果（判断）——回答\u201c我做出了什么选择、取舍或修改决定，为什么？\u201d：用户在讨论中形成的方向选择、方案取舍、修改依据及其理由。",
  "4. 方法成果（模板 / 方法）——回答\u201c以后遇到类似任务，可以复用什么做法？\u201d：可以在以后直接再次使用的模板、方法或流程。",
  "",
  "每个候选成果必须满足：",
  "1. 脱离原始聊天以后仍能够独立理解；",
  "2. 未来重新进入当前任务时，可以帮助用户恢复思路或继续工作，或者可以用于类似任务；",
  "3. 表达的是\u201c聊出了什么\u201d，而不是\u201c刚才聊了什么\u201d；",
  "4. 有明确实际内容；",
  "5. 所有事实和判断都能够追溯到 Source Messages。",
  "",
  "拆分原则——以\u201c未来是否会被单独调用\u201d为主要判断标准：",
  "- 不按消息条数、段落或信息点机械拆分；",
  "- 一组内容如果通常会被一起理解、引用或修改，应合并为一个 Artifact；",
  "- 一部分内容如果可以独立理解，并很可能被单独引用、修改或用于其他任务，应拆成独立 Artifact；",
  "- 避免把多个彼此独立的成果塞进同一个 Artifact；",
  "- 也避免把一个完整成果切成大量没有独立复用价值的小碎片。",
  "",
  "用户主动点击沉淀本身是一个价值信号：",
  "- 只要 Source 中形成了任何可独立复用的内容、结构、判断或方法，就应积极生成 1–4 个候选；",
  "- 不要因为成果还不够完美而过度保守；",
  "- 只有 Source 纯粹是寒暄、确认、过渡，或确实没有形成任何可复用内容时，才返回空数组 {\"artifacts\":[]}。",
  "",
  "Background Context 只用于理解语境，不允许仅依据 Background Context 生成新的成果。",
  "Existing Artifacts 只用于判断是否已经存在明显重复成果。",
  "只有 Source Messages 中实际出现或明确形成的信息才可以成为本次新成果。",
  "可以重新组织 Source 的表达，使成果更加完整、自包含、可复用，但不得增加 Source 无法支持的新事实、新判断或新结论。",
  "",
  "输出格式硬性要求：",
  "- 只输出一个 JSON object，从 { 开始到 } 结束；",
  "- 不输出 markdown 代码块标记，不输出 JSON 前后的任何解释文字；",
  "- JSON 字符串内部出现英文双引号时必须用反斜杠转义（中文引号不需要）；",
  "- 成果 content 中如需展示代码块示例，用缩进或其他方式表示，不要使用 ``` 围栏。",
  "",
  "只输出 JSON，不要输出任何其他文字。输出格式：",
  '{"artifacts":[{"title":"...","type":"结论|案例|资料|框架|判断|模板|方法","summary":"...","content":"...","sourceMessageIds":["消息id"]}]}',
].join("\n");

// --- stage cut-off & source computation -------------------------------------

// The cut-off cursor of the latest cursor-advancing job.
// ONLY a confirmed job (an artifact was actually saved) advances the stage
// cut-off. Discarded (user gave up, incl. failed attempts) and empty (AI found
// nothing) do NOT advance — the user can re-trigger deposition on the same
// source segment. (The old explicit "skip" outcome was removed: nothing but
// confirmation advances the cursor.)
async function latestCursor(pool, conversationId) {
  const { rows } = await pool.query(
    "SELECT cursor_message_id FROM deposition_jobs " +
      "WHERE conversation_id = $1 AND status = 'confirmed' " +
      "ORDER BY completed_at DESC NULLS LAST, updated_at DESC LIMIT 1",
    [conversationId]
  );
  return rows[0] ? rows[0].cursor_message_id : null;
}

async function messagesAfter(pool, conversationId, cursorId) {
  if (!cursorId) {
    const { rows } = await pool.query(
      "SELECT id, role, content, created_at FROM messages WHERE conversation_id = $1 " +
        "ORDER BY created_at ASC, id ASC",
      [conversationId]
    );
    return rows;
  }
  const cur = (
    await pool.query(
      "SELECT created_at, id FROM messages WHERE id = $1 AND conversation_id = $2",
      [cursorId, conversationId]
    )
  ).rows[0];
  if (!cur) {
    // cursor row vanished (defensive); treat as no cut-off
    return messagesAfter(pool, conversationId, null);
  }
  const { rows } = await pool.query(
    "SELECT id, role, content, created_at FROM messages WHERE conversation_id = $1 " +
      "AND (created_at, id) > ($2::timestamptz, $3::uuid) ORDER BY created_at ASC, id ASC",
    [conversationId, cur.created_at, cur.id]
  );
  return rows;
}

// --- refine input assembly (exported for tests) -----------------------------

// Returns { background: [{role, content}], source: [{messageId, role, content}] }.
// Branch background = inherited main snapshot + own messages produced BEFORE
// this stage started. The boundary is source_snapshot.cursorMessageId (the
// PREVIOUS completed stage's cut-off = stage START) - NOT job.cursor_message_id,
// which is the END of the current stage.
async function buildRefineInput(job, conversation) {
  const pool = db.getPool();
  const background = [];
  if (conversation.type === "branch") {
    for (const m of readSnapshot(conversation)) background.push({ role: m.role, content: m.content });
  }
  const stageStartId =
    job.source_snapshot && job.source_snapshot.cursorMessageId
      ? job.source_snapshot.cursorMessageId
      : null;
  if (stageStartId) {
    const cur = (
      await pool.query(
        "SELECT created_at, id FROM messages WHERE id = $1 AND conversation_id = $2",
        [stageStartId, conversation.id]
      )
    ).rows[0];
    if (cur) {
      const own = (
        await pool.query(
          "SELECT role, content FROM messages WHERE conversation_id = $1 " +
            "AND (created_at, id) <= ($2::timestamptz, $3::uuid) ORDER BY created_at ASC, id ASC",
          [conversation.id, cur.created_at, cur.id]
        )
      ).rows;
      for (const m of own) background.push({ role: m.role, content: m.content });
    }
  }
  // Keep the most recent context only (prompt budget).
  const backgroundTrimmed = background.slice(-MAX_BACKGROUND_MESSAGES);
  const snapshot = job.source_snapshot || {};
  const source = (Array.isArray(snapshot.messages) ? snapshot.messages : []).map((m) => ({
    messageId: m.messageId,
    role: m.role,
    content: m.content,
  }));
  return { background: backgroundTrimmed, source };
}

function buildRefineUserMessage(input, existingArtifacts) {
  const bg =
    input.background.length === 0
      ? "（无）"
      : input.background.map((m) => `[${m.role === "user" ? "用户" : "助手"}] ${m.content}`).join("\n\n");
  const ex =
    existingArtifacts.length === 0
      ? "（暂无）"
      : existingArtifacts
          .map((a) => `- 《${a.title}》（${a.type}）：${a.summary || "（无摘要）"}`)
          .join("\n");
  const src = input.source
    .map((m) => `[${m.messageId} ${m.role === "user" ? "用户" : "助手"}]：${m.content}`)
    .join("\n\n");
  return [
    "【Background Context｜仅用于理解语境，不得作为新成果的来源】",
    bg,
    "",
    "【Existing Artifacts｜该任务已保存的成果，仅用于避免生成重复成果】",
    ex,
    "",
    "【Source Messages｜本阶段新增消息；只有这里实际出现或明确形成的信息才可以成为本次新成果】",
    src,
    "",
    "请严格按系统指令输出 JSON，只输出 JSON 本身。",
  ].join("\n");
}

// --- model output parsing & validation ---------------------------------------

// Tolerant JSON parse for the common LLM failure mode: unescaped `"` inside
// string values (e.g. 给观众一张"地图"). Walks the text; a `"` inside a
// string is treated as the terminator ONLY if the next non-space char is a
// JSON structural char, otherwise it is escaped.
function lenientJsonParse(text) {
  let out = "";
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (!inStr) {
      if (c === '"') inStr = true;
      out += c;
    } else if (c === "\\") {
      out += c + (text[i + 1] || "");
      i++;
    } else if (c === '"') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      const next = text[j];
      if (next === undefined || [",", ":", "}", "]"].includes(next)) {
        inStr = false;
        out += c;
      } else {
        out += '\\"'; // embedded quote - escape it
      }
    } else {
      out += c;
    }
  }
  return JSON.parse(out);
}

function coerceType(t) {
  const s = String(t || "");
  const hit = ARTIFACT_TYPES.find((k) => s.includes(k));
  return hit || "结论";
}

// Parse & validate the model output against the frozen source ids.
// Returns a candidate array (possibly empty) or null on structural failure
// (caller retries once, then the job fails).
function parseCandidates(raw, validSourceIds) {
  let text = String(raw || "").trim();
  // Strip an OUTER markdown fence only when the whole output is wrapped in
  // one (```json ... ```). Interior ``` inside artifact content (markdown
  // examples) must NOT be touched - an unanchored match here used to truncate
  // the JSON at the first interior fence and break every parse.
  const wrapped = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (wrapped) text = wrapped[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) text = text.slice(start, end + 1);
  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    try {
      data = lenientJsonParse(text);
    } catch (_) {
      return null;
    }
  }
  if (!data || !Array.isArray(data.artifacts)) return null;
  const idSet = new Set(validSourceIds);
  const out = [];
  for (const c of data.artifacts.slice(0, MAX_CANDIDATES)) {
    if (!c || typeof c !== "object") continue;
    const title = String(c.title || "").trim().slice(0, 100);
    const content = String(c.content || "").trim();
    if (!title || !content) continue;
    const ids = Array.isArray(c.sourceMessageIds)
      ? c.sourceMessageIds.filter((id) => idSet.has(id))
      : [];
    if (ids.length === 0) continue; // not traceable to this stage's source
    out.push({
      title,
      type: coerceType(c.type),
      summary: String(c.summary || "").trim().slice(0, 300),
      content,
      sourceMessageIds: ids,
    });
  }
  return out;
}

// --- background runner --------------------------------------------------------

// Runs the AI refine for a processing job (called fire-and-forget after job
// creation and after retry). Uses ONLY the job's frozen source. One light
// retry on parse/AI failure, then the job is marked failed.
async function runDeposition(jobId) {
  const pool = db.getPool();
  try {
    const job = (await pool.query("SELECT * FROM deposition_jobs WHERE id = $1", [jobId])).rows[0];
    if (!job || job.status !== "processing") return;
    const conv = (
      await pool.query("SELECT * FROM conversations WHERE id = $1", [job.conversation_id])
    ).rows[0];
    if (!conv) {
      await pool.query(
        "UPDATE deposition_jobs SET status='failed', error_message='来源对话不存在', updated_at=now() WHERE id=$1",
        [jobId]
      );
      return;
    }

    const input = await buildRefineInput(job, conv);
    const existing = (
      await pool.query(
        "SELECT id, title, type, summary FROM artifacts WHERE task_id = $1 ORDER BY created_at ASC",
        [job.task_id]
      )
    ).rows;
    const userMessage = buildRefineUserMessage(input, existing);
    console.log(
      `[deposition] job=${jobId.slice(0, 8)} conv=${conv.id.slice(0, 8)} type=${conv.type} ` +
        `source=${input.source.length} background=${input.background.length} existing=${existing.length}`
    );

    let candidates = null;
    let lastErr = null;
    for (let attempt = 0; attempt < 2 && candidates === null; attempt++) {
      try {
        const raw = await ai.chat([{ role: "user", content: userMessage }], {
          system: REFINE_SYSTEM_PROMPT,
          maxTokens: 6000,
        });
        candidates = parseCandidates(raw, job.source_message_ids);
      } catch (e) {
        lastErr = e;
      }
    }
    if (candidates === null) {
      await pool.query(
        "UPDATE deposition_jobs SET status='failed', error_message=$2, updated_at=now() WHERE id=$1",
        [jobId, `AI 提炼失败：${(lastErr && lastErr.message) || "输出无法解析"}`]
      );
      console.log(`[deposition] job=${jobId.slice(0, 8)} -> failed`);
      return;
    }
    if (candidates.length === 0) {
      // Nothing worth keeping: end the job and advance the stage cut-off.
      await pool.query(
        "UPDATE deposition_jobs SET status='discarded', outcome='empty', " +
          "candidate_artifacts='[]'::jsonb, completed_at=now(), updated_at=now() WHERE id=$1",
        [jobId]
      );
      console.log(`[deposition] job=${jobId.slice(0, 8)} -> empty (0 candidates)`);
      return;
    }
    await pool.query(
      "UPDATE deposition_jobs SET status='ready', candidate_artifacts=$2, " +
        "completed_at=now(), updated_at=now() WHERE id=$1",
      [jobId, JSON.stringify(candidates)]
    );
    console.log(`[deposition] job=${jobId.slice(0, 8)} -> ready candidates=${candidates.length}`);
  } catch (e) {
    await pool
      .query(
        "UPDATE deposition_jobs SET status='failed', error_message=$2, updated_at=now() " +
          "WHERE id=$1 AND status='processing'",
        [jobId, e.message]
      )
      .catch(() => {});
    console.error("[deposition] run error:", e.message);
  }
}

module.exports = {
  ARTIFACT_TYPES,
  REFINE_SYSTEM_PROMPT,
  lenientJsonParse,
  latestCursor,
  messagesAfter,
  buildRefineInput,
  buildRefineUserMessage,
  parseCandidates,
  runDeposition,
};
