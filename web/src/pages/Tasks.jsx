import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { KebabMenu, InlineEdit } from "../components/Sidebar.jsx";

const fmt = (iso) =>
  new Date(iso).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

// 全部任务
export default function Tasks() {
  const [tasks, setTasks] = useState(null);
  const [error, setError] = useState(null);
  const [editingId, setEditingId] = useState(null);

  useEffect(() => {
    let alive = true;
    api
      .listTasks()
      .then((d) => alive && setTasks(d.tasks || []))
      .catch((e) => alive && setError(e.message));
    const onChanged = () => api.listTasks().then((d) => alive && setTasks(d.tasks || [])).catch(() => {});
    window.addEventListener("tasks-changed", onChanged);
    return () => {
      alive = false;
      window.removeEventListener("tasks-changed", onChanged);
    };
  }, []);

  // Same capabilities as the task workspace (renameTask / deleteTask).
  const handleRename = async (id, newTitle) => {
    setEditingId(null);
    try {
      const { task } = await api.renameTask(id, newTitle);
      setTasks((ts) => (ts || []).map((t) => (t.id === id ? { ...t, title: task.title } : t)));
      window.dispatchEvent(new CustomEvent("tasks-changed"));
    } catch (e) { alert(e.message || "重命名失败"); }
  };

  const handleDelete = async (t) => {
    if (!window.confirm(`确认删除任务「${t.title}」？\n此操作无法撤销，将删除所有对话和成果。`)) return;
    try {
      await api.deleteTask(t.id);
      setTasks((ts) => (ts || []).filter((x) => x.id !== t.id));
      window.dispatchEvent(new CustomEvent("tasks-changed"));
    } catch (e) { alert(e.message || "删除失败"); }
  };

  return (
    <div className="tasks-page">
      <div className="tasks-inner">
        <h1 className="page-title">全部任务</h1>
        {error && <div className="error-text">{error}</div>}
        {tasks === null && !error && <div className="loading">加载中…</div>}
        {tasks && tasks.length === 0 && (
          <div className="chat-empty">
            还没有任务，去<Link to="/" className="inline-link">首页</Link>开始第一个吧
          </div>
        )}
        {tasks &&
          tasks.map((t) => (
            <div key={t.id} className="task-row-outer">
              {editingId === t.id ? (
                <div className="task-row">
                  <InlineEdit
                    value={t.title}
                    onSave={(v) => handleRename(t.id, v)}
                    onCancel={() => setEditingId(null)}
                  />
                </div>
              ) : (
                <>
                  <Link to={`/tasks/${t.id}`} className="task-row">
                    <span className="t-title">{t.title}</span>
                    <span className="t-time">{fmt(t.updatedAt)}</span>
                    <span className="chev">›</span>
                  </Link>
                  <KebabMenu items={[
                    { label: "重命名任务", onClick: () => setEditingId(t.id) },
                    { label: "删除任务", danger: true, onClick: () => handleDelete(t) },
                  ]} />
                </>
              )}
            </div>
          ))}
      </div>
    </div>
  );
}
