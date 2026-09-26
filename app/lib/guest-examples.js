// Create a two-task, per-guest example of confirmed-result reuse.
// These are illustrative conversations, not AI output or real user research.
const db = require("../services/db");
const { artifactToSnapshot } = require("./reference");
const SEED_VERSION = 7;
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
  [
    ["示例｜生成式 AI 与大学教育汇报", 6, "支线｜AI 会替代大学教师吗|支线｜即时反馈会削弱学生判断吗", 12,
      "从零构建与对 AI 草稿反应的判断力差异|学生使用 AI 时的「先判断—再反馈—后验证」三步框架", 1, 2],
    ["示例｜AI 素养工作坊", 6, "支线｜小组互评怎么提问", 4, "", 1, 0],
  ],
  [
    ["示例｜生成式 AI 与大学教育汇报", 6, "支线｜AI 会替代大学教师吗|支线｜即时反馈会削弱学生判断吗", 12,
      "从零构建与对 AI 草稿反应的判断力差异|大学教育汇报的切入问题与范围|学生使用 AI 时的「先判断—再反馈—后验证」三步框架|即时反馈议题的汇报论证边界|不以「AI 是否替代教师」作为汇报主线", 1, 3],
    ["示例｜AI 素养工作坊", 6, "支线｜小组互评怎么提问", 4, "", 1, 0],
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
  const fingerprint = (row) => [row.title, Number(row.main_count), normalizeTitles(row.branch_titles),
    Number(row.branch_count), normalizeTitles(row.artifact_titles), Number(row.ref_count), Number(row.job_count)];
  const published = new Set(previousCopies.flat().map((item) => JSON.stringify(
    [item[0], item[1], normalizeTitles(item[2]), item[3], normalizeTitles(item[4]), ...item.slice(5)]
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
  const sourceSnapshot = source.messages.map((m) => ({
    id: m.id, role: m.role, content: m.content,
  }));
  return (await client.query(
    "INSERT INTO artifacts(task_id,source_conversation_id,title,type,summary,content," +
      "source_message_ids,source_snapshot,source_conversation_title,created_at,updated_at) " +
      "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) RETURNING *",
    [source.task.id, source.main.id, title, type, summary, content,
      source.messages.map((m) => m.id), JSON.stringify(sourceSnapshot),
      source.title.startsWith("支线｜") ? source.title : "主线对话", seededAt(client)]
  )).rows[0];
}

async function addConfirmedStage(client, source, artifacts) {
  // A seeded result has the same source/cursor contract as an approved
  // deposition. Later turns remain available for a new deposition.
  const ids = source.messages.map((m) => m.id);
  const selected = Array.isArray(artifacts) ? artifacts : [artifacts];
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
      JSON.stringify(selected.map((artifact) => ({ title: artifact.title, type: artifact.type,
        summary: artifact.summary, content: artifact.content, sourceMessageIds: ids }))),
      ids.at(-1), seededAt(client)]
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
      ["assistant", "可以从学生的学习过程切入：AI 很快就能给答案或反馈，但学生在哪一步形成自己的判断？你可以把汇报问题定为「AI 参与学习时，怎样保留学生提出判断、检验判断的机会」。先找两个具体场景对比，再讨论教师可以怎样设计练习。"],
      ["user", "我自己写一段分析时要先想怎么论证；如果让 AI 先写，我经常只是在它的草稿上改字。这两种情况能放到汇报里对比吗？如果合适，我想把两种情况下要做的判断留着，后面排汇报结构时用。"],
      ["assistant", "可以把它们作为两种任务方式来对比：从零构建时，学生要先选问题、列理由、决定证据；对 AI 草稿作反应时，学生更多在筛选、质疑和修改现成内容。两者都需要判断，但判断发生的位置不同。拿同一个小题演示，让同学分别说说先写提纲和先看 AI 提纲时要回答什么问题；这样汇报就能落到具体过程上。"],
    ]);
    const contrast = await addArtifact(client, report, "从零构建与对 AI 草稿反应的判断力差异", "结论",
      "两种学习任务都需要判断，但判断发生在提出问题与检验现成草稿的不同环节。",
      "从零构建：学生先界定问题、组织理由、选择证据。对 AI 草稿反应：学生先检查既有结构和断言，再决定保留、质疑或修改。区别是判断发生的位置，不是对谁学得更好作效果判断。课堂可让两组面对同一题目分别从零列提纲、审查 AI 提纲，并比较各自做过哪些判断。");
    const reportScope = await addArtifact(client, report, "大学教育汇报的切入问题与范围", "框架",
      "8 分钟汇报聚焦 AI 参与学习后学生的判断发生在哪里，以两个学习场景展开，不把学习效果当成已验证结论。",
      "汇报问题：AI 参与学习时，学生在哪些环节提出和检验自己的判断？用同一道小题的两种处理方式切入：自己先列提纲，或先审查 AI 给出的提纲。先比较两个过程里学生做了哪些判断，再讨论教师能如何设计练习。限定在可观察的任务过程，不从这组示例推断学生学得更好或更差。");
    await addConfirmedStage(client, report, [contrast, reportScope]);

    const feedback = await addBranch(client, report, "支线｜即时反馈会削弱学生判断吗", [
      ["user", "我想单独想想：如果 AI 每一步都马上告诉学生哪里错了，学生会不会渐渐不愿意自己判断？"],
      ["assistant", "关键可能是反馈的时机。如果学生还没提出自己的理由就先看到纠正，就少了一次形成判断的机会；但在学生先写下判断后，反馈也可能帮助他发现漏洞。汇报时可以用一道自拟的讨论题对比两种顺序，例如「准备课程报告时，应该先让 AI 出提纲吗？」一组先看 AI 提纲再说哪里不认可，另一组先写自己的观点和理由，再看 AI 的反例。这里比较的是判断出现在哪一步，不预设哪组学得更好。"],
      ["user", "如果让学生先写一句自己的判断，再问 AI，然后怎么避免直接照抄 AI 的回复？"],
      ["assistant", "可以要求学生保留第一版判断，并在收到 AI 反馈后写两栏：「我同意或不同意什么」「依据是什么」。最后让学生回到教材或原始材料核对一处关键事实。这样能看见学生有没有改变想法，也能看见改变的理由，而不是只交一段润色后的答案。"],
      ["user", "我想给这套做法起个简单名字，汇报时让同学现场试，之后设计类似活动也能用。你帮我整理成三个步骤和每步的产出。"],
      ["assistant", "叫「先判断—再反馈—后验证」：\n\n1. **先判断**：学生独立写一句观点和一条理由，留下初稿。\n2. **再反馈**：请 AI 指出反例或薄弱处，学生标出同意与质疑的地方。\n3. **后验证**：用课程材料核对关键事实，写清最终保留或修改了什么，以及原因。\n\n现场可以用一个不要求专业背景的小题，让大家对照第一版观点，看看哪些地方真的改了，为什么改。"],
    ]);
    const method = await addArtifact(client, feedback, "学生使用 AI 时的「先判断—再反馈—后验证」三步框架", "方法",
      "把 AI 反馈放在学生独立判断之后，并要求核验与修正理由。",
      "适用场景：课堂讨论、短文写作或观点练习。\n1. 先判断：学生先写观点与理由，保留原稿。\n2. 再反馈：请 AI 提供反例或指出漏洞，学生标出同意和质疑之处。\n3. 后验证：回到课程材料核对关键事实，记录保留或修改了什么及原因。\n可观察的产出：初稿、反馈标记、修订理由；不能据此推断学习效果已被证实。");
    const feedbackCase = await addArtifact(client, feedback, "同一道讨论题的两种 AI 反馈时机", "案例",
      "自拟的课堂练习情境：用同一道题对比先看 AI 提纲与先写独立判断两种顺序，观察判断出现在哪里。",
      "这是汇报中用于演示的自拟情境，不是真实课堂实验。题目：「准备课程报告时，应该先让 AI 出提纲吗？」情境 A：学生先看 AI 提纲，再标出不认可的地方和理由。情境 B：学生先写自己的观点和理由，之后请 AI 提供反例，最后回到课程材料核对。讨论问题：两种顺序中，学生分别在哪一步提出、检验或修正自己的判断？不能据此断言哪一种学习效果更好。");
    await addConfirmedStage(client, feedback, [method, feedbackCase]);

    const teacher = await addBranch(client, report, "支线｜AI 会替代大学教师吗", [
      ["user", "还有个方向：AI 会不会替代大学教师？大家可能更想听这个。"],
      ["assistant", "它容易吸引注意，但「替代或不替代」太宽，也不容易在 8 分钟内讲清条件。你可以问得具体些：哪些环节适合 AI 给反馈，哪些环节仍需要教师设计任务、判断学生是否真正理解？"],
      ["user", "这样讲又像是另起一个汇报。我现在更想讲学生怎样保持判断力。"],
      ["assistant", "那就把教师角色留作结尾的一句延伸：教师可以设计先独立判断、再借助反馈、最后核验的任务。主体仍围绕学生在不同环节做了什么判断。这个方向可以先放下，之后有时间再单独讨论。"],
      ["user", "对，先不把「替代教师」放到标题里。之后改稿时我可能又觉得它更吸引人，你帮我把不选它的理由说清楚，我要把时间留给那个具体的课堂练习。"],
      ["assistant", "可以记下这个取舍：8 分钟内很难说清「替代教师」依赖的教学环节和条件，还容易把汇报带到二选一的争论里。你真正要展示的是学生在什么环节作判断，以及课堂练习怎么保留这些环节。标题暂定为「AI 参与学习后，学生的判断发生在哪里？」教师如何设计练习放到结尾。"],
    ]);
    const teacherChoice = await addArtifact(client, teacher, "不以「AI 是否替代教师」作为汇报主线", "判断",
      "保留将教师角色放在汇报结尾的取舍：8 分钟主线聚焦学生判断过程，而非二元替代争论。",
      "当时考虑过用「AI 是否替代大学教师」吸引听众，但这个提问太宽，涉及不同教学环节的条件，8 分钟内容易沦为替代或不替代的争论。最终选择「AI 参与学习后，学生的判断发生在哪里？」作为主线，把时间给两种学习过程的对比与现场练习；教师如何设计任务仅在结尾回应。今后修改这份汇报时可用这个理由检查是否跑题。");
    await addConfirmedStage(client, teacher, teacherChoice);

    const reportRef = await addTurn(client, report, "user",
      "我决定不以「AI 是否替代教师」作主线。请用【@" + method.title + "】重新排 8 分钟的汇报，重点放在学生判断发生在哪些环节，最后给一个同学能现场尝试的小练习。");
    await addReference(client, reportRef.id, "artifact", report, method);
    await addTurn(client, report, "assistant",
      "可以按「判断发生在哪里」来安排：\n\n- **0—1 分钟｜提出问题**：同一道题，学生先列提纲与先看 AI 提纲时，分别要做哪些判断？\n- **1—3 分钟｜对比两种过程**：前者重在界定问题、选理由，后者重在筛选和质疑现成草稿。用一张对照表说明判断位置的变化。\n- **3—6 分钟｜现场练习**：请同学先独立写一条观点和理由，再看 AI 的一个反例，最后用课程材料核验并写出是否修改。把「先判断—再反馈—后验证」作为练习流程。\n- **6—8 分钟｜收束**：请同学说说自己在哪一步改变了看法，再讨论教师能怎样设计任务，给学生留下形成判断的机会。\n\n练习产出是初稿、反馈标记和修订理由，能让讨论落在可观察的学习过程上。");
    const talkTemplate = await addArtifact(client, report, "八分钟汇报的对比与练习结构", "模板",
      "适用于用两个过程的对比引出现场练习的短汇报：提出问题、比较差异、让听众尝试、收束判断。",
      "使用时替换方括号中的具体内容：\n0—1 分钟｜提出 [核心问题]，用同一道题展示两种处理方式。\n1—3 分钟｜对比 [方式 A] 和 [方式 B]，说明关键差异出现在哪一步。\n3—6 分钟｜让听众先写 [个人判断]，再看 [反例或反馈]，最后用 [指定材料] 核对并说明改或不改的理由。\n6—8 分钟｜请听众说出自己的判断在哪一步变化，用 [可观察的练习产出] 回答开头的问题。\n这是一份组织汇报的结构模板；具体事实与案例应另行核对。");
    await addConfirmedStage(client, report, talkTemplate);

    const workshop = await addTask(client, guestId, "示例｜AI 素养工作坊", 2, [
      ["user", "我要给大一学生设计一场 40 分钟的 AI 素养工作坊。不想教一遍工具怎么用，而是让他们练习审查 AI 给的建议。先帮我定活动目标，暂时不用排流程。"],
      ["assistant", "目标可以是：学生能指出 AI 建议里一处需要追问的说法，并解释自己为什么采纳或拒绝它。最后收一张记录判断过程的小卡片，而不是只收润色后的答案。至于练习顺序，还要看现场怎么安排。"],
      ["user", "我担心大家一拿到 AI 的完整答案就跟着走。活动怎么安排，才能看见他们自己做过什么判断？"],
      ["assistant", "可以先要求每个人对题目写一句初步看法；看到 AI 建议后，再圈出一处想接受或质疑的地方，并写原因。这还是粗安排：讨论环节怎么提问，以及最后如何核实，需要进一步细化。"],
    ]);
    await addBranch(client, workshop, "支线｜小组互评怎么提问", [
      ["user", "如果同伴只是说「我觉得挺好」，小组互评就没用了。给他们一个具体问题吧。"],
      ["assistant", "让每个人只追问一件事：「你这条理由依赖的事实或前提是什么？我们能在哪里核对？」这比评价写得好不好更容易推动下一步。"],
      ["user", "有的人可能还没写完初稿，怎么避免互评变成互相给答案？"],
      ["assistant", "把互评限制在指出一个需要核对的前提，不替同伴补结论。先收齐每个人的第一版观点，再交换；没有初稿的同学先花两分钟写一条判断。"],
    ]);
    const workshopRef = await addTurn(client, workshop, "user",
      "小组互评我打算只让同伴追问一个可以核对的前提，先有个人初稿再交换，不替同伴给答案。我记得【@" + report.title + "】里还讨论过学生怎样形成判断、怎样使用 AI 反馈。请结合其中能用的内容，把刚才的粗安排做成一张 40 分钟任务卡：每步做什么、留下什么、如何带讨论？");
    await addReference(client, workshopRef.id, "task", report, [contrast, method]);
    await addTurn(client, workshop, "assistant",
      "可以把之前讨论的「先判断—再反馈—后验证」做法变成活动顺序，再用「从零构建与审查 AI 草稿」的对比设计最后的讨论。你刚决定的小组互问，放在第一次看 AI 建议之前：\n\n| 时间 | 学生做什么 | 留下什么 |\n|---|---|---|\n| 0—5 分钟 | 了解题目和材料；独立写一句观点、一条理由 | 个人初稿 |\n| 5—12 分钟 | 两人互问：这条理由依赖什么事实或前提？不替对方给答案 | 一个待核对的问题 |\n| 12—22 分钟 | 请 AI 给出反例或指出薄弱处；标出同意和质疑的地方 | 反馈标记 |\n| 22—32 分钟 | 回到指定材料核对一处关键事实，决定保留还是修改初稿 | 核对依据、修改理由 |\n| 32—40 分钟 | 对比独立写初稿与审查 AI 建议时，各自做了哪些判断 | 一句过程反思 |\n\n引导时可以追问：「你最初怎么想？AI 的哪句话让你停下来核对？最后为什么改或不改？」讨论重点放在学生怎样作出和修改判断，而不只看最终卡片写得是否漂亮。");
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
