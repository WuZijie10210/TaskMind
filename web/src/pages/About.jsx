import { Link } from "react-router-dom";

export default function About() {
  return <article className="case-study">
    <span className="case-kicker">个人产品作品 · Case Study</span>
    <h1>TaskMind：让复杂学习任务从对话走向成果</h1>
    <p className="case-lead">普通 AI 对话适合快速问答。面对需要多轮探索的任务，信息容易散落在长聊天记录里，临时探索也容易干扰主线。我用 TaskMind 探索一种更有结构的工作方式。</p>
    <Link className="case-cta" to="/">亲自体验产品 →</Link>
    <section><h2>产品假设</h2><p>如果把工作组织为「任务 → 主线与支线 → 可确认的成果 → 显式复用」，用户能否更容易延续复杂思考，并找到之前形成的结论？这是设计假设，还需要真实用户验证。</p></section>
    <section><h2>体验路径</h2><ol><li>用一句话创建任务，在主线推进目标。</li><li>遇到值得探索但不想打乱主线的问题时，创建支线。</li><li>把阶段讨论整理为候选成果，由用户审核后保存。</li><li>在后续对话中使用 @成果 或 @任务引用已保存的内容。</li></ol></section>
    <section><h2>三个关键决策</h2><p><strong>支线冻结创建时的主线上下文。</strong>支线获得明确的起点，主线之后的消息不会悄悄改变它的背景。</p><p><strong>成果需要用户确认。</strong>AI 负责提出候选，用户决定哪些内容值得成为可复用资产。</p><p><strong>引用保存内容快照。</strong>日后重命名或删除成果，不会改写已经发送给模型的历史语境。</p></section>
    <section><h2>现阶段与下一步</h2><p>这是一个可交互的个人项目，目前没有真实用户效果数据。公开体验版采用游客隔离和每日额度；下一步会优先验证用户是否真正需要支线与成果复用，再根据使用反馈优化信息架构和长对话的上下文预算。</p></section>
    <Link className="case-cta" to="/">开始一个任务 →</Link>
  </article>;
}
