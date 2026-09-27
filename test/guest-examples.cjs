const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const db = require("../app/services/db");
const { seedGuestExamples } = require("../app/lib/guest-examples");
const { buildAiMessages } = require("../app/lib/context");

const oldGetPool = db.getPool;
const seedVersions = new Map();
const tasks = [];
const conversations = [];
const messages = [];
const artifacts = [];
const refs = [];
const branches = [];
const jobs = [];
const archived = [];
let legacyRows = [];
let committed = 0;

const client = {
  async query(sql, params = []) {
    if (sql === "BEGIN" || sql === "ROLLBACK") return { rowCount: 0, rows: [] };
    if (sql === "COMMIT") { committed++; return { rowCount: 0, rows: [] }; }
    if (sql.startsWith("INSERT INTO guest_example_seeds")) {
      if (seedVersions.has(params[0])) return { rowCount: 0, rows: [] };
      seedVersions.set(params[0], params[1]);
      return { rowCount: 1, rows: [{ guest_id: params[0] }] };
    }
    if (sql.startsWith("SELECT seed_version FROM guest_example_seeds")) {
      return { rows: [{ seed_version: seedVersions.get(params[0]) }] };
    }
    if (sql.startsWith("SELECT t.id,t.title")) return { rows: legacyRows };
    if (sql.startsWith("UPDATE tasks SET is_archived_example")) {
      archived.push(...params[1]); return { rows: [] };
    }
    if (sql.startsWith("UPDATE guest_example_seeds SET seed_version")) {
      seedVersions.set(params[0], params[1]); return { rows: [] };
    }
    if (sql.startsWith("INSERT INTO tasks")) {
      const row = { id: crypto.randomUUID(), title: params[0], guest_id: params[1], demo_rank: params[2], created_at: params[3] };
      tasks.push(row); return { rowCount: 1, rows: [row] };
    }
    if (sql.startsWith("INSERT INTO conversations")) {
      const isBranch = params.length === 5;
      const row = { id: crypto.randomUUID(), task_id: params[0], snapshot: isBranch ? params[2] : null,
        title: isBranch ? params[1] : "主线对话" };
      if (isBranch) branches.push(row);
      conversations.push(row);
      return { rowCount: 1, rows: [row] };
    }
    if (sql.startsWith("INSERT INTO messages")) {
      const row = { id: crypto.randomUUID(), conversation_id: params[0], role: params[1], content: params[2],
        created_at: params[3] };
      messages.push(row); return { rowCount: 1, rows: [row] };
    }
    if (sql.startsWith("INSERT INTO artifacts")) {
      const row = { id: crypto.randomUUID(), task_id: params[0],
        source_conversation_id: params[1], title: params[2], type: params[3],
        summary: params[4], content: params[5], source_message_ids: params[6],
        source_snapshot: JSON.parse(params[7]), source_conversation_title: params[8], created_at: params[9] };
      artifacts.push(row); return { rowCount: 1, rows: [row] };
    }
    if (sql.startsWith("INSERT INTO deposition_jobs")) {
      jobs.push(params); return { rows: [] };
    }
    if (sql.startsWith("INSERT INTO message_references")) {
      refs.push(params); return { rowCount: 1, rows: [] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  },
  release() {},
};
db.getPool = () => ({ connect: async () => client });

(async () => {
  const firstGuest = crypto.randomUUID();
  const secondGuest = crypto.randomUUID();
  await seedGuestExamples(firstGuest);
  await seedGuestExamples(firstGuest);
  assert.equal(tasks.length, 3, "Repeat visits do not add examples");
  assert.equal(committed, 2);
  assert.ok(tasks.every((t) => t.guest_id === firstGuest));
  assert.deepEqual(tasks.map((t) => t.demo_rank), [1, 3, 2],
    "The report is first, workshop second, and new source task third in the task list");
  assert.deepEqual(tasks.slice().sort((a, b) => a.demo_rank - b.demo_rank).map((t) => t.title),
    ["示例｜生成式 AI 与大学教育汇报", "示例｜AI 素养工作坊", "示例｜团队方案评审会"]);
  assert.equal(branches.length, 3, "The report has two branches and the workshop has one");
  assert.equal(artifacts.length, 9, "Both source tasks have confirmed results");
  assert.equal(jobs.length, 5, "Each confirmed stage has a record");
  assert.deepEqual(jobs.map((job) => JSON.parse(job[4]).length), [2, 2, 1, 1, 3],
    "One review can confirm more than one useful intermediate result");
  assert.deepEqual(refs.map((r) => r[1]), ["artifact", "artifact", "task", "task"]);
  assert.equal(refs[0][2], artifacts[2].id, "Main explicitly uses the branch method");
  assert.equal(refs[1][2], artifacts[6].id, "The review task finishes by citing its own method");
  assert.equal(refs[2][2], tasks[1].id, "The report cites the other task by task ID");
  assert.deepEqual(refs[2][4], [artifacts[6].id],
    "The report matches one relevant method from three confirmed review results");
  assert.deepEqual(JSON.parse(refs[2][5]).map((x) => x.title), [artifacts[6].title]);
  assert.deepEqual(refs[3][4], [artifacts[0].id, artifacts[2].id],
    "The workshop uses two transferable results out of six confirmed results");
  assert.deepEqual(JSON.parse(refs[3][5]).map((x) => x.title),
    [artifacts[0].title, artifacts[2].title],
    "The task-reference snapshot contains only the two selected results");
  assert.ok(artifacts.slice(0, 6).filter((a) => !refs[3][4].includes(a.id)).every((a) =>
    !JSON.stringify(JSON.parse(refs[3][5])).includes(a.title)),
    "The other four report results do not leak into the workshop prompt");
  assert.ok(artifacts.slice(7).every((a) => !JSON.stringify(JSON.parse(refs[2][5])).includes(a.title)),
    "The task reference in the report excludes unrelated meeting results");
  assert.deepEqual(new Set(artifacts.slice(0, 6).map((a) => a.type)),
    new Set(["结论", "案例", "框架", "判断", "模板", "方法"]),
    "The demonstrated labels describe six distinct, supported types of source material");

  const mains = tasks.map((task) => conversations.find((c) => c.task_id === task.id && !c.snapshot));
  for (const [i, main] of mains.entries()) {
    const turns = messages.filter((m) => m.conversation_id === main.id);
    assert.equal(turns.length, i === 0 ? 12 : 6);
    assert.equal(turns.at(-2).id, refs[i === 0 ? 2 : i === 1 ? 1 : 3][0],
      "Final main turn has explicit reference");
    assert.equal(turns.at(-1).role, "assistant");
  }
  const reportTurns = messages.filter((m) => m.conversation_id === mains[0].id);
  const reportJobs = jobs.filter((job) => job[1] === mains[0].id);
  assert.equal(reportJobs.length, 2);
  assert.equal(reportJobs.at(-1)[2].at(-1), reportTurns[5].id,
    "The last confirmed stage ends before the six new main turns");
  const pendingSource = reportTurns.slice(6);
  assert.deepEqual(pendingSource.map((m) => m.role),
    ["user", "assistant", "user", "assistant", "user", "assistant"]);
  assert.match(pendingSource.at(-1).content, /投屏给同学填写/);
  assert.match(pendingSource.at(-1).content, /主持人照着问/);
  assert.ok(!artifacts.some((a) => a.source_message_ids.some((id) =>
    pendingSource.some((m) => m.id === id))),
  "The two candidate results are left unconfirmed so visitors can try depositing");
  assert.deepEqual(branches.map((b) => messages.filter((m) => m.conversation_id === b.id).length),
    [6, 6, 4]);
  assert.ok(branches.every((b) => JSON.parse(b.snapshot).messages.length === 4),
    "Branches freeze the main context before its final citation");
  assert.equal(artifacts[0].source_conversation_id, mains[0].id);
  assert.equal(artifacts[1].source_conversation_id, mains[0].id);
  assert.equal(artifacts[2].source_conversation_id, branches[0].id);
  assert.equal(artifacts[3].source_conversation_id, branches[0].id);
  assert.equal(artifacts[4].source_conversation_id, branches[1].id);
  assert.equal(artifacts[5].source_conversation_id, mains[0].id);
  assert.equal(artifacts[5].source_message_ids.length, 6,
    "The reusable speaking template comes from the final, fully developed main exchange");
  assert.ok(artifacts.every((a) => a.source_snapshot.length === a.source_message_ids.length),
    "Confirmed example results preserve their source messages for later review");
  assert.equal(artifacts[4].type, "判断", "A discarded direction can leave a reusable decision");
  assert.ok(!artifacts.some((a) => a.source_conversation_id === branches[2].id),
    "The workshop's unfinished branch has no callable result");
  assert.ok(artifacts.slice(0, 6).every((a) => a.task_id === tasks[0].id));
  assert.ok(artifacts.slice(6).every((a) => a.task_id === tasks[1].id));
  assert.ok(!artifacts.some((a) => a.task_id === tasks[2].id),
    "The workshop uses prior results without forcing a new result");
  assert.ok(jobs.every((job) => JSON.parse(job[3]).messages.length === 4 ||
    JSON.parse(job[3]).messages.length === 6));
  assert.ok(messages.every((m, i) => i === 0 || m.created_at > messages[i - 1].created_at));
  assert.ok(messages.every((m) => !/本轮不保存成果|用户确认保存|系统匹配了|这个任务仍在探索阶段/.test(m.content)),
    "The dialogue cannot narrate product internals");
  const cited = messages.find((m) => m.id === refs[3][0]);
  const contextual = buildAiMessages({ type: "main" }, [cited], {
    [cited.id]: [{ artifact_snapshots: JSON.parse(refs[3][5]) }],
  });
  assert.match(contextual[0].content, /先判断/);
  assert.match(contextual[0].content, /从零构建/);
  assert.doesNotMatch(contextual[0].content, /AI 会不会替代大学教师？大家可能更想听这个/,
    "The abandoned branch's raw chat must not enter a different task");
  const reportCited = messages.find((m) => m.id === refs[2][0]);
  const reportContext = buildAiMessages({ type: "main" }, [reportCited], {
    [reportCited.id]: [{ artifact_snapshots: JSON.parse(refs[2][5]) }],
  });
  assert.match(reportContext[0].content, /先写判断再展示方案/);
  assert.doesNotMatch(reportContext[0].content, /团队要在 15 分钟例会上比较两版首页方案/,
    "The report only reads the selected result, never the review task's raw conversation");

  if (process.env.DEMO_PREVIEW_PATH) {
    const lines = [
      "# TaskMind · 交互示例与对话预览",
      "",
      "这是一份预置交互的审阅稿：对话为编写的示例，整理与确认状态由预置记录模拟；不是实时 AI 回答、真实教学实验或用户研究。",
      "",
      "## 如何看链路",
      "",
      "列表中展示顺序：①生成式 AI 与大学教育汇报；②AI 素养工作坊；③团队方案评审会。任务 A 的主线先保留结论和框架，支线 A 保留方法与自拟案例，支线 B 保留选题取舍；主线直接 @成果形成汇报模板。团队方案评审会留有三项已确认成果；任务 A 最后一轮 @这个任务，只取其中的独立判断方法，不读取整段会议对话。主线最后六条消息还可供访客亲自尝试整理：预计可分别提炼同学用的记录卡和主持人用的追问方法，尚未预先保存；实际候选由 AI 当场生成，数量可能不同。AI 素养工作坊最后 @任务 A，从六项已确认成果里只取适合工作坊的两项。",
      "以下为便于阅读按任务和主线、支线分组；实际交互顺序为任务 A 主线前四条 → 支线 A → 支线 B → 返回任务 A 主线引用并确认汇报模板 → 团队方案评审会确认成果 → 回到任务 A 用 @任务安排现场练习 → AI 素养工作坊 @任务 A。",
      "",
    ];
    for (const [index, task] of tasks.slice().sort((a, b) => a.demo_rank - b.demo_rank).entries()) {
      lines.push("## " + (index + 1) + ". " + task.title, "");
      for (const conv of conversations.filter((c) => c.task_id === task.id)) {
        lines.push("### " + conv.title, "");
        if (conv.snapshot) {
          lines.push("> 来源：从主线第 " + JSON.parse(conv.snapshot).messages.length + " 条消息后的节点展开。后续主线对话不会自动流入这条支线。", "");
        }
        for (const msg of messages.filter((m) => m.conversation_id === conv.id)) {
          lines.push("**" + (msg.role === "user" ? "用户" : "助手") + "**：" + msg.content, "");
          const ref = refs.find((r) => r[0] === msg.id);
          if (ref) {
            lines.push("> 明确 @"+(ref[1] === "task" ? "任务" : "成果")+"：「"+ref[3]+"」；本轮引用的已确认成果："+JSON.parse(ref[5]).map((a)=>a.title).join("、")+"。", "");
          }
          for (const job of jobs.filter((j) => j[1] === conv.id && j[2].at(-1) === msg.id)) {
            const candidates = JSON.parse(job[4]);
            lines.push("**整理记录（预置交互状态，不是聊天消息）**：用户在本阶段主动发起整理 → AI 提炼候选"+
              candidates.map((candidate) => "「"+candidate.title+"」（"+candidate.type+"）").join("、")+
              " → 用户查看来源、确认保存。来源消息 "+job[2].length+" 条。", "");
          }
        }
        if (conv.id === branches[2].id) lines.push("**状态**：这条支线没有确认成果；打开 @ 引用列表时会显示「暂无可调用成果」。", "");
      }
      lines.push("### 可调用的已确认成果", "");
      const saved = artifacts.filter((a) => a.task_id === task.id);
      if (!saved.length) lines.push("当前任务没有自己的确认成果，仍可以明确引用历史任务的成果。", "");
      for (const a of saved) lines.push("#### "+a.title+"（"+a.type+"）", "", a.content, "");
      if (task.id === tasks[0].id) lines.push("**尚可尝试沉淀**：主线最后六条对话在最近一次确认之后产生。点击主线的「沉淀」可审阅 AI 当场提炼的候选，预计有同学用的四格记录卡与主持人用的三句追问。", "");
    }
    fs.writeFileSync(process.env.DEMO_PREVIEW_PATH, lines.join("\n") + "\n");
  }

  await seedGuestExamples(secondGuest);
  assert.equal(tasks.length, 6);
  assert.ok(tasks.slice(3).every((t) => t.guest_id === secondGuest));
  assert.ok(refs.slice(4).every((r) => !refs.slice(0, 4).some((old) => old[2] === r[2])),
    "Different visitors' references must be isolated");

  const older = crypto.randomUUID();
  seedVersions.set(older, 3);
  const ids = Array.from({ length: 3 }, () => crypto.randomUUID());
  legacyRows = [
    { id: ids[0], title: "示例｜从宽泛选题到研究计划", main_count: 6,
      branch_titles: "支线｜找不到原文怎么办", branch_count: 6,
      artifact_titles: "无法核实资料的展示边界|文献线索核查卡", ref_count: 1, job_count: 2 },
    { id: ids[1], title: "示例｜把研究计划做成课堂分享", main_count: 6,
      branch_titles: "支线｜没有数据怎么开场", branch_count: 6,
      artifact_titles: "六页八分钟课堂分享稿", ref_count: 1, job_count: 1 },
    { id: ids[2], title: "示例｜教育科技行业分析立项", main_count: 7,
      branch_titles: "支线｜官网说法能当证据吗", branch_count: 6,
      artifact_titles: "", ref_count: 1, job_count: 0 },
  ];
  await seedGuestExamples(older);
  assert.deepEqual(archived, ids.slice(0, 2),
    "Only unchanged earlier tasks are hidden; user-edited examples survive");
  assert.equal(seedVersions.get(older), 9);
  assert.equal(tasks.length, 9, "An upgrade inserts three curated examples");
  const copy = crypto.randomUUID();
  seedVersions.set(copy, 3);
  const duplicateId = crypto.randomUUID();
  legacyRows = [{ ...legacyRows[0], id: duplicateId }];
  await seedGuestExamples(copy);
  assert.deepEqual(archived.slice(2), [duplicateId], "Old duplicates are archived individually");

  const recentGuest = crypto.randomUUID();
  seedVersions.set(recentGuest, 4);
  const recentIds = Array.from({ length: 3 }, () => crypto.randomUUID());
  const recentReport = {
    id: recentIds[0], title: "示例｜生成式 AI 与大学教育汇报", main_count: 6,
    branch_titles: "支线｜即时反馈会削弱学生判断吗|支线｜AI 会替代大学教师吗", branch_count: 12,
    artifact_titles: "学生使用 AI 时的「先判断—再反馈—后验证」三步框架|从零构建与对 AI 草稿反应的判断力差异",
    ref_count: 1, job_count: 2,
  };
  legacyRows = [
    recentReport,
    { id: recentIds[1], title: "示例｜AI 素养工作坊", main_count: 6,
      branch_titles: "支线｜小组互评怎么提问", branch_count: 4,
      artifact_titles: "", ref_count: 1, job_count: 0 },
    { ...recentReport, id: recentIds[2], main_count: 7 },
  ];
  await seedGuestExamples(recentGuest);
  assert.deepEqual(archived.slice(3), recentIds.slice(0, 2),
    "Pristine version 4 examples are hidden; changed conversations survive the refresh");
  assert.equal(seedVersions.get(recentGuest), 9);
  const versionFiveGuest = crypto.randomUUID();
  seedVersions.set(versionFiveGuest, 5);
  const versionFiveId = crypto.randomUUID();
  legacyRows = [{ ...recentReport, id: versionFiveId }];
  await seedGuestExamples(versionFiveGuest);
  assert.equal(archived.at(-1), versionFiveId,
    "An unchanged version 5 source example is archived before showing the five-result version");
  assert.equal(seedVersions.get(versionFiveGuest), 9);
  const versionSixGuest = crypto.randomUUID();
  seedVersions.set(versionSixGuest, 6);
  const versionSixId = crypto.randomUUID();
  legacyRows = [{ ...recentReport, id: versionSixId,
    artifact_titles: "从零构建与对 AI 草稿反应的判断力差异|大学教育汇报的切入问题与范围|学生使用 AI 时的「先判断—再反馈—后验证」三步框架|即时反馈议题的汇报论证边界|不以「AI 是否替代教师」作为汇报主线",
    job_count: 3 }];
  await seedGuestExamples(versionSixGuest);
  assert.equal(archived.at(-1), versionSixId,
    "An unchanged version 6 example is archived before showing examples with more type variety");
  assert.equal(seedVersions.get(versionSixGuest), 9);
  const versionSevenGuest = crypto.randomUUID();
  seedVersions.set(versionSevenGuest, 7);
  const versionSevenId = crypto.randomUUID();
  legacyRows = [{ ...recentReport, id: versionSevenId,
    artifact_titles: "从零构建与对 AI 草稿反应的判断力差异|大学教育汇报的切入问题与范围|学生使用 AI 时的「先判断—再反馈—后验证」三步框架|同一道讨论题的两种 AI 反馈时机|不以「AI 是否替代教师」作为汇报主线|八分钟汇报的对比与练习结构",
    job_count: 4 }];
  await seedGuestExamples(versionSevenGuest);
  assert.equal(archived.at(-1), versionSevenId,
    "An unchanged version 7 example is archived before the depositable version appears");
  assert.equal(seedVersions.get(versionSevenGuest), 9);
  const versionEightGuest = crypto.randomUUID();
  seedVersions.set(versionEightGuest, 8);
  const versionEightId = crypto.randomUUID();
  legacyRows = [{ ...legacyRows[0], id: versionEightId, main_count: 12, ref_count: 2 }];
  await seedGuestExamples(versionEightGuest);
  assert.equal(archived.at(-1), versionEightId,
    "An unchanged version 8 report is archived before adding the referenced third task");
  assert.equal(seedVersions.get(versionEightGuest), 9);
  console.log("Guest examples PASS");
})().catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(() => { db.getPool = oldGetPool; });
