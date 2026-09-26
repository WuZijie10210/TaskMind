// Create a two-task, per-guest example of confirmed-result reuse.
// These are illustrative conversations, not AI output or real user research.
const db = require("../services/db");
const { artifactToSnapshot } = require("./reference");
const SEED_VERSION = 4;
const timelines = new WeakMap();

function seededAt(client) {
  const timeline = timelines.get(client);
  return new Date(timeline.start + timeline.next++ * 1000).toISOString();
}

// Earlier releases had no reliable seed marker on individual tasks. Archive
// each matching published copy independently; preserve changed tasks and all
// their messages/references, even if another copy from the same release changed.
const previousCopies = [
  [
    ["示例｜大学学习方式研究", 4, "支线｜资料核查方法", 2, "研究问题与证据清单", 0, 0],
    ["示例｜学习工具产品方案", 4, "", 0, "资料核查功能假设", 1, 0],
    ["示例｜学习工具课程汇报", 4, "", 0, "八分钟汇报提纲", 1, 0],
  ],
  [
    ["示例｜大学学习方式研究", 6, "支线｜资料核查方法", 2, "研究问题与证据清单", 1, 0],
    ["示例｜学习工具课程汇报", 6, "支线｜证据与表述边界", 2, "八分钟汇报提纲", 1, 0],
    ["示例｜新行业分析选题", 6, "支线｜信息来源筛选", 2, "", 1, 0],
  ],
  [
    ["示例｜从宽泛选题到研究计划", 6, "支线｜找不到原文怎么办", 2, "文献线索核查卡|无法核实资料的展示边界", 1, 2],
    ["示例｜把研究计划做成课堂分享", 6, "支线｜没有数据怎么开场", 2, "六页八分钟课堂分享稿", 1, 1],
    ["示例｜教育科技行业分析立项", 6, "支线｜官网说法能当证据吗", 2, "", 1, 0],
  ],
  [
    ["示例｜从宽泛选题到研究计划", 6, "支线｜找不到原文怎么办", 6, "文献线索核查卡|无法核实资料的展示边界", 1, 2],
    ["示例｜把研究计划做成课堂分享", 6, "支线｜没有数据怎么开场", 6, "六页八分钟课堂分享稿", 1, 1],
    ["示例｜教育科技行业分析立项", 6, "支线｜官网说法能当证据吗", 6, "", 1, 0],
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
  const normalizeTitles = (titles) => titles.split("|").sort((a, b) => a.localeCompare(b)).join("|");
  const fingerprint = (row) => [row.title, Number(row.main_count), row.branch_titles,
    Number(row.branch_count), normalizeTitles(row.artifact_titles), Number(row.ref_count), Number(row.job_count)];
  const published = new Set(previousCopies.flat().map((item) => JSON.stringify(
    [...item.slice(0, 4), normalizeTitles(item[4]), ...item.slice(5)]
  )));
  const pristineIds = rows.filter((row) => published.has(JSON.stringify(fingerprint(row))))
    .map((row) => row.id);
  if (pristineIds.length) {
    await client.query("UPDATE tasks SET is_archived_example=true WHERE guest_id=$1 AND id=ANY($2::uuid[])",
      [guestId, pristineIds]);
  }
}

async function addTask(client, guestId, title, rank, turns) {
  const task = (await client.query(
    "INSERT INTO tasks(title,guest_id,demo_rank,created_at,updated_at) VALUES ($1,$2,$3,$4,$4) RETURNING id",
    [title, guestId, rank, seededAt(client)]
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

async function addReference(client, messageId, type, source, artifacts) {
  const selected = Array.isArray(artifacts) ? artifacts : [artifacts];
  await client.query(
    "INSERT INTO message_references(message_id,reference_type,reference_id,display_title," +
      "resolved_artifact_ids,artifact_snapshots) VALUES ($1,$2,$3,$4,$5,$6)",
    [messageId, type, type === "task" ? source.task.id : selected[0].id,
      type === "task" ? source.title : selected[0].title,
      selected.map((a) => a.id), JSON.stringify(selected.map(artifactToSnapshot))]
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

    const report = await addTask(client, guestId, "示例｜生成式 AI 与大学教育汇报", 1, [
      ["user", "下周要做一场 8 分钟的课程汇报，题目是「生成式 AI 与大学教育」。我不想只讲它会不会替代教师，能不能帮我找到一个更具体的角度？"],
      ["assistant", "可以从学生的学习过程切入：AI 很快就能给答案或反馈，但学生在哪一步形成自己的判断？你可以把汇报问题定为「AI 参与学习时，怎样保留学生提出判断、检验判断的机会」。先讲两个具体场景，再讨论教学设计；暂时不把「学习效果变好或变差」当成已有结论。"],
      ["user", "我自己写一段分析时要先想怎么论证；如果让 AI 先写，我经常只是在它的草稿上改字。这两种情况能放到汇报里对比吗？"],
      ["assistant", "可以把它们作为**需要观察的两种任务方式**：从零构建时，学生要先选问题、列理由、决定证据；对 AI 草稿作反应时，学生更多在筛选、质疑和修改现成内容。两者都需要判断，但判断发生的位置不同。建议拿同一个小题做演示，对照学生先写提纲和先看 AI 提纲时分别要回答什么问题；这是分析框架，还不能据此宣称哪种方式效果更好。"],
    ]);
    const contrast = await addArtifact(client, report, "从零构建与对 AI 草稿反应的判断力差异", "判断",
      "两种学习任务都需要判断，但判断发生在提出问题与检验现成草稿的不同环节。",
      "从零构建：学生先界定问题、组织理由、选择证据。对 AI 草稿反应：学生先检查既有结构和断言，再决定保留、质疑或修改。区别是判断发生的位置，不是对谁学得更好作效果判断。课堂可让两组面对同一题目分别从零列提纲、审查 AI 提纲，并比较各自做过哪些判断。");
    await addConfirmedStage(client, report, contrast);

    const feedback = await addBranch(client, report, "支线｜即时反馈会削弱学生判断吗", [
      ["user", "我想单独想想：如果 AI 每一步都马上告诉学生哪里错了，学生会不会渐渐不愿意自己判断？"],
      ["assistant", "风险可能出在反馈的**时机**，而不只是反馈的速度。如果学生还没提出自己的理由就先看到纠正，就少了一次形成判断的机会；但在学生先写下判断后，反馈也可能帮助他发现漏洞。可以把这两种顺序做成一个可比较的课堂活动，不先下「一定削弱」的结论。"],
      ["user", "如果让学生先写一句自己的判断，再问 AI，然后怎么避免直接照抄 AI 的回复？"],
      ["assistant", "可以要求学生保留第一版判断，并在收到 AI 反馈后写两栏：「我同意或不同意什么」「依据是什么」。最后让学生回到教材或原始材料核对一处关键事实。这样能看见学生有没有改变想法，也能看见改变的理由，而不是只交一段润色后的答案。"],
      ["user", "我想给这套做法起个简单名字，汇报时也能让同学现场试。你帮我整理成三个步骤和每步的产出。"],
      ["assistant", "叫「先判断—再反馈—后验证」：\n\n1. **先判断**：学生独立写一句观点和一条理由，留下初稿。\n2. **再反馈**：请 AI 指出反例或薄弱处，学生标出同意与质疑的地方。\n3. **后验证**：用课程材料核对关键事实，写清最终保留或修改了什么，以及原因。\n\n现场可用一个不要求专业背景的小题演示。重点展示判断怎样变化，不把这套流程说成已经证实能提升成绩的方法。"],
    ]);
    const method = await addArtifact(client, feedback, "学生使用 AI 时的「先判断—再反馈—后验证」三步框架", "方法",
      "把 AI 反馈放在学生独立判断之后，并要求核验与修正理由。",
      "适用场景：课堂讨论、短文写作或观点练习。\n1. 先判断：学生先写观点与理由，保留原稿。\n2. 再反馈：请 AI 提供反例或指出漏洞，学生标出同意和质疑之处。\n3. 后验证：回到课程材料核对关键事实，记录保留或修改了什么及原因。\n可观察的产出：初稿、反馈标记、修订理由；不能据此推断学习效果已被证实。");
    await addConfirmedStage(client, feedback, method);

    await addBranch(client, report, "支线｜AI 会替代大学教师吗", [
      ["user", "还有个方向：AI 会不会替代大学教师？大家可能更想听这个。"],
      ["assistant", "它容易吸引注意，但「替代或不替代」太宽，也不容易在 8 分钟内讲清条件。你可以问得具体些：哪些环节适合 AI 给反馈，哪些环节仍需要教师设计任务、判断学生是否真正理解？"],
      ["user", "这样讲又像是另起一个汇报。我现在更想讲学生怎样保持判断力。"],
      ["assistant", "那就把教师角色留作结尾的一句延伸：教师可以设计先独立判断、再借助反馈、最后核验的任务。主体仍围绕学生在不同环节做了什么判断。这个方向可以先放下，之后有时间再单独讨论。"],
      ["user", "对，先不把「替代教师」放到标题里。我要把时间留给那个具体的课堂练习。"],
      ["assistant", "可以。标题可以暂定为「AI 参与学习后，学生的判断发生在哪里？」结尾再用教师如何设计练习收住，不需要先回答一个很大的替代问题。"],
    ]);

    const reportRef = await addTurn(client, report, "user",
      "我决定不以「AI 是否替代教师」作主线。请用【@" + method.title + "】重新排 8 分钟的汇报，重点放在学生判断发生在哪些环节，最后给一个同学能现场尝试的小练习。");
    await addReference(client, reportRef.id, "artifact", report, method);
    await addTurn(client, report, "assistant",
      "可以按「判断发生在哪里」来安排：\n\n- **0—1 分钟｜提出问题**：同一道题，学生先列提纲与先看 AI 提纲时，分别要做哪些判断？不要预设谁学得更好。\n- **1—3 分钟｜对比两种过程**：前者重在界定问题、选理由，后者重在筛选和质疑现成草稿。用一张对照表说明判断位置的变化。\n- **3—6 分钟｜现场练习**：请同学先独立写一条观点和理由，再看 AI 的一个反例，最后用课程材料核验并写出是否修改。把「先判断—再反馈—后验证」作为练习流程。\n- **6—8 分钟｜收束与边界**：讨论教师如何设计任务以保留判断机会；说明这只是可尝试的课堂方法，尚不能证明它能提升学习成效。\n\n练习产出是初稿、反馈标记和修订理由，能让讨论落在可观察的学习过程上。");

    const workshop = await addTask(client, guestId, "示例｜AI 素养工作坊", 2, [
      ["user", "我要给大一学生设计一场 40 分钟的 AI 素养工作坊。不想做一套工具使用教程，而是让他们练习判断 AI 给的内容。先帮我定一个活动目标。"],
      ["assistant", "可以把目标写成：学生能先提出自己的观点，再识别 AI 回复中值得追问的一处断言，并说明自己如何核验和修正。活动结束时收集过程记录，而不是只收一份被 AI 润色过的答案。"],
      ["user", "我担心大家一拿到 AI 的完整答案就跟着走。小组活动要怎么安排，才能看见他们自己的判断？"],
      ["assistant", "先给每个人 3 分钟独立写观点和理由，再让小组交换、指出一处依据不足的地方。之后才给出 AI 的反馈，让每人记录一条接受或拒绝它的建议以及理由。最后回到指定材料核对。这样你能看到改动前后的依据，而不只看到最后答案。"],
    ]);
    await addBranch(client, workshop, "支线｜小组互评怎么提问", [
      ["user", "如果同伴只是说「我觉得挺好」，小组互评就没用了。给他们一个具体问题吧。"],
      ["assistant", "让每个人只追问一件事：「你这条理由依赖的事实或前提是什么？我们能在哪里核对？」这比评价写得好不好更容易推动下一步。"],
      ["user", "有的人可能还没写完初稿，怎么避免互评变成互相给答案？"],
      ["assistant", "把互评限制在指出一个需要核对的前提，不替同伴补结论。先收齐每个人的第一版观点，再交换；没有初稿的同学先花两分钟写一条判断。"],
    ]);
    const workshopRef = await addTurn(client, workshop, "user",
      "我记得【@" + report.title + "】里有关于学生自己形成判断和使用 AI 反馈的做法。请结合其中相关成果，为工作坊做一张学生任务卡：写清每步时间、要留下什么，以及我该怎么引导讨论。");
    await addReference(client, workshopRef.id, "task", report, [contrast, method]);
    await addTurn(client, workshop, "assistant",
      "任务卡建议围绕「从零提出判断」与「审查现成建议」这两个环节展开：\n\n| 时间 | 学生做什么 | 留下什么 |\n|---|---|---|\n| 0—5 分钟 | 了解题目和材料；独立写一句观点、一条理由 | 个人初稿 |\n| 5—12 分钟 | 两人互问：理由依赖的事实或前提是什么？ | 一个待核验的问题 |\n| 12—22 分钟 | 向 AI 请求反例或薄弱点，而非完整答案；标出同意与质疑 | 反馈标记 |\n| 22—32 分钟 | 回到指定材料核对一处关键事实，修改或保留初稿 | 核验依据、修订理由 |\n| 32—40 分钟 | 小组讨论「最先自己写」与「面对 AI 建议」时分别做了什么判断 | 一句过程反思 |\n\n引导时可问：「你原先怎么想？AI 的哪句话让你停下来核对？最后为什么改或不改？」这借用了之前保存的两项成果来设计活动，不假设这套方法已被实证证明有效。");
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
