# 求职跟踪模块实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在 Personal AI Workbench（私有 fork）中新增「求职跟踪」模块：每天从 BOSS 直聘抓取匹配岗位，硬过滤 + LLM 打分，生成 Vault 日报，页面管理投递状态机。

**架构：** BOSS 直聘 Playwright 半自动爬虫（扫码登录 + session 复用）是唯一数据源；岗位库存 server 端 JSON（原子写，ignored）；LLM 打分复用 learning-ai 的 OpenAI 兼容配置；每日 pipeline 为独立 node 脚本（Windows 计划任务 8:30）；前端新增 `JobTrackerPage.jsx` 三区页面。

**技术栈：** Node 24、Playwright（chromium）、React 19、Vite、OpenAI 兼容 LLM API。

**决策来源：** grilling 拷问两轮共 12 问，用户全部确认（Q4/Q7 有具体内容，其余按推荐）。

---

## 已确认决策表

| # | 问题 | 决策 |
|---|---|---|
| Q1 | 模块归属 | 用户已将仓库 fork 为私有，无公开仓库顾虑，模块进导航 |
| Q2 | 数据来源 | D：BOSS 半自动爬虫为主；免浏览器源经实验证伪后，一期即 BOSS 爬虫 |
| Q3 | 匹配判定 | C：硬过滤（城市/薪资/经验/外包/规模）+ LLM 打分（≥7 进日报） |
| Q4 | 求职硬条件 | 城市：广州/深圳/杭州/苏州；薪资 ≥12K；行业偏储能/IoT/新能源/充电桩，Java 后端皆可；经验 1-5 年；排除外包、公司规模 >300 人 |
| Q5 | 推送形态 | Windows 计划任务每日 8:30 跑 digest 脚本，产物为 Vault Markdown 日报 |
| Q6 | 跟踪深度 | B：推荐 + 状态机 pipeline（含投递 3 天未回复提醒） |
| Q7 | 关键词矩阵 | 4 城 × 5 词：Java后端、储能EMS、充电桩、物联网、新能源；目标公司：固德威、阳光电源 |
| Q8 | 存储 | 岗位库 JSON（`Workbench/data/job-tracker.local.json`，ignored）+ Vault 日报（`个人知识库/70_career/daily/`） |
| Q9 | 去重 | 岗位 URL 主键（无 URL 时 公司+标题+城市 哈希）；已推送不再进日报，变更静默更新 |
| Q10 | LLM 配置 | 复用 `config/learning-ai.local.json`；阈值 7/10；每日上限 20 条；画像存 `config/job-profile.local.json` |
| Q11 | 状态机 | 新推荐 → 感兴趣 → 已投递 → 面试中 → offer / 已拒绝 / 不合适；投递日期手动填（默认当天）；3 天未回复仅在页面顶部提醒 |
| Q12 | 页面/定时 | `JobTrackerPage.jsx` 三区（提醒条/今日推荐/全部岗位）；`node scripts/job-digest.mjs` 手动可跑 |

## 数据源调研结论（2026-09-08 实测）

- 前程无忧搜索 API：阿里云 WAF 拦截（JS 挑战），裸 node 不可用
- 固德威：无集中 ATS 职位列表，社招散落各平台 → 不作为独立源，改作 BOSS 搜索关键词
- 阳光电源：Moka HR SPA，职位 API 逆向成本高 → 同上
- `m.zhipin.com` 移动端免登录抓取（mcp-jobs 路线）：实测被安全验证 → 强制登录墙，**匿名抓取已死**
- 开源项目评估：`Snseam/boss-zhipin-mcp`（招聘方工具，不适用）；`mergedao/mcp-jobs`（本身是 Playwright 爬虫，BOSS 免登录已失效）；`TreeWalk/boss-zhipin-skill`（同构方案，可借鉴触底滚动翻页与反检测）
- **结论：BOSS 登录态爬虫是唯一可行数据源**

---

## 文件结构

**新建：**

| 文件 | 职责 | 状态 |
|---|---|---|
| `Workbench/scripts/job-boss-login.mjs` | 有头浏览器扫码登录，session 存 `data/boss-session.local.json` | ✅ 已建 |
| `Workbench/scripts/job-boss-fetch.mjs` | 复用 session 抓 4 城 × 5 词，随机延时 + 风控检测 + session 续期 | ✅ 已建 |
| `Workbench/config/job-profile.local.example.json` | 求职画像模板（简历摘要 + Q4 硬条件，合成示例） | ✅ 已建 |
| `Workbench/server/job-store.mjs` | 岗位库 JSON 原子读写、去重、状态机流转、逾期提醒计算 | ✅ 已建 |
| `Workbench/server/job-match.mjs` | 硬过滤 + LLM 打分（复用 learning-ai 配置）、推荐理由 | ✅ 已建 |
| `Workbench/scripts/job-digest.mjs` | 每日 pipeline：抓取 → 入库去重 → 过滤 → 打分 → Vault 日报 | ✅ 已建 |
| `Workbench/src/pages/JobTrackerPage.jsx` | 三区页面：提醒条 / 今日推荐 / 全部岗位（状态分组 + 操作） | ✅ 已建 |
| `Workbench/src/styles/job-tracker.css` | 页面样式 | ✅ 已建 |
| `Workbench/tests/job-store.test.mjs` | store 去重/状态机/提醒测试 | ✅ 已建 |
| `Workbench/tests/job-match.test.mjs` | 硬过滤规则测试（mock LLM） | ✅ 已建 |

**修改：**

| 文件 | 改动 | 状态 |
|---|---|---|
| `.gitignore` | `Workbench/data/*.local.json`（BOSS session、岗位库） | ✅ 已加 |
| `Workbench/package.json` | `job:login` / `job:fetch` / `job:digest` 脚本；devDependency playwright | ✅ playwright 已装 |
| `Workbench/server/vite-plugin-workbench.mjs` | 注册 `/api/job-tracker/*` 端点（列表/状态更新/投递日期/手动投喂） | ✅ 已改 |
| `Workbench/src/App.jsx` | 注册 `/jobs` 路由 | ✅ 已改 |
| `Workbench/src/components/AppShell.jsx` | 导航加「求职跟踪」 | ✅ 已改 |
| `Workbench/src/styles.css` | `@import "./styles/job-tracker.css";` | ✅ 已改 |

**环境：** Playwright + Chromium 已通过 npmmirror 镜像安装（`PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright`）。

---

### 任务 1：BOSS 爬虫链路 ✅ 代码完成 / ⬜ 实测待用户扫码

- [x] `job-boss-login.mjs`（扫码登录存 session）
- [x] `job-boss-fetch.mjs`（矩阵抓取、风控检测、去重字段标准化）
- [ ] 用户运行 `node scripts/job-boss-login.mjs` 完成扫码登录
- [ ] 真实抓取验证字段解析（`.job-card-wrapper` 等选择器）
- [ ] 可选增强：触底滚动翻页、反检测补丁（借鉴 boss-zhipin-skill）

> **2026-09-08 路线变更：爬虫方案已放弃，切换为 Agent + WebSearch 采集。**
> 实测结论：BOSS 对自动化浏览器的账号级风控无法稳定绕过——每次新会话（无论 headless
> 还是 headful、是否同一 profile）都可能触发安全验证，验证通过也不跨会话保留；
> 且新版搜索页 DOM 与旧选择器不兼容。爬虫脚本保留在仓库中备用。
> 替代方案：`job-digest.mjs` 新增 `--input <file>` 入口，由 Codex 定时任务
> 「求职日报 · WebSearch 采集」（每日 8:30）通过 web 搜索采集公开岗位，
> 写入 `data/job-inbox.local.json` 后驱动原有过滤/打分/日报 pipeline。
> 已知取舍：BOSS 内容对搜索引擎是登录墙，采集以公司官网、猎聘、智联等公开源为主，
> 覆盖面与时效性低于登录态爬虫。

### 任务 2：求职画像配置

- [x] `config/job-profile.local.example.json`：合成示例（城市/薪资/行业/经验/排除项/简历摘要）
- [ ] 用户复制为 `job-profile.local.json` 填入真实画像（已被 `*.local.json` 规则 ignore）

### 任务 3：job-store.mjs

- [x] 原子读写作业库（参照 learning-store 的 writeAtomic 模式）
- [x] upsert 去重（URL 主键 → 哈希兜底）
- [x] 状态机流转 + 投递日期 + `pendingFollowups()`（投递 ≥3 天无状态变化）
- [x] 测试 `tests/job-store.test.mjs`

### 任务 4：job-match.mjs

- [x] 硬过滤纯函数：城市白名单、薪资下限解析（`15-25K·14薪` 取下限）、经验年限区间、外包关键词排除、公司规模（companyTags 解析）
- [x] LLM 打分：复用 learning-ai 配置，prompt 注入画像 + JD，输出 `{score, reasons[]}`，JSON 校验
- [x] 测试 `tests/job-match.test.mjs`（纯过滤函数 + mock fetch）

### 任务 5：job-digest.mjs 每日 pipeline

- [x] 调用 fetch（子进程）→ 入库去重 → 硬过滤 → LLM 打分（≥7，上限 20）
- [x] 生成 Vault 日报 `个人知识库/70_career/daily/YYYY-MM-DD.md`（表格：公司/职位/城市/薪资/分数/理由/链接）
- [x] `package.json` 加 `job:digest`；Windows 计划任务文档说明（见 job-digest.mjs 头部 schtasks 示例）

### 任务 6：server API（vite-plugin-workbench.mjs）

- [x] `GET /api/job-tracker/jobs`（按状态分组 + 今日推荐 + 逾期提醒）
- [x] `POST /api/job-tracker/jobs/:id/status`（状态流转 + 可选投递日期）
- [x] `POST /api/job-tracker/jobs/import`（手动投喂 JD 文本，LLM 清洗入库——兜底通道）

### 任务 7：JobTrackerPage.jsx

- [x] 三区布局 + 状态操作 + 筛选 + 手动投喂框
- [x] 路由 `/jobs` + 导航项 + 样式 import

### 任务 8：release gate

- [x] `npm test` / `npm run build` / `npm run privacy:scan`（193 测试通过 190，3 个失败为既有 symlink 测试在 Windows 无权限的环境问题，与本模块无关；privacy:scan 通过）
- [x] 确认无个人数据入库（画像/session/岗位库全部 ignored）
