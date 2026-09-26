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
        summary: params[4], content: params[5], source_message_ids: params[6], created_at: params[7] };
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
  assert.equal(tasks.length, 2, "Repeat visits do not add examples");
  assert.equal(committed, 2);
  assert.ok(tasks.every((t) => t.guest_id === firstGuest));
  assert.deepEqual(tasks.map((t) => t.demo_rank), [1, 2]);
  assert.equal(branches.length, 3, "Task A has two branches and Task B has one");
  assert.equal(artifacts.length, 2);
  assert.equal(jobs.length, 2, "Each confirmed result has a candidate record");
  assert.deepEqual(refs.map((r) => r[1]), ["artifact", "task"]);
  assert.equal(refs[0][2], artifacts[1].id, "Main explicitly uses the branch method");
  assert.deepEqual(refs[1][4], [artifacts[0].id, artifacts[1].id],
    "Cross-task reference only uses two confirmed artifacts");
  assert.deepEqual(JSON.parse(refs[1][5]).map((x) => x.title),
    artifacts.map((a) => a.title));

  const mains = tasks.map((task) => conversations.find((c) => c.task_id === task.id && !c.snapshot));
  for (const [i, main] of mains.entries()) {
    const turns = messages.filter((m) => m.conversation_id === main.id);
    assert.equal(turns.length, 6);
    assert.equal(turns.at(-2).id, refs[i][0], "Final main turn has explicit reference");
    assert.equal(turns.at(-1).role, "assistant");
  }
  assert.deepEqual(branches.map((b) => messages.filter((m) => m.conversation_id === b.id).length),
    [6, 6, 4]);
  assert.ok(branches.every((b) => JSON.parse(b.snapshot).messages.length === 4),
    "Branches freeze the main context before its final citation");
  assert.equal(artifacts[0].source_conversation_id, mains[0].id);
  assert.equal(artifacts[1].source_conversation_id, branches[0].id);
  assert.ok(artifacts.every((a) => a.task_id === tasks[0].id));
  assert.ok(!artifacts.some((a) => a.source_conversation_id === branches[1].id),
    "Abandoned teacher-replacement branch has no callable result");
  assert.ok(!artifacts.some((a) => a.task_id === tasks[1].id),
    "The workshop uses prior results without forcing a new result");
  assert.ok(jobs.every((job) => JSON.parse(job[3]).messages.length === 4 ||
    JSON.parse(job[3]).messages.length === 6));
  assert.ok(messages.every((m, i) => i === 0 || m.created_at > messages[i - 1].created_at));
  assert.ok(messages.every((m) => !/本轮不保存成果|用户确认保存|系统匹配了|这个任务仍在探索阶段/.test(m.content)),
    "The dialogue cannot narrate product internals");
  const cited = messages.find((m) => m.id === refs[1][0]);
  const contextual = buildAiMessages({ type: "main" }, [cited], {
    [cited.id]: [{ artifact_snapshots: JSON.parse(refs[1][5]) }],
  });
  assert.match(contextual[0].content, /先判断/);
  assert.match(contextual[0].content, /从零构建/);
  assert.doesNotMatch(contextual[0].content, /AI 会不会替代大学教师？大家可能更想听这个/,
    "The abandoned branch's raw chat must not enter a different task");

  if (process.env.DEMO_PREVIEW_PATH) {
    const lines = [
      "# TaskMind · 交互示例与对话预览",
      "",
      "这是一份预置交互的审阅稿：对话为编写的示例，整理与确认状态由预置记录模拟；不是实时 AI 回答、真实教学实验或用户研究。",
      "",
      "## 如何看链路",
      "",
      "任务 A 的主线先形成一份判断成果；支线 A 连续探索并确认三步方法；支线 B 探索后没有确认成果；主线明确引用支线 A 的方法。任务 B 最后 @任务 A，只取两份确认成果。",
      "以下为便于阅读按主线、支线分组；实际交互顺序为任务 A 主线前四条 → 支线 A → 支线 B → 返回任务 A 主线引用 → 任务 B。",
      "",
    ];
    for (const [index, task] of tasks.entries()) {
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
            const candidate = JSON.parse(job[4])[0];
            lines.push("**整理记录（预置交互状态，不是聊天消息）**：用户在本阶段主动发起整理 → AI 提炼候选「"+candidate.title+"」（"+candidate.type+"） → 用户查看来源、确认保存。来源消息 "+job[2].length+" 条。", "");
          }
        }
        if (conv.id === branches[1].id) lines.push("**状态**：这条支线没有确认成果；打开 @ 引用列表时会显示「暂无可调用成果」。", "");
      }
      lines.push("### 可调用的已确认成果", "");
      const saved = artifacts.filter((a) => a.task_id === task.id);
      if (!saved.length) lines.push("当前任务没有自己的确认成果，仍可以明确引用历史任务的成果。", "");
      for (const a of saved) lines.push("#### "+a.title+"（"+a.type+"）", "", a.content, "");
    }
    fs.writeFileSync(process.env.DEMO_PREVIEW_PATH, lines.join("\n") + "\n");
  }

  await seedGuestExamples(secondGuest);
  assert.equal(tasks.length, 4);
  assert.ok(tasks.slice(2).every((t) => t.guest_id === secondGuest));
  assert.ok(refs.slice(2).every((r) => !refs.slice(0, 2).some((old) => old[2] === r[2])),
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
  assert.equal(seedVersions.get(older), 4);
  assert.equal(tasks.length, 6, "An upgrade inserts two new curated examples");
  const copy = crypto.randomUUID();
  seedVersions.set(copy, 3);
  const duplicateId = crypto.randomUUID();
  legacyRows = [{ ...legacyRows[0], id: duplicateId }];
  await seedGuestExamples(copy);
  assert.deepEqual(archived.slice(2), [duplicateId], "Old duplicates are archived individually");
  console.log("Guest examples PASS");
})().catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(() => { db.getPool = oldGetPool; });
