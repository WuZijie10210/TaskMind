import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, streamChat } from "../lib/api";

const TMP_USER = "tmp-user";
const TMP_ASSISTANT = "tmp-assistant";

// Task-reference transparency note: what the selector actually pulled in.
// Defensive reads: @Artifact refs also carry resolvedArtifactIds (=[id]) from
// the server, but rendering must never depend on it (only @Task is meaningful
// here) — and a ref row missing optional fields must not crash the page.
// NOTE: this component's prop is called `reference`, NOT `ref` — React strips
// the reserved `ref` prop from function components, which used to make
// refProp undefined and crash rendering ("reading 'resolvedArtifactIds'").
export function TaskRefNote({ reference, titleById }) {
  const ids = (reference && reference.resolvedArtifactIds) || [];
  const title = (reference && reference.displayTitle) || "任务";
  if (ids.length === 0) {
    return <div className="ref-note">未从「{title}」找到适合本次需求的成果</div>;
  }
  // Titles must always render (live send AND reloaded history). Prefer the
  // frozen titles in resolvedArtifacts; fall back to the live artifact title
  // map (refOptions) when an entry is missing/blank, so a note never shows
  // empty bullets. Bullet count always matches the summary count (ids).
  const byId = {};
  for (const a of (reference && reference.resolvedArtifacts) || []) {
    if (a && a.id && a.title) byId[a.id] = a.title;
  }
  return (
    <details className="ref-note">
      <summary>已从「{title}」调用 {ids.length} 项成果</summary>
      <ul>
        {ids.map((id) => (
          <li key={id}>✓ {byId[id] || (titleById && titleById[id]) || "（已删除成果）"}</li>
        ))}
      </ul>
    </details>
  );
}

// Render user message content with inline mentions replaced by chips.
// Supports BOTH mention forms:
//   new (picker insert):   【@title】
//   legacy (old messages): @title
// mentionMap: title → {type, id, title} (from when message was sent/loaded).
// For persisted messages, refs come from message.references[].displayTitle.
export function InlineContent({ content, inlineRefs }) {
  if (!inlineRefs || inlineRefs.length === 0) {
    return <span>{content}</span>;
  }
  // Build a set of titles to highlight
  const titleSet = new Set(inlineRefs.map((r) => r.displayTitle).filter(Boolean));
  if (titleSet.size === 0) return <span>{content}</span>;

  // Split content on mention occurrences (sorted by length desc to avoid
  // partial matches). The bracketed form is listed first so 【@X】 matches as
  // a whole token; the bare form only matches when not bracketed.
  const titles = Array.from(titleSet).sort((a, b) => b.length - a.length);
  const escaped = titles.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const regex = new RegExp(`【@(${escaped.join("|")})】|@(${escaped.join("|")})`, "g");

  const parts = [];
  let last = 0;
  let match;
  while ((match = regex.exec(content)) !== null) {
    if (match.index > last) parts.push({ text: content.slice(last, match.index), type: "text" });
    parts.push({ text: match[1] || match[2], type: "chip" });
    last = match.index + match[0].length;
  }
  if (last < content.length) parts.push({ text: content.slice(last), type: "text" });

  return (
    <>
      {parts.map((p, i) =>
        p.type === "chip" ? (
          <span className="ref-chip inline-chip" key={i}>@ {p.text}</span>
        ) : (
          <span key={i}>{p.text}</span>
        )
      )}
    </>
  );
}

export function ChatMessage({ message, generating, titleById }) {
  if (message.role === "user") {
    const refs = message.references || [];
    // For rendering: use message.inlineRefs if present (live), else derive from stored refs
    const inlineRefs = message.inlineRefs || refs.map((r) => ({ displayTitle: r.displayTitle }));
    return (
      <div className="msg user" id={"msg-" + message.id}>
        <div className="bubble">
          <InlineContent content={message.content} inlineRefs={inlineRefs} />
          {/* Task resolution notes only for persisted messages (server-confirmed). */}
          {message.id !== TMP_USER &&
            refs
              .filter((r) => r.referenceType === "task")
              .map((r, i) => (
                <TaskRefNote key={(r.id || r.referenceId || "") + i} reference={r} titleById={titleById} />
              ))}
        </div>
      </div>
    );
  }
  return (
    <div className="msg assistant">
      <div className="avatar">✦</div>
      <div className="msg-body">
        {generating && !message.content ? (
          <span className="dots" aria-label="正在生成">
            <i />
            <i />
            <i />
          </span>
        ) : (
          <div className={"md" + (generating ? " typing" : "")}>
            <Markdown remarkPlugins={[remarkGfm]}>{message.content}</Markdown>
          </div>
        )}
      </div>
    </div>
  );
}

// Light marker under a main message that spawned branch(es).
// Single branch → jump straight in; multiple → expandable chooser.
// Copy: 「从这里展开了支线…」 (NOT "分叉" — branches are not user-picked
// fork points; they inherit main history up to creation time).
function BranchMarker({ branches, onOpen }) {
  const [open, setOpen] = useState(false);
  const multi = branches.length > 1;
  return (
    <div className="branch-marker">
      <button
        className="bm-link"
        onClick={() => (multi ? setOpen((v) => !v) : onOpen(branches[0]))}
      >
        ↳ {multi ? `从这里展开了 ${branches.length} 条支线` : `从这里展开了支线「${branches[0].title}」`}
      </button>
      {multi && open && (
        <div className="bm-list">
          {branches.map((b) => (
            <button key={b.id} className="bm-item" onClick={() => onOpen(b)}>
              {b.title}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function TaskChat() {
  const { taskId, conversationId } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [task, setTask] = useState(null);
  const [conversation, setConversation] = useState(null);
  const [messages, setMessages] = useState(null);
  const [input, setInput] = useState("");
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const [convMissing, setConvMissing] = useState(false);
  // Branch origin (「从主线这里展开」 banner). null = not loaded / not a
  // branch / legacy branch without origin → banner degrades gracefully.
  const [originInfo, setOriginInfo] = useState(null);
  const [focusNote, setFocusNote] = useState(null); // ?focus= target missing hint
  const [convs, setConvs] = useState([]); // all conversations of the task
  const [depNote, setDepNote] = useState(null);
  const [depJobs, setDepJobs] = useState([]);
  const [depositing, setDepositing] = useState(false);
  const [refOptions, setRefOptions] = useState(null);
  const [pickerQuery, setPickerQuery] = useState(null); // null = closed, "" = browse, text = search
  const [expandedTasks, setExpandedTasks] = useState(() => new Set()); // browse mode: expanded task ids

  // mentionMap: title → {type, id, title}
  // We track ALL mentions the user has selected (even if they edit the text,
  // we re-scan for which @title mentions survive at send time).
  const mentionMapRef = useRef({}); // title→{type,id,title}

  const autoFired = useRef(false);
  const abortRef = useRef(null);
  const scrollRef = useRef(null);
  const stickBottom = useRef(true);
  const textareaRef = useRef(null);
  const pickerRef = useRef(null);

  useEffect(() => {
    autoFired.current = false;
    abortRef.current?.abort();
    abortRef.current = null;
    setTask(null);
    setConversation(null);
    setMessages(null);
    setNotFound(false);
    setConvMissing(false);
    setError(null);
    mentionMapRef.current = {};
    let alive = true;
    api
      .getTask(taskId)
      .then((d) => {
        if (!alive) return;
        setTask(d.task);
        const convs = d.conversations || [];
        const main = convs.find((c) => c.type === "main");
        const active = conversationId ? convs.find((c) => c.id === conversationId) : main;
        if (!active) {
          if (conversationId) setConvMissing(true);
          setConversation(null);
        } else {
          setConversation(active);
        }
      })
      .catch(() => alive && setNotFound(true));
    return () => { alive = false; };
  }, [taskId, conversationId]);

  useEffect(() => {
    if (!conversation) return;
    let alive = true;
    stickBottom.current = true;
    api
      .listMessages(conversation.id)
      .then((d) => alive && setMessages(d.messages || []))
      .catch((e) => alive && setError(e.message));
    return () => { alive = false; };
  }, [conversation]);

  // Branch origin banner data (「从主线这里展开」). Degrades to null on any
  // failure (legacy branch / network error) — the banner still renders with
  // fallback copy and a plain "回到主线" jump.
  useEffect(() => {
    if (!conversation || conversation.type !== "branch") {
      setOriginInfo(null);
      return;
    }
    let alive = true;
    setOriginInfo(null);
    api
      .getBranchOrigin(conversation.id)
      .then((d) => alive && setOriginInfo(d))
      .catch(() => alive && setOriginInfo(null));
    return () => {
      alive = false;
    };
  }, [conversation]);

  // ?focus=<messageId> deep link (「回到主线位置」): once history is loaded,
  // scroll to the target message and flash it. Missing/deleted target →
  // settle near bottom + light hint (no error).
  useEffect(() => {
    const focusId = searchParams.get("focus");
    if (!focusId || !messages) return;
    setSearchParams({}, { replace: true });
    const el = document.getElementById(`msg-${focusId}`);
    if (el) {
      el.scrollIntoView({ block: "center" });
      el.classList.add("msg-focus-flash");
      const t = setTimeout(() => el.classList.remove("msg-focus-flash"), 2000);
      return () => clearTimeout(t);
    }
    const sc = document.querySelector(".chat-scroll");
    if (sc) sc.scrollTop = sc.scrollHeight;
    setFocusNote("原消息已不存在，已回到主线底部");
    const t2 = setTimeout(() => setFocusNote(null), 3000);
    return () => clearTimeout(t2);
  }, [messages, searchParams]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
  };

  const run = async (content, refs) => {
    if (!conversation || generating) return;
    setError(null);
    setGenerating(true);
    const pendingRefs = (refs || []).map((r, i) => ({
      id: `pending-${i}`,
      referenceType: r.type,
      referenceId: r.id,
      displayTitle: r.title,
      resolvedArtifactIds: [],
      resolvedArtifacts: [],
    }));
    if (content) {
      setMessages((m) => [
        ...(m || []),
        {
          id: TMP_USER,
          role: "user",
          content,
          createdAt: new Date().toISOString(),
          references: pendingRefs,
          inlineRefs: pendingRefs.map((r) => ({ displayTitle: r.displayTitle })),
        },
      ]);
    }
    const ac = new AbortController();
    abortRef.current = ac;
    const replace = (id, updater) =>
      setMessages((m) => (m || []).map((x) => (x.id === id ? updater(x) : x)));

    try {
      await streamChat(
        conversation.id,
        content,
        (ev) => {
          if (ev.type === "user") {
            replace(TMP_USER, () => ({
              ...ev.message,
              references: ev.references || pendingRefs,
              // Keep inlineRefs from the pendingRefs (they already have displayTitle)
              inlineRefs: (ev.references || pendingRefs).map((r) => ({ displayTitle: r.displayTitle })),
            }));
          } else if (ev.type === "start") {
            setMessages((m) => [
              ...(m || []),
              { id: TMP_ASSISTANT, role: "assistant", content: "", createdAt: new Date().toISOString() },
            ]);
          } else if (ev.type === "delta") {
            replace(TMP_ASSISTANT, (x) => ({ ...x, content: x.content + ev.text }));
          } else if (ev.type === "done") {
            replace(TMP_ASSISTANT, () => ev.message);
            if (ev.task && ev.task.title) setTask((t) => (t ? { ...t, title: ev.task.title } : t));
            if (ev.conversation && ev.conversation.title)
              setConversation((c) => (c ? { ...c, title: ev.conversation.title } : c));
            window.dispatchEvent(new CustomEvent("tasks-changed"));
          } else if (ev.type === "error") {
            setError(ev.error || "AI 生成失败");
            if (ev.message) {
              replace(TMP_ASSISTANT, () => ev.message);
            } else {
              setMessages((m) => (m || []).filter((x) => x.id !== TMP_ASSISTANT));
            }
          }
        },
        ac.signal,
        refs && refs.length ? refs.map((r) => ({ type: r.type, id: r.id })) : undefined
      );
      window.dispatchEvent(new CustomEvent("tasks-changed"));
    } catch (e) {
      if (e.name !== "AbortError") {
        setError(e.message || "网络错误，请重试");
        setMessages((m) => (m || []).filter((x) => x.id !== TMP_ASSISTANT));
      }
    } finally {
      if (abortRef.current === ac) {
        abortRef.current = null;
        setGenerating(false);
      }
    }
  };

  useEffect(() => {
    if (!messages || !conversation || generating) return;
    const last = messages[messages.length - 1];
    if (
      searchParams.get("auto") === "1" &&
      conversation.type === "main" &&
      last &&
      last.role === "user" &&
      !autoFired.current
    ) {
      autoFired.current = true;
      setSearchParams({}, { replace: true });
      run("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, searchParams]);

  useEffect(() => {
    if (!taskId) return;
    let alive = true;
    api
      .getTaskDepositions(taskId)
      .then((d) => alive && setDepJobs(d.jobs || []))
      .catch(() => {});
    const h = (e) => {
      const incoming = e.detail && e.detail.jobs;
      if (Array.isArray(incoming) && (!e.detail.taskId || e.detail.taskId === taskId)) {
        setDepJobs(incoming);
      }
    };
    window.addEventListener("depositions-changed", h);
    return () => { alive = false; window.removeEventListener("depositions-changed", h); };
  }, [taskId]);

  const deposit = async () => {
    if (!conversation || depositing) return;
    setDepositing(true);
    setDepNote(null);
    try {
      const { job } = await api.createDeposition(conversation.id);
      setDepJobs((js) => [job, ...js.filter((j) => j.id !== job.id)]);
      window.dispatchEvent(new CustomEvent("depositions-changed"));
    } catch (e) {
      setDepNote(e.message || "沉淀失败，请重试");
      setTimeout(() => setDepNote(null), 5000);
    } finally {
      setDepositing(false);
    }
  };

  const retryDeposition = async (jobId) => {
    try {
      await api.retryDeposition(jobId);
      window.dispatchEvent(new CustomEvent("depositions-changed"));
    } catch (e) {
      setDepNote(e.message || "重试失败");
      setTimeout(() => setDepNote(null), 5000);
    }
  };

  const discardDeposition = async (jobId) => {
    try {
      await api.discardDeposition(jobId);
      window.dispatchEvent(new CustomEvent("depositions-changed"));
    } catch (e) {
      setDepNote(e.message || "放弃失败");
      setTimeout(() => setDepNote(null), 5000);
    }
  };

  const reanalyzeDeposition = async (jobId) => {
    try {
      await api.reanalyzeDeposition(jobId);
      window.dispatchEvent(new CustomEvent("depositions-changed"));
    } catch (e) {
      setDepNote(e.message || "重新分析失败");
      setTimeout(() => setDepNote(null), 5000);
    }
  };

  const myJobs = depJobs
    .filter((j) => conversation && j.conversationId === conversation.id)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const myActiveJob = myJobs.find(
    (j) => j.status === "processing" || (j.status === "ready" && j.candidateCount > 0) || j.status === "failed"
  );

  const seenJobStatus = useRef({});
  useEffect(() => {
    for (const j of depJobs) {
      const prev = seenJobStatus.current[j.id];
      if (prev === "processing" && j.status === "discarded" && j.outcome === "empty") {
        setDepNote("本阶段暂无值得沉淀的独立成果");
        setTimeout(() => setDepNote((n) => (n === "本阶段暂无值得沉淀的独立成果" ? null : n)), 5000);
      }
      seenJobStatus.current[j.id] = j.status;
    }
  }, [depJobs]);

  useEffect(() => {
    if (!taskId) return;
    let alive = true;
    const load = () => {
      api
        .referenceOptions(taskId)
        .then((d) => alive && setRefOptions(d))
        .catch(() => {});
    };
    setRefOptions(null);
    setExpandedTasks(new Set([taskId])); // current task defaults to expanded in browse mode
    load();
    // Keep the @ picker in sync with artifact mutations: a deposition
    // confirm / artifact rename / delete dispatches "depositions-changed"
    // WITHOUT detail — refetch so the just-confirmed artifact is immediately
    // referenceable (same task, branch ↔ main, no page refresh). Sidebar
    // polling events carry detail.jobs and are ignored (no request spam).
    const h = (e) => {
      if (!e.detail || !e.detail.jobs) load();
    };
    window.addEventListener("depositions-changed", h);
    return () => {
      alive = false;
      window.removeEventListener("depositions-changed", h);
    };
  }, [taskId]);

  // id → title for EVERY referenceable artifact (all tasks) — fallback source
  // for TaskRefNote bullets when a message reference lacks frozen titles.
  const artifactTitleById = useMemo(() => {
    const m = {};
    if (refOptions) for (const a of refOptions.artifacts) m[a.id] = a.title;
    return m;
  }, [refOptions]);

  // --- Inline @ mention handling ---

  const onInputChange = (e) => {
    const v = e.target.value;
    setInput(v);
    // Detect @query at cursor (or anywhere if cursor is right after @text)
    const pos = e.target.selectionStart;
    const textUpToCursor = v.slice(0, pos);
    const m = textUpToCursor.match(/@([^\s@]*)$/);
    setPickerQuery(m ? m[1] : null);
  };

  // Open the SAME reference picker the "@" keystroke opens (empty query),
  // keeping focus in the textarea so the insertion still lands at the caret.
  const openPicker = () => {
    setPickerQuery("");
    const textarea = textareaRef.current;
    if (textarea) textarea.focus();
  };

  const closePicker = () => setPickerQuery(null);

  const pickRef = (item) => {
    const textarea = textareaRef.current;
    const pos = textarea ? textarea.selectionStart : input.length;
    const textUpToCursor = input.slice(0, pos);
    const m = textUpToCursor.match(/@([^\s@]*)$/);
    // Replace an active "@query" at the caret; otherwise insert a fresh
    // mention at the caret (picker opened via the @ 引用 button — the same
    // single insertion path, no second reference logic). The visible token is
    // 【@title】 so mentions stand out from plain text; the structured
    // reference (id/type in mentionMap) stays the source of truth.
    const before = m ? input.slice(0, pos - m[0].length) : input.slice(0, pos);
    const mentionText = `【@${item.title}】`;
    const after = input.slice(pos);
    const newInput = before + mentionText + after;
    setInput(newInput);

    // Store in mentionMap (title → item)
    mentionMapRef.current = { ...mentionMapRef.current, [item.title]: item };
    closePicker();

    // Restore cursor position after the inserted text
    setTimeout(() => {
      if (textarea) {
        const newPos = before.length + mentionText.length;
        textarea.setSelectionRange(newPos, newPos);
        textarea.focus();
      }
    }, 0);
  };

  // Extract which mentions from mentionMap survive in the current input text.
  // Survival requires the FULL bracketed token 【@title】 — partially deleted
  // or fully deleted mentions drop out of the pending references.
  const extractLiveRefs = (text) => {
    const map = mentionMapRef.current;
    const refs = [];
    const seen = new Set();
    for (const [title, item] of Object.entries(map)) {
      if (text.includes(`【@${title}】`) && !seen.has(item.id)) {
        refs.push(item);
        seen.add(item.id);
      }
    }
    return refs;
  };

  const matches = (text, q) => !q || String(text || "").toLowerCase().includes(q.toLowerCase());

  const isBranch = conversation && conversation.type === "branch";
  // Main-view branch markers: origin main message id → branch conversations
  // spawned from that point (multiple branches sharing one origin collapse
  // into a single "N 条支线" marker with an expandable list).
  const branchOriginMap = useMemo(() => {
    const map = {};
    for (const c of convs) {
      if (c.type === "branch" && c.originMainMessageId) {
        (map[c.originMainMessageId] = map[c.originMainMessageId] || []).push(c);
      }
    }
    return map;
  }, [convs]);

  // --- reference picker data ------------------------------------------------
  // Browse mode: hierarchical Task → Artifact (current task expanded, others
  // collapsed). Search mode (non-empty query): flat hits across both.
  // Same refOptions payload as before — no backend change, no second
  // reference logic; picking still goes through pickRef / mentionMap.
  const artifactsByTask = {};
  if (refOptions) {
    for (const a of refOptions.artifacts) {
      (artifactsByTask[a.taskId] = artifactsByTask[a.taskId] || []).push(a);
    }
  }
  const currentArts = refOptions ? (artifactsByTask[taskId] || []) : [];
  const currentBranches = refOptions?.branches || [];
  const branchIds = new Set(currentBranches.map((branch) => branch.id));
  const mainArts = currentArts.filter((artifact) => !branchIds.has(artifact.sourceConversationId));
  const otherTasks = refOptions ? refOptions.tasks.filter((t) => t.id !== taskId) : [];
  const searchArtifactHits = pickerQuery
    ? (refOptions ? refOptions.artifacts : []).filter((a) => matches(a.title, pickerQuery) || matches(a.taskTitle, pickerQuery)).slice(0, 8)
    : [];
  const searchTaskHits = pickerQuery
    ? (refOptions ? refOptions.tasks : []).filter((t) => matches(t.title, pickerQuery)).slice(0, 8)
    : [];
  const searchBranchHits = pickerQuery
    ? currentBranches.filter((b) => matches(b.title, pickerQuery)).slice(0, 5)
    : [];

  const toggleTask = (id) =>
    setExpandedTasks((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  // "前往任务沉淀": close the picker, then navigate into that task (user
  // picks main/branch and deposits there — the picker never reads raw chat,
  // never creates artifacts, never triggers @Task). Current task: just close,
  // no redundant navigation.
  const goDeposit = (t) => {
    closePicker();
    if (t.id !== taskId) navigate(`/tasks/${t.id}`);
  };

  // Close the picker ONLY on a real outside mousedown (outside both the
  // picker and the textarea). Interactions inside the picker never close it:
  // the picker root preventDefaults mousedown (except its search input), so
  // the textarea never blurs — expanding a task used to blur-close the picker
  // before the row's click even registered.
  useEffect(() => {
    if (pickerQuery === null) return;
    const onDocMouseDown = (e) => {
      const t = e.target;
      if (pickerRef.current && t instanceof Node && pickerRef.current.contains(t)) return;
      if (textareaRef.current && t === textareaRef.current) return;
      closePicker();
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [pickerQuery]);

  const submit = async () => {
    const text = input.trim();
    if (!text || generating) return;
    const refs = extractLiveRefs(text);
    setInput("");
    mentionMapRef.current = {};
    closePicker();
    stickBottom.current = true;
    await run(text, refs);
  };

  const onKeyDown = (e) => {
    if (e.key === "Escape") { closePicker(); return; }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
  };

  if (notFound) {
    return (
      <div className="page-pad">
        任务不存在。<Link to="/" className="inline-link">返回首页</Link>
      </div>
    );
  }
  if (convMissing) {
    return (
      <div className="page-pad">
        对话不存在。<Link to={`/tasks/${taskId}`} className="inline-link">回到主线对话</Link>
      </div>
    );
  }

  // isBranch already declared above (line ~537); no re-declaration needed.
  const headerTitle = conversation
    ? isBranch
      ? conversation.title
      : task
        ? task.title
        : "…"
    : "…";

  return (
    <div className="chat">
      <div className="chat-head">
        <div className="chat-title">
          {headerTitle}
          {isBranch && <span className="branch-badge">继承创建时的主线上下文</span>}
        </div>
      </div>

      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="chat-inner">
          {/* Branch origin banner: shown at the top of a branch conversation */}
          {isBranch && (
            <div className="branch-origin-banner">
              <span className="bob-label">↑ 从主线这里展开</span>
              {originInfo?.excerpt && (
                <span className="bob-excerpt">
                  {originInfo.role === "user" ? "你说：" : "AI 说："}「{originInfo.excerpt}」
                </span>
              )}
              {originInfo?.mainConversationId && (
                <button
                  className="bob-back"
                  onClick={() =>
                    navigate(
                      `/tasks/${taskId}/c/${originInfo.mainConversationId}` +
                        (originInfo.found && originInfo.originMessageId
                          ? `?focus=${originInfo.originMessageId}`
                          : "")
                    )
                  }
                >
                  回到主线
                </button>
              )}
            </div>
          )}
          {messages === null && <div className="loading">加载中…</div>}
          {messages && messages.length === 0 && (
            <div className="chat-empty">
              {isBranch
                ? "这条支线已继承创建时的主线上下文，发送第一条消息开始推进"
                : "发送第一条消息，开始推进这个任务"}
            </div>
          )}
          {messages &&
            messages.map((m) => (
              <Fragment key={m.id}>
                <ChatMessage
                  message={m}
                  generating={generating && m.id === TMP_ASSISTANT}
                  titleById={artifactTitleById}
                />
                {/* BranchMarker: shown under main-conv messages that spawned branches */}
                {!isBranch && branchOriginMap[m.id] && (
                  <BranchMarker
                    branches={branchOriginMap[m.id]}
                    onOpen={(b) =>
                      navigate(`/tasks/${taskId}/c/${b.id}`)
                    }
                  />
                )}
              </Fragment>
            ))}
        </div>
      </div>

      <div className="composer-bar">
        <div className="composer">
          {pickerQuery !== null && refOptions && (
            <div
              className="ref-picker"
              ref={pickerRef}
              onMouseDown={(e) => {
                // Keep the current focus for every interaction inside the
                // picker (task expand, artifact rows, 引用任务…) so the
                // textarea never blurs and the picker never self-closes.
                // The search input is the ONLY element that may take focus.
                if (e.target && e.target.tagName !== "INPUT") e.preventDefault();
              }}
            >
              <div className="ref-head">
                <span className="ref-head-title">@ 引用</span>
                <input
                  className="ref-search"
                  type="text"
                  value={pickerQuery}
                  placeholder="搜索任务或成果…"
                  onChange={(e) => setPickerQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.stopPropagation();
                      closePicker();
                      if (textareaRef.current) textareaRef.current.focus();
                    }
                  }}
                />
              </div>
              <div className="ref-list">
                {pickerQuery ? (
                  <>
                    {searchArtifactHits.length === 0 && searchTaskHits.length === 0 && searchBranchHits.length === 0 && (
                      <div className="ref-empty">没有匹配「{pickerQuery}」的任务或成果</div>
                    )}
                    {searchArtifactHits.map((a) => (
                      <button
                        className="ref-item"
                        key={a.id}
                        onClick={() => pickRef({ type: "artifact", id: a.id, title: a.title })}
                      >
                        <span className={"type-chip ref-badge t-" + a.type}>{a.type}</span>
                        <span className="ref-item-title">{a.title}</span>
                        <span className="ref-item-origin">{a.taskTitle}</span>
                      </button>
                    ))}
                    {searchTaskHits.map((t) =>
                      t.artifactCount > 0 ? (
                        <button
                          className="ref-item"
                          key={t.id}
                          onClick={() => pickRef({ type: "task", id: t.id, title: t.title })}
                        >
                          <span className="type-chip ref-badge ref-badge-task">任务</span>
                          <span className="ref-item-title">{t.title}</span>
                          <span className="ref-item-origin">{t.artifactCount} 项成果</span>
                        </button>
                      ) : (
                        <div className="ref-item ref-item-static" key={t.id}>
                          <span className="type-chip ref-badge ref-badge-task">任务</span>
                          <span className="ref-item-title">{t.title}</span>
                          <span className="ref-item-origin">暂无成果</span>
                          <button className="ref-go-deposit" onClick={() => goDeposit(t)}>
                            前往任务沉淀
                          </button>
                        </div>
                      )
                    )}
                    {searchBranchHits.map((branch) => (
                      <div className="ref-branch-group" key={branch.id}>
                        <div className="ref-section">{branch.title}</div>
                        {branch.artifactCount > 0
                          ? currentArts.filter((a) => a.sourceConversationId === branch.id).map((a) => (
                            <button className="ref-item" key={a.id}
                              onClick={() => pickRef({ type: "artifact", id: a.id, title: a.title })}>
                              <span className={"type-chip ref-badge t-" + a.type}>{a.type}</span>
                              <span className="ref-item-title">{a.title}</span>
                            </button>
                          ))
                          : <div className="ref-empty-block">暂无可调用成果，需要先整理并确认。
                            <button className="ref-go-deposit" onClick={() => { closePicker(); navigate(`/tasks/${taskId}/c/${branch.id}`); }}>前往支线</button>
                          </div>}
                      </div>
                    ))}
                  </>
                ) : (
                  <>
                    <div className="ref-section">当前任务</div>
                    <div className="ref-task-row" onClick={() => toggleTask(taskId)}>
                      <span className="ref-caret">{expandedTasks.has(taskId) ? "▾" : "›"}</span>
                      <span className="ref-task-name" title={task ? task.title : ""}>
                        {task ? task.title : "…"}
                      </span>
                      <span className="ref-task-count">
                        {currentArts.length > 0 ? `${currentArts.length} 项成果` : "暂无成果"}
                      </span>
                      {task && currentArts.length > 0 && (
                        <button
                          className="ref-task-ref"
                          onClick={(e) => {
                            e.stopPropagation();
                            pickRef({ type: "task", id: taskId, title: task.title });
                          }}
                        >
                          引用任务
                        </button>
                      )}
                    </div>
                    {expandedTasks.has(taskId) &&
                      (<>
                        {mainArts.length > 0 && <div className="ref-section">主线成果</div>}
                        {mainArts.map((a) => (
                          <button
                            className="ref-item indented"
                            key={a.id}
                            onClick={() => pickRef({ type: "artifact", id: a.id, title: a.title })}
                          >
                            <span className={"type-chip ref-badge t-" + a.type}>{a.type}</span>
                            <span className="ref-item-title">{a.title}</span>
                          </button>
                        ))}
                        {currentBranches.map((branch) => <div className="ref-branch-group" key={branch.id}>
                          <div className="ref-section">{branch.title}</div>
                          {branch.artifactCount > 0
                            ? currentArts.filter((a) => a.sourceConversationId === branch.id).map((a) => (
                              <button className="ref-item indented" key={a.id}
                                onClick={() => pickRef({ type: "artifact", id: a.id, title: a.title })}>
                                <span className={"type-chip ref-badge t-" + a.type}>{a.type}</span>
                                <span className="ref-item-title">{a.title}</span>
                              </button>
                            ))
                            : <div className="ref-empty-block">暂无可调用成果，需要先整理并确认。
                                <button className="ref-go-deposit" onClick={() => { closePicker(); navigate(`/tasks/${taskId}/c/${branch.id}`); }}>前往支线</button>
                              </div>}
                        </div>)}
                        {currentArts.length === 0 && currentBranches.length === 0 && (
                        <div className="ref-empty-block">
                          <div className="ref-empty-inline">这个任务还没有可引用的成果</div>
                          <button className="ref-go-deposit" onClick={() => goDeposit({ id: taskId })}>
                            前往任务沉淀
                          </button>
                        </div>
                        )}
                      </>)}
                    {otherTasks.length > 0 && <div className="ref-section">其他任务</div>}
                    {otherTasks.map((t) => (
                      <div key={t.id}>
                        <div className="ref-task-row" onClick={() => toggleTask(t.id)}>
                          <span className="ref-caret">{expandedTasks.has(t.id) ? "▾" : "›"}</span>
                          <span className="ref-task-name" title={t.title}>{t.title}</span>
                          <span className="ref-task-count">
                            {t.artifactCount > 0 ? `${t.artifactCount} 项成果` : "暂无成果"}
                          </span>
                          {t.artifactCount > 0 && (
                            <button
                              className="ref-task-ref"
                              onClick={(e) => {
                                e.stopPropagation();
                                pickRef({ type: "task", id: t.id, title: t.title });
                              }}
                            >
                              引用任务
                            </button>
                          )}
                        </div>
                        {expandedTasks.has(t.id) &&
                          (t.artifactCount > 0 ? (
                            (artifactsByTask[t.id] || []).map((a) => (
                              <button
                                className="ref-item indented"
                                key={a.id}
                                onClick={() => pickRef({ type: "artifact", id: a.id, title: a.title })}
                              >
                                <span className={"type-chip ref-badge t-" + a.type}>{a.type}</span>
                                <span className="ref-item-title">{a.title}</span>
                              </button>
                            ))
                          ) : (
                            <div className="ref-empty-block">
                              <div className="ref-empty-inline">这个任务还没有可引用的成果</div>
                              <button className="ref-go-deposit" onClick={() => goDeposit(t)}>
                                前往任务沉淀
                              </button>
                            </div>
                          ))}
                      </div>
                    ))}
                  </>
                )}
              </div>
            </div>
          )}
          <textarea
            ref={textareaRef}
            rows={1}
            placeholder={generating ? "AI 正在回复…" : "输入消息，Enter 发送 · 输入 @ 引用成果/任务"}
            value={input}
            onChange={onInputChange}
            onKeyDown={onKeyDown}
            onBlur={() => setTimeout(() => {
              // Don't close when focus moved INTO the picker (e.g. its search box).
              const active = document.activeElement;
              if (pickerRef.current && active && pickerRef.current.contains(active)) return;
              closePicker();
            }, 150)}
          />
          <div className="composer-foot">
            <div className="composer-actions">
              <button
                className="deposit-btn"
                onMouseDown={(e) => e.preventDefault()}
                onClick={openPicker}
                disabled={!conversation}
                title="引用历史成果或任务，与输入 @ 相同"
              >
                @ 引用
              </button>
              <button
                className={"deposit-btn" + (myActiveJob ? " has-job" : "")}
                onClick={deposit}
                disabled={depositing || !conversation || Boolean(myActiveJob)}
                title="把本阶段新聊出的成果沉淀为可复用条目"
              >
                ✦ 沉淀
              </button>
              {depNote && <span className="dep-note">{depNote}</span>}
              {myActiveJob?.status === "processing" && (
                <span className="dep-chip processing">✦ 正在整理成果…</span>
              )}
              {myActiveJob?.status === "ready" && (
                <>
                  <button
                    className="dep-chip ready"
                    onClick={() => window.dispatchEvent(new CustomEvent("open-confirm", { detail: { jobId: myActiveJob.id } }))}
                  >
                    ✦ {myActiveJob.candidateCount} 项成果待确认
                  </button>
                  <button
                    className="dep-chip reanalyze"
                    onClick={() => reanalyzeDeposition(myActiveJob.id)}
                    title="重新分析，保持已冻结的源消息不变"
                  >
                    重新分析
                  </button>
                </>
              )}
              {myActiveJob?.status === "failed" && (
                <>
                  <button className="dep-chip failed" onClick={() => retryDeposition(myActiveJob.id)}>
                    成果整理失败 · 重试
                  </button>
                  <button
                    className="dep-chip reanalyze"
                    onClick={() => discardDeposition(myActiveJob.id)}
                    title="放弃本次整理（不推进阶段游标），可重新沉淀同一段消息"
                  >
                    放弃
                  </button>
                </>
              )}
            </div>
            {generating ? (
              <span className="gen-status">
                <span className="dots"><i /><i /><i /></span>
                正在生成…
              </span>
            ) : (
              <span className="hint">Enter 发送 · Shift+Enter 换行</span>
            )}
            <button className="send-btn" disabled={!input.trim() || generating} onClick={submit}>
              发送
            </button>
          </div>
        </div>
        {error && <div className="composer-error">{error}</div>}
      </div>
    </div>
  );
}
