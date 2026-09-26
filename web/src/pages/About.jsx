import { Link } from "react-router-dom";

export default function About() {
  return <div className="case-page"><article className="case-study">
    <header className="case-hero">
      <span className="case-kicker">TaskMind · AI 对话成果复用</span>
      <h1>先推进任务，自然接住成果</h1>
      <p className="case-lead">用 AI 做方案、报告等任务时，很多有用的判断、框架和方法产生在过程中，却留在长对话里。下次需要时，人们往往找不到，也不会专门维护一套知识库。</p>
      <p>TaskMind 让阶段产出在任务推进中留下，并在后续对话里继续使用。</p>
      <div className="case-actions"><Link className="case-cta" to="/tasks">进入产品 →</Link></div>
    </header>

    <section aria-labelledby="flow"><h2 id="flow">从推进任务到复用成果</h2>
      <div className="case-examples">
        <div className="case-example"><span className="case-number">01 · 推进</span><h3>主线与支线</h3><p>主线围绕目标前进；需要单独追问时，从当前节点展开支线。探索可以继续，也可以放下。</p></div>
        <div className="case-example"><span className="case-number">02 · 留下</span><h3>用户确认成果</h3><p>需要保留时，用户发起整理，AI 提炼候选；用户确认后，它才成为可复用的成果。</p></div>
        <div className="case-example"><span className="case-number">03 · 调用</span><h3>从成果或任务找回</h3><p>知道具体内容，用 @成果；只记得来源，用 @任务从已确认成果中匹配。对话之间不自动共享过程。</p></div>
      </div>
    </section>

    <section aria-labelledby="choice"><h2 id="choice">设计判断</h2>
      <p>不是保存聊了什么，而是保存聊出了什么。整理发生在需要复用的时刻，由 AI 帮忙提炼、用户决定是否留下；调用时只需记得相关任务，不必记住成果的准确标题。</p>
      <p>这项设计起步于学习任务的探索性调研，但关注的是各类复杂任务中都可能出现的整理与复用成本。<a className="case-secondary" href="https://docs.qq.com/slide/DWnBuUUdwUmhDS01Y" target="_blank" rel="noopener noreferrer">查看早期调研分析 →</a></p>
    </section>
    <section aria-labelledby="next"><h2 id="next">下一步验证</h2>
      <p>优化整理触发时机、成果粒度和确认展示；观察用户是否愿意保留候选成果，以及之后是否真的会调用它们。</p>
    </section>
    <footer className="case-footer"><Link className="case-cta" to="/tasks">开始探索 →</Link></footer>
  </article></div>;
}
