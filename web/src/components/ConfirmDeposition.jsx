import { useEffect, useState } from "react";
import { api } from "../lib/api";

// Confirmation UI for a ready deposition job.
//
// Opens with the frozen candidates; by default each candidate shows only
// type + title + summary + source count — full content ("展开内容") and the
// frozen source messages ("查看来源") are collapsed, content stays editable
// once expanded. The user may edit the title inline, or "移除此候选"
// (single-candidate removal — this is NOT the same as deleting a saved
// artifact). Merely closing the modal keeps the job in `ready` server-side
// (nothing is lost); re-opening shows the same candidates again. "保存 X 项
// 成果" confirms the final edits (requires >= 1 candidate — the ONLY action
// that advances the stage cursor); "放弃本次沉淀" explicitly discards (the
// cut-off does NOT advance).

export default function ConfirmDeposition({ jobId, onClose }) {
  const [conversation, setConversation] = useState(null);
  const [drafts, setDrafts] = useState(null); // null = loading
  const [sourceMessages, setSourceMessages] = useState([]);
  const [openSources, setOpenSources] = useState(null); // index into drafts
  const [openContent, setOpenContent] = useState(null); // index into drafts
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const reload = async () => {
    try {
      const d = await api.getDeposition(jobId);
      setConversation(d.conversation);
      setSourceMessages(d.sourceMessages || []);
      if (!d.job || d.job.status !== "ready") {
        // confirmed/discarded elsewhere (or empty) — nothing to confirm
        onClose();
        window.dispatchEvent(new CustomEvent("depositions-changed"));
        return;
      }
      setDrafts((d.candidates || []).map((c) => ({ ...c })));
    } catch (e) {
      setError(e.message);
    }
  };

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  const edit = (i, patch) =>
    setDrafts((ds) => ds.map((d, k) => (k === i ? { ...d, ...patch } : d)));
  const removeAt = (i) => setDrafts((ds) => ds.filter((_, k) => k !== i));

  const sourcesOf = (d) =>
    (d.sourceMessageIds || [])
      .map((id) => sourceMessages.find((m) => m.id === id))
      .filter(Boolean);

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.confirmDeposition(
        jobId,
        drafts.map((d) => ({
          title: d.title,
          type: d.type,
          summary: d.summary,
          content: d.content,
          sourceMessageIds: d.sourceMessageIds,
        }))
      );
      window.dispatchEvent(new CustomEvent("depositions-changed"));
      window.dispatchEvent(new CustomEvent("tasks-changed"));
      onClose();
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

  const discard = async () => {
    if (busy) return;
    if (!window.confirm("确定放弃本次沉淀？候选成果将不会保存。")) return;
    setBusy(true);
    try {
      await api.discardDeposition(jobId);
      window.dispatchEvent(new CustomEvent("depositions-changed"));
      onClose();
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

  return (
    <div className="dep-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dep-modal">
        <div className="dep-modal-head">
          <div>
            <div className="dep-modal-title">✦ 确认沉淀成果</div>
            <div className="dep-modal-sub">
              来自「{conversation ? conversation.title : "…"}」 · 关闭不会丢失候选成果
            </div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>

        <div className="dep-modal-body">
          {drafts === null && <div className="loading">加载中…</div>}
          {drafts !== null && drafts.length === 0 && (
            <div className="dep-empty">候选成果已全部移除</div>
          )}
          {drafts !== null &&
            drafts.map((d, i) => (
              <div className="cand-card" key={i}>
                <div className="cand-top">
                  <span className={"type-chip t-" + d.type}>{d.type}</span>
                  <button
                    className="cand-remove"
                    onClick={() => removeAt(i)}
                    title="移除此候选（不会保存为成果）"
                  >
                    移除此候选
                  </button>
                </div>
                <input
                  className="cand-title"
                  value={d.title}
                  onChange={(e) => edit(i, { title: e.target.value })}
                  placeholder="成果标题"
                />
                <label className="cand-summary-field">
                  <span>成果摘要 · 后续按任务查找时会参考它</span>
                  <textarea
                    className="cand-summary"
                    value={d.summary || ""}
                    onChange={(e) => edit(i, { summary: e.target.value })}
                    maxLength={300}
                    rows={2}
                    placeholder="用一句话说明这份成果是什么、何时适用"
                  />
                  <span className="cand-summary-hint">修改标题或正文后，也请检查摘要是否仍准确。</span>
                </label>
                <div className="cand-toggles">
                  <button
                    className="link-btn"
                    onClick={() => setOpenContent(openContent === i ? null : i)}
                  >
                    {openContent === i ? "收起内容" : "展开内容"}
                  </button>
                  <button
                    className="link-btn"
                    onClick={() => setOpenSources(openSources === i ? null : i)}
                  >
                    {openSources === i ? "收起来源" : `查看来源 · ${sourcesOf(d).length} 条消息`}
                  </button>
                </div>
                {openContent === i && (
                  <textarea
                    className="cand-content"
                    value={d.content}
                    onChange={(e) => edit(i, { content: e.target.value })}
                    rows={Math.min(12, Math.max(4, Math.ceil(d.content.length / 40)))}
                  />
                )}
                {openSources === i && (
                  <div className="src-list">
                    {sourcesOf(d).map((m) => (
                      <div className="src-msg" key={m.id}>
                        <span className={"src-role " + m.role}>{m.role === "user" ? "用户" : "助手"}</span>
                        <span className="src-text">{m.content}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
        </div>

        {error && <div className="dep-modal-error">{error}</div>}

        <div className="dep-modal-foot">
          <button className="ghost-btn" onClick={discard} disabled={busy}>
            放弃本次沉淀
          </button>
          <button className="primary-btn" onClick={save} disabled={busy || drafts === null || drafts.length === 0}>
            {drafts === null ? "…" : `保存 ${drafts.length} 项成果`}
          </button>
        </div>
      </div>
    </div>
  );
}
