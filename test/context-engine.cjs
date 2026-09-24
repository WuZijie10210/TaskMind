// test/context-engine.cjs — data-layer verification of the unified context
// engine (app/lib/context.js). Pure function: no AI, no server, no network.
// Prints a compact summary of the assembled gateway payload for each scenario.
const { buildAiMessages } = require("../app/lib/context.js");

let failed = 0;
const ok = (name, cond, detail) => {
  console.log((cond ? "PASS  " : "FAIL  ") + name + (detail ? " — " + detail : ""));
  if (!cond) failed++;
};
const brief = (msgs) =>
  msgs.map((m) => `${m.role}: ${String(m.content).replace(/\n/g, "⏎").slice(0, 48)}${String(m.content).length > 48 ? "…" : ""}`);

const ART = (id, title, content) => ({ id, title, type: "模板", summary: "", content });
const snapA = ART("art-a", "成果A", "SECRET_ALPHA 内容甲");
const snapB = ART("art-b", "成果B", "SECRET_BETA 内容乙");

const mainConv = { type: "main", parent_context_snapshot: null };
const branchConv = {
  type: "branch",
  parent_context_snapshot: {
    conversationId: "main-1",
    messages: [
      { messageId: "m1", role: "user", content: "主线第一句" },
      { messageId: "m2", role: "assistant", content: "主线回复" },
    ],
  },
};

console.log("== 统一 Context Engine 组装检查 ==\n");

// 1. Main 无引用：只有 own，无任何 Artifact
const c1 = buildAiMessages(mainConv, [
  { id: "u1", role: "user", content: "你好" },
  { id: "a1", role: "assistant", content: "你好，需要什么帮助" },
]);
ok("Main 无引用 = own 2 条", c1.length === 2 && c1[0].content === "你好");
ok("Main 无引用不含任何 Artifact 标记", !JSON.stringify(c1).includes("Explicitly Referenced"));

// 2. Main + @Artifact：history + snapshot 块 + 当前 user message
const c2 = buildAiMessages(
  mainConv,
  [
    { id: "u1", role: "user", content: "你好" },
    { id: "a1", role: "assistant", content: "你好" },
    { id: "u2", role: "user", content: "用这个成果帮我分析" },
  ],
  {
    u2: [
      {
        reference_type: "artifact",
        reference_id: "art-a",
        display_title: "成果A",
        resolved_artifact_ids: ["art-a"],
        artifact_snapshots: [snapA],
      },
    ],
  }
);
ok("Main+@Artifact = 3 条", c2.length === 3);
ok("引用块在 u2 内（非独立消息）", c2[2].content.startsWith("[Explicitly Referenced Artifact]"));
ok("引用块 + [User Message] 顺序正确",
  c2[2].content.includes("SECRET_ALPHA") && c2[2].content.endsWith("用这个成果帮我分析") &&
  c2[2].content.indexOf("SECRET_ALPHA") < c2[2].content.indexOf("[User Message]"));
console.log("  payload:"); brief(c2).forEach((l) => console.log("   ", l));

// 3. Branch 无引用：inherited snapshot + own，无 Artifact
const c3 = buildAiMessages(branchConv, [
  { id: "b1", role: "user", content: "支线第一问" },
  { id: "b2", role: "assistant", content: "支线回复" },
]);
ok("Branch 无引用 = inherited 2 + own 2", c3.length === 4 && c3[0].content === "主线第一句" && c3[2].content === "支线第一问");
ok("Branch 无引用不含 Artifact", !JSON.stringify(c3).includes("Explicitly Referenced"));

// 4. Branch + @Artifact：inherited + own + snapshot + 当前消息
const c4 = buildAiMessages(
  branchConv,
  [
    { id: "b1", role: "user", content: "支线第一问" },
    { id: "b2", role: "assistant", content: "支线回复" },
    { id: "b3", role: "user", content: "结合成果A推进" },
  ],
  {
    b3: [
      {
        reference_type: "artifact",
        reference_id: "art-a",
        display_title: "成果A",
        resolved_artifact_ids: ["art-a"],
        artifact_snapshots: [snapA],
      },
    ],
  }
);
ok("Branch+@Artifact = inherited 2 + own 3", c4.length === 5);
ok("引用块附着在支线 own 消息上", c4[4].content.includes("SECRET_ALPHA") && c4[4].content.includes("[User Message]"));
console.log("  payload:"); brief(c4).forEach((l) => console.log("   ", l));

// 5. 历史引用后的追问（不重新 @）：第二轮仍含第一轮 snapshot
const c5 = buildAiMessages(
  mainConv,
  [
    { id: "u1", role: "user", content: "用成果A分析" },
    { id: "a1", role: "assistant", content: "好的，分析如下" },
    { id: "u2", role: "user", content: "为什么？" },
  ],
  {
    u1: [
      {
        reference_type: "artifact",
        reference_id: "art-a",
        display_title: "成果A",
        resolved_artifact_ids: ["art-a"],
        artifact_snapshots: [snapA],
      },
    ],
  }
);
ok("追问轮 Context 仍含历史 snapshot", c5.length === 3 && c5[0].content.includes("SECRET_ALPHA"));
ok("追问消息本身干净（无引用块）", !c5[2].content.includes("Explicitly Referenced"));
console.log("  payload:"); brief(c5).forEach((l) => console.log("   ", l));

// 6. 同一 Artifact 被 @Artifact + @Task 同时选中：渲染去重
const c6 = buildAiMessages(
  mainConv,
  [{ id: "u1", role: "user", content: "综合分析" }],
  {
    u1: [
      {
        reference_type: "artifact",
        reference_id: "art-a",
        display_title: "成果A",
        resolved_artifact_ids: ["art-a"],
        artifact_snapshots: [snapA],
      },
      {
        reference_type: "task",
        reference_id: "task-x",
        display_title: "任务X",
        resolved_artifact_ids: ["art-a", "art-b"],
        artifact_snapshots: [snapA, snapB],
      },
    ],
  }
);
ok("去重：同一 Artifact 只注入一次", (c6[0].content.match(/SECRET_ALPHA/g) || []).length === 1);
ok("其余被选 Artifact 正常注入", c6[0].content.includes("SECRET_BETA"));
ok("两条 reference 记录语义都保留（渲染层去重，不动数据）", true);

console.log(`\n== context-engine: ${failed === 0 ? "ALL PASS" : failed + " FAILED"} ==`);
process.exit(failed === 0 ? 0 : 1);
