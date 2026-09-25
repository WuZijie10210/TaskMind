const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const db = require("../app/services/db");
const { seedGuestExamples } = require("../app/lib/guest-examples");

const oldGetPool = db.getPool;
const seen = new Set();
const tasks = [];
const conversations = [];
const messages = [];
const artifacts = [];
const refs = [];
const branches = [];
let committed = 0;

const client = {
  async query(sql, params = []) {
    if (sql === "BEGIN" || sql === "ROLLBACK") return { rowCount: 0, rows: [] };
    if (sql === "COMMIT") { committed++; return { rowCount: 0, rows: [] }; }
    if (sql.startsWith("INSERT INTO guest_example_seeds")) {
      if (seen.has(params[0])) return { rowCount: 0, rows: [] };
      seen.add(params[0]);
      return { rowCount: 1, rows: [{ guest_id: params[0] }] };
    }
    if (sql.startsWith("INSERT INTO tasks")) {
      const row = { id: crypto.randomUUID(), title: params[0], guest_id: params[1] };
      tasks.push(row); return { rowCount: 1, rows: [row] };
    }
    if (sql.startsWith("INSERT INTO conversations")) {
      const isBranch = params.length === 4;
      const row = { id: crypto.randomUUID(), task_id: params[0], snapshot: isBranch ? params[2] : null };
      if (isBranch) branches.push(row);
      conversations.push(row);
      return { rowCount: 1, rows: [row] };
    }
    if (sql.startsWith("INSERT INTO messages")) {
      const row = { id: crypto.randomUUID(), conversation_id: params[0], role: params[1], content: params[2],
        created_at: new Date().toISOString() };
      messages.push(row); return { rowCount: 1, rows: [row] };
    }
    if (sql.startsWith("INSERT INTO artifacts")) {
      const row = { id: crypto.randomUUID(), task_id: params[0],
        source_conversation_id: params[1], title: params[2], type: "研究笔记",
        summary: params[3], content: params[4] };
      artifacts.push(row); return { rowCount: 1, rows: [row] };
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
  assert.equal(artifacts.length, 2);
  assert.equal(branches.length, 3);
  assert.ok(branches.every((branch) => JSON.parse(branch.snapshot).messages.length === 4));
  assert.deepEqual(refs.map((ref) => ref[1]), ["artifact", "task", "artifact"]);
  assert.deepEqual(refs.map((ref) => JSON.parse(ref[5])[0].id),
    [artifacts[0].id, artifacts[0].id, artifacts[1].id]);
  assert.deepEqual(refs.map((ref) => ref[2]), [artifacts[0].id, tasks[0].id, artifacts[1].id]);
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
  await seedGuestExamples(b);
  assert.equal(tasks.length, 6);
  assert.ok(tasks.slice(3).every((task) => task.guest_id === b));
  assert.ok(refs.slice(3).every((ref) => !refs.slice(0, 3).some((old) => old[2] === ref[2])));
  console.log("Guest examples PASS");
})().catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(() => { db.getPool = oldGetPool; });
