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
  const a = crypto.randomUUID();
  const b = crypto.randomUUID();
  await seedGuestExamples(a);
  await seedGuestExamples(a);
  assert.equal(tasks.length, 3, "Repeat visit must not recreate examples");
  assert.equal(committed, 2);
  assert.ok(tasks.every((task) => task.guest_id === a));
  assert.deepEqual(tasks.map((task) => task.demo_rank), [1, 2, 3]);
  assert.equal(artifacts.length, 3);
  assert.equal(branches.length, 3);
  assert.equal(jobs.length, 3);
  assert.ok(branches.every((branch) => JSON.parse(branch.snapshot).messages.length === 4));
  assert.ok(branches.every((branch) => messages.filter((m) => m.conversation_id === branch.id).length === 6));
  assert.deepEqual(refs.map((ref) => ref[1]), ["artifact", "task", "artifact"]);
  assert.deepEqual(refs.map((ref) => JSON.parse(ref[5])[0].id),
    [artifacts[0].id, artifacts[0].id, artifacts[2].id]);
  assert.deepEqual(refs.map((ref) => ref[2]), [artifacts[0].id, tasks[0].id, artifacts[2].id]);
  assert.ok(refs.every((ref) => messages.some((msg) => msg.id === ref[0])));
  for (const [index, task] of tasks.entries()) {
    const main = conversations.find((c) => c.task_id === task.id && !c.snapshot);
    const mainMessages = messages.filter((m) => m.conversation_id === main.id);
    assert.equal(mainMessages.length, 6);
    assert.equal(mainMessages.at(-2).role, "user");
    assert.equal(mainMessages.at(-1).role, "assistant");
    assert.equal(refs[index][0], mainMessages.at(-2).id);
    assert.match(mainMessages.at(-2).content, /【@.+】/);
  }
  assert.equal(artifacts.filter((artifact) => artifact.task_id === tasks[2].id).length, 0);
  assert.equal(artifacts[1].source_message_ids.length, 6, "Branch result cites only its own turns");
  assert.equal(artifacts[2].source_message_ids.length, 6, "Cross-task answer precedes its saved result");
  assert.ok(messages.every((message, index) => index === 0 ||
    message.created_at > messages[index - 1].created_at), "Messages sort in conversation order");
  assert.ok(tasks.every((task, index) => index === 0 ||
    task.created_at > tasks[index - 1].created_at), "Tasks sort in intended order");
  assert.equal(jobs[0][5], artifacts[0].source_message_ids.at(-1));
  assert.equal(jobs[2][5], artifacts[2].source_message_ids.at(-1));
  const cited = messages.find((message) => message.id === refs[1][0]);
  const contextual = buildAiMessages({ type: "main" }, [cited], {
    [cited.id]: [{ artifact_snapshots: JSON.parse(refs[1][5]) }],
  });
  assert.match(contextual[0].content, /文献线索核查卡/);
  assert.match(contextual[0].content, /可引用/);
  assert.match(messages.find((message) => message.id === refs[2][0]).content, /六页八分钟课堂分享稿/);
  assert.ok(messages.every((message) => !/本轮不保存成果|这个任务仍在探索阶段|按引用任务中实际调用|主线先不改|预置演示/.test(message.content)),
    "Visible dialogue should not contain product-internal instructions");
  if (process.env.DEMO_PREVIEW_PATH) {
    const lines = ["# TaskMind 示例对话预览", "", "以下内容直接来自本次预置数据；它是交互演示，不是真实文献、调查或用户效果。", ""];
    for (const [index, task] of tasks.entries()) {
      lines.push(`## ${index + 1}. ${task.title}`, "");
      for (const conversation of conversations.filter((item) => item.task_id === task.id)) {
        lines.push(`### ${conversation.title}`, "");
        for (const message of messages.filter((item) => item.conversation_id === conversation.id)) {
          lines.push(`**${message.role === "user" ? "用户" : "助手"}**：${message.content}`, "");
          const reference = refs.find((entry) => entry[0] === message.id);
          if (reference) {
            lines.push(`> 已保存的${reference[1] === "task" ? "任务" : "成果"}引用：「${reference[3]}」；实际调用：${JSON.parse(reference[5]).map((snap) => snap.title).join("、")}`, "");
          }
        }
      }
      const saved = artifacts.filter((artifact) => artifact.task_id === task.id);
      lines.push("### 已保存成果", "");
      if (!saved.length) lines.push("无。本任务保留对话与引用，但没有保存自己的成果。", "");
      for (const artifact of saved) {
        lines.push(`#### ${artifact.title}（${artifact.type}）`, "", artifact.content, "");
      }
    }
    fs.writeFileSync(process.env.DEMO_PREVIEW_PATH, lines.join("\n") + "\n");
  }
  await seedGuestExamples(b);
  assert.equal(tasks.length, 6);
  assert.ok(tasks.slice(3).every((task) => task.guest_id === b));
  assert.ok(refs.slice(3).every((ref) => !refs.slice(0, 3).some((old) => old[2] === ref[2])));
  const old = crypto.randomUUID();
  seedVersions.set(old, 1);
  const oldIds = Array.from({ length: 3 }, () => crypto.randomUUID());
  legacyRows = [
    { id: oldIds[0], title: "示例｜大学学习方式研究", main_count: 6,
      branch_titles: "支线｜资料核查方法", branch_count: 2,
      artifact_titles: "研究问题与证据清单", ref_count: 1, job_count: 0 },
    { id: oldIds[1], title: "示例｜学习工具课程汇报", main_count: 6,
      branch_titles: "支线｜证据与表述边界", branch_count: 2,
      artifact_titles: "八分钟汇报提纲", ref_count: 1, job_count: 0 },
    { id: oldIds[2], title: "示例｜新行业分析选题", main_count: 6,
      branch_titles: "支线｜信息来源筛选", branch_count: 2,
      artifact_titles: "", ref_count: 1, job_count: 0 },
  ];
  await seedGuestExamples(old);
  assert.deepEqual(archived, oldIds, "Only untouched old examples are archived");
  assert.equal(seedVersions.get(old), 3);
  const changed = crypto.randomUUID();
  seedVersions.set(changed, 1);
  legacyRows[0].main_count++;
  await seedGuestExamples(changed);
  assert.equal(archived.length, 3, "Changed examples remain visible");
  const v2 = crypto.randomUUID();
  seedVersions.set(v2, 2);
  const v2Ids = Array.from({ length: 3 }, () => crypto.randomUUID());
  legacyRows = [
    { id: v2Ids[0], title: "示例｜从宽泛选题到研究计划", main_count: 6,
      branch_titles: "支线｜找不到原文怎么办", branch_count: 2,
      artifact_titles: "无法核实资料的展示边界|文献线索核查卡", ref_count: 1, job_count: 2 },
    { id: v2Ids[1], title: "示例｜把研究计划做成课堂分享", main_count: 6,
      branch_titles: "支线｜没有数据怎么开场", branch_count: 2,
      artifact_titles: "六页八分钟课堂分享稿", ref_count: 1, job_count: 1 },
    { id: v2Ids[2], title: "示例｜教育科技行业分析立项", main_count: 6,
      branch_titles: "支线｜官网说法能当证据吗", branch_count: 2,
      artifact_titles: "", ref_count: 1, job_count: 0 },
  ];
  await seedGuestExamples(v2);
  assert.deepEqual(archived.slice(3), v2Ids, "Untouched second-generation examples are hidden on upgrade");
  assert.equal(seedVersions.get(v2), 3);
  const customizedV2 = crypto.randomUUID();
  seedVersions.set(customizedV2, 2);
  legacyRows[0].branch_count++;
  await seedGuestExamples(customizedV2);
  assert.equal(archived.length, 6, "A modified second-generation task remains visible");
  console.log("Guest examples PASS");
})().catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(() => { db.getPool = oldGetPool; });
