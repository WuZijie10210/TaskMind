import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import ConfirmDeposition from "./ConfirmDeposition.jsx";

const ARTIFACT_TYPES_SHORT = {
  结论: "结论",
  案例: "案例",
  资料: "资料",
  框架: "框架",
  判断: "判断",
  模板: "模板",
  方法: "方法",
};

// Three-dot kebab menu (inline small popup)
export function KebabMenu({ items }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);
  return (
    <div className="kebab-wrap" ref={ref}>
      <button
        className="kebab-btn"
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen((v) => !v); }}
        aria-label="更多操作"
      >
        ···
      </button>
      {open && (
        <div className="kebab-menu">
          {items.map((item, i) => (
            <button
              key={i}
              className={"kebab-item" + (item.danger ? " danger" : "")}
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(false); item.onClick(); }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Inline editable title (Enter saves, Esc cancels)
export function InlineEdit({ value, onSave, onCancel }) {
  const [val, setVal] = useState(value);
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current && inputRef.current.focus(); }, []);
  const save = () => { const t = val.trim(); if (t && t !== value) onSave(t); else onCancel(); };
  return (
    <input
      ref={inputRef}
      className="inline-edit"
      value={val}
      onChange={(e) => setVal(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); save(); }
        if (e.key === "Escape") { e.preventDefault(); onCancel(); }
      }}
      onBlur={save}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
    />
  );
}

export default function Sidebar() {
  const location = useLocation();
  const navigate = useNavigate();
  const [tasks, setTasks] = useState([]);
  const [current, setCurrent] = useState(null);
  const [conversations, setConversations] = useState([]);
  const [creatingBranch, setCreatingBranch] = useState(false);
  const [jobs, setJobs] = useState([]);
  const [artifacts, setArtifacts] = useState([]);
  const [confirmJobId, setConfirmJobId] = useState(null);
  // rename/delete UI state
  const [editingTaskTitle, setEditingTaskTitle] = useState(false);
  const [editingBranchId, setEditingBranchId] = useState(null);
  const [editingRecentId, setEditingRecentId] = useState(null);

  const taskId = location.pathname.match(/^\/tasks\/([^/]+)/)?.[1];
  const conversationId = location.pathname.match(/^\/tasks\/[^/]+\/c\/([^/]+)/)?.[1];

  const refresh = useCallback(async () => {
    try {
      const data = await api.listTasks();
      setTasks(data.tasks || []);
    } catch (_) {}
    if (taskId) {
      try {
        const data = await api.getTask(taskId);
        setCurrent(data.task);
        setConversations(data.conversations || []);
      } catch (_) {
        setCurrent(null);
        setConversations([]);
      }
    } else {
      setCurrent(null);
      setConversations([]);
    }
  }, [taskId]);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    const h = () => refresh();
    window.addEventListener("tasks-changed", h);
    return () => window.removeEventListener("tasks-changed", h);
  }, [refresh]);

  // --- deposition state polling ---
  const refreshDeps = useCallback(async () => {
    if (!taskId) { setJobs([]); setArtifacts([]); return; }
    try {
      const [d, a] = await Promise.all([api.getTaskDepositions(taskId), api.getTaskArtifacts(taskId)]);
      setJobs(d.jobs || []);
      setArtifacts(a.artifacts || []);
      window.dispatchEvent(new CustomEvent("depositions-changed", { detail: { taskId, jobs: d.jobs || [] } }));
    } catch (_) {}
  }, [taskId]);

  useEffect(() => { refreshDeps(); }, [refreshDeps]);

  useEffect(() => {
    const hasProcessing = jobs.some((j) => j.status === "processing");
    const iv = setInterval(refreshDeps, hasProcessing ? 2500 : 12000);
    return () => clearInterval(iv);
  }, [refreshDeps, jobs]);

  useEffect(() => {
    const h = (e) => { if (!e.detail || !e.detail.jobs) refreshDeps(); };
    window.addEventListener("depositions-changed", h);
    return () => window.removeEventListener("depositions-changed", h);
  }, [refreshDeps]);

  useEffect(() => {
    const h = (e) => { if (e.detail && e.detail.jobId) setConfirmJobId(e.detail.jobId); };
    window.addEventListener("open-confirm", h);
    return () => window.removeEventListener("open-confirm", h);
  }, []);

  const retryJob = async (jobId) => {
    try { await api.retryDeposition(jobId); refreshDeps(); }
    catch (e) { alert(e.message || "重试失败"); }
  };

  const createBranch = async () => {
    if (!taskId || creatingBranch) return;
    setCreatingBranch(true);
    try {
      const { conversation } = await api.createBranch(taskId);
      window.dispatchEvent(new CustomEvent("tasks-changed"));
      navigate(`/tasks/${taskId}/c/${conversation.id}`);
    } catch (e) { alert(e.message || "创建支线失败，请重试"); }
    finally { setCreatingBranch(false); }
  };

  // --- task management ---
  const handleRenameTask = async (newTitle) => {
    setEditingTaskTitle(false);
    if (!taskId) return;
    try {
      const { task } = await api.renameTask(taskId, newTitle);
      setCurrent(task);
      setTasks((ts) => ts.map((t) => t.id === taskId ? { ...t, title: task.title } : t));
      window.dispatchEvent(new CustomEvent("tasks-changed"));
    } catch (e) { alert(e.message || "重命名失败"); }
  };

  const handleDeleteTask = async () => {
    if (!taskId) return;
    if (!window.confirm(`确认删除任务「${current?.title || ""}」？\n此操作无法撤销，将删除所有对话和成果。`)) return;
    try {
      await api.deleteTask(taskId);
      window.dispatchEvent(new CustomEvent("tasks-changed"));
      navigate("/tasks");
    } catch (e) { alert(e.message || "删除失败"); }
  };

  // --- branch management ---
  const handleRenameBranch = async (branchId, newTitle) => {
    setEditingBranchId(null);
    if (!taskId) return;
    try {
      await api.renameBranch(taskId, branchId, newTitle);
      setConversations((cs) => cs.map((c) => c.id === branchId ? { ...c, title: newTitle } : c));
      window.dispatchEvent(new CustomEvent("tasks-changed"));
    } catch (e) { alert(e.message || "重命名失败"); }
  };

  const handleDeleteBranch = async (branch) => {
    if (!taskId) return;
    if (!window.confirm(`确认删除支线「${branch.title}」？\n该支线的消息将被删除，已确认成果不受影响。`)) return;
    try {
      await api.deleteBranch(taskId, branch.id);
      setConversations((cs) => cs.filter((c) => c.id !== branch.id));
      window.dispatchEvent(new CustomEvent("tasks-changed"));
      // If currently on this branch, navigate back to main
      if (conversationId === branch.id) navigate(`/tasks/${taskId}`);
    } catch (e) { alert(e.message || "删除失败"); }
  };

  // --- recent task management (global sidebar mode; same capabilities as
  // the in-task workspace: renameTask / deleteTask) ---
  const handleRenameRecentTask = async (id, newTitle) => {
    setEditingRecentId(null);
    try {
      const { task } = await api.renameTask(id, newTitle);
      setTasks((ts) => ts.map((t) => (t.id === id ? { ...t, title: task.title } : t)));
      window.dispatchEvent(new CustomEvent("tasks-changed"));
    } catch (e) { alert(e.message || "重命名失败"); }
  };

  const handleDeleteRecentTask = async (t) => {
    if (!window.confirm(`确认删除任务「${t.title}」？\n此操作无法撤销，将删除所有对话和成果。`)) return;
    try {
      await api.deleteTask(t.id);
      setTasks((ts) => ts.filter((x) => x.id !== t.id));
      window.dispatchEvent(new CustomEvent("tasks-changed"));
    } catch (e) { alert(e.message || "删除失败"); }
  };

  const mainConv = conversations.find((c) => c.type === "main");
  const branches = conversations.filter((c) => c.type === "branch");
  const activeConvId = conversationId || mainConv?.id || null;

  const convTitle = (id) => {
    const c = conversations.find((x) => x.id === id);
    return c ? c.title : "对话";
  };
  const activeJobs = jobs.filter((j) => ["processing", "ready", "failed"].includes(j.status));
  const confirmedJobs = jobs.filter((j) => j.status === "confirmed" && j.candidateCount > 0).slice(0, 3);
  const readyConvIds = new Set(
    jobs.filter((j) => j.status === "ready" && j.candidateCount > 0).map((j) => j.conversationId)
  );

  // Recent artifacts (max 3) for sidebar preview
  const recentArtifacts = artifacts.slice(0, 3);
  const artifactCount = artifacts.length;

  // === In-task mode (task workspace) ===
  if (current && taskId) {
    return (
      <aside className="sidebar">
        {/* Back to home */}
        <div className="sidebar-back-row">
          <Link to="/" className="sidebar-back-link">← 首页</Link>
        </div>

        {/* Task title + kebab */}
        <div className="side-section side-task-header">
          {editingTaskTitle ? (
            <InlineEdit
              value={current.title}
              onSave={handleRenameTask}
              onCancel={() => setEditingTaskTitle(false)}
            />
          ) : (
            <div className="task-header-row">
              <div className="current-task-title" title={current.title}>{current.title}</div>
              <KebabMenu items={[
                { label: "重命名任务", onClick: () => setEditingTaskTitle(true) },
                { label: "删除任务", danger: true, onClick: handleDeleteTask },
              ]} />
            </div>
          )}
        </div>

        {/* Conversations */}
        <div className="side-section">
          <div className="side-section-title">对话</div>
          {mainConv && (
            <Link
              to={`/tasks/${current.id}`}
              className={"conv-item" + (activeConvId === mainConv.id ? " active" : "")}
            >
              <span className="conv-dot" />
              主线对话
            </Link>
          )}
          {branches.length > 0 && <div className="conv-group-title">支线</div>}
          {branches.map((b) => (
            <div key={b.id} className={"conv-item-row" + (activeConvId === b.id ? " active" : "")}>
              {editingBranchId === b.id ? (
                <InlineEdit
                  value={b.title}
                  onSave={(t) => handleRenameBranch(b.id, t)}
                  onCancel={() => setEditingBranchId(null)}
                />
              ) : (
                <>
                  <Link
                    to={`/tasks/${current.id}/c/${b.id}`}
                    className="conv-item branch"
                    title={b.title}
                  >
                    {b.title}
                    {readyConvIds.has(b.id) && <span className="conv-flag">待确认</span>}
                  </Link>
                  <KebabMenu items={[
                    { label: "重命名支线", onClick: () => setEditingBranchId(b.id) },
                    { label: "删除支线", danger: true, onClick: () => handleDeleteBranch(b) },
                  ]} />
                </>
              )}
            </div>
          ))}
          <button className="new-branch-btn" onClick={createBranch} disabled={creatingBranch}>
            + 新建支线
          </button>
        </div>

        {/* Deposition status (active jobs only) */}
        {activeJobs.length > 0 && (
          <div className="side-section">
            <div className="side-section-title">沉淀</div>
            {activeJobs.map((j) => {
              if (j.status === "processing")
                return (
                  <div className="dep-item processing" key={j.id}>
                    <span className="spin">✦</span> 正在整理成果…
                    <span className="dep-from">来自「{convTitle(j.conversationId)}」</span>
                  </div>
                );
              if (j.status === "failed")
                return (
                  <button className="dep-item failed" key={j.id} onClick={() => retryJob(j.id)}>
                    成果整理失败 · 重试
                    <span className="dep-from">来自「{convTitle(j.conversationId)}」</span>
                  </button>
                );
              return (
                <button className="dep-item ready" key={j.id} onClick={() => setConfirmJobId(j.id)}>
                  ✦ {j.candidateCount} 项成果待确认
                  <span className="dep-from">来自「{convTitle(j.conversationId)}」</span>
                </button>
              );
            })}
          </div>
        )}
        {confirmedJobs.length > 0 && (
          <div className="side-section">
            <div className="side-section-title">整理记录</div>
            {confirmedJobs.map((j) => (
              <button className="dep-item ready" key={j.id} onClick={() => setConfirmJobId(j.id)}>
                查看已确认的候选
                <span className="dep-from">来自「{convTitle(j.conversationId)}」</span>
              </button>
            ))}
          </div>
        )}

        {/* Artifacts preview (max 3 + "view all") */}
        <div className="side-section">
          <div className="side-section-title">成果 {artifactCount > 0 ? artifactCount : ""}</div>
          {artifactCount === 0 && (
            <div className="side-empty">还没有已确认成果</div>
          )}
          {recentArtifacts.map((a) => (
            <Link
              key={a.id}
              to={`/tasks/${taskId}/artifacts`}
              className="sidebar-artifact-item"
              title={a.title}
            >
              <span className="sidebar-artifact-type">{ARTIFACT_TYPES_SHORT[a.type] || a.type}</span>
              <span className="sidebar-artifact-title">{a.title}</span>
            </Link>
          ))}
          {artifactCount > 0 && (
            <Link to={`/tasks/${taskId}/artifacts`} className="sidebar-artifacts-all">
              查看全部成果 →
            </Link>
          )}
        </div>

        {confirmJobId && (
          <ConfirmDeposition jobId={confirmJobId} onClose={() => setConfirmJobId(null)} />
        )}
      </aside>
    );
  }

  // === Global mode (not in a task) ===
  const recent = tasks.slice(0, 6);
  return (
    <aside className="sidebar">
      <Link to="/" className="logo">
        <span className="logo-mark">✦</span>
        TaskMind
      </Link>

      <nav className="side-nav">
        <Link to="/" className={"nav-item" + (location.pathname === "/" ? " active" : "")}>
          首页
        </Link>
      </nav>

      <div className="side-section side-recent">
        <div className="side-section-title-row">
          <span className="side-section-title">最近任务</span>
          <Link to="/tasks" className="side-all-link">全部 →</Link>
        </div>
        {recent.length === 0 && <div className="side-empty">暂无任务</div>}
        {recent.map((t) => (
          <div key={t.id} className={"task-item-row" + (t.id === taskId ? " active" : "")}>
            {editingRecentId === t.id ? (
              <InlineEdit
                value={t.title}
                onSave={(v) => handleRenameRecentTask(t.id, v)}
                onCancel={() => setEditingRecentId(null)}
              />
            ) : (
              <>
                <Link
                  to={`/tasks/${t.id}`}
                  className={"task-item" + (t.id === taskId ? " active" : "")}
                  title={t.title}
                >
                  {t.title}
                </Link>
                <KebabMenu items={[
                  { label: "重命名任务", onClick: () => setEditingRecentId(t.id) },
                  { label: "删除任务", danger: true, onClick: () => handleDeleteRecentTask(t) },
                ]} />
              </>
            )}
          </div>
        ))}
      </div>

      {confirmJobId && (
        <ConfirmDeposition jobId={confirmJobId} onClose={() => setConfirmJobId(null)} />
      )}
    </aside>
  );
}
