// Create three clearly labeled, per-guest example tasks on first task-list read.
// These are illustrative conversations, not AI output or real user research.
const db = require("../services/db");
const { artifactToSnapshot } = require("./reference");

async function addTask(client, guestId, title, turns) {
  const task = (await client.query(
    "INSERT INTO tasks(title,guest_id) VALUES ($1,$2) RETURNING id", [title, guestId]
  )).rows[0];
  const main = (await client.query(
    "INSERT INTO conversations(task_id,type,title) VALUES ($1,'main','主线对话') RETURNING id",
    [task.id]
  )).rows[0];
  const messages = [];
  for (const [role, content] of turns) {
    messages.push((await client.query(
      "INSERT INTO messages(conversation_id,role,content) VALUES ($1,$2,$3) " +
        "RETURNING id,role,content,created_at", [main.id, role, content]
    )).rows[0]);
  }
  return { task, main, messages, title };
}

async function addTurn(client, source, role, content) {
  const message = (await client.query(
    "INSERT INTO messages(conversation_id,role,content) VALUES ($1,$2,$3) " +
      "RETURNING id,role,content,created_at", [source.main.id, role, content]
  )).rows[0];
  source.messages.push(message);
  return message;
}

async function addBranch(client, source, title, turns) {
  // Freeze the main line as it stood when this branch was created. Later main
  // messages (including its final reference exchange) are deliberately absent.
  const snapshot = {
    conversationId: source.main.id, taskId: source.task.id,
    capturedAt: new Date().toISOString(), messageCount: source.messages.length,
    messages: source.messages.map((m) => ({
      messageId: m.id, role: m.role, content: m.content, createdAt: m.created_at,
    })),
  };
  const branch = (await client.query(
    "INSERT INTO conversations(task_id,type,title,parent_context_snapshot,origin_main_message_id) " +
      "VALUES ($1,'branch',$2,$3,$4) RETURNING id",
    [source.task.id, title, JSON.stringify(snapshot), source.messages.at(-1)?.id || null]
  )).rows[0];
  for (const [role, content] of turns) {
    await client.query("INSERT INTO messages(conversation_id,role,content) VALUES ($1,$2,$3)",
      [branch.id, role, content]);
  }
}

async function addArtifact(client, source, title, summary, content) {
  return (await client.query(
    "INSERT INTO artifacts(task_id,source_conversation_id,title,type,summary,content,source_message_ids) " +
      "VALUES ($1,$2,$3,'研究笔记',$4,$5,$6) RETURNING *",
    [source.task.id, source.main.id, title, summary, content, source.messages.map((m) => m.id)]
  )).rows[0];
}

async function addReference(client, messageId, type, source, artifact) {
  await client.query(
    "INSERT INTO message_references(message_id,reference_type,reference_id,display_title," +
      "resolved_artifact_ids,artifact_snapshots) VALUES ($1,$2,$3,$4,$5,$6)",
    [messageId, type, type === "task" ? source.task.id : artifact.id,
      type === "task" ? source.title : artifact.title,
      [artifact.id], JSON.stringify([artifactToSnapshot(artifact)])]
  );
}

async function seedGuestExamples(guestId) {
  const client = await db.getPool().connect();
  try {
    await client.query("BEGIN");
    const inserted = await client.query(
      "INSERT INTO guest_example_seeds(guest_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING guest_id",
      [guestId]
    );
    if (!inserted.rowCount) {
      await client.query("COMMIT");
      return;
    }

    const first = await addTask(client, guestId, "示例｜大学学习方式研究", [
      ["user", "我想研究生成式 AI 如何影响大学生学习方式，先帮我把问题收窄。"],
      ["assistant", "这是演示对话，并非真实调研结果。可以先聚焦：学生使用 AI 辅助查资料时，如何核查信息可信度？接下来列出需要观察的行为和资料来源。"],
      ["user", "请整理一份可执行的研究路径，别编造调查结论。"],
      ["assistant", "## 研究路径\n1. 界定对象：正在做课程作业的大学生。\n2. 收集资料：课程要求、公开研究和自愿参与的使用记录。\n3. 观察环节：检索、核查、引用与修改。\n4. 标明限制：尚未收集数据，下面只是待验证的问题。"],
    ]);
    const firstArtifact = await addArtifact(client, first, "研究问题与证据清单",
      "围绕资料检索、核查与引用的待验证问题。",
      "【演示资料，非真实研究结论】\n研究问题：AI 辅助查资料后，学生如何核查来源？\n待收集证据：课程要求、公开研究、学生自愿提供的匿名使用记录。\n注意：没有调研数据时不推断比例或效果。");

    await addBranch(client, first, "支线｜资料核查方法", [
      ["user", "先从主线单独展开：应该怎样核查 AI 推荐的文献？"],
      ["assistant", "逐条核对作者、标题、发表年份和原始链接；找不到原文就不要引用。记录核查状态，再回到主线决定是否纳入报告。"],
    ]);
    const firstRefMessage = await addTurn(client, first, "user",
      `请引用【@${firstArtifact.title}】，帮我排出下一步资料核查的优先顺序。`);
    await addReference(client, firstRefMessage.id, "artifact", first, firstArtifact);
    await addTurn(client, first, "assistant",
      "依据「研究问题与证据清单」，先确认课程任务要求，再逐条找公开研究的原文并记录出处，最后设计自愿参与的匿名观察。找不到原文的资料暂不引用；目前没有任何调查数据或效果结论。");

    const second = await addTask(client, guestId, "示例｜学习工具课程汇报", [
      ["user", "我要做一场 8 分钟的课程汇报，介绍帮助学生核查资料的学习工具设想。"],
      ["assistant", "这是演示对话。可按问题场景、产品设想、演示流程和验证计划组织；尚无真实用户测试结果，需要如实说明。"],
      ["user", "请列一个汇报提纲，把产品假设和已经验证的事实分开。"],
      ["assistant", "## 初版提纲\n- 问题场景：课程作业里的资料核查。\n- 产品设想：来源入口、核查记录、引用前提醒。\n- 演示流程：用一条虚构资料展示操作。\n- 验证计划：未来做任务观察。\n以上均为演示和待验证设计，不包含已证实的效果。"],
    ]);
    const secondArtifact = await addArtifact(client, second, "八分钟汇报提纲",
      "问题场景、产品设想、演示流程和验证计划；尚待真实验证。",
      "【演示资料，非实际汇报效果】\n背景（1 分钟）→ 产品设想（2 分钟）→ 虚构流程演示（3 分钟）→ 验证计划与局限（2 分钟）。尚无真实用户测试结果。");
    await addBranch(client, second, "支线｜证据与表述边界", [
      ["user", "我该怎么讲产品的价值，才能避免把假设说成已验证的事实？"],
      ["assistant", "把「我们希望解决」和「我们已观察到」分开表述。当前只有设计假设；在验证计划页列出要观察的行为，不给出未经测量的效果数字。"],
    ]);
    const secondRefMessage = await addTurn(client, second, "user",
      `请参考【@${first.title}】，从其中的研究成果提取可复用的问题，完善我的课程汇报结构。`);
    await addReference(client, secondRefMessage.id, "task", first, firstArtifact);
    await addTurn(client, second, "assistant",
      "已从「大学学习方式研究」调用「研究问题与证据清单」。汇报开头可用其中的核心问题：学生使用 AI 查资料后如何核查来源？随后演示资料核查流程，结尾明确哪些证据尚待收集。保留原有八分钟结构，但不要宣称工具已经改善学习效果。");

    const third = await addTask(client, guestId, "示例｜新行业分析选题", [
      ["user", "我想做一个教育科技行业分析，但现在还没确定具体问题。"],
      ["assistant", "先缩小范围：选择一个产品类别，例如学习辅助工具；再列出要研究的用户场景、替代方案与资料来源。此时还不能写行业规模结论。"],
      ["user", "先帮我规划要找哪些资料，暂时不整理成果。"],
      ["assistant", "可以先收集公开产品资料、行业报告的原始出处、可核实的公开数据和使用者描述。把每条信息标成「已核实」或「待核实」；现在仍是探索阶段，本任务没有已确认的成果。"],
    ]);
    await addBranch(client, third, "支线｜信息来源筛选", [
      ["user", "行业报告和产品官网各适合回答什么问题？"],
      ["assistant", "行业报告可以提供带出处的背景数据，官网适合核对产品当前功能。两者都不能直接证明用户需求或产品实际效果；关键数据仍须回到原始来源核查。"],
    ]);
    const thirdRefMessage = await addTurn(client, third, "user",
      `请借用【@${secondArtifact.title}】的表达结构，规划这个行业分析怎么汇报；先不要把本任务整理成成果。`);
    await addReference(client, thirdRefMessage.id, "artifact", second, secondArtifact);
    await addTurn(client, third, "assistant",
      "可以借用「背景→分析过程→待验证问题→局限」的汇报顺序，但课程汇报提纲里的产品设想不能直接当作行业事实。先收集该领域的公开资料和原始出处，再决定是否形成行业判断。这个任务目前只有探索对话，尚无已保存成果。");

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { seedGuestExamples };
