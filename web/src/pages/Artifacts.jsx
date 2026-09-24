import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { KebabMenu, InlineEdit } from "../components/Sidebar.jsx";

const TYPE_LABELS = {
  结论: "结论",
  案例: "案例",
  资料: "资料",
  框架: "框架",
  判断: "判断",
  模板: "模板",
  方法: "方法",
};

function ArtifactCard({ artifact, expanded, onToggle, onRenamed, onDeleted }) {
  const [editing, setEditing] = useState(false);
  const sourceLabel = artifact.sourceConversationTitle || "已删除对话";
  const sourceDeleted = !artifact.sourceConversationTitle || artifact.sourceConversationTitle === "已删除对话";
  const createdAt = artifact.createdAt ? new Date(artifact.createdAt).toLocaleDateString("zh-CN") : "";

  const handleRename = async (newTitle) => {
    setEditing(false);
    try {
      const { artifact: a } = await api.renameArtifact(artifact.taskId, artifact.id, newTitle);
      onRenamed(a);
    } catch (e) { alert(e.message || "重命名失败"); }
  };

  const handleDelete = async () => {
    if (!window.confirm(`确认删除成果「${artifact.title}」？\n此操作无法撤销。`)) return;
    try {
      await api.deleteArtifact(artifact.taskId, artifact.id);
      onDeleted(artifact.id);
    } catch (e) { alert(e.message || "删除失败"); }
  };

  return (
    <div className={"artifact-card-v2" + (expanded ? " expanded" : "")} onClick={onToggle}>
      <div className="artifact-card-header">
        <div className="artifact-card-meta-row" onClick={(e) => e.stopPropagation()}>
          <span className={"type-chip t-" + artifact.type}>{TYPE_LABELS[artifact.type] || artifact.type}</span>
          <span className={"artifact-source" + (sourceDeleted ? " deleted" : "")}>
            {sourceDeleted ? "原支线已删除" : `来自「${sourceLabel}」`}
          </span>
          <span className="artifact-date">{createdAt}</span>
          <KebabMenu items={[
            { label: "重命名成果", onClick: () => setEditing(true) },
            { label: "删除成果", danger: true, onClick: handleDelete },
          ]} />
        </div>
        {editing ? (
          <InlineEdit
            value={artifact.title}
            onSave={handleRename}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <div className="artifact-card-title">{artifact.title}</div>
        )}
        {artifact.summary && !expanded && (
          <div className="artifact-card-summary">{artifact.summary}</div>
        )}
      </div>
      {expanded && (
        <div className="artifact-card-detail" onClick={(e) => e.stopPropagation()}>
          {artifact.summary && (
            <div className="artifact-detail-summary">{artifact.summary}</div>
          )}
          <div className="artifact-detail-content">{artifact.content}</div>
          <div className="artifact-detail-footer">
            <span className="artifact-source-info">
              {sourceDeleted ? "原支线已删除" : `来自「${sourceLabel}」`}
              {" · "}追溯 {(artifact.sourceMessageIds || []).length} 条消息
            </span>
          </div>
        </div>
      )}
      <div className="artifact-card-expand-hint">
        {expanded ? "▲ 收起" : "▼ 展开详情"}
      </div>
    </div>
  );
}

// Confirmed artifacts of a task — single-column card list.
// Route: /tasks/:taskId/artifacts
export default function Artifacts() {
  const { taskId } = useParams();
  const [task, setTask] = useState(null);
  const [artifacts, setArtifacts] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const [expandedId, setExpandedId] = useState(null);

  useEffect(() => {
    let alive = true;
    setArtifacts(null);
    setNotFound(false);
    setExpandedId(null);
    Promise.all([api.getTask(taskId), api.getTaskArtifacts(taskId)])
      .then(([t, a]) => {
        if (!alive) return;
        setTask(t.task);
        setArtifacts(a.artifacts || []);
      })
      .catch(() => alive && setNotFound(true));
    const h = () => {
      api.getTaskArtifacts(taskId)
        .then((a) => alive && setArtifacts(a.artifacts || []))
        .catch(() => {});
    };
    window.addEventListener("depositions-changed", h);
    return () => { alive = false; window.removeEventListener("depositions-changed", h); };
  }, [taskId]);

  if (notFound) {
    return (
      <div className="page-pad">
        任务不存在。<Link to="/" className="inline-link">返回首页</Link>
      </div>
    );
  }

  const handleToggle = (id) => setExpandedId((prev) => (prev === id ? null : id));

  const handleRenamed = (a) => {
    setArtifacts((xs) => (xs || []).map((x) => (x.id === a.id ? { ...x, ...a } : x)));
    // Refresh the sidebar artifact preview.
    window.dispatchEvent(new CustomEvent("depositions-changed"));
  };

  const handleDeleted = (id) => {
    if (expandedId === id) setExpandedId(null);
    setArtifacts((xs) => (xs || []).filter((x) => x.id !== id));
    window.dispatchEvent(new CustomEvent("depositions-changed"));
  };

  return (
    <div className="page artifacts-page">
      <div className="page-head">
        <div>
          <div className="page-kicker">
            <Link to={`/tasks/${taskId}`} className="inline-link">← 回到对话</Link>
          </div>
          <h1>成果{task ? ` · ${task.title}` : ""}</h1>
        </div>
      </div>

      <div className="artifact-list-v2">
        {artifacts === null && <div className="loading">加载中…</div>}
        {artifacts !== null && artifacts.length === 0 && (
          <div className="chat-empty">
            还没有已确认的成果。在对话中点击「✦ 沉淀」，整理出可复用的阶段成果。
          </div>
        )}
        {artifacts !== null &&
          artifacts.map((a) => (
            <ArtifactCard
              key={a.id}
              artifact={a}
              expanded={expandedId === a.id}
              onToggle={() => handleToggle(a.id)}
              onRenamed={handleRenamed}
              onDeleted={handleDeleted}
            />
          ))}
      </div>
    </div>
  );
}
