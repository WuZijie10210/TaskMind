import { Link } from "react-router-dom";

export default function About() {
  return <div className="case-page"><article className="case-study">
    <header className="case-hero">
      <span className="case-kicker">TaskMind · AI 对话成果复用</span>
      <h1>先推进任务，自然接住成果</h1>
      <p className="case-lead">用 AI 做方案、报告等任务时，有用的判断、框架和方法常与临时探索混在长对话里。任务结束后，人们通常不会专门整理；之后想用时，又难以找到并接上当前任务。</p>
      <p>TaskMind 探索如何让这些阶段产出在任务推进中留下，并在以后继续使用。</p>
      <div className="case-actions"><Link className="case-cta" to="/tasks">进入产品 →</Link></div>
    </header>

    <section aria-labelledby="friction"><h2 id="friction">为什么有价值的内容留不下来、用不起来</h2>
      <p><strong>沉淀有成本：</strong>用户正忙着推进任务，不确定眼前内容以后是否有用；额外整理、命名和归档容易被放到最后。</p>
      <p><strong>调用有成本：</strong>之后可能只记得内容来自哪个任务，却想不起具体位置，也难判断它能否用于眼前的问题。重新问 AI 可能更省事。</p>
      <p>信任贯穿这两步：内容来自哪里、是否值得留下、能否接入新语境，以及哪些历史内容会被调用，都需要清楚的边界。</p>
    </section>

    <section aria-labelledby="flow"><h2 id="flow">从推进任务到复用成果</h2>
      <div className="case-examples">
        <div className="case-example"><span className="case-number">01 · 推进</span><h3>主线与支线</h3><p>主线围绕目标前进；需要单独追问时，从当前节点展开支线。探索可以继续，也可以放下。</p></div>
        <div className="case-example"><span className="case-number">02 · 留下</span><h3>用户确认成果</h3><p>需要保留时，用户主动发起整理；AI 提炼候选，用户回看来源、调整并确认后，它才成为成果。</p></div>
        <div className="case-example"><span className="case-number">03 · 调用</span><h3>从成果或任务找回</h3><p>知道具体内容，用 @成果；只记得来源，用 @任务从已确认成果中匹配。历史对话过程不会自动进入新任务。</p></div>
      </div>
    </section>

    <section aria-labelledby="choice"><h2 id="choice">设计判断</h2>
      <p>整理发生在用户觉得一段探索值得保留，或正需要跨对话调用时。AI 降低提炼成本，用户决定成果是否值得留下；调用从用户记得的任务出发，也只使用已确认的成果。</p>
      <p>早期调研从学习任务切入，设计关注的是复杂任务中阶段产出如何再次被使用。<a className="case-secondary" href="https://docs.qq.com/slide/DWnBuUUdwUmhDS01Y" target="_blank" rel="noopener noreferrer">查看调研分析 →</a></p>
    </section>
    <section aria-labelledby="next"><h2 id="next">下一步验证</h2>
      <p>优化整理触发时机、成果粒度和确认展示；通过成果保留率与后续调用率，检验这两步是否真的更容易发生。</p>
    </section>
    <footer className="case-footer"><Link className="case-cta" to="/tasks">开始探索 →</Link></footer>
  </article></div>;
}
