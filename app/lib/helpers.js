// app/lib/helpers.js — shared utilities for TaskMind routes.

// Wrap async route handlers so rejections reach the error middleware
// (Express 4 does not catch async errors itself).
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s) => UUID_RE.test(String(s || ""));

// snake_case DB rows -> camelCase API objects (stable contract for the frontend).
const toTask = (r) => ({ id: r.id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at });
const toConversation = (r) => ({
  id: r.id,
  taskId: r.task_id,
  type: r.type,
  title: r.title,
  createdAt: r.created_at,
  // Branch only: id of the last main message frozen into
  // parent_context_snapshot at creation time (null for main, or for legacy
  // branches created before this column existed / with an empty main).
  originMainMessageId: r.origin_main_message_id || null,
});
const toMessage = (r) => ({
  id: r.id,
  conversationId: r.conversation_id,
  role: r.role,
  content: r.content,
  createdAt: r.created_at,
});

const toArtifact = (r) => ({
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
});

const toDepositionJob = (r) => ({
  id: r.id,
  taskId: r.task_id,
  conversationId: r.conversation_id,
  status: r.status,
  sourceMessageIds: r.source_message_ids || [],
  candidateCount: Array.isArray(r.candidate_artifacts) ? r.candidate_artifacts.length : 0,
  outcome: r.outcome || null,
  errorMessage: r.error_message || null,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  completedAt: r.completed_at,
});

// API shape of a message reference. Accepts DB rows (snake_case) and freshly
// resolved in-memory payloads (camelCase). Full snapshot CONTENTS stay
// server-side — the client only needs id/title/type for display.
const toMessageReferenceLite = (r) => {
  const snaps = Array.isArray(r.artifact_snapshots)
    ? r.artifact_snapshots
    : Array.isArray(r.artifactSnapshots)
      ? r.artifactSnapshots
      : [];
  return {
    id: r.id || null,
    referenceType: r.reference_type !== undefined ? r.reference_type : r.referenceType,
    referenceId: r.reference_id !== undefined ? r.reference_id : r.referenceId,
    displayTitle: r.display_title !== undefined ? r.display_title : r.displayTitle,
    resolvedArtifactIds: r.resolved_artifact_ids || r.resolvedArtifactIds || [],
    resolvedArtifacts: snaps
      .filter((s) => s && s.id)
      .map((s) => ({ id: s.id, title: s.title, type: s.type })),
  };
};



// Local heuristic short title for the moment of task creation; refined by an
// AI call after the first exchange completes (see routes/conversations.js).
function fallbackTitle(text) {
  let t = String(text || "").trim().replace(/\s+/g, " ");
  t = t.replace(/^(请)?帮(我)?(完成|做|写|准备|弄|搞|生成|整理|分析)一下?/, "").trim();
  t = t.replace(/^(我想|我要|我想要|我需要|请给我)/, "").trim();
  if (!t) t = String(text || "").trim();
  if (t.length > 20) t = t.slice(0, 20) + "…";
  return t || "新任务";
}

module.exports = { ah, isUuid, toTask, toConversation, toMessage, toArtifact, toDepositionJob, toMessageReferenceLite, fallbackTitle };
