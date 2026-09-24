// app/lib/reference.js — @Artifact / @Task reference resolution.
//
//   @Artifact (direct)  -> read the artifact, freeze a full snapshot. No
//                          relevance filtering: the user already chose it.
//   @Task               -> a light AI SELECTOR call decides which of that
//                          task's CONFIRMED artifacts actually help. The
//                          selector only ever sees artifact metadata
//                          (id/title/type/summary) — never the historical
//                          task's raw chat. Its ids are strictly validated
//                          against the task's real artifacts.
//
// Resolution happens BEFORE the chat stream starts and BEFORE the user
// message is persisted (so a bad reference fails cleanly with nothing saved).
// The result rows are inserted into message_references; context.js renders
// the frozen snapshots into the AI payload.

const db = require("../services/db");
const ai = require("../services/ai");
const { isUuid } = require("./helpers");
const { lenientJsonParse } = require("./deposition");

const MAX_REFERENCES_PER_MESSAGE = 5;
const SELECTOR_MAX = 3;
const SELECTOR_HISTORY_MESSAGES = 10;

const SELECTOR_SYSTEM_PROMPT = [
  "你是 TaskMind 的历史成果选择器。",
  "",
  "用户已经明确指定了一个历史 Task 作为可信召回范围。",
  "你的任务是根据当前 Conversation 语境和用户本轮需求，从该 Task 已确认的 Artifact 中选择真正有帮助的成果。",
  "",
  "规则：",
  "1. 只能选择提供给你的 Artifact ID；",
  "2. 可以选择 0～3 项；",
  "3. 不需要为了使用历史内容而强行选择；",
  "4. 只根据 title / type / summary 判断相关性；",
  "5. 不生成最终用户答案；",
  "6. 只返回合法 JSON。",
  "",
  "输出格式（只输出 JSON 本身，不要 markdown，不要解释）：",
  '{"artifactIds":["artifact-id-1","artifact-id-2"]}',
  "",
  "如果没有相关成果：",
  '{"artifactIds":[]}',
].join("\n");

// --- pure helpers (exported for tests) ---------------------------------------

function artifactToSnapshot(row) {
  return {
    id: row.id,
    title: row.title,
    type: row.type,
    summary: row.summary || "",
    content: row.content,
    sourceTaskId: row.task_id,
    sourceConversationId: row.source_conversation_id || null,
  };
}

function buildSelectorUserMessage(taskTitle, artifacts, recentHistory, userContent) {
  const hist =
    (recentHistory || [])
      .slice(-SELECTOR_HISTORY_MESSAGES)
      .map((m) => `[${m.role === "user" ? "用户" : "助手"}] ${m.content}`)
      .join("\n") || "（无）";
  const list =
    artifacts.length === 0
      ? "（无）"
      : artifacts
          .map((a) => `- id: ${a.id} | title: ${a.title} | type: ${a.type} | summary: ${a.summary || "（无）"}`)
          .join("\n");
  return [
    "【Selected Task（用户指定的可信召回范围）】",
    taskTitle,
    "",
    "【Current Conversation Context（用于理解当前语境）】",
    hist,
    "",
    "【Current User Message（用户本轮需求）】",
    userContent,
    "",
    "【Available Confirmed Artifacts（只能从这里选择，只能使用给出的 ID）】",
    list,
    "",
    "请严格按系统指令输出 JSON。",
  ].join("\n");
}

// Parse + validate the selector output. Returns an array of validated ids
// (possibly empty — a valid 0-choice), or null on structural failure.
function validateSelectorOutput(raw, validIds) {
  let text = String(raw || "").trim();
  const wrapped = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (wrapped) text = wrapped[1].trim();
  const s = text.indexOf("{");
  const e = text.lastIndexOf("}");
  if (s >= 0 && e > s) text = text.slice(s, e + 1);
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
  if (!data || !Array.isArray(data.artifactIds)) return null;
  const valid = new Set(validIds);
  const out = [];
  for (const id of data.artifactIds) {
    if (valid.has(id) && !out.includes(id)) out.push(id);
    if (out.length >= SELECTOR_MAX) break;
  }
  return out;
}

// --- DB reads ------------------------------------------------------------------

async function getArtifact(id, guestId) {
  return (await db.getPool().query("SELECT a.* FROM artifacts a JOIN tasks t ON t.id=a.task_id WHERE a.id=$1 AND t.guest_id=$2", [id, guestId])).rows[0] || null;
}

async function getTask(id, guestId) {
  return (await db.getPool().query("SELECT * FROM tasks WHERE id=$1 AND guest_id=$2", [id, guestId])).rows[0] || null;
}

// ONLY confirmed artifacts ever exist in the artifacts table (rows are written
// exclusively by the deposition confirm endpoint), so this read is inherently
// confirmed-artifacts-only.
async function listTaskArtifacts(taskId) {
  return (
    await db.getPool().query("SELECT * FROM artifacts WHERE task_id = $1 ORDER BY created_at ASC", [
      taskId,
    ])
  ).rows;
}

// --- selector run ---------------------------------------------------------------

// One light AI call + one retry on parse failure. A selector that keeps
// failing resolves to [] (the chat proceeds; the UI shows "未找到") — never
// blocks or fails the user's message.
async function runTaskSelector(taskTitle, artifacts, recentHistory, userContent) {
  if (!artifacts.length) return [];
  const userMessage = buildSelectorUserMessage(taskTitle, artifacts, recentHistory, userContent);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await ai.chat([{ role: "user", content: userMessage }], {
        system: SELECTOR_SYSTEM_PROMPT,
        maxTokens: 500,
      });
      const ids = validateSelectorOutput(raw, artifacts.map((a) => a.id));
      if (ids !== null) {
        console.log(
          `[selector] task=${taskTitle} available=${artifacts.length} picked=${ids.length}`
        );
        return ids;
      }
    } catch (e) {
      console.error("[selector] attempt failed:", e.message);
    }
  }
  console.log(`[selector] task=${taskTitle} -> unparseable, resolved to 0`);
  return [];
}

// --- resolution ----------------------------------------------------------------

// input: {type:'artifact'|'task', id}. selectorCtx: {history:[{role,content}],
// userContent}. Returns a message_references payload (camelCase, no
// message_id — the caller inserts it after saving the user message).
async function resolveReference(input, selectorCtx) {
  if (input.type === "artifact") {
    const a = await getArtifact(input.id, selectorCtx.guestId);
    if (!a) {
      const err = new Error("引用的成果不存在");
      err.status = 404;
      throw err;
    }
    return {
      referenceType: "artifact",
      referenceId: a.id,
      displayTitle: a.title,
      resolvedArtifactIds: [a.id],
      artifactSnapshots: [artifactToSnapshot(a)],
    };
  }
  const t = await getTask(input.id, selectorCtx.guestId);
  if (!t) {
    const err = new Error("引用的任务不存在");
    err.status = 404;
    throw err;
  }
  const arts = await listTaskArtifacts(t.id);
  const ids = await runTaskSelector(
    t.title,
    arts,
    (selectorCtx || {}).history || [],
    (selectorCtx || {}).userContent || ""
  );
  const selected = arts.filter((a) => ids.includes(a.id));
  return {
    referenceType: "task",
    referenceId: t.id,
    displayTitle: t.title,
    resolvedArtifactIds: ids,
    artifactSnapshots: selected.map(artifactToSnapshot),
  };
}

// Validate + dedupe the raw request references; throws 400 on bad shape.
function normalizeReferenceInputs(raw) {
  const list = Array.isArray(raw) ? raw : [];
  if (list.length > MAX_REFERENCES_PER_MESSAGE) {
    const err = new Error("一条消息最多引用 5 项");
    err.status = 400;
    throw err;
  }
  const seen = new Set();
  const out = [];
  for (const r of list) {
    if (!r || (r.type !== "artifact" && r.type !== "task") || typeof r.id !== "string" || !isUuid(r.id)) {
      const err = new Error("引用格式不正确");
      err.status = 400;
      throw err;
    }
    const key = r.type + ":" + r.id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ type: r.type, id: r.id });
  }
  return out;
}

module.exports = {
  MAX_REFERENCES_PER_MESSAGE,
  SELECTOR_MAX,
  SELECTOR_SYSTEM_PROMPT,
  artifactToSnapshot,
  buildSelectorUserMessage,
  validateSelectorOutput,
  runTaskSelector,
  resolveReference,
  normalizeReferenceInputs,
};
