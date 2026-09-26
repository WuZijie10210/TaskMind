import { Link } from "react-router-dom";

export default function About() {
  return <div className="case-page"><article className="case-study">
    <header className="case-hero">
      <span className="case-kicker">TaskMind · 产品设计</span>
      <h1>先推进任务，自然接住成果</h1>
      <p className="case-lead">用 AI 做一项复杂任务时，真正有用的往往不只是最后的回答，还有过程中形成的判断、框架和方法。它们容易留在长对话里，下一次需要时却找不到。</p>
      <p>TaskMind 让这些中间产出在任务推进中被留下，并在下一项任务中继续使用。用户无需另外维护一套资料库。</p>
      <div className="case-actions"><Link className="case-cta" to="/tasks">进入产品 →</Link></div>
    </header>

    <section aria-labelledby="flow"><h2 id="flow">怎么从对话走向成果</h2>
      <div className="case-examples">
        <div className="case-example"><span className="case-number">01 · 推进</span><h3>围绕任务对话</h3><p>主线持续推进目标。碰到需要追问的问题，从当前节点展开支线，独立探索，不打乱主线。</p></div>
        <div className="case-example"><span className="case-number">02 · 整理</span><h3>只留下值得复用的内容</h3><p>用户在需要时发起阶段整理；AI 提炼候选，用户查看并确认后，候选才成为成果。</p></div>
        <div className="case-example"><span className="case-number">03 · 调用</span><h3>在后续任务中接着用</h3><p>知道具体内容时用 @成果；只记得来自哪个任务时用 @任务，从该任务已确认成果中找回相关内容。</p></div>
      </div>
    </section>

    <section aria-labelledby="choice"><h2 id="choice">关键设计取舍</h2>
      <p><strong>不是保存聊了什么，而是保存聊出了什么。</strong>支线讨论可以被放下；只有用户确认的成果，才有进入后续对话的资格。</p>
      <p><strong>对话之间不共享过程，只共享明确调用的成果。</strong>主线和支线各自保留推进脉络，不自动互相带入全部聊天内容。</p>
      <p><strong>降低找回成本。</strong>@成果适合知道自己要什么的时候；@任务适合记得从哪里产生，却记不住成果标题的时候。</p>
    </section>
    <footer className="case-footer"><Link className="case-cta" to="/tasks">开始探索 →</Link></footer>
  </article></div>;
}
