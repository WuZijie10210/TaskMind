# TaskMind

把复杂学习任务组织成主线、支线、可确认的成果，并在后续对话中显式复用。

- **在线体验入口**：https://taskmind-production-7344.up.railway.app/
- **产品说明**：在线应用的 https://taskmind-production-7344.up.railway.app/about，以及可单独静态发布的 `docs/index.html`。
- **项目定位**：产品经理个人作品与限额公开体验版；尚未进行真实用户效果验证。

## 产品体验

1. 创建任务，在主线讨论目标。
2. 为特定问题创建支线。支线继承创建时冻结的主线上下文。
3. 对阶段对话发起「沉淀」，审核候选成果后确认保存。
4. 用 `@成果` 或 `@任务` 引用已确认成果；发送时保存引用快照。

首次打开任务列表时，每个浏览器会得到三个以「示例｜」开头的独立任务：大学学习方式研究（主要功能展示）、学习工具课程汇报（跨任务引用）、新行业分析选题（没有本任务成果）。三个主线均以一轮已完成的引用对话结束；每个任务有一条支线，前两个任务各有一项成果，第三个任务的成果页为空。演示数据不消耗 AI 额度、不包含真实调研结果；可以照常编辑或删除，后续刷新不会重复生成。已生成旧版示例的浏览器不会自动覆盖现有任务，可用无痕窗口查看新版示例。

## 运行架构

单个 Node/Express 服务同时提供 React 前端、JSON API 和流式聊天。PostgreSQL 保存任务、消息、支线快照、成果与访客每日额度。服务端通过 OpenAI 兼容的 Chat Completions 接口调用模型，密钥从不发送到浏览器。

## 本地运行

要求 Node 20+ 和 PostgreSQL。复制 `.env.example`，设置真实 `DATABASE_URL`、`AI_API_KEY`、`AI_MODEL` 与随机 `SESSION_SECRET`，并把这些变量加载到运行环境中（Node 20 可使用 `node --env-file=.env`）。

```sh
npm ci
npm run migrate
npm run build
npm start
```

访问 `http://localhost:3000`。开发前端可运行 `npm run build` 后重启服务；目前没有单独的 Vite 代理开发脚本。

## Railway 上线

1. 将此目录的文件推送到你自己的 GitHub 仓库。不要提交 `.env`、密钥或从旧环境导出的数据库文件。
2. 在 Railway 新建项目，关联 GitHub 仓库并新增 PostgreSQL。Railway 会使用根目录的 `Dockerfile` 构建单个 Web 服务。
3. 在 Web 服务的 Variables 中设置：

   | 变量 | 值 |
   |---|---|
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}`（若数据库服务名不同，按实际名称替换） |
   | `AI_API_KEY` | AI 供应商密钥 |
   | `AI_MODEL` | 支持 Chat Completions、流式输出与 `max_tokens` 的模型，例如 `gpt-4o-mini` |
   | `AI_BASE_URL` | 官方 OpenAI 可用 `https://api.openai.com/v1`；兼容服务填其 `/v1` 地址 |
   | `SESSION_SECRET` | 至少 32 个随机字符；部署后保持不变 |
   | `PUBLIC_ORIGIN` | 可先省略；域名确定后填 `https://实际域名` |

4. 先运行一个 Web 实例。Docker 启动时执行数据库迁移，再启动服务；配置健康检查路径 `/healthz`，生成公开域名。

如果密钥由第三方转接平台发放，必须同时把 `AI_BASE_URL` 改成该平台文档中的 Chat Completions API 基础地址（通常以 `/v1` 结尾），`AI_MODEL` 改成该平台支持的模型名称。不能用第三方密钥搭配默认的 `https://api.openai.com/v1`。变量修改后在 Railway 应用待部署变更，再测试聊天。密钥只填在 Railway 服务变量里，勿上传到 GitHub。
5. 打开首页并检查：创建任务、流式回复、支线、沉淀确认、`@` 引用；用无痕窗口确认看不到另一个窗口的任务。最后填写上面的体验 URL，并把 `/about` 链接加入简历或作品集。

可在 GitHub 仓库设置 Pages，选择从主分支的 `/docs` 目录发布静态案例页。Web App 确认上线后，为 `docs/index.html` 加入体验链接和真实截图。静态案例页可以独立访问，不能替代需要 API、数据库与 AI 的产品本体。

公开前在 AI 供应商后台设置消费预算。不要只依赖应用内的每日调用次数来控制财务风险。

## 演示版边界

- 游客通过签名的 HttpOnly Cookie 隔离数据；Cookie 丢失后原任务无法找回。游客任务 7 天不活跃后清理。
- 每个游客每日最多 10 个任务、20 次聊天、5 次沉淀操作；同一来源地址还有额外总量约束。请求额度由数据库原子计数。分布式滥用仍需要供应商预算或网关防护。
- 同一对话的模型回合采用 PostgreSQL advisory lock；成果确认只有一个请求能成功，并禁止 0 条成果却推进阶段。
- 聊天历史尚未做 token 预算或摘要；很长的任务可能触达模型的上下文上限。当前定位为短时作品演示。
- 这不是完整多用户账户产品；访客内容不适合输入敏感资料。

## 验证

`npm test` 检查 Context 组装；`node test/smoke.cjs` 检查健康接口、前端路由和 JSON 404；`npm run build` 检查前端构建。真实 PostgreSQL 与 AI 的端到端验证须在配置连接后进行。
