// Create three clearly labeled, per-guest example tasks on first task-list read.
// These are illustrative conversations, not AI output or real user research.
const db = require("../services/db");
const { artifactToSnapshot } = require("./reference");
const SEED_VERSION = 2;
const timelines = new WeakMap();

function seededAt(client) {
  const timeline = timelines.get(client);
  return new Date(timeline.start + timeline.next++ * 1000).toISOString();
}

// Before this release, example tasks had no dedicated task marker. Only hide
// copies whose titles, message counts, branches, artifacts, references, and
// job counts match an untouched published script. User-edited tasks stay put.
const previousCopies = [
  [
    ["示例｜大学学习方式研究", 4, "支线｜资料核查方法", 2, "研究问题与证据清单", 0],
    ["示例｜学习工具产品方案", 4, "", 0, "资料核查功能假设", 1],
    ["示例｜学习工具课程汇报", 4, "", 0, "八分钟汇报提纲", 1],
  ],
  [
    ["示例｜大学学习方式研究", 6, "支线｜资料核查方法", 2, "研究问题与证据清单", 1],
    ["示例｜学习工具课程汇报", 6, "支线｜证据与表述边界", 2, "八分钟汇报提纲", 1],
    ["示例｜新行业分析选题", 6, "支线｜信息来源筛选", 2, "", 1],
  ],
];

async function archivePristineLegacy(client, guestId) {
  const { rows } = await client.query(
    "SELECT t.id,t.title," +
      "(SELECT count(*)::int FROM messages m JOIN conversations c ON c.id=m.conversation_id " +
        "WHERE c.task_id=t.id AND c.type='main') AS main_count," +
      "(SELECT coalesce(string_agg(c.title,'|' ORDER BY c.title),'') FROM conversations c " +
        "WHERE c.task_id=t.id AND c.type='branch') AS branch_titles," +
      "(SELECT count(*)::int FROM messages m JOIN conversations c ON c.id=m.conversation_id " +
        "WHERE c.task_id=t.id AND c.type='branch') AS branch_count," +
      "(SELECT coalesce(string_agg(a.title,'|' ORDER BY a.title),'') FROM artifacts a " +
        "WHERE a.task_id=t.id) AS artifact_titles," +
      "(SELECT count(*)::int FROM message_references r JOIN messages m ON m.id=r.message_id " +
        "JOIN conversations c ON c.id=m.conversation_id WHERE c.task_id=t.id) AS ref_count," +
      "(SELECT count(*)::int FROM deposition_jobs j WHERE j.task_id=t.id) AS job_count " +
    "FROM tasks t WHERE t.guest_id=$1 AND t.title LIKE '示例｜%' AND NOT t.is_archived_example",
    [guestId]
  );
  const fingerprint = (row) => [row.title, Number(row.main_count), row.branch_titles,
    Number(row.branch_count), row.artifact_titles, Number(row.ref_count)];
  const actual = rows.map(fingerprint).sort((a, b) => a[0].localeCompare(b[0]));
  const matches = previousCopies.some((copy) =>
    JSON.stringify(actual) === JSON.stringify([...copy].sort((a, b) => a[0].localeCompare(b[0])))
  );
  if (matches && rows.every((row) => Number(row.job_count) === 0)) {
    await client.query("UPDATE tasks SET is_archived_example=true WHERE guest_id=$1 AND id=ANY($2::uuid[])",
      [guestId, rows.map((row) => row.id)]);
  }
}

async function addTask(client, guestId, title, turns) {
  const task = (await client.query(
    "INSERT INTO tasks(title,guest_id,created_at,updated_at) VALUES ($1,$2,$3,$3) RETURNING id",
    [title, guestId, seededAt(client)]
  )).rows[0];
  const main = (await client.query(
    "INSERT INTO conversations(task_id,type,title,created_at) " +
      "VALUES ($1,'main','主线对话',$2) RETURNING id", [task.id, seededAt(client)]
  )).rows[0];
  const messages = [];
  for (const [role, content] of turns) {
    messages.push((await client.query(
      "INSERT INTO messages(conversation_id,role,content,created_at) VALUES ($1,$2,$3,$4) " +
        "RETURNING id,role,content,created_at", [main.id, role, content, seededAt(client)]
    )).rows[0]);
  }
  return { task, main, messages, title };
}

async function addTurn(client, source, role, content) {
  const message = (await client.query(
    "INSERT INTO messages(conversation_id,role,content,created_at) VALUES ($1,$2,$3,$4) " +
      "RETURNING id,role,content,created_at", [source.main.id, role, content, seededAt(client)]
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
    "INSERT INTO conversations(task_id,type,title,parent_context_snapshot,origin_main_message_id,created_at) " +
      "VALUES ($1,'branch',$2,$3,$4,$5) RETURNING id",
    [source.task.id, title, JSON.stringify(snapshot), source.messages.at(-1)?.id || null, seededAt(client)]
  )).rows[0];
  const messages = [];
  for (const [role, content] of turns) {
    messages.push((await client.query(
      "INSERT INTO messages(conversation_id,role,content,created_at) VALUES ($1,$2,$3,$4) " +
        "RETURNING id,role,content,created_at", [branch.id, role, content, seededAt(client)]
    )).rows[0]);
  }
  return { task: source.task, main: branch, messages, title };
}

async function addArtifact(client, source, title, type, summary, content) {
  return (await client.query(
    "INSERT INTO artifacts(task_id,source_conversation_id,title,type,summary,content,source_message_ids,created_at,updated_at) " +
      "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING *",
    [source.task.id, source.main.id, title, type, summary, content,
      source.messages.map((m) => m.id), seededAt(client)]
  )).rows[0];
}

async function addConfirmedStage(client, source, artifact) {
  // A seeded result has the same source/cursor contract as an approved
  // deposition. Later turns remain available for a new deposition.
  const ids = source.messages.map((m) => m.id);
  const snapshot = {
    conversationId: source.main.id, taskId: source.task.id,
    capturedAt: new Date().toISOString(), cursorMessageId: ids.at(-1),
    messageCount: ids.length,
    messages: source.messages.map((m) => ({
      messageId: m.id, role: m.role, content: m.content, createdAt: m.created_at,
    })),
  };
  await client.query(
    "INSERT INTO deposition_jobs(task_id,conversation_id,status,source_message_ids," +
      "source_snapshot,candidate_artifacts,cursor_message_id,outcome,created_at,updated_at,completed_at) " +
      "VALUES ($1,$2,'confirmed',$3,$4,$5,$6,'saved',$7,$7,$7)",
    [source.task.id, source.main.id, ids, JSON.stringify(snapshot),
      JSON.stringify([{ title: artifact.title, type: artifact.type, summary: artifact.summary,
        content: artifact.content, sourceMessageIds: ids }]), ids.at(-1), seededAt(client)]
  );
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
    timelines.set(client, { start: Date.now() - 120_000, next: 0 });
    const inserted = await client.query(
      "INSERT INTO guest_example_seeds(guest_id,seed_version) VALUES ($1,$2) " +
        "ON CONFLICT DO NOTHING RETURNING guest_id",
      [guestId, SEED_VERSION]
    );
    if (!inserted.rowCount) {
      const existing = (await client.query(
        "SELECT seed_version FROM guest_example_seeds WHERE guest_id=$1 FOR UPDATE", [guestId]
      )).rows[0];
      if (!existing || existing.seed_version >= SEED_VERSION) {
        await client.query("COMMIT");
        return;
      }
      await archivePristineLegacy(client, guestId);
      await client.query("UPDATE guest_example_seeds SET seed_version=$2 WHERE guest_id=$1",
        [guestId, SEED_VERSION]);
    }

    const first = await addTask(client, guestId, "示例｜从宽泛选题到研究计划", [
      ["user", "三天后要做一场 8 分钟课堂分享，题目暂定「生成式 AI 改变大学生学习」。老师要求引用能查到原文，我也来不及做问卷。这个题目太大了，怎么收窄？"],
      ["assistant", "先把目标从「证明 AI 改变了学习」改为「展示核查 AI 提供的文献线索的方法」。\n\n**可完成的研究问题**：面对 AI 推荐的文献，怎样判断它能不能进入课堂分享的证据清单？\n\n三天内的交付物可以是：一张线索记录表、一条核查流程，以及一页说明哪些结论目前不能下。没有问卷，就不推断大学生群体的行为变化。"],
      ["user", "我手头有 AI 给的三条论文线索，其中一条找不到原文。核查表应该怎么填？"],
      ["assistant", "先为**每条线索**记录：标题、作者、年份、原始发表页或 DOI、要支持的观点、核查状态。\n\n| 状态 | 判断标准 | 分享时如何用 |\n|---|---|---|\n| 可引用 | 找到原文，且观点能在原文定位 | 标明出处后使用 |\n| 待核 | 只有转载或检索摘要 | 暂不当作证据 |\n| 排除 | 找不到原文，或信息对不上 | 不引用，可说明排除原因 |\n\n那条找不到原文的线索先记为「待核」；不要补写猜测的作者、DOI 或论文内容。"],
    ]);
    const firstBranch = await addBranch(client, first, "支线｜找不到原文怎么办", [
      ["user", "主线先不改。我想单独想清楚：那条找不到原文的线索，能不能作为分享里的一个案例？"],
      ["assistant", "可以把它作为**核查过程中的反例**，但不能拿它证明课程观点。展示时只写「AI 提供的线索 → 未找到可核验原文 → 未纳入证据」，不要虚构标题或作者。回到主线后，仍按记录表继续处理另外两条。"],
    ]);
    const firstArtifact = await addArtifact(client, first, "文献线索核查卡", "方法",
      "把宽泛选题收窄为可执行的核查任务；记录每条线索的来源和状态。",
      "研究问题：AI 给出的文献线索，如何判断能否用于课堂分享？\n\n每条记录填写：标题｜作者与年份｜原始发表页或 DOI｜拟支持的观点｜原文定位｜状态。\n\n状态规则：找到原文且观点吻合 → 可引用；只有摘要或转载 → 待核；找不到原文或信息矛盾 → 排除。待核与排除项都不能作为论据。\n\n展示边界：这是资料核查方法，不是「AI 已改变大学生学习」的实证结论。");
    await addConfirmedStage(client, first, firstArtifact);
    const branchArtifact = await addArtifact(client, firstBranch, "无法核实资料的展示边界", "判断",
      "未找到原文的线索可用于说明核查过程，不能作为观点证据。",
      "分享时可以使用去标识的流程示意：AI 提供线索 → 查不到可核验原文 → 标为待核或排除 → 不纳入论证。不要补写不存在的作者、标题、DOI 或论文结论。这个反例说明的是核查决策，不说明 AI 生成内容的总体错误率。");
    await addConfirmedStage(client, firstBranch, branchArtifact);
    const firstRefMessage = await addTurn(client, first, "user",
      `请用【@${firstArtifact.title}】给我排接下来两天的工作，具体到每天要完成什么；三条线索还没核实完。`);
    await addReference(client, firstRefMessage.id, "artifact", first, firstArtifact);
    await addTurn(client, first, "assistant",
      "按照核查卡的字段推进：\n\n**第 1 天｜填表与核验**：逐条补齐标题、作者、年份和原始发表页；打开原文定位要引用的段落。找不到原文的那条保持「待核」，不要为了凑数补一个来源。完成时交付一张三行的记录表，每行都有核查状态。\n\n**第 2 天｜筛选与成稿**：仅用「可引用」的条目写分享中的论据；待核条目继续查证或换来源，排除条目只用于说明核查流程。最后做一页「我们展示了方法，尚未测量学生行为变化」的局限说明。\n\n如果到期仍没有可引用的原文，就把分享定位为核查方法演示，不写研究发现。",
    );

    const second = await addTask(client, guestId, "示例｜把研究计划做成课堂分享", [
      ["user", "我要把「核查 AI 给出的文献线索」讲成 8 分钟课堂分享。现在没有调查数据，先帮我安排页面和时间。"],
      ["assistant", "先排六页：问题与边界（45 秒）、研究问题（75 秒）、核查规则（90 秒）、操作演示（105 秒）、资料取舍（90 秒）、局限与下一步（75 秒），合计 8 分钟。当前只是讲述框架；每一页的证据还需要后续填入。"],
      ["user", "老师可能追问「凭什么能引用这篇论文」。每页应该留什么证据位置？"],
      ["assistant", "第 2 页写明确的研究问题；第 3 页预留原始发表页或 DOI 与核查状态；第 4 页预留一条**实际核验后**才可展示的记录；第 5 页说明待核和排除的依据；第 6 页写未做问卷、不能推断总体变化。没有核验完成的材料，就保留空位，不编造例子。"],
    ]);
    await addBranch(client, second, "支线｜没有数据怎么开场", [
      ["user", "有人建议我用「大部分同学依赖 AI」开场，但我没有调查数字。这句怎么办？"],
      ["assistant", "删掉「大部分」。可以这样开场：「AI 能迅速给出文献线索；这次分享讨论的是，我们怎样判断线索能否用于课堂论证。」这句话交代了问题和分享范围，没有冒充调查结论。"],
    ]);
    const secondRefMessage = await addTurn(client, second, "user",
      `请参考【@${first.title}】里已保存且相关的成果，把刚才的证据空位变成六页 8 分钟讲述稿。每页写标题、时间、要展示的材料和一句讲述词。`);
    await addReference(client, secondRefMessage.id, "task", first, firstArtifact);
    const secondAnswer = "按引用任务中实际调用的「文献线索核查卡」，把空白框架改成可排练的讲述稿：\n\n| 页 | 时间 | 标题与展示材料 | 讲述词示例 |\n|---|---|---|---|\n| 1 | 0:45 | 问题：AI 给出文献线索；展示待核查的记录表字段 |「今天展示核查办法，不报告学生行为变化。」|\n| 2 | 1:15 | 研究问题：什么线索可以引用；展示核查卡中的问题句 |「能否引用，取决于能否找到原文并定位观点。」|\n| 3 | 1:30 | 判断规则；展示「可引用／待核／排除」三栏 |「只有核对过原文与观点的条目才进入证据清单。」|\n| 4 | 1:45 | 操作演示；展示一条**核实后**的记录，未完成时标「待填」 |「按标题、作者、发表页、观点位置逐项核对。」|\n| 5 | 1:30 | 资料取舍；展示待核条目的处理流程 |「查不到原文的线索暂不引用，也不补写 DOI。」|\n| 6 | 1:15 | 局限与下一步；展示缺失的数据和后续核查计划 |「这是一套核查流程，还不是对学生群体的调查结论。」|\n\n第 4 页的示例记录必须在实际核验后填写；目前不能把占位文字当成真实文献。";
    await addTurn(client, second, "assistant", secondAnswer);
    const secondArtifact = await addArtifact(client, second, "六页八分钟课堂分享稿", "模板",
      "从引用的核查卡生成六页讲述结构，保留尚未核实材料的证据空位。",
      "【预置演示稿；证据空位须由真实材料填写】\n\n" + secondAnswer);
    await addConfirmedStage(client, second, secondArtifact);

    const third = await addTask(client, guestId, "示例｜教育科技行业分析立项", [
      ["user", "社团让我做一份教育科技行业分析。我只剩两个晚上，也没做访谈；现在应该先定什么范围？"],
      ["assistant", "先把范围限定为「大学生使用的学习辅助工具」，不要试图覆盖整个教育科技行业。暂时只回答三个问题：这类产品宣称解决什么问题？有哪些可核实的产品功能？哪些市场和用户判断还缺证据？交付物先定为带证据空位的简报草稿，不写市场规模结论。"],
      ["user", "公开资料很多。只有两个晚上，应该先找哪几类，怎么记录？"],
      ["assistant", "**今晚**：找 2～3 个产品的官网或更新日志，只记录可核对的功能与发布日期。**明晚**：找有出处的行业资料，追到原始统计口径；无法确认的数字先不用。\n\n每条材料记录「来源链接｜发布日期｜原文说了什么｜可支持的问题｜不能证明什么｜核查状态」。这张表目前是工作计划，还不是已确认的行业结论。"],
    ]);
    await addBranch(client, third, "支线｜官网说法能当证据吗", [
      ["user", "一个产品官网写「AI 显著提升学习效果」，这句话能直接放进行业分析吗？"],
      ["assistant", "官网能证明它**这样宣传**，不能证明效果确实存在。若要讨论实际效果，需要找到方法、样本和原始研究；找不到时只写「官网声称」，并在证据表标为待核，不推导成行业普遍结论。"],
    ]);
    const thirdRefMessage = await addTurn(client, third, "user",
      `请借用【@${secondArtifact.title}】的结构，把我的行业分析改成五页简报草稿。只复用组织方法，不能把那份课堂分享里的内容当作行业事实；这个任务先不保存成果。`);
    await addReference(client, thirdRefMessage.id, "artifact", second, secondArtifact);
    await addTurn(client, third, "assistant",
      "借用那份分享稿的「提出问题 → 交代方法 → 展示材料 → 说明取舍 → 承认局限」，转换成行业分析的**五页待填草稿**：\n\n1. **范围与问题**：大学生学习辅助工具；写清楚研究范围，不填行业规模。\n2. **资料方法**：列出官网、更新日志和原始行业资料；注明各自能证明什么。\n3. **产品对照**：做「产品｜可核验功能｜发布日期｜来源」表；【待填：实际核过的条目】。\n4. **证据取舍**：区分官网宣传与第三方证据；【待填：原始研究或统计口径】。\n5. **局限与下一步**：没有访谈就不声称用户需求已被证实；下一步核对数据并决定是否形成结论。\n\n复用的是汇报结构，不是它关于文献核查的事实。这个任务仍在探索阶段，本轮不保存成果。",
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    timelines.delete(client);
    client.release();
  }
}

module.exports = { seedGuestExamples };
