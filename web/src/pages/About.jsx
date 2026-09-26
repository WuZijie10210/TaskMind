import { Link } from "react-router-dom";

const steps = [
  { number: "01", title: "围绕任务推进", detail: "「生成式 AI 与大学教育汇报」从一个宽泛题目开始，主线把重点收窄到学生判断力。左侧同时保留主线、两条支线和已确认成果。", see: "打开任务 A，看左侧结构与主线开头。" },
  { number: "02", title: "在出现问题的地方分出支线", detail: "「即时反馈会削弱学生判断吗」从主线当时的节点展开，沿着反馈时机连聊三轮。另一条「AI 会替代大学教师吗」探了一段后被放下。", see: "打开两条支线，看顶部来源与不同结果。" },
  { number: "03", title: "没有成果时，过程不能直接调用", detail: "尚未确认成果的「教师替代」支线不会把聊天内容带回主线。引用选择框会标明该支线暂无可调用成果；支线对话仍留在原处。", see: "在任务 A 的输入框输入 @，展开尚无成果的支线。" },
  { number: "04", title: "整理候选，由用户决定留什么", detail: "「即时反馈」支线讨论出三步做法。AI 提炼方法候选；用户查看内容与来源，确认后才得到可调用的成果。已确认的示例可打开整理记录回看候选与来源。", see: "看支线 A 的成果及左侧整理记录；也可以在自己的任务中实际发起整理。" },
  { number: "05", title: "让确认的成果回到主线", detail: "主线明确 @「先判断—再反馈—后验证」三步框架，基于它重新安排 8 分钟汇报。只带入这份成果，不读取支线全部聊天。", see: "看任务 A 主线最后一轮的引用与回复。" },
  { number: "06", title: "只记得任务，也能找回成果", detail: "「AI 素养工作坊」直接 @ 历史汇报任务。系统从已确认成果中匹配判断力差异和三步方法，再帮助设计学生任务卡。", see: "看任务 B 主线最后一轮与引用标记。" },
];

export default function About() {
  return <div className="case-page"><article className="case-study">
    <header className="case-hero">
      <span className="case-kicker">TaskMind · 产品设计记录</span>
      <h1>先推进任务，自然接住成果</h1>
      <p className="case-lead">做报告、方案和研究整理时，AI 对话里会产生有价值的中间产出，却常常埋在长记录中。TaskMind 试着解决：人不刻意维护知识库，聊出的阶段成果如何仍能被找回、调用，并继续服务下一个任务。</p>
      <div className="case-actions"><Link className="case-cta" to="/tasks">从示例任务开始 →</Link><Link className="case-secondary" to="/">自己开始一个任务</Link></div>
      <p className="case-disclosure">示例对话是为演示产品行为而编写，未声称真实用户研究或教学效果。</p>
    </header>

    <section aria-labelledby="principle"><h2 id="principle">不是保存聊了什么，而是保存聊出了什么</h2>
      <p>用户围绕一个任务持续推进；遇到值得深究的问题，可以从当时的主线节点开支线。支线可以形成成果，也可以探索后放下。对话之间不共享过程，只共享用户明确调用的成果；可调用的前提是这份成果经过用户确认。</p>
      <p>整理不是自动总结全部历史：用户主动发起一次阶段整理，AI 提炼候选，用户看来源、决定是否保存。未经确认的内容留在对话中，不会悄悄进入别的对话。</p>
    </section>

    <section aria-labelledby="walkthrough"><h2 id="walkthrough">用两个任务看完整链路</h2>
      <p>任务 A「生成式 AI 与大学教育汇报」展示主线、两条支线、确认成果及回到主线调用；任务 B「AI 素养工作坊」展示跨任务复用。按以下顺序看，重点是成果如何产生和流转。</p>
      <div className="case-examples">{steps.map((s) => <div className="case-example" key={s.number}>
        <span className="case-number">{s.number} / 06</span><h3>{s.title}</h3>
        <p className="case-path">{s.detail}</p><p className="case-see">{s.see}</p>
      </div>)}</div>
      <Link className="case-cta" to="/tasks">打开两个示例任务 →</Link>
    </section>

    <section aria-labelledby="reuse"><h2 id="reuse">两种引用，回应两种记忆方式</h2>
      <div className="case-decisions">
        <div><h3>@成果：我知道我要什么</h3><p>明确选中一份已确认成果。任务 A 的主线使用支线的三步框架；发送时保存引用内容快照，历史对话可追溯。</p></div>
        <div><h3>@任务：我知道去哪里找</h3><p>只记得成果出自哪项任务时，选择整个任务。系统只从这个任务已确认的成果中匹配相关内容，不读取任务原始聊天。</p></div>
        <div><h3>由人确认，才进入下次对话</h3><p>AI 负责提炼候选，用户负责判断此刻要不要留、要留什么。没有成果的支线仍可以继续聊，也可以放下。</p></div>
      </div>
    </section>

    <section aria-labelledby="limits"><h2 id="limits">目前的边界与待验证问题</h2>
      <p>这是可交互的产品原型。示例展示的是设计路径，不是已经验证的教学方法；有关学生判断力的描述用于提出问题和设计练习，不应当作效果结论。公开体验版按浏览器隔离访客数据、限制每天的模型调用，并定期清理不活跃任务。</p>
      <p>下一步需要观察：用户会不会在推进任务时主动整理，哪些候选值得保留，以及用 @任务 找成果是否真的比重翻聊天记录轻松。现在没有真实用户效果数据。</p>
    </section>
    <footer className="case-footer"><Link className="case-cta" to="/tasks">先看任务 A →</Link></footer>
  </article></div>;
}
