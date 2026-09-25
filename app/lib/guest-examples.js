// Create three clearly labeled, per-guest example tasks on first task-list read.
// These are illustrative conversations, not AI output or real user research.
const db = require("../services/db");
const { artifactToSnapshot } = require("./reference");
const SEED_VERSION = 3;
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
  const actual = rows.map(fingerprint).sort((a, b) => a[0].localeCompare(b[0]));
  const matches = previousCopies.some((copy) =>
    JSON.stringify(actual) === JSON.stringify(copy.map((item) =>
      [...item.slice(0, 4), normalizeTitles(item[4]), ...item.slice(5)]
    ).sort((a, b) => a[0].localeCompare(b[0])))
  );
  if (matches) {
    await client.query("UPDATE tasks SET is_archived_example=true WHERE guest_id=$1 AND id=ANY($2::uuid[])",
      [guestId, rows.map((row) => row.id)]);
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

    const first = await addTask(client, guestId, "示例｜从宽泛选题到研究计划", 1, [
      ["user", "三天后要做一场 8 分钟课堂分享，题目暂定「生成式 AI 改变大学生学习」。老师要求引用能查到原文，我也来不及做问卷。这个题目太大了，怎么收窄？"],
      ["assistant", "先把目标从「证明 AI 改变了学习」改为「展示核查 AI 提供的文献线索的方法」。\n\n**可完成的研究问题**：面对 AI 推荐的文献，怎样判断它能不能进入课堂分享的证据清单？\n\n三天内的交付物可以是：一张线索记录表、一条核查流程，以及一页说明哪些结论目前不能下。没有问卷，就不推断大学生群体的行为变化。"],
      ["user", "我手头有 AI 给的三条论文线索，其中一条找不到原文。核查表应该怎么填？"],
      ["assistant", "先为**每条线索**记录：标题、作者、年份、原始发表页或 DOI、要支持的观点、核查状态。\n\n| 状态 | 判断标准 | 分享时如何用 |\n|---|---|---|\n| 可引用 | 找到原文，且观点能在原文定位 | 标明出处后使用 |\n| 待核 | 只有转载或检索摘要 | 暂不当作证据 |\n| 排除 | 找不到原文，或信息对不上 | 不引用，可说明排除原因 |\n\n那条找不到原文的线索先记为「待核」；不要补写猜测的作者、DOI 或论文内容。"],
    ]);
    const firstBranch = await addBranch(client, first, "支线｜找不到原文怎么办", [
      ["user", "那条找不到原文的线索，我能在分享里讲它吗？还是干脆不要提？"],
      ["assistant", "可以讲你的**核查过程**，但不能把那条线索当作支持观点的论文。你可以展示「检索了什么信息、在哪些来源查找、为何暂时无法核验」，并明确说它未进入证据清单。先别断言论文不存在，可能只是题名或作者信息有误。"],
      ["user", "另外一条能搜到相似标题，但作者和年份对不上。它跟完全查不到的那条一样处理吗？"],
      ["assistant", "都不能直接引用，不过记录原因要分开：第一条标「未找到可核验原文」；相似标题那条标「书目信息冲突」。后一条可以继续核对期刊页面、作者主页或 DOI 登记信息，确认是否同一篇。只凭相似标题，不要把检索结果当成原文。"],
      ["user", "给我一段能直接放到第 5 页的资料取舍说明吧，别让它听起来像在证明 AI 总会编文献。"],
      ["assistant", "可以写：「本次收集的文献线索中，有的尚未找到可核验原文，有的检索结果与提供的作者、年份不一致。因此，这些线索暂不用于论证；只有核对到原文并定位相关观点的材料，才可能进入证据清单。」这只说明你的筛选过程，不推断 AI 给出的文献总体有多可靠。"],
    ]);
    const firstArtifact = await addArtifact(client, first, "文献线索核查卡", "方法",
      "把宽泛选题收窄为可执行的核查任务；记录每条线索的来源和状态。",
      "研究问题：AI 给出的文献线索，如何判断能否用于课堂分享？\n\n每条记录填写：标题｜作者与年份｜原始发表页或 DOI｜拟支持的观点｜原文定位｜状态。\n\n状态规则：找到原文且观点吻合 → 可引用；只有摘要或转载 → 待核；找不到原文或信息矛盾 → 排除。待核与排除项都不能作为论据。\n\n展示边界：这是资料核查方法，不是「AI 已改变大学生学习」的实证结论。");
    await addConfirmedStage(client, first, firstArtifact);
    const branchArtifact = await addArtifact(client, firstBranch, "无法核实资料的展示边界", "判断",
      "未找到原文的线索可用于说明核查过程，不能作为观点证据。",
      "分享时可以展示两种不同的核查结果：未找到可核验原文；检索结果与作者或年份冲突。两者均暂不纳入论证，分别记录检索途径和冲突之处，不补写猜测的 DOI 或论文结论。说明的是资料取舍过程，不推断 AI 生成内容的总体错误率。\n\n建议讲述词：「本次收集的文献线索中，有的尚未找到可核验原文，有的检索结果与提供的作者、年份不一致。因此，这些线索暂不用于论证。」");
    await addConfirmedStage(client, firstBranch, branchArtifact);
    const firstRefMessage = await addTurn(client, first, "user",
      `请用【@${firstArtifact.title}】给我排接下来两天的工作，具体到每天要完成什么；三条线索还没核实完。`);
    await addReference(client, firstRefMessage.id, "artifact", first, firstArtifact);
    await addTurn(client, first, "assistant",
      "按照核查卡的字段推进：\n\n**第 1 天｜填表与核验**：逐条补齐标题、作者、年份和原始发表页；打开原文定位要引用的段落。找不到原文的那条保持「待核」，不要为了凑数补一个来源。完成时交付一张三行的记录表，每行都有核查状态。\n\n**第 2 天｜筛选与成稿**：仅用「可引用」的条目写分享中的论据；待核条目继续查证或换来源，排除条目只用于说明核查流程。最后做一页「我们展示了方法，尚未测量学生行为变化」的局限说明。\n\n如果到期仍没有可引用的原文，就把分享定位为核查方法演示，不写研究发现。",
    );

    const second = await addTask(client, guestId, "示例｜把研究计划做成课堂分享", 2, [
      ["user", "我要把「核查 AI 给出的文献线索」讲成 8 分钟课堂分享。现在没有调查数据，先帮我安排页面和时间。"],
      ["assistant", "先排六页：问题与边界（45 秒）、研究问题（75 秒）、核查规则（90 秒）、操作演示（105 秒）、资料取舍（90 秒）、局限与下一步（75 秒），合计 8 分钟。当前只是讲述框架；每一页的证据还需要后续填入。"],
      ["user", "老师可能追问「凭什么能引用这篇论文」。每页应该留什么证据位置？"],
      ["assistant", "第 2 页写明确的研究问题；第 3 页预留原始发表页或 DOI 与核查状态；第 4 页预留一条**实际核验后**才可展示的记录；第 5 页说明待核和排除的依据；第 6 页写未做问卷、不能推断总体变化。没有核验完成的材料，就保留空位，不编造例子。"],
    ]);
    await addBranch(client, second, "支线｜没有数据怎么开场", [
      ["user", "有人建议我用「大部分同学依赖 AI」开场，但我没有调查数字。这句怎么办？"],
      ["assistant", "先删掉「大部分」。你可以从自己遇到的问题说起：「我请 AI 推荐了一些文献，但在准备课堂分享时发现，能不能引用还得自己核对。」这交代了选题缘由，没有把个人经历说成调查结果。"],
      ["user", "能帮我写一个 20 秒的开场吗？要能自然过渡到我的核查方法。"],
      ["assistant", "试试这一版：「准备这次分享时，我先用 AI 找到几条可能相关的文献线索。但线索能搜到，并不等于观点能引用。接下来我想展示：怎样找到原文、核对它说了什么，再决定哪些材料可以进入分享。」正常语速读一遍，过长就删掉第一句的修饰语。"],
      ["user", "如果老师说「你没有调查数据，那分享有什么价值」，我怎么回答？"],
      ["assistant", "可以答：「这次没有做问卷，所以我不报告同学们使用 AI 的比例或效果。我展示的是一套查证引用资料的方法，以及哪些线索暂时不能作为证据。它能帮助后续研究先把资料基础弄清楚。」如果老师要求实证结论，就坦诚说本次材料不足，并把它列为后续工作。"],
    ]);
    const secondRefMessage = await addTurn(client, second, "user",
      `请结合【@${first.title}】里的文献核查做法，把刚才的证据空位变成六页 8 分钟讲述稿。每页写标题、时间、要展示的材料和一句讲述词。`);
    await addReference(client, secondRefMessage.id, "task", first, firstArtifact);
    const secondAnswer = "我沿用「标题、作者与年份、原始发表页、观点定位、核查状态」这几项，把六页安排成可以排练的讲述稿：\n\n| 页 | 时间 | 标题与展示材料 | 讲述词示例 |\n|---|---|---|---|\n| 1 | 0:45 | 为什么要核查；展示你的开场问题 |「AI 给出线索后，我还需要判断哪些材料真能引用。」|\n| 2 | 1:15 | 研究问题；展示「怎样判断线索能否引用」 |「我关注的是核查方法，不是 AI 使用率。」|\n| 3 | 1:30 | 判断规则；展示「可引用／待核／排除」三栏 |「能找到原文，还要核对原文是否支持所述观点。」|\n| 4 | 1:45 | 操作演示；展示一条**实际核验后**的记录，尚未核实则保留空位 |「依次核对发表页、作者、年份和观点所在段落。」|\n| 5 | 1:30 | 资料取舍；展示无法核实及信息冲突的处理方式 |「没有核对到原文的线索暂不作为证据。」|\n| 6 | 1:15 | 局限与下一步；展示后续核查计划 |「我没有调查学生行为，这次分享只展示核查流程。」|\n\n第 4 页的记录要用实际核验的材料填写，不能把占位文字当成真实文献。";
    await addTurn(client, second, "assistant", secondAnswer);
    const secondArtifact = await addArtifact(client, second, "六页八分钟课堂分享稿", "模板",
      "从引用的核查卡生成六页讲述结构，保留尚未核实材料的证据空位。",
      "【讲述稿草稿；证据空位须由实际核验的材料填写】\n\n" + secondAnswer);
    await addConfirmedStage(client, second, secondArtifact);

    const third = await addTask(client, guestId, "示例｜教育科技行业分析立项", 3, [
      ["user", "社团让我做一份教育科技行业分析。我只剩两个晚上，也没做访谈；现在应该先定什么范围？"],
      ["assistant", "先把范围限定为「大学生使用的学习辅助工具」，不要试图覆盖整个教育科技行业。暂时只回答三个问题：这类产品宣称解决什么问题？有哪些可核实的产品功能？哪些市场和用户判断还缺证据？交付物先定为带证据空位的简报草稿，不写市场规模结论。"],
      ["user", "公开资料很多。只有两个晚上，应该先找哪几类，怎么记录？"],
      ["assistant", "**今晚**：找 2～3 个产品的官网或更新日志，只记录可核对的功能与发布日期。**明晚**：找有出处的行业资料，追到原始统计口径；无法确认的数字先不用。\n\n每条材料记录「来源链接｜发布日期｜原文说了什么｜可支持的问题｜不能证明什么｜核查状态」。这张表目前是工作计划，还不是已确认的行业结论。"],
    ]);
    await addBranch(client, third, "支线｜官网说法能当证据吗", [
      ["user", "一个产品官网写「AI 显著提升学习效果」，这句话能直接放进行业分析吗？"],
      ["assistant", "你可以写「该产品官网宣称提升学习效果」，并附官网页面和访问日期；不能据此写成已验证的实际效果。要评价效果，需要找到研究设计、样本、对照和原始结果。"],
      ["user", "如果还有新闻稿转述这个说法，算不算第二个证据？"],
      ["assistant", "先看新闻稿引用了什么。如果只是重复官网措辞，那仍是一条主张的转载，不是独立验证。你可以记下它帮助读者追溯传播路径，但不能把「官网 + 转述官网的新闻稿」算成两份效果证据。"],
      ["user", "那我的对照表要怎么写，才不会把产品功能和效果混在一起？给我一行示范。"],
      ["assistant", "可以先做一行**填写示范，暂不对应真实产品**：\n\n| 产品 | 可核对的功能 | 效果主张 | 独立证据 |\n|---|---|---|---|\n| 产品 A（占位） | 官网列出错题整理功能；待核上线时间 | 官网称能改善学习效果 | 未找到可核验的独立研究 |\n\n正式写作时用实际页面替换「产品 A」，给每条功能和主张补上链接、发布日期与查看日期；找不到效果研究就保持空缺。"],
    ]);
    const thirdRefMessage = await addTurn(client, third, "user",
      `请参考【@${secondArtifact.title}】的讲述结构，把我的行业分析改成五页简报草稿。借用表达顺序就好，不要把文献核查的内容当作行业事实。`);
    await addReference(client, thirdRefMessage.id, "artifact", second, secondArtifact);
    await addTurn(client, third, "assistant",
      "可以借用那份稿子的「提出问题 → 交代方法 → 展示材料 → 说明取舍 → 承认局限」，改成行业分析的**五页待填草稿**：\n\n1. **范围与问题**：聚焦大学生学习辅助工具，写清楚不覆盖整个教育科技行业。\n2. **资料方法**：列官网、更新日志和原始行业资料，并说明各自能证明什么。\n3. **产品对照**：列「产品｜可核验功能｜发布日期｜来源」；实际核过之前先留空。\n4. **证据取舍**：分开记录产品的效果主张与独立研究；没有原始研究就不写「效果已证实」。\n5. **局限与下一步**：未做访谈，不能声称用户需求已被验证；先完成两晚的资料核对。\n\n讲述结构可以借用，关于文献线索的例子不要放进这份行业简报。",
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
