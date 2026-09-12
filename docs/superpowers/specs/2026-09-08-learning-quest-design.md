# 学习闯关模块设计规格

- 日期：2026-09-08
- 状态：设计已通过用户两轮决策确认，待规格审查
- 范围：在 Personal AI Workbench 中新增「学习闯关」模块（MVP）

## 0. 决策记录（已与用户确认）

| # | 决策点 | 结论 |
|---|---|---|
| Q1 | 改造方式 | 在现有 Workbench 架构上新增模块，不重写；复用 Vault、索引、React 前端、d3 星图 |
| Q2 | 数据存储 | Markdown + frontmatter，落在 Vault 新目录 `60_learning/` |
| Q3 | 关卡结构 | 知识点依赖图（DAG），前置列表表达依赖，线性是其特例 |
| Q4 | AI 验证形式 | 混合式：实践挑战 + 产物提交 + rubric 打分为主，条件触发的费曼追问为辅 |
| Q5 | AI 接入 | OpenAI 兼容 API，server 端代理，key 放本地 `Workbench/.env`，loopback-only |
| Q6 | 内容来源 | 手工创建项目骨架 + AI 按挂接资料拆解补全；AI 产物一律草稿，人工确认后上架 |
| Q7 | 游戏化深度 | MVP 只做关卡四态 + 掌握度 + 项目进度条；积分/成就后置 |
| Q8 | 通关判定 | 默认阈值 80（关卡可覆盖）；模糊带（阈值±10）或疑似搬运触发 1-2 个费曼追问；无限重试 + 变体题防背答案；验证历史完整可追溯 |
| Q9 | 代码评判 | 纯 AI 文本评判（贴代码 + 粘贴运行输出），不做本地沙箱执行 |
| Q10 | UI 形态 | 星图 Tab 用于「闯」+ 列表 Tab 用于「管」，双视图共享数据 |
| Q11 | 文件粒度 | 一关一个 Markdown；验证历史独立存 attempts；index.md 存项目元信息与进度缓存 |
| Q12 | 出题时机 | 拆解时批量生成挑战草稿；变体题在重试时按需生成 |
| §6 | 降级与自评 | AI 不可用时模块只读可用；允许手工自评，状态记 `self-assessed`，与 `ai-verified` 明确区分 |

## 1. 背景与目标

把 Workbench 扩展为个人学习工作台。核心模型：**学习项目 = 一张闯关地图**，知识点是关卡，前置依赖是路径，掌握度是通关状态。通关条件不是「看过了」，而是完成 AI 生成的实践挑战、提交产物并由 AI 按 rubric 验证。核心循环：**学（挂接资料）→ 练（实践挑战）→ 证（AI 验证）**。

成功标准：

- 用户能创建学习项目、挂接 Vault 资料、用 AI 拆解出关卡 DAG 并确认上架
- 用户能在星图上按依赖解锁闯关，提交产物获得 AI 评分与反馈
- 全部状态与验证历史以 Markdown 落盘，Obsidian 可直接查看编辑，Agent 可直接读写
- AI 未配置时模块降级为只读 + 手工管理，不阻塞既有功能

## 2. 架构总览

```
个人知识库/60_learning/             唯一事实来源（Markdown）
  └─ <project-slug>/
       ├─ index.md                  项目元信息 + 关卡清单 + 进度缓存
       ├─ levels/<level-slug>.md    关卡：frontmatter 状态机 + 挑战 + rubric
       └─ attempts/<level-slug>/<yyyymmdd-HHMMSS>.md
                                    每次验证：提交物 + 评分 + 追问记录

Workbench/server/
  ├─ learning.mjs                   Vault 读写、项目索引、解锁计算、状态回写、REST 端点
  └─ learning-ai.mjs                OpenAI 兼容 API 代理：decompose / challenge / grade / variant

Workbench/src/pages/
  ├─ LearningPage.jsx               学习项目列表 + 新建项目向导
  └─ LearningProjectPage.jsx        星图 Tab（闯）/ 列表 Tab（管）+ 关卡详情抽屉
```

- server 通过现有 `vite-plugin-workbench.mjs` 挂载，保持 loopback-only。
- AI 配置：`LEARNING_AI_BASE_URL` / `LEARNING_AI_API_KEY` / `LEARNING_AI_MODEL`，放 `Workbench/.env`（.gitignore 已覆盖，参照 `config/attention.local.json` 的本地覆盖模式）。
- 前端星图复用 GraphPage 的 d3 力导向图基建（`src/graph/`）。

## 3. Vault 数据 Schema

### 3.1 项目 `index.md`

```yaml
---
type: learning-project
title: 学习 React 状态管理
slug: react-state-management
description: 从 useState 到 Zustand 的实践闯关
created: 2026-09-08T20:00:00+08:00
sources: []                 # 挂接的 Vault 资料相对路径（只读引用）
levels: [react-rerender, context-basics, zustand-store]   # 关卡清单（slug 列表）
progress:                   # server 重算后回写的缓存，Obsidian 可见
  total: 3
  mastered: 0
  percent: 0
---
```

正文为项目简介与学习目标，人工编写或 AI 草稿确认后写入。

### 3.2 关卡 `levels/<level-slug>.md`

```yaml
---
type: learning-level
project: react-state-management
title: 理解 React 重渲染机制
status: locked              # locked | available | challenged | mastered
mastery: 0                  # 历史最高 AI 评分 0-100
verified_by: none           # none | ai-verified | self-assessed
pass_score: 80              # 可选；缺省用全局默认 80
depends_on: []              # 前置关卡 slug 列表，空 = 入口关
updated: 2026-09-08T20:00:00+08:00
---
```

正文结构（二级标题约定，server 按标题锚点解析）：

- `## 知识点笔记`：学什么，AI 草稿确认后写入，可随时人工补充
- `## 挑战`：实践任务描述（Markdown，可含代码块要求）
- `## 评分细则`：rubric 列表，3-5 条，格式 `- [10分] 判定标准描述`，总分 100

### 3.3 验证记录 `attempts/<level-slug>/<yyyymmdd-HHMMSS>.md`

```yaml
---
type: learning-attempt
project: react-state-management
level: react-rerender
score: 85
verdict: passed             # passed | failed | self-assessed
variant_of: null            # 变体题时指向原关卡 slug
probe: true                 # 本次是否发生了追问
created: 2026-09-08T21:00:00+08:00
---
```

正文依次记录：提交物全文（含引用的 Vault 文件内容快照）、rubric 逐条得分与评语、总反馈、追问问答链（如有）。

### 3.4 约束

- slug：`[a-z0-9-]+`，项目内唯一；server 创建时校验。
- `depends_on` 必须指向同项目已有关卡，写入前做 DAG 环检测，发现环拒绝写入并返回具体环路。
- 所有写入走「临时文件 + rename」保证原子性。

## 4. Server API 契约

### 4.1 数据端点（`learning.mjs`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/learning/projects` | 项目列表（含 progress 缓存） |
| GET | `/api/learning/projects/:slug` | 项目详情：关卡 DAG、状态、解锁计算结果 |
| POST | `/api/learning/projects` | 创建项目（title/description/sources），写 index.md |
| PUT | `/api/learning/projects/:slug/levels/:level` | 更新关卡（笔记/挑战/rubric/depends_on），环检测 |
| POST | `/api/learning/projects/:slug/levels:publish` | 批量写入 AI 拆解确认后的关卡草稿 |
| POST | `/api/learning/projects/:slug/levels/:level/submit` | 提交产物 `{ content_md, vault_refs[] }` → 调 grade → 写 attempt → 回写关卡状态 |
| POST | `/api/learning/projects/:slug/levels/:level/probe` | 提交追问回答 `{ answers[] }` → grade 追问模式 → 最终判定 |
| POST | `/api/learning/projects/:slug/levels/:level/retry` | 请求变体题（调 variant），更新关卡正文挑战 |
| POST | `/api/learning/projects/:slug/levels/:level/self-assess` | 手工自评 `{ score? }`（0-100，缺省 100），verdict=self-assessed，写 attempt |
| GET | `/api/learning/projects/:slug/levels/:level/attempts` | 验证历史列表 |

### 4.2 AI 代理端点（`learning-ai.mjs`）

全部要求模型 JSON 输出，server 做 schema 校验，解析失败自动重试一次后报错。

| 方法 | 路径 | 输入 | 输出 JSON |
|---|---|---|---|
| POST | `/api/learning/ai/decompose` | 项目描述 + sources 文本（截断保护，单文件 ≤8000 字） | `{ levels: [{ slug, title, summary, depends_on, rubric_hints[] }] }` |
| POST | `/api/learning/ai/challenge` | 全部已确认关卡草稿 | `{ challenges: [{ slug, challenge_md, rubric: [{ item, points }] }] }`，rubric 总分必须 100 |
| POST | `/api/learning/ai/grade` | 挑战 + rubric + 提交物；或追问模式（问答上下文 + 原评分） | `{ scores: [{ item, earned, comment }], total, feedback, needs_probe, probes: [question] }` |
| POST | `/api/learning/ai/variant` | 原挑战 + 历史提交摘要 | `{ challenge_md }`（同 rubric 换情境） |

## 5. 闯关状态机与判定流程

```
locked ──(depends_on 全部 mastered)──▶ available ──(开始挑战/首次提交)──▶ challenged
                                                                        │ submit
       mastered ◀──(追问通过)── 判定 ◀──────────────────────────────────┘
           ▲                      │
           │        ┌─────────────┼──────────────────┐
           │   total ≥ 阈值+10   模糊带(阈值±10)    total < 阈值-10
           │   直接 mastered     或疑似搬运           mastery 更新为最高分
           │                     触发 1-2 个追问      AI 给补练建议
           │                     追问通过→mastered    retry 生成变体题
           │                     答不动→按实际分
           └──── self-assess → mastered（verified_by=self-assessed）
```

规则细节：

- 解锁、阈值、模糊带判定全部由 server 计算；前端不持有判定逻辑。
- `mastery` 取全部 attempt 的最高分（含 self-assess 的记录分，但 verified_by 保留各自来源；一旦 ai-verified 通关则不再被自评覆盖标记）。
- 模糊带默认 ±10（如阈值 80 则 70-89 触发追问）；`needs_probe` 以 AI 返回为准，server 再用模糊带兜底——AI 说不用追问但分数在模糊带内，仍触发。
- 项目 progress.percent = mastered 关卡数 / total，写回 index.md。

## 6. 前端视图

- **LearningPage**：项目卡片（名称、进度条、mastered/total、最近活动时间）+「新建项目」向导四步：名称与描述 → 挂接 Vault 资料（路径选择）→ AI 拆解 → 草稿确认（可增删改关卡与依赖，确认后 publish）。
- **LearningProjectPage 星图 Tab**：DAG 力导向图。locked 灰色、available 发光脉冲、challenged 高亮、mastered 点亮并显示 mastery 标签；self-assessed 通关用不同描边区分。点击节点打开关卡详情抽屉。
- **列表 Tab**：按依赖层级分组的关卡表格，承载全部管理操作（编辑、确认草稿、查看 attempts）。
- **关卡详情抽屉**：知识点笔记、挑战、rubric、Markdown 提交编辑器（代码块 + vault_refs 路径引用，server 读取文件内容注入评分上下文）、attempt 时间线、追问对话区。

## 7. AI 配置、降级与手工自评

- 未配置 `LEARNING_AI_API_KEY` 或调用失败时：浏览、编辑、attempt 查看全部可用；拆解/出题/评分/变体按钮替换为配置引导说明。
- 手工自评（self-assess）随时可用，验证记录与通关标记永久区分 `self-assessed` / `ai-verified`，UI 明确标注。
- AI 调用超时默认 60s，429/5xx 重试一次；所有失败写清楚错误原因到前端提示，不写 attempt 文件（判定未发生不落盘）。

## 8. 错误处理

- Vault 写入失败（权限/磁盘）：返回 500 + 具体路径，前端提示重试，不产生半写状态（临时文件 + rename）。
- AI 返回非法 JSON：自动重试一次，仍失败返回 502 + 原始输出摘要。
- DAG 环检测失败：PUT/publish 返回 422 + 环路节点列表。
- 提交空产物或 vault_refs 指向不存在文件：422 + 具体原因。

## 9. 测试策略

沿用 `Workbench/tests/*.test.mjs`（node:test）模式，新增：

- `learning-schema.test.mjs`：三类 frontmatter 解析、slug 校验、rubric 总分 100 校验、DAG 环检测
- `learning-unlock.test.mjs`：解锁计算、模糊带判定、mastery 取最高分、ai-verified 标记不被自评覆盖
- `learning-ai.test.mjs`：mock fetch，验证四个端点 prompt 组装、JSON 校验、失败重试一次
- synthetic demo 数据须通过现有 authenticity 测试约束与 `npm run privacy:scan`

发布门禁：`npm test` + `npm run build` + `npm run privacy:scan` 全绿。

## 10. 公开仓库边界合规

- 仓库内 `60_learning/` 只放 synthetic demo：一个虚构学习项目（如「学习 React 状态管理」，3-4 个关卡），文件头明确标注合成演示；标题、日期、内容全部从零虚构。
- 真实学习数据通过 `PERSONAL_DASHBOARD_VAULT_ROOT` 指向的私人 Vault，不进仓库。
- 导航新增「学习」入口属于公开功能，但只展示 demo 数据；缺失数据保持缺失。

## 11. 非目标（MVP 不做）

- 积分、等级、streak、成就系统
- 本地代码沙箱执行判题
- 多人协作、分享、导入导出
- 移动端适配
- AI 自动生成/改写挂接资料（sources 只读）
- 挑战计时器、排行榜
