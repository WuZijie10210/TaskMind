import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { Link } from "react-router-dom";

const examples = [
  "我想做一份关于大学生学习方式的课程汇报，先帮我确定问题和资料来源",
  "我想研究生成式 AI 对大学学习方式的影响，帮我拆解研究路径",
  "我要做一个新行业分析，先和我一起确定问题、信息来源与输出结构",
];

// Home: "今天要推进什么？" + big composer.
// First message -> server creates Task + main conversation + user message,
// then we navigate into the task chat which triggers the streaming AI reply.
export default function Home() {
  const navigate = useNavigate();
  const [value, setValue] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState(null);
  const taRef = useRef(null);

  const submit = async () => {
    const text = value.trim();
    if (!text || creating) return;
    setCreating(true);
    setError(null);
    try {
      const { task } = await api.createTask(text);
      navigate(`/tasks/${task.id}?auto=1`);
    } catch (e) {
      setError(e.message || "创建失败，请重试");
      setCreating(false);
    }
  };

  const onKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="home">
      <div className="home-inner">
        <h1 className="home-title">今天要推进什么？</h1>
        <p className="home-sub">课程汇报 · 论文 · 研究分析 —— 从一句话开始，持续推进</p>
        <p className="demo-note">公开体验版 · 每个浏览器独立保存，数据 7 天后清理 · 每日 20 次对话、5 次成果整理</p>
        <div className="composer home-composer">
          <textarea
            ref={taRef}
            rows={3}
            autoFocus
            placeholder="描述你的学习任务，例如：帮我完成生成式 AI 对大学教育影响的课程汇报"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <div className="composer-foot">
            <span className="hint">Enter 发送 · Shift+Enter 换行</span>
            <button className="send-btn" disabled={!value.trim() || creating} onClick={submit}>
              {creating ? "创建中…" : "开始任务"}
            </button>
          </div>
        </div>
        {error && <div className="error-text">{error}</div>}
        <div className="demo-examples">
          <span>试试这些任务</span>
          {examples.map((example) => <button key={example} type="button" onClick={() => { setValue(example); taRef.current?.focus(); }}>{example}</button>)}
        </div>
        <p className="demo-about"><Link to="/about">了解 TaskMind 的产品设计思路 →</Link></p>
      </div>
    </div>
  );
}
