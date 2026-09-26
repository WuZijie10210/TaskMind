import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";

export default function About() {
  const [firstExample, setFirstExample] = useState(undefined);
  useEffect(() => {
    let active = true;
    api.listTasks().then(({ tasks }) => {
      if (active) setFirstExample((tasks || []).find((t) => t.title === "示例｜生成式 AI 与大学教育汇报") || null);
    }).catch(() => { if (active) setFirstExample(null); });
    return () => { active = false; };
  }, []);
  return <div className="case-page"><article className="case-study">
    <header className="case-hero">
      <span className="case-kicker">TaskMind · AI 对话成果复用</span>
      <h1>先推进任务，自然接住成果</h1>
      <p className="case-lead">用 AI 做方案、报告等任务时，有用的判断、框架和方法常与临时探索混在长对话里。任务结束后，人们通常不会专门整理；之后想用时，又难以找到并接上当前任务。</p>
      <p>TaskMind 探索如何让这些阶段产出在任务推进中留下，并在以后继续使用。</p>
      <div className="case-actions"><Link className="case-cta" to="/">开始自己的任务 →</Link></div>
    </header>

    <section aria-labelledby="friction"><h2 id="friction">为什么有用的内容常留在聊天记录里</h2>
      <p><strong>当下很难停下来整理。</strong>人正忙着推进任务，不确定这段话以后会不会用，也未必分得清它是阶段结果还是一次试错。要求他另外命名、分类和归档，容易变成额外负担。</p>
      <p><strong>以后也不容易找回来。</strong>人可能记得“上次在某个任务里讨论过”，却想不起在哪一轮、当时为什么这样判断。翻旧记录、重新理解背景之后，还得想它能不能接上现在的问题。</p>
      <p><strong>留下和再用，都需要心里有数。</strong>内容来自哪里、自己是否认可、眼下是否适用、系统到底带入了哪些历史内容，这些问题会影响人是否愿意保存和使用它。</p>
    </section>

    <section aria-labelledby="flow"><h2 id="flow">从推进任务到复用成果</h2>
      <div className="case-examples">
        <div className="case-example"><span className="case-number">01 · 推进</span><h3>让讨论分开走</h3><p>在一个任务里，主线推进目标；遇到值得单独追问的问题，从当前节点展开支线。支线可以继续，也可以放下。</p></div>
        <div className="case-example"><span className="case-number">02 · 留下</span><h3>只留下自己认可的内容</h3><p>用户需要时主动发起整理；AI 从对话中提出候选，用户查看来源、调整并确认后，它才成为可复用的成果。</p></div>
        <div className="case-example"><span className="case-number">03 · 找回</span><h3>从成果或任务出发</h3><p>知道具体内容，用 @成果；只记得来源，用 @任务从已确认成果中匹配。支线聊天不会自动进入主线，旧任务对话也不会自动带入新任务。</p></div>
      </div>
    </section>

    <section aria-labelledby="choice"><h2 id="choice">设计判断</h2>
      <p>先推进任务，等一段探索值得留下、或正需要回头使用时，再让 AI 帮忙整理。用户决定保存什么；之后只需记得相关任务，不必维护另一套资料目录。</p>
      <p>早期调研从学习任务切入；这套设计关注的是各类复杂任务中，中间产出怎样再次被使用。<a className="case-secondary" href="https://docs.qq.com/slide/DWnBuUUdwUmhDS01Y" target="_blank" rel="noopener noreferrer">查看调研分析 →</a></p>
    </section>
    <section aria-labelledby="next"><h2 id="next">下一步验证</h2>
      <p>优化整理触发时机、成果粒度和确认展示；通过成果保留率与后续调用率，检验这两步是否真的更容易发生。</p>
    </section>
    <footer className="case-footer">
      {firstExample ? <Link className="case-cta" to={`/tasks/${firstExample.id}`}>查看第一个示例 →</Link>
        : firstExample === null ? <Link className="case-cta" to="/tasks">查看全部任务 →</Link>
        : <span className="case-cta" aria-busy="true">正在查找示例…</span>}
    </footer>
  </article></div>;
}
