import { Link } from "react-router-dom";

const examples = [
  { number: "01 · 建议先看", title: "从宽泛选题到研究计划",
    path: "主线确定研究问题 → 支线连续核查存疑资料 → 分别保存核查卡与判断 → 回到主线引用核查卡制定两天计划",
    payoff: "看主线如何保持方向，支线如何深入一个问题，以及成果如何再次进入对话。" },
  { number: "02 · 跨任务复用", title: "把研究计划做成课堂分享",
    path: "主线排出六页内容 → 支线打磨没有调查数据时的开场 → 主线引用第一个任务的核查卡 → 得到一份讲述稿",
    payoff: "看另一个任务如何借用已核实的方法，同时保留尚未填入的证据空位。" },
  { number: "03 · 探索中的任务", title: "教育科技行业分析立项",
    path: "主线收窄分析范围 → 支线辨别官网宣传与有效证据 → 主线引用第二个任务的讲述结构 → 留下一份待核查草稿",
    payoff: "看引用现有成果后仍可继续探索；这个任务尚未确认自己的成果。" },
];

export default function About() {
  return <div className="case-page"><article className="case-study">
    <header className="case-hero">
      <span className="case-kicker">TaskMind · 产品设计记录</span>
      <h1>把长对话里的探索，变成下次还能接着用的成果</h1>
      <p className="case-lead">一个研究题目往往要经历收窄范围、查找资料、处理例外，再写成可交付的内容。TaskMind 把这些步骤放在同一个任务里：主线负责推进目标，支线负责单独追问，确认过的内容可以被后续对话引用。</p>
      <div className="case-actions"><Link className="case-cta" to="/tasks">按顺序查看三个示例 →</Link><Link className="case-secondary" to="/">自己创建任务</Link></div>
      <p className="case-disclosure">以下示例为演示交互而编写，不是真实访谈、论文核查结果或用户效果数据。</p>
    </header>

    <section aria-labelledby="problem"><h2 id="problem">为什么要这样设计</h2>
      <p>复杂任务中的一段临时讨论可能很有价值，但也可能让原本要完成的目标失焦。即使对话给出了有用的做法，过几天仍需要翻找聊天记录、重新解释背景。产品假设是：给探索留出独立空间，并让用户决定哪些内容值得保存，能帮助人继续做事。这个假设尚未经过真实用户研究验证。</p>
    </section>

    <section aria-labelledby="examples"><h2 id="examples">从这三个任务看完整流程</h2>
      <p>三个示例各有主线和多轮支线。它们按下面的顺序展示；每个任务的主线最后一轮都有显式引用。</p>
      <div className="case-examples">{examples.map((item) => <div className="case-example" key={item.number}>
        <span className="case-number">{item.number}</span><h3>{item.title}</h3>
        <p className="case-path">{item.path}</p><p>{item.payoff}</p>
      </div>)}</div>
      <Link className="case-cta" to="/tasks">打开任务列表 →</Link>
    </section>

    <section aria-labelledby="decisions"><h2 id="decisions">三个交互决策</h2>
      <div className="case-decisions">
        <div><h3>支线有固定的起点</h3><p>从主线的某一刻分出支线时，保存当时的上下文。之后主线继续推进，不会悄悄改写支线的讨论背景；支线里的内容也不会自动进入主线。</p></div>
        <div><h3>成果由人确认</h3><p>AI 可以根据对话整理候选成果，用户检查、修改并决定是否保存。一次讨论可以暂时只留下对话，不必强行生成成果。</p></div>
        <div><h3>引用有可追溯的内容</h3><p>发送带有 @成果 或 @任务 的消息时，系统保存实际引用内容的快照。后续改名不会让历史消息看起来引用了另一份材料。</p></div>
      </div>
    </section>

    <section aria-labelledby="scope"><h2 id="scope">现在能体验什么</h2>
      <p>可以创建任务、继续主线或支线、审核阶段成果，并在新对话中引用保存过的内容。公开体验版按浏览器隔离访客数据，设置每日使用额度；不活跃数据会定期清理。三个示例是可编辑的演示数据，里面的占位文献和待查资料不能当作已经核实的事实。</p>
      <p>下一步需要通过真实使用验证：人们是否会主动开支线、是否愿意审核成果，以及跨任务引用能否真正减少重复整理。</p>
    </section>
    <footer className="case-footer"><Link className="case-cta" to="/tasks">先看第一个示例 →</Link></footer>
  </article></div>;
}
