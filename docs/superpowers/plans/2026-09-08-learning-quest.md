# 学习闯关模块实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在 Personal AI Workbench 中新增「学习闯关」模块：Markdown Vault 存储学习项目/知识点关卡/验证记录，AI 拆解出题并按 rubric 验证通关，星图 + 列表双视图前端。

**架构：** 唯一事实来源是 Vault 的 `60_learning/` Markdown 目录；server 新增三个模块（纯函数 schema/状态机、Vault 读写 store、OpenAI 兼容 AI 代理），路由注册进现有 `vite-plugin-workbench.mjs` middleware；前端新增两个页面 + 一个 d3-force 闯关地图组件。

**技术栈：** Node 24（`node:test`、`process.loadEnvFile`）、React 19、react-router-dom 7、d3-force、Vite。

**规格：** `docs/superpowers/specs/2026-09-08-learning-quest-design.md`（决策表 Q1-Q12 与 §6 已全部确认）

---

## 文件结构

**新建：**

| 文件 | 职责 |
|---|---|
| `Workbench/server/learning.mjs` | 纯函数：frontmatter 解析/序列化、三类文档解析校验、DAG 环检测、解锁/进度计算、payload 构建 |
| `Workbench/server/learning-store.mjs` | Vault 读写：原子写、创建项目/关卡、submit/probe/retry/self-assess 编排、状态回写 |
| `Workbench/server/learning-ai.mjs` | `.env` 加载、OpenAI 兼容客户端（fetch + 60s 超时 + 重试一次）、5 个 prompt 构建器、JSON 校验 |
| `Workbench/tests/learning-schema.test.mjs` | 解析/序列化/校验/rubric 测试 |
| `Workbench/tests/learning-unlock.test.mjs` | 环检测/解锁/模糊带/mastery/payload 测试 |
| `Workbench/tests/learning-ai.test.mjs` | mock fetch 的客户端与 prompt/parse 测试 |
| `Workbench/src/pages/LearningPage.jsx` | 项目列表 + 新建项目向导（含 AI 拆解确认） |
| `Workbench/src/pages/LearningProjectPage.jsx` | 星图/列表双 Tab + 关卡详情抽屉（提交/追问/重试/自评） |
| `Workbench/src/components/learning/QuestMap.jsx` | d3-force DAG 闯关地图 |
| `Workbench/src/styles/learning.css` | 学习模块样式 |
| `个人知识库/60_learning/react-state-management/` | synthetic demo（index.md + 3 关卡 + 1 attempt，全部标注合成演示） |
| `Workbench/.env.example` | AI 配置占位（不含真实 key，避免触发 privacy-scan） |

**修改：**

| 文件 | 改动 |
|---|---|
| `Workbench/server/vite-plugin-workbench.mjs` | import 三个 learning 模块；注册 14 个 `/api/learning/*` 端点 |
| `Workbench/src/App.jsx` | 注册 `/learning` 与 `/learning/:projectSlug` 两条路由 |
| `Workbench/src/components/AppShell.jsx` | 导航数组加「学习闯关」项 |
| `Workbench/src/styles.css` | `@import "./styles/learning.css";` |
| `Workbench/package.json` | 加 `test:learning` 脚本 |

**命令约定：** 测试用 `node --test tests/<file>`（在 `Workbench/` 目录下执行）；commit message 用英文 conventional commits（跟随仓库历史）。

---

### 任务 1：learning.mjs — frontmatter 解析/序列化与三类文档解析

**文件：**
- 创建：`Workbench/server/learning.mjs`
- 测试：`Workbench/tests/learning-schema.test.mjs`

- [x] **步骤 1：编写失败的测试**

```js
import assert from "node:assert/strict";
import test from "node:test";

import {
  LEARNING_LEVEL_STATUS,
  parseLearningDocument,
  parseRubric,
  serializeFrontmatter,
} from "../server/learning.mjs";

test("serializeFrontmatter round-trips scalars and string arrays", () => {
  const frontmatter = {
    type: "learning-level",
    project: "react-state-management",
    title: "理解 React 重渲染机制",
    status: "locked",
    mastery: 0,
    depends_on: ["react-rerender", "context-basics"],
  };
  const text = serializeFrontmatter(frontmatter);
  const parsed = parseLearningDocument(`---\n${text}---\n\n正文\n`, "levels/x.md");
  assert.equal(parsed.frontmatter.title, "理解 React 重渲染机制");
  assert.deepEqual(parsed.frontmatter.depends_on, ["react-rerender", "context-basics"]);
  assert.equal(parsed.body, "正文\n");
});

test("parseLearningDocument validates level required fields and status enum", () => {
  const valid = `---
type: learning-level
project: demo
title: 关卡
status: available
mastery: 0
verified_by: none
depends_on: []
---

## 知识点笔记
内容
`;
  const parsed = parseLearningDocument(valid, "levels/a.md");
  assert.equal(parsed.frontmatter.status, "available");

  assert.throws(
    () => parseLearningDocument(valid.replace("status: available", "status: flying"), "levels/a.md"),
    /status/,
  );
  assert.throws(
    () => parseLearningDocument(valid.replace("title: 关卡\n", ""), "levels/a.md"),
    /title/,
  );
});

test("parseLearningDocument enforces slug-safe project and type enum", () => {
  const base = `---
type: learning-project
title: 项目
slug: react-state-management
description: 描述
created: 2026-09-08T20:00:00+08:00
sources: []
levels: []
---
`;
  assert.equal(parseLearningDocument(base, "index.md").frontmatter.slug, "react-state-management");
  assert.throws(
    () => parseLearningDocument(base.replace("react-state-management", "Bad Slug!"), "index.md"),
    /slug/,
  );
  assert.throws(
    () => parseLearningDocument(base.replace("learning-project", "learning-xyz"), "index.md"),
    /type/,
  );
});

test("parseRubric extracts scored items and rejects non-100 totals", () => {
  const rubric = parseRubric(`## 挑战
做一件事

## 评分细则
- [30分] 能说明触发重渲染的条件
- [30分] 代码演示了 memo 的阻断效果
- [40分] 解释了状态批量更新
`);
  assert.deepEqual(rubric, [
    { item: "能说明触发重渲染的条件", points: 30 },
    { item: "代码演示了 memo 的阻断效果", points: 30 },
    { item: "解释了状态批量更新", points: 40 },
  ]);
  assert.throws(
    () => parseRubric("## 评分细则\n- [30分] 只有一条且总分不对\n"),
    /100/,
  );
});

test("level status enum is exactly the four states", () => {
  assert.deepEqual(LEARNING_LEVEL_STATUS, ["locked", "available", "challenged", "mastered"]);
});
```

- [x] **步骤 2：运行测试验证失败**

运行：`node --test tests/learning-schema.test.mjs`
预期：FAIL，报错 `Cannot find module '../server/learning.mjs'`

- [x] **步骤 3：编写实现代码**

创建 `Workbench/server/learning.mjs`：

```js
export const LEARNING_ROOT = "60_learning";
export const LEARNING_LEVEL_STATUS = ["locked", "available", "challenged", "mastered"];
export const LEARNING_VERIFIED_BY = ["none", "ai-verified", "self-assessed"];
export const DEFAULT_PASS_SCORE = 80;
export const PROBE_BAND = 10;

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DOCUMENT_TYPES = ["learning-project", "learning-level", "learning-attempt"];

export function assertSlug(value, field = "slug") {
  if (typeof value !== "string" || !SLUG_PATTERN.test(value)) {
    throw new TypeError(`${field} 必须是小写字母/数字/连字符组成的 slug，收到: ${value}`);
  }
  return value;
}

// ---- 简单 YAML 子集：string / number / boolean / null / string[] ----

function parseScalar(raw) {
  const value = raw.trim();
  if (value === "[]") return [];
  if (value === "null" || value === "") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((item) => {
      const scalar = parseScalar(item);
      if (scalar === null) throw new TypeError(`数组元素不能为空: ${value}`);
      return String(scalar);
    });
  }
  return value.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
}

export function parseFrontmatter(text) {
  const frontmatter = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || /^\s/.test(line)) continue;
    const match = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!match) throw new TypeError(`frontmatter 行无法解析: ${line}`);
    frontmatter[match[1]] = parseScalar(match[2]);
  }
  return frontmatter;
}

function serializeScalar(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return String(value);
}

export function serializeFrontmatter(frontmatter) {
  let text = "";
  for (const [key, value] of Object.entries(frontmatter)) {
    if (Array.isArray(value)) {
      text += `${key}: [${value.map(serializeScalar).join(", ")}]\n`;
    } else if (value && typeof value === "object") {
      text += `${key}: ${JSON.stringify(value)}\n`;
    } else {
      text += `${key}: ${serializeScalar(value)}\n`;
    }
  }
  return text;
}

// ---- 文档解析 ----

function requireFields(frontmatter, fields, fileLabel) {
  for (const field of fields) {
    if (frontmatter[field] === undefined || frontmatter[field] === null) {
      throw new TypeError(`${fileLabel} 缺少必填 frontmatter 字段: ${field}`);
    }
  }
}

function validateLevel(frontmatter, fileLabel) {
  requireFields(frontmatter, ["type", "project", "title", "status", "mastery", "depends_on"], fileLabel);
  if (!LEARNING_LEVEL_STATUS.includes(frontmatter.status)) {
    throw new TypeError(`${fileLabel} status 非法: ${frontmatter.status}`);
  }
  if (frontmatter.verified_by !== undefined && !LEARNING_VERIFIED_BY.includes(frontmatter.verified_by)) {
    throw new TypeError(`${fileLabel} verified_by 非法: ${frontmatter.verified_by}`);
  }
  if (!Array.isArray(frontmatter.depends_on)) {
    throw new TypeError(`${fileLabel} depends_on 必须是数组`);
  }
  assertSlug(frontmatter.project, "project");
  if (frontmatter.pass_score !== undefined && frontmatter.pass_score !== null) {
    const score = Number(frontmatter.pass_score);
    if (!Number.isFinite(score) || score < 0 || score > 100) {
      throw new TypeError(`${fileLabel} pass_score 必须在 0-100 之间`);
    }
  }
}

function validateProject(frontmatter, fileLabel) {
  requireFields(frontmatter, ["type", "title", "slug", "description", "created"], fileLabel);
  assertSlug(frontmatter.slug);
  if (!Array.isArray(frontmatter.sources ?? [])) {
    throw new TypeError(`${fileLabel} sources 必须是数组`);
  }
  if (!Array.isArray(frontmatter.levels ?? [])) {
    throw new TypeError(`${fileLabel} levels 必须是数组`);
  }
}

function validateAttempt(frontmatter, fileLabel) {
  requireFields(frontmatter, ["type", "project", "level", "score", "verdict", "created"], fileLabel);
  if (!["passed", "failed", "pending_probe", "self-assessed"].includes(frontmatter.verdict)) {
    throw new TypeError(`${fileLabel} verdict 非法: ${frontmatter.verdict}`);
  }
}

export function parseLearningDocument(text, fileLabel = "learning document") {
  const match = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) throw new TypeError(`${fileLabel} 缺少 frontmatter 块`);
  const frontmatter = parseFrontmatter(match[1]);
  if (!DOCUMENT_TYPES.includes(frontmatter.type)) {
    throw new TypeError(`${fileLabel} type 非法: ${frontmatter.type}`);
  }
  if (frontmatter.type === "learning-level") validateLevel(frontmatter, fileLabel);
  if (frontmatter.type === "learning-project") validateProject(frontmatter, fileLabel);
  if (frontmatter.type === "learning-attempt") validateAttempt(frontmatter, fileLabel);
  return { frontmatter, body: match[2].replace(/^\r?\n/, "") };
}

// ---- 正文段落与 rubric ----

export function splitSections(body) {
  const sections = new Map();
  let current = null;
  for (const line of String(body).split(/\r?\n/)) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      current = heading[1];
      sections.set(current, []);
    } else if (current) {
      sections.get(current).push(line);
    }
  }
  return new Map([...sections].map(([key, lines]) => [key, lines.join("\n").trim()]));
}

export function parseRubric(body) {
  const section = splitSections(body).get("评分细则");
  if (!section) throw new TypeError("关卡正文缺少 ## 评分细则 段落");
  const rubric = [];
  for (const line of section.split(/\r?\n/)) {
    const match = line.match(/^-\s*\[(\d+)分\]\s*(.+)$/);
    if (match) rubric.push({ item: match[2].trim(), points: Number(match[1]) });
  }
  if (rubric.length === 0) throw new TypeError("评分细则为空");
  const total = rubric.reduce((sum, entry) => sum + entry.points, 0);
  if (total !== 100) throw new TypeError(`评分细则总分必须为 100，当前为 ${total}`);
  return rubric;
}

export function replaceSection(body, heading, content) {
  const lines = String(body).split(/\r?\n/);
  const output = [];
  let inTarget = false;
  let replaced = false;
  for (const line of lines) {
    const match = line.match(/^##\s+(.+?)\s*$/);
    if (match) {
      if (inTarget) {
        output.push(content, "");
        inTarget = false;
        replaced = true;
      }
      if (match[1] === heading) {
        inTarget = true;
        output.push(line);
        continue;
      }
    }
    if (!inTarget) output.push(line);
  }
  if (inTarget) {
    output.push(content, "");
    replaced = true;
  }
  if (!replaced) output.push("", `## ${heading}`, content, "");
  return output.join("\n").replace(/\n{3,}/g, "\n\n");
}
```

- [x] **步骤 4：运行测试验证通过**

运行：`node --test tests/learning-schema.test.mjs`
预期：PASS(5 个用例）

- [x] **步骤 5：Commit**

```bash
git add Workbench/server/learning.mjs Workbench/tests/learning-schema.test.mjs
git commit -m "feat(learning): add learning document schema parsing"
```

---

### 任务 2:learning.mjs — DAG 校验、解锁计算与 payload

**文件：**
- 修改:`Workbench/server/learning.mjs`
- 测试：`Workbench/tests/learning-unlock.test.mjs`

- [x] **步骤 1：编写失败的测试**

```js
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildLevelStates,
  computeProgress,
  projectDetailPayload,
  projectsPayload,
  validateDag,
} from "../server/learning.mjs";

function level(slug, overrides = {}) {
  return {
    slug,
    frontmatter: {
      type: "learning-level",
      project: "demo",
      title: slug,
      status: "locked",
      mastery: 0,
      verified_by: "none",
      depends_on: [],
      ...overrides,
    },
    body: "",
  };
}

test("validateDag reports unknown dependencies and cycles", () => {
  const unknown = validateDag([level("a", { depends_on: ["ghost"] })]);
  assert.match(unknown.errors[0], /ghost/);

  const cycle = validateDag([
    level("a", { depends_on: ["b"] }),
    level("b", { depends_on: ["a"] }),
  ]);
  assert.match(cycle.errors[0], /环/);
  assert.equal(validateDag([level("a"), level("b", { depends_on: ["a"] })]).errors.length, 0);
});

test("buildLevelStates unlocks levels whose dependencies are mastered", () => {
  const states = buildLevelStates([
    level("root"),
    level("mid", { depends_on: ["root"] }),
    level("leaf", { depends_on: ["mid"] }),
  ]);
  assert.equal(states.get("root").effectiveStatus, "available");
  assert.equal(states.get("mid").effectiveStatus, "locked");
  assert.equal(states.get("leaf").effectiveStatus, "locked");

  const advanced = buildLevelStates([
    level("root", { status: "mastered", mastery: 88, verified_by: "ai-verified" }),
    level("mid", { depends_on: ["root"], status: "challenged" }),
  ]);
  assert.equal(advanced.get("mid").effectiveStatus, "challenged");
});

test("computeProgress counts mastered levels", () => {
  const progress = computeProgress([
    level("a", { status: "mastered" }),
    level("b", { status: "mastered" }),
    level("c"),
    level("d"),
  ]);
  assert.deepEqual(progress, { total: 4, mastered: 2, percent: 50 });
  assert.deepEqual(computeProgress([]), { total: 0, mastered: 0, percent: 0 });
});

test("projectsPayload derives cards from vault index documents", () => {
  const index = {
    generatedAt: "2026-09-08T00:00:00.000Z",
    documents: [
      {
        path: "60_learning/demo/index.md",
        fileName: "index.md",
        title: "演示项目",
        frontmatter: {
          type: "learning-project",
          title: "演示项目",
          slug: "demo",
          description: "合成演示",
          created: "2026-09-01T00:00:00+08:00",
          sources: [],
          levels: ["a", "b"],
        },
      },
      {
        path: "60_learning/demo/levels/a.md",
        fileName: "a.md",
        title: "A",
        frontmatter: { type: "learning-level", project: "demo", title: "A", status: "mastered", mastery: 90, depends_on: [] },
      },
      {
        path: "60_learning/demo/levels/b.md",
        fileName: "b.md",
        title: "B",
        frontmatter: { type: "learning-level", project: "demo", title: "B", status: "locked", mastery: 0, depends_on: ["a"] },
      },
      { path: "wiki/concepts/other.md", fileName: "other.md", title: "别的", frontmatter: {} },
    ],
  };
  const payload = projectsPayload(index);
  assert.equal(payload.total, 1);
  assert.equal(payload.projects[0].slug, "demo");
  assert.deepEqual(payload.projects[0].progress, { total: 2, mastered: 1, percent: 50 });
});

test("projectDetailPayload assembles dag with effective status and pass score", () => {
  const project = {
    frontmatter: { type: "learning-project", title: "演示", slug: "demo", description: "", created: "2026-09-01T00:00:00+08:00", sources: [], levels: ["a", "b"] },
    body: "简介",
  };
  const detail = projectDetailPayload(project, [
    level("a", { status: "mastered", mastery: 92, verified_by: "ai-verified" }),
    level("b", { depends_on: ["a"], pass_score: 90 }),
  ], new Map([["a", 2]]));
  assert.equal(detail.levels.length, 2);
  assert.equal(detail.levels[0].effectiveStatus, "mastered");
  assert.equal(detail.levels[0].attemptCount, 2);
  assert.equal(detail.levels[1].effectiveStatus, "available");
  assert.equal(detail.levels[1].passScore, 90);
  assert.deepEqual(detail.progress, { total: 2, mastered: 1, percent: 50 });
});
```

- [x] **步骤 2：运行测试验证失败**

运行:`node --test tests/learning-unlock.test.mjs`
预期：FAIL，报错 `validateDag is not a function`

- [x] **步骤 3：编写实现代码**

在 `Workbench/server/learning.mjs` 末尾追加：

```js
// ---- DAG ----

export function validateDag(levels) {
  const errors = [];
  const known = new Set(levels.map((entry) => entry.slug));
  for (const entry of levels) {
    for (const dependency of entry.frontmatter.depends_on ?? []) {
      if (!known.has(dependency)) {
        errors.push(`关卡 ${entry.slug} 依赖了不存在的关卡: ${dependency}`);
      }
    }
  }
  // 环检测：三色 DFS
  const visiting = new Set();
  const done = new Set();
  const bySlug = new Map(levels.map((entry) => [entry.slug, entry]));
  const visit = (slug, trail) => {
    if (done.has(slug)) return;
    if (visiting.has(slug)) {
      errors.push(`依赖存在环: ${[...trail, slug].join(" -> ")}`);
      return;
    }
    visiting.add(slug);
    for (const dependency of bySlug.get(slug)?.frontmatter.depends_on ?? []) {
      if (known.has(dependency)) visit(dependency, [...trail, slug]);
    }
    visiting.delete(slug);
    done.add(slug);
  };
  for (const entry of levels) visit(entry.slug, []);
  return { errors };
}

// ---- 状态与进度 ----

export function buildLevelStates(levels) {
  const states = new Map();
  const bySlug = new Map(levels.map((entry) => [entry.slug, entry]));
  const resolve = (slug) => {
    if (states.has(slug)) return states.get(slug);
    const entry = bySlug.get(slug);
    const frontmatter = entry.frontmatter;
    let effectiveStatus = frontmatter.status;
    if (effectiveStatus === "locked") {
      const unlocked = (frontmatter.depends_on ?? []).every(
        (dependency) => resolve(dependency).effectiveStatus === "mastered",
      );
      if (unlocked) effectiveStatus = "available";
    }
    const state = {
      slug,
      effectiveStatus,
      passScore: frontmatter.pass_score ?? DEFAULT_PASS_SCORE,
    };
    states.set(slug, state);
    return state;
  };
  for (const entry of levels) resolve(entry.slug);
  return states;
}

export function computeProgress(levels) {
  const total = levels.length;
  const mastered = levels.filter((entry) => entry.frontmatter.status === "mastered").length;
  return { total, mastered, percent: total === 0 ? 0 : Math.round((mastered / total) * 100) };
}

// ---- payload ----

function isLearningDocument(document) {
  return (
    document.path.startsWith(`${LEARNING_ROOT}/`) &&
    !document.path.split("/").some((segment) => segment.startsWith("."))
  );
}

export function projectsPayload(index) {
  const projects = new Map();
  const levelsByProject = new Map();
  for (const document of index?.documents ?? []) {
    if (!isLearningDocument(document)) continue;
    const frontmatter = document.frontmatter ?? {};
    if (frontmatter.type === "learning-project") {
      projects.set(frontmatter.slug, {
        slug: frontmatter.slug,
        title: frontmatter.title,
        description: frontmatter.description ?? "",
        created: frontmatter.created ?? null,
        path: document.path,
      });
    }
    if (frontmatter.type === "learning-level" && frontmatter.project) {
      if (!levelsByProject.has(frontmatter.project)) levelsByProject.set(frontmatter.project, []);
      levelsByProject.get(frontmatter.project).push({ slug: document.fileName?.replace(/\.md$/, ""), frontmatter });
    }
  }
  const list = [...projects.values()].map((project) => ({
    ...project,
    progress: computeProgress(levelsByProject.get(project.slug) ?? []),
  }));
  list.sort((left, right) => left.slug.localeCompare(right.slug, "en"));
  return { generatedAt: index?.generatedAt ?? null, total: list.length, projects: list };
}

export function projectDetailPayload(project, levels, attemptCounts = new Map()) {
  const states = buildLevelStates(levels);
  return {
    slug: project.frontmatter.slug,
    title: project.frontmatter.title,
    description: project.frontmatter.description ?? "",
    sources: project.frontmatter.sources ?? [],
    body: project.body,
    progress: computeProgress(levels),
    levels: levels.map((entry) => ({
      slug: entry.slug,
      title: entry.frontmatter.title,
      status: entry.frontmatter.status,
      effectiveStatus: states.get(entry.slug).effectiveStatus,
      passScore: states.get(entry.slug).passScore,
      mastery: entry.frontmatter.mastery ?? 0,
      verifiedBy: entry.frontmatter.verified_by ?? "none",
      dependsOn: entry.frontmatter.depends_on ?? [],
      attemptCount: attemptCounts.get(entry.slug) ?? 0,
    })),
  };
}
```

- [x] **步骤 4：运行测试验证通过**

运行：`node --test tests/learning-schema.test.mjs tests/learning-unlock.test.mjs`
预期：PASS(10 个用例）

- [x] **步骤 5：Commit**

```bash
git add Workbench/server/learning.mjs Workbench/tests/learning-unlock.test.mjs
git commit -m "feat(learning): add dag validation, unlock states and payloads"
```

---

### 任务 3:learning-store.mjs — Vault 读写与闯关编排

**文件：**
- 创建:`Workbench/server/learning-store.mjs`
- 测试：`Workbench/tests/learning-unlock.test.mjs`（追加 store 用例）

- [x] **步骤 1：编写失败的测试**

在 `Workbench/tests/learning-unlock.test.mjs` 末尾追加：

```js
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createLearningStore } from "../server/learning-store.mjs";

async function makeVault(t) {
  const vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), "learning-vault-"));
  t.after(() => fs.rm(vaultRoot, { recursive: true, force: true }));
  return vaultRoot;
}

test("store creates project, publishes levels and computes unlock on disk", async (t) => {
  const vaultRoot = await makeVault(t);
  const store = createLearningStore({ vaultRoot });
  const { slug } = await store.createProject({ title: "演示项目", description: "合成演示", sources: [], slug: "demo-project" });
  assert.equal(slug, "demo-project");
  // 不传 slug 且 title 无法推导合法 slug 时必须报错
  await assert.rejects(() => store.createProject({ title: "演示项目", description: "", sources: [] }), /slug/);

  await store.publishLevels(slug, [
    { slug: "root", title: "入口关", dependsOn: [], notes: "学这个", challenge: "做练习", rubric: [{ item: "完成练习", points: 100 }] },
    { slug: "next", title: "进阶关", dependsOn: ["root"], notes: "", challenge: "", rubric: [{ item: "待定", points: 100 }] },
  ]);
  const detail = await store.readProjectDetail(slug);
  assert.equal(detail.levels.length, 2);
  assert.equal(detail.levels[0].effectiveStatus, "available");
  assert.equal(detail.levels[1].effectiveStatus, "locked");

  await assert.rejects(
    () => store.publishLevels(slug, [{ slug: "loop", title: "环", dependsOn: ["loop"], notes: "", challenge: "", rubric: [{ item: "x", points: 100 }] }]),
    /环/,
  );
});

test("submitAttempt grades via ai client, writes attempt and masters level", async (t) => {
  const vaultRoot = await makeVault(t);
  const grades = [];
  const store = createLearningStore({
    vaultRoot,
    ai: {
      async grade(input) {
        grades.push(input);
        return { scores: [{ item: "完成练习", earned: 90, comment: "好" }], total: 90, feedback: "通过", needs_probe: false, probes: [] };
      },
    },
  });
  const { slug } = await store.createProject({ title: "demo", description: "", sources: [], slug: "demo" });
  await store.publishLevels(slug, [
    { slug: "root", title: "入口", dependsOn: [], notes: "", challenge: "写代码", rubric: [{ item: "完成练习", points: 100 }] },
  ]);

  const result = await store.submitAttempt(slug, "root", { contentMd: "我的作答", vaultRefs: [] });
  assert.equal(result.verdict, "passed");
  assert.equal(result.score, 90);
  assert.equal(result.needsProbe, false);

  const detail = await store.readProjectDetail(slug);
  assert.equal(detail.levels[0].status, "mastered");
  assert.equal(detail.levels[0].mastery, 90);
  assert.equal(detail.levels[0].verifiedBy, "ai-verified");
  assert.deepEqual(detail.progress, { total: 1, mastered: 1, percent: 100 });

  const attempts = await store.listAttempts(slug, "root");
  assert.equal(attempts.length, 1);
  assert.match(attempts[0].body, /我的作答/);
});

test("submitAttempt triggers probe inside the band and probe answer decides", async (t) => {
  const vaultRoot = await makeVault(t);
  const store = createLearningStore({
    vaultRoot,
    ai: {
      async grade() {
        return { scores: [], total: 75, feedback: "模糊", needs_probe: false, probes: [] };
      },
      async gradeProbe(input) {
        assert.equal(input.answers[0], "追问回答");
        return { total: 82, feedback: "追问后确认理解", passed: true };
      },
    },
  });
  await store.createProject({ title: "demo", description: "", sources: [], slug: "demo" });
  await store.publishLevels("demo", [
    { slug: "root", title: "入口", dependsOn: [], notes: "", challenge: "写代码", rubric: [{ item: "完成练习", points: 100 }] },
  ]);

  const pending = await store.submitAttempt("demo", "root", { contentMd: "作答", vaultRefs: [] });
  assert.equal(pending.needsProbe, true); // 75 落在 80±10 模糊带，server 兜底触发
  assert.equal(pending.probes.length, 1);

  const final = await store.answerProbe("demo", "root", pending.attemptId, { answers: ["追问回答"] });
  assert.equal(final.verdict, "passed");
  assert.equal(final.score, 82);
  const detail = await store.readProjectDetail("demo");
  assert.equal(detail.levels[0].status, "mastered");
});

test("selfAssess marks self-assessed and never overrides ai-verified", async (t) => {
  const vaultRoot = await makeVault(t);
  const store = createLearningStore({
    vaultRoot,
    ai: { async grade() { return { scores: [], total: 95, feedback: "好", needs_probe: false, probes: [] }; } },
  });
  await store.createProject({ title: "demo", description: "", sources: [], slug: "demo" });
  await store.publishLevels("demo", [
    { slug: "root", title: "入口", dependsOn: [], notes: "", challenge: "c", rubric: [{ item: "x", points: 100 }] },
  ]);
  await store.submitAttempt("demo", "root", { contentMd: "作答", vaultRefs: [] });
  await store.selfAssess("demo", "root", {});
  const detail = await store.readProjectDetail("demo");
  assert.equal(detail.levels[0].verifiedBy, "ai-verified"); // 不被自评覆盖
});
```

- [x] **步骤 2：运行测试验证失败**

运行：`node --test tests/learning-unlock.test.mjs`
预期：FAIL，报错 `Cannot find module '../server/learning-store.mjs'`

- [x] **步骤 3：编写实现代码**

创建 `Workbench/server/learning-store.mjs`：

```js
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  DEFAULT_PASS_SCORE,
  LEARNING_ROOT,
  PROBE_BAND,
  assertSlug,
  buildLevelStates,
  computeProgress,
  parseLearningDocument,
  parseRubric,
  projectDetailPayload,
  replaceSection,
  serializeFrontmatter,
  splitSections,
  validateDag,
} from "./learning.mjs";

function nowStamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `${stamp}-${Math.random().toString(36).slice(2, 6)}`; // 随机后缀避免同秒文件名冲突
}

function slugFromTitle(title) {
  return String(title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

async function writeAtomic(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}`;
  await fs.writeFile(temporary, content, "utf8");
  await fs.rename(temporary, filePath);
}

async function readDocument(filePath, label) {
  return parseLearningDocument(await fs.readFile(filePath, "utf8"), label);
}

function serializeLevelBody({ notes, challenge, rubric }) {
  return [
    "## 知识点笔记",
    notes || "（待补充）",
    "",
    "## 挑战",
    challenge || "（待 AI 生成）",
    "",
    "## 评分细则",
    rubric.map((entry) => `- [${entry.points}分] ${entry.item}`).join("\n"),
    "",
  ].join("\n");
}

export function createLearningStore({ vaultRoot, ai = null }) {
  const learningRoot = path.join(vaultRoot, LEARNING_ROOT);
  const projectRoot = (slug) => path.join(learningRoot, assertSlug(slug));
  const levelPath = (slug, levelSlug) => path.join(projectRoot(slug), "levels", `${assertSlug(levelSlug)}.md`);
  const attemptsDir = (slug, levelSlug) => path.join(projectRoot(slug), "attempts", assertSlug(levelSlug));
  const indexPath = (slug) => path.join(projectRoot(slug), "index.md");

  async function readProject(slug) {
    return readDocument(indexPath(slug), `${slug}/index.md`);
  }

  async function readLevel(slug, levelSlug) {
    return readDocument(levelPath(slug, levelSlug), `${slug}/levels/${levelSlug}.md`);
  }

  async function listLevelSlugs(slug) {
    try {
      const files = await fs.readdir(path.join(projectRoot(slug), "levels"));
      return files.filter((name) => name.endsWith(".md")).map((name) => name.replace(/\.md$/, "")).sort();
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
  }

  async function readLevels(slug) {
    const levels = [];
    for (const levelSlug of await listLevelSlugs(slug)) {
      levels.push({ slug: levelSlug, ...(await readLevel(slug, levelSlug)) });
    }
    return levels;
  }

  async function attemptCounts(slug) {
    const counts = new Map();
    for (const levelSlug of await listLevelSlugs(slug)) {
      try {
        const files = await fs.readdir(attemptsDir(slug, levelSlug));
        counts.set(levelSlug, files.filter((name) => name.endsWith(".md")).length);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    return counts;
  }

  async function writeLevel(slug, levelSlug, frontmatter, body) {
    await writeAtomic(levelPath(slug, levelSlug), `---\n${serializeFrontmatter(frontmatter)}---\n\n${body}`);
  }

  async function syncProgress(slug) {
    const project = await readProject(slug);
    const levels = await readLevels(slug);
    project.frontmatter.progress = computeProgress(levels);
    project.frontmatter.levels = levels.map((entry) => entry.slug);
    await writeAtomic(indexPath(slug), `---\n${serializeFrontmatter(project.frontmatter)}---\n\n${project.body}`);
  }

  function requireAi() {
    if (!ai) {
      const error = new Error("AI 未配置：请在 Workbench/.env 配置 LEARNING_AI_BASE_URL / LEARNING_AI_API_KEY / LEARNING_AI_MODEL。");
      error.code = "AI_NOT_CONFIGURED";
      throw error;
    }
    return ai;
  }

  return {
    async createProject({ title, description, sources = [], slug }) {
      let projectSlug = slug;
      if (!projectSlug) {
        projectSlug = slugFromTitle(title);
        if (!projectSlug) throw new TypeError("title 无法推导出合法 slug，请显式传入 slug 字段");
      }
      assertSlug(projectSlug);
      const frontmatter = {
        type: "learning-project",
        title,
        slug: projectSlug,
        description: description ?? "",
        created: new Date().toISOString(),
        sources,
        levels: [],
        progress: { total: 0, mastered: 0, percent: 0 },
      };
      await writeAtomic(indexPath(projectSlug), `---\n${serializeFrontmatter(frontmatter)}---\n\n# ${title}\n\n${description ?? ""}\n`);
      return { slug: projectSlug };
    },

    async readProjectDetail(slug) {
      const project = await readProject(slug);
      const levels = await readLevels(slug);
      return projectDetailPayload(project, levels, await attemptCounts(slug));
    },

    async readLevelDetail(slug, levelSlug) {
      const entry = await readLevel(slug, levelSlug);
      const sections = splitSections(entry.body);
      return {
        slug: levelSlug,
        frontmatter: entry.frontmatter,
        notes: sections.get("知识点笔记") ?? "",
        challenge: sections.get("挑战") ?? "",
        rubric: parseRubric(entry.body),
      };
    },

    async publishLevels(slug, levels) {
      const existing = await readLevels(slug);
      const staged = levels.map((input) => ({
        slug: assertSlug(input.slug),
        frontmatter: {
          type: "learning-level",
          project: slug,
          title: input.title,
          status: "locked",
          mastery: 0,
          verified_by: "none",
          depends_on: input.dependsOn ?? [],
          pass_score: input.passScore ?? null,
          updated: new Date().toISOString(),
        },
        body: serializeLevelBody(input),
      }));
      const { errors } = validateDag([...existing, ...staged]);
      if (errors.length) {
        const error = new Error(errors.join(";"));
        error.code = "DAG_INVALID";
        throw error;
      }
      for (const entry of staged) {
        await writeLevel(slug, entry.slug, entry.frontmatter, entry.body);
      }
      await syncProgress(slug);
      return { published: staged.map((entry) => entry.slug) };
    },

    async updateLevel(slug, levelSlug, patch) {
      const entry = await readLevel(slug, levelSlug);
      if (patch.notes !== undefined) entry.body = replaceSection(entry.body, "知识点笔记", patch.notes);
      if (patch.challenge !== undefined) entry.body = replaceSection(entry.body, "挑战", patch.challenge);
      if (patch.rubric !== undefined) {
        entry.body = replaceSection(entry.body, "评分细则",
          patch.rubric.map((item) => `- [${item.points}分] ${item.item}`).join("\n"));
      }
      if (patch.title !== undefined) entry.frontmatter.title = patch.title;
      if (patch.passScore !== undefined) entry.frontmatter.pass_score = patch.passScore;
      if (patch.dependsOn !== undefined) {
        const next = { slug: levelSlug, frontmatter: { ...entry.frontmatter, depends_on: patch.dependsOn }, body: entry.body };
        const others = (await readLevels(slug)).filter((item) => item.slug !== levelSlug);
        const { errors } = validateDag([...others, next]);
        if (errors.length) {
          const error = new Error(errors.join(";"));
          error.code = "DAG_INVALID";
          throw error;
        }
        entry.frontmatter.depends_on = patch.dependsOn;
      }
      entry.frontmatter.updated = new Date().toISOString();
      await writeLevel(slug, levelSlug, entry.frontmatter, entry.body);
      return { slug: levelSlug };
    },

    async listAttempts(slug, levelSlug) {
      try {
        const files = (await fs.readdir(attemptsDir(slug, levelSlug))).filter((name) => name.endsWith(".md")).sort();
        const attempts = [];
        for (const file of files) {
          attempts.push({ id: file.replace(/\.md$/, ""), ...(await readDocument(path.join(attemptsDir(slug, levelSlug), file), file)) });
        }
        return attempts;
      } catch (error) {
        if (error?.code === "ENOENT") return [];
        throw error;
      }
    },

    async submitAttempt(slug, levelSlug, { contentMd, vaultRefs = [] }) {
      const client = requireAi();
      if (!contentMd?.trim()) {
        const error = new Error("提交产物不能为空");
        error.code = "EMPTY_SUBMISSION";
        throw error;
      }
      const level = await this.readLevelDetail(slug, levelSlug);
      // 存储状态 locked 不代表未解锁：发布时一律写 locked，真实可玩状态由依赖推导
      const states = buildLevelStates(await readLevels(slug));
      const effectiveStatus = states.get(levelSlug)?.effectiveStatus ?? level.frontmatter.status;
      if (effectiveStatus === "locked") {
        const error = new Error("关卡尚未解锁");
        error.code = "LEVEL_LOCKED";
        throw error;
      }
      if (level.frontmatter.status === "mastered") {
        const error = new Error("关卡已通关");
        error.code = "LEVEL_MASTERED";
        throw error;
      }
      const refTexts = [];
      for (const ref of vaultRefs) {
        const absolute = path.join(vaultRoot, ref);
        if (!absolute.startsWith(vaultRoot)) {
          const error = new Error(`vault_refs 越界: ${ref}`);
          error.code = "REF_OUT_OF_VAULT";
          throw error;
        }
        refTexts.push(`### 引用 ${ref}\n${await fs.readFile(absolute, "utf8")}`);
      }
      const graded = await client.grade({
        projectSlug: slug,
        levelTitle: level.frontmatter.title,
        challenge: level.challenge,
        rubric: level.rubric,
        submission: [contentMd, ...refTexts].join("\n\n"),
      });
      const passScore = level.frontmatter.pass_score ?? DEFAULT_PASS_SCORE;
      const inBand = Math.abs(graded.total - passScore) <= PROBE_BAND;
      const needsProbe = graded.needs_probe === true || (inBand && graded.total < passScore + PROBE_BAND);
      const attemptId = nowStamp();
      const attempt = {
        id: attemptId,
        frontmatter: {
          type: "learning-attempt",
          project: slug,
          level: levelSlug,
          score: graded.total,
          verdict: needsProbe ? "pending_probe" : graded.total >= passScore ? "passed" : "failed",
          variant_of: null,
          probe: needsProbe,
          created: new Date().toISOString(),
        },
        body: [
          "## 提交产物", contentMd, "",
          ...(refTexts.length ? ["## 引用快照", ...refTexts, ""] : []),
          "## 逐条评分",
          (graded.scores ?? []).map((entry) => `- [${entry.earned}分] ${entry.item}：${entry.comment}`).join("\n"), "",
          "## 总反馈", graded.feedback ?? "", "",
        ].join("\n"),
      };
      await writeAtomic(
        path.join(attemptsDir(slug, levelSlug), `${attemptId}.md`),
        `---\n${serializeFrontmatter(attempt.frontmatter)}---\n\n${attempt.body}`,
      );
      if (needsProbe) {
        const probes = graded.probes?.length
          ? graded.probes.slice(0, 2)
          : [`请用自己的话解释：「${level.frontmatter.title}」中最容易混淆的点是什么？`];
        return { attemptId, needsProbe: true, probes, draftScore: graded.total, verdict: "pending_probe" };
      }
      await applyOutcome(slug, levelSlug, attempt.frontmatter.verdict, graded.total);
      return { attemptId, needsProbe: false, verdict: attempt.frontmatter.verdict, score: graded.total, feedback: graded.feedback };
    },

    async answerProbe(slug, levelSlug, attemptId, { answers = [] }) {
      const client = requireAi();
      const attemptPath = path.join(attemptsDir(slug, levelSlug), `${attemptId}.md`);
      const attempt = await readDocument(attemptPath, `attempt ${attemptId}`);
      if (attempt.frontmatter.verdict !== "pending_probe") {
        const error = new Error("该验证记录不在追问状态");
        error.code = "ATTEMPT_NOT_PENDING";
        throw error;
      }
      const level = await this.readLevelDetail(slug, levelSlug);
      const passScore = level.frontmatter.pass_score ?? DEFAULT_PASS_SCORE;
      const result = await client.gradeProbe({
        levelTitle: level.frontmatter.title,
        challenge: level.challenge,
        rubric: level.rubric,
        draftScore: attempt.frontmatter.score,
        qa: attempt.body,
        answers,
      });
      const verdict = result.passed && result.total >= passScore ? "passed" : "failed";
      attempt.frontmatter.score = result.total;
      attempt.frontmatter.verdict = verdict;
      attempt.body += `\n## 追问问答\n${answers.map((answer, index) => `${index + 1}. ${answer}`).join("\n")}\n\n## 追问反馈\n${result.feedback ?? ""}\n`;
      await writeAtomic(attemptPath, `---\n${serializeFrontmatter(attempt.frontmatter)}---\n\n${attempt.body}`);
      await applyOutcome(slug, levelSlug, verdict, result.total);
      return { attemptId, verdict, score: result.total, feedback: result.feedback };
    },

    async retryVariant(slug, levelSlug) {
      const client = requireAi();
      const level = await this.readLevelDetail(slug, levelSlug);
      const attempts = await this.listAttempts(slug, levelSlug);
      const variant = await client.variant({
        challenge: level.challenge,
        rubric: level.rubric,
        previousSummaries: attempts.slice(-3).map((entry) => entry.body.slice(0, 500)),
      });
      const entry = await readLevel(slug, levelSlug);
      entry.body = replaceSection(entry.body, "挑战", variant.challenge_md);
      entry.frontmatter.updated = new Date().toISOString();
      await writeLevel(slug, levelSlug, entry.frontmatter, entry.body);
      return { challenge: variant.challenge_md };
    },

    async selfAssess(slug, levelSlug, { score } = {}) {
      const level = await readLevel(slug, levelSlug);
      const states = buildLevelStates(await readLevels(slug));
      if ((states.get(levelSlug)?.effectiveStatus ?? level.frontmatter.status) === "locked") {
        const error = new Error("关卡尚未解锁");
        error.code = "LEVEL_LOCKED";
        throw error;
      }
      const finalScore = Number.isFinite(Number(score)) ? Math.min(100, Math.max(0, Number(score))) : 100;
      const attemptId = nowStamp();
      await writeAtomic(
        path.join(attemptsDir(slug, levelSlug), `${attemptId}.md`),
        `---\n${serializeFrontmatter({
          type: "learning-attempt",
          project: slug,
          level: levelSlug,
          score: finalScore,
          verdict: "self-assessed",
          variant_of: null,
          probe: false,
          created: new Date().toISOString(),
        })}---\n\n## 手工自评\n自评分数 ${finalScore}。\n`,
      );
      await applyOutcome(slug, levelSlug, "self-assessed", finalScore);
      return { attemptId, verdict: "self-assessed", score: finalScore };
    },
  };

  async function applyOutcome(slug, levelSlug, verdict, score) {
    const entry = await readLevel(slug, levelSlug);
    entry.frontmatter.mastery = Math.max(entry.frontmatter.mastery ?? 0, score);
    if (verdict === "passed") {
      entry.frontmatter.status = "mastered";
      entry.frontmatter.verified_by = "ai-verified";
    } else if (verdict === "self-assessed") {
      entry.frontmatter.status = "mastered";
      if (entry.frontmatter.verified_by !== "ai-verified") entry.frontmatter.verified_by = "self-assessed";
    } else if (entry.frontmatter.status === "available") {
      entry.frontmatter.status = "challenged";
    }
    entry.frontmatter.updated = new Date().toISOString();
    await writeLevel(slug, levelSlug, entry.frontmatter, entry.body);
    await syncProgress(slug);
  }
}
```

注意：上面 `createProject` 的测试里第一处断言写法啰嗦，实现时把测试改成直接断言返回的 slug 等于传入或生成的值（`assert.equal(slug, "demo")` 对应传入 slug 的用例；未传 slug 的用例断言 `assert.match(slug, /^[a-z0-9-]+$/)`）。

- [x] **步骤 4：运行测试验证通过**

运行：`node --test tests/learning-unlock.test.mjs`
预期：PASS（任务 2 的 6 个 + 本任务 4 个用例）

- [x] **步骤 5：Commit**

```bash
git add Workbench/server/learning-store.mjs Workbench/tests/learning-unlock.test.mjs
git commit -m "feat(learning): add vault store with submit/probe/self-assess flow"
```

---

### 任务 4:learning-ai.mjs — prompt 构建器与 JSON 校验

**文件：**
- 创建：`Workbench/server/learning-ai.mjs`
- 测试：`Workbench/tests/learning-ai.test.mjs`

- [x] **步骤 1：编写失败的测试**

```js
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildChallengePrompt,
  buildDecomposePrompt,
  buildGradeProbePrompt,
  buildGradePrompt,
  buildVariantPrompt,
  parseAiJson,
  parseChallengeResult,
  parseDecomposeResult,
  parseGradeResult,
  parseVariantResult,
} from "../server/learning-ai.mjs";

test("buildDecomposePrompt embeds project and sources with truncation note", () => {
  const { system, user } = buildDecomposePrompt({
    title: "学习 React 状态管理",
    description: "从 useState 到 Zustand",
    sourcesText: "资料内容".repeat(100),
  });
  assert.match(system, /JSON/);
  assert.match(user, /学习 React 状态管理/);
  assert.match(user, /从 useState 到 Zustand/);
});

test("parseDecomposeResult validates dag draft shape", () => {
  const parsed = parseDecomposeResult(JSON.stringify({
    levels: [{ slug: "a", title: "关卡 A", summary: "简介", depends_on: [], rubric_hints: ["点1"] }],
  }));
  assert.equal(parsed.levels[0].slug, "a");
  assert.throws(() => parseDecomposeResult(JSON.stringify({ levels: [{ slug: "Bad!", title: "x" }] })), /slug/);
  assert.throws(() => parseDecomposeResult("not json"), /JSON/);
});

test("parseChallengeResult enforces rubric total 100 per level", () => {
  const ok = parseChallengeResult(JSON.stringify({
    challenges: [{ slug: "a", challenge_md: "做练习", rubric: [{ item: "完成", points: 100 }] }],
  }));
  assert.equal(ok.challenges[0].rubric[0].points, 100);
  assert.throws(
    () => parseChallengeResult(JSON.stringify({ challenges: [{ slug: "a", challenge_md: "x", rubric: [{ item: "y", points: 50 }] }] })),
    /100/,
  );
});

test("parseGradeResult validates score fields", () => {
  const parsed = parseGradeResult(JSON.stringify({
    scores: [{ item: "完成", earned: 40, comment: "部分" }],
    total: 40,
    feedback: "继续努力",
    needs_probe: false,
    probes: [],
  }));
  assert.equal(parsed.total, 40);
  assert.throws(() => parseGradeResult(JSON.stringify({ total: "高分" })), /total/);
});

test("parseVariantResult requires challenge_md", () => {
  assert.equal(parseVariantResult(JSON.stringify({ challenge_md: "变体题" })).challenge_md, "变体题");
  assert.throws(() => parseVariantResult(JSON.stringify({})), /challenge_md/);
});

test("parseAiJson strips code fences", () => {
  assert.deepEqual(parseAiJson("```json\n{\"a\": 1}\n```"), { a: 1 });
});

test("buildGradePrompt and probe/variant prompts carry rubric items", () => {
  const rubric = [{ item: "说明重渲染条件", points: 100 }];
  assert.match(buildGradePrompt({ levelTitle: "关卡", challenge: "挑战", rubric, submission: "作答" }).user, /说明重渲染条件/);
  assert.match(buildGradeProbePrompt({ levelTitle: "关卡", challenge: "挑战", rubric, draftScore: 75, qa: "问答", answers: ["答"] }).user, /75/);
  assert.match(buildVariantPrompt({ challenge: "原题", rubric, previousSummaries: ["旧作答"] }).user, /原题/);
  assert.match(buildChallengePrompt({ projectTitle: "项目", levels: [{ slug: "a", title: "A", summary: "s", rubric_hints: [] }] }).user, /项目/);
});
```

- [x] **步骤 2：运行测试验证失败**

运行：`node --test tests/learning-ai.test.mjs`
预期：FAIL，报错 `Cannot find module '../server/learning-ai.mjs'`

- [x] **步骤 3：编写实现代码**

创建 `Workbench/server/learning-ai.mjs`：

```js
import { assertSlug } from "./learning.mjs";

const SOURCE_CHAR_LIMIT = 8000;

export function parseAiJson(text) {
  const cleaned = String(text).trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    return JSON.parse(cleaned);
  } catch (error) {
    throw new TypeError(`AI 输出不是合法 JSON: ${error.message}`);
  }
}

function requireArray(value, field) {
  if (!Array.isArray(value)) throw new TypeError(`AI 输出缺少数组字段: ${field}`);
  return value;
}

function requireString(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`AI 输出缺少字符串字段: ${field}`);
  return value;
}

export function parseDecomposeResult(text) {
  const output = parseAiJson(text);
  const levels = requireArray(output.levels, "levels").map((entry) => ({
    slug: assertSlug(entry.slug ?? "", "levels[].slug"),
    title: requireString(entry.title, "levels[].title"),
    summary: String(entry.summary ?? ""),
    depends_on: requireArray(entry.depends_on ?? [], "levels[].depends_on").map(String),
    rubric_hints: requireArray(entry.rubric_hints ?? [], "levels[].rubric_hints").map(String),
  }));
  return { levels };
}

export function parseChallengeResult(text) {
  const output = parseAiJson(text);
  const challenges = requireArray(output.challenges, "challenges").map((entry) => {
    const rubric = requireArray(entry.rubric, "challenges[].rubric").map((item) => ({
      item: requireString(item.item, "rubric.item"),
      points: Number(item.points),
    }));
    const total = rubric.reduce((sum, item) => sum + item.points, 0);
    if (total !== 100) throw new TypeError(`关卡 ${entry.slug} 的 rubric 总分为 ${total}，必须为 100`);
    return { slug: assertSlug(entry.slug ?? "", "challenges[].slug"), challenge_md: requireString(entry.challenge_md, "challenges[].challenge_md"), rubric };
  });
  return { challenges };
}

export function parseGradeResult(text) {
  const output = parseAiJson(text);
  if (!Number.isFinite(Number(output.total))) throw new TypeError("AI 输出缺少数值字段: total");
  return {
    scores: requireArray(output.scores ?? [], "scores").map((entry) => ({
      item: String(entry.item ?? ""),
      earned: Number(entry.earned) || 0,
      comment: String(entry.comment ?? ""),
    })),
    total: Number(output.total),
    feedback: String(output.feedback ?? ""),
    needs_probe: output.needs_probe === true,
    probes: requireArray(output.probes ?? [], "probes").map(String).slice(0, 2),
  };
}

export function parseProbeGradeResult(text) {
  const output = parseAiJson(text);
  if (!Number.isFinite(Number(output.total))) throw new TypeError("AI 输出缺少数值字段: total");
  return { total: Number(output.total), feedback: String(output.feedback ?? ""), passed: output.passed === true };
}

export function parseVariantResult(text) {
  const output = parseAiJson(text);
  return { challenge_md: requireString(output.challenge_md, "challenge_md") };
}

const SYSTEM_JSON = "你是学习闯关模块的助教引擎。你只输出 JSON，不输出任何解释性文字、 Markdown 代码围栏以外的内容也必须是合法 JSON。";

export function buildDecomposePrompt({ title, description, sourcesText }) {
  return {
    system: SYSTEM_JSON,
    user: [
      `把学习项目「${title}」拆解为知识点关卡依赖图。`,
      description ? `项目描述：${description}` : "",
      "要求：5-12 个关卡；每关一个可实践验证的知识点；用 depends_on 表达前置依赖（必须是本次输出中靠前的 slug）；slug 用小写字母数字连字符。",
      "输出 JSON：{\"levels\":[{\"slug\",\"title\",\"summary\",\"depends_on\":[],\"rubric_hints\":[\"考点\"]}]}",
      sourcesText ? `\n挂接资料（截断于 ${SOURCE_CHAR_LIMIT} 字）：\n${sourcesText.slice(0, SOURCE_CHAR_LIMIT)}` : "",
    ].filter(Boolean).join("\n"),
  };
}

export function buildChallengePrompt({ projectTitle, levels }) {
  return {
    system: SYSTEM_JSON,
    user: [
      `为学习项目「${projectTitle}」的每个关卡设计实践挑战和评分细则。`,
      "要求：挑战必须是可产出物的实践任务（写代码/做练习/写讲解），不是背诵题；每关 rubric 3-5 条，总分必须恰好 100；关卡之间难度递进、情境不重复。",
      `关卡清单：${JSON.stringify(levels.map((entry) => ({ slug: entry.slug, title: entry.title, summary: entry.summary, rubric_hints: entry.rubric_hints })))}`,
      "输出 JSON：{\"challenges\":[{\"slug\",\"challenge_md\",\"rubric\":[{\"item\",\"points\"}]}]}",
    ].join("\n"),
  };
}

export function buildGradePrompt({ levelTitle, challenge, rubric, submission }) {
  return {
    system: SYSTEM_JSON,
    user: [
      `你是严格的评审。关卡「${levelTitle}」的挑战：\n${challenge}`,
      `评分细则：${JSON.stringify(rubric)}`,
      `学习者的提交产物：\n${submission}`,
      "逐条按 rubric 打分（ earned 不超过该条 points ），给出总分与针对性反馈。",
      "如果产物有搬运/拼凑痕迹，或分数不足以明确判定理解程度，设 needs_probe 为 true 并给出 1-2 个追问问题（考察理解深度而非记忆）。",
      "输出 JSON：{\"scores\":[{\"item\",\"earned\",\"comment\"}],\"total\":0,\"feedback\":\"\",\"needs_probe\":false,\"probes\":[]}",
    ].join("\n"),
  };
}

export function buildGradeProbePrompt({ levelTitle, challenge, rubric, draftScore, qa, answers }) {
  return {
    system: SYSTEM_JSON,
    user: [
      `关卡「${levelTitle}」的挑战：\n${challenge}`,
      `评分细则：${JSON.stringify(rubric)}`,
      `此前评审草稿分：${draftScore}。原始评审记录：\n${qa}`,
      `学习者对追问的回答：${JSON.stringify(answers)}`,
      "综合产物与追问回答给出最终判定：passed 表示确认理解达标；total 为最终总分（0-100）。",
      "输出 JSON：{\"total\":0,\"feedback\":\"\",\"passed\":false}",
    ].join("\n"),
  };
}

export function buildVariantPrompt({ challenge, rubric, previousSummaries }) {
  return {
    system: SYSTEM_JSON,
    user: [
      `原挑战：\n${challenge}`,
      `评分细则（必须不变，仍按同一 rubric 评分）：${JSON.stringify(rubric)}`,
      `学习者最近的提交摘要（避免与这些答案撞车）：\n${previousSummaries.join("\n---\n") || "（无）"}`,
      "生成同一考点、同一 rubric、不同情境的变体挑战，防止靠背答案过关。",
      "输出 JSON：{\"challenge_md\":\"\"}",
    ].join("\n"),
  };
}
```

- [x] **步骤 4：运行测试验证通过**

运行：`node --test tests/learning-ai.test.mjs`
预期：PASS(7 个用例）

- [x] **步骤 5：Commit**

```bash
git add Workbench/server/learning-ai.mjs Workbench/tests/learning-ai.test.mjs
git commit -m "feat(learning): add ai prompt builders and result parsers"
```

---

### 任务 5:learning-ai.mjs — OpenAI 兼容客户端与配置加载

**文件：**
- 修改:`Workbench/server/learning-ai.mjs`
- 测试：`Workbench/tests/learning-ai.test.mjs`（追加）

- [x] **步骤 1：编写失败的测试**

在 `Workbench/tests/learning-ai.test.mjs` 末尾追加：

```js
import { createLearningAiClient, loadLearningAiConfig } from "../server/learning-ai.mjs";

test("loadLearningAiConfig returns null when key missing", () => {
  assert.equal(loadLearningAiConfig({ env: {} }), null);
  const config = loadLearningAiConfig({
    env: {
      LEARNING_AI_BASE_URL: "https://example.test/v1",
      LEARNING_AI_API_KEY: "tk",
      LEARNING_AI_MODEL: "test-model",
    },
  });
  assert.deepEqual(config, { baseUrl: "https://example.test/v1", apiKey: "tk", model: "test-model" });
});

test("client posts chat completions and retries once on failure", async (t) => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) return { ok: false, status: 429, text: async () => "rate limited" };
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: "{\"total\": 88, \"feedback\": \"好\", \"passed\": true}" } }] }),
    };
  };
  const client = createLearningAiClient({ baseUrl: "https://example.test/v1", apiKey: "tk", model: "test-model" });
  const result = await client.gradeProbe({ levelTitle: "t", challenge: "c", rubric: [], draftScore: 75, qa: "", answers: ["a"] });
  assert.equal(result.total, 88);
  assert.equal(calls.length, 2); // 重试一次
  assert.equal(calls[0].url, "https://example.test/v1/chat/completions");
  assert.equal(calls[0].options.headers.Authorization, "Bearer tk");
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.model, "test-model");
  assert.equal(body.response_format.type, "json_object");
  assert.equal(body.messages.length, 2);
});

test("client throws after second failure with status in message", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => "boom" });
  const client = createLearningAiClient({ baseUrl: "https://example.test/v1", apiKey: "k", model: "m" });
  await assert.rejects(() => client.variant({ challenge: "c", rubric: [], previousSummaries: [] }), /500/);
});
```

- [x] **步骤 2：运行测试验证失败**

运行：`node --test tests/learning-ai.test.mjs`
预期：FAIL，报错 `createLearningAiClient is not a function`

- [x] **步骤 3：编写实现代码**

在 `Workbench/server/learning-ai.mjs` 末尾追加：

```js
import path from "node:path";

const AI_TIMEOUT_MS = 60_000;

export function loadLearningAiConfig({ env = process.env, workbenchRoot = null } = {}) {
  if (workbenchRoot) {
    try {
      process.loadEnvFile(path.join(workbenchRoot, ".env"));
    } catch {
      // .env 不存在时静默忽略，env 变量也可以由 shell 注入
    }
  }
  const baseUrl = env.LEARNING_AI_BASE_URL?.trim();
  const apiKey = env.LEARNING_AI_API_KEY?.trim();
  const model = env.LEARNING_AI_MODEL?.trim();
  if (!apiKey) return null;
  return {
    baseUrl: (baseUrl || "https://api.openai.com/v1").replace(/\/+$/, ""),
    apiKey,
    model: model || "gpt-4o-mini",
  };
}

async function callChatCompletions(config, messages) {
  let lastError = null;
  for (let attemptNumber = 0; attemptNumber < 2; attemptNumber += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
    try {
      const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          messages,
          temperature: 0.3,
          response_format: { type: "json_object" },
        }),
      });
      if (!response.ok) {
        lastError = new Error(`AI 请求失败 HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
        continue;
      }
      const payload = await response.json();
      const content = payload?.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new TypeError("AI 响应缺少 choices[0].message.content");
      return content;
    } catch (error) {
      lastError = error.name === "AbortError" ? new Error("AI 请求超时（60s）") : error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

export function createLearningAiClient(config) {
  const run = async (prompt, parse) => parse(await callChatCompletions(config, [
    { role: "system", content: prompt.system },
    { role: "user", content: prompt.user },
  ]));
  return {
    decompose: (input) => run(buildDecomposePrompt(input), parseDecomposeResult),
    challenge: (input) => run(buildChallengePrompt(input), parseChallengeResult),
    grade: (input) => run(buildGradePrompt(input), parseGradeResult),
    gradeProbe: (input) => run(buildGradeProbePrompt(input), parseProbeGradeResult),
    variant: (input) => run(buildVariantPrompt(input), parseVariantResult),
  };
}
```

注意：`loadLearningAiConfig` 里 `process.loadEnvFile` 会把 `.env` 值灌入 `process.env`，但函数读取的是入参 `env`——测试传自定义 env 时不传 workbenchRoot，生产调用不传 env 时用 process.env，两者不冲突。

- [x] **步骤 4：运行测试验证通过**

运行：`node --test tests/learning-ai.test.mjs`
预期：PASS(10 个用例）

- [x] **步骤 5：Commit**

```bash
git add Workbench/server/learning-ai.mjs Workbench/tests/learning-ai.test.mjs Workbench/.env.example
git commit -m "feat(learning): add openai-compatible client with config loading"
```

同时创建 `Workbench/.env.example`（纯占位，无引号无真实 key，不触发 privacy-scan）:

```text
# 学习闯关 AI 配置（OpenAI 兼容 API），复制为 .env 后填入真实值
LEARNING_AI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
LEARNING_AI_API_KEY=填入你自己的key
LEARNING_AI_MODEL=qwen-plus
```

---

### 任务 6:vite-plugin 注册 learning 读端点

**文件：**
- 修改:`Workbench/server/vite-plugin-workbench.mjs`

- [x] **步骤 1：加 import 与 store 初始化**

在文件顶部 import 区（`import { booksPayload } from "./books.mjs";` 之后）加：

```js
import { projectsPayload } from "./learning.mjs";
import { createLearningStore } from "./learning-store.mjs";
import { createLearningAiClient, loadLearningAiConfig } from "./learning-ai.mjs";
```

在 `configureServer(server) {` 之前、`const currentIndex = ...` 附近加：

```js
const learningAiConfig = loadLearningAiConfig({ workbenchRoot });
const learningAiClient = learningAiConfig ? createLearningAiClient(learningAiConfig) : null;
const learningStore = createLearningStore({
  vaultRoot: defaultVaultRoot,
  ai: learningAiClient,
});
```

- [x] **步骤 2：注册读端点**

在 `if (req.method === "GET" && url.pathname === "/api/books") { ... }` 块之后插入：

```js
if (req.method === "GET" && url.pathname === "/api/learning/projects") {
  return json(res, 200, {
    ...projectsPayload(await currentIndex()),
    aiConfigured: Boolean(learningAiConfig),
  });
}

const learningProjectMatch = url.pathname.match(/^\/api\/learning\/projects\/([a-z0-9-]+)$/);
if (req.method === "GET" && learningProjectMatch) {
  return json(res, 200, {
    ...(await learningStore.readProjectDetail(learningProjectMatch[1])),
    aiConfigured: Boolean(learningAiConfig),
  });
}

const learningLevelMatch = url.pathname.match(/^\/api\/learning\/projects\/([a-z0-9-]+)\/levels\/([a-z0-9-]+)$/);
if (req.method === "GET" && learningLevelMatch) {
  return json(res, 200, await learningStore.readLevelDetail(learningLevelMatch[1], learningLevelMatch[2]));
}

const learningAttemptsMatch = url.pathname.match(/^\/api\/learning\/projects\/([a-z0-9-]+)\/levels\/([a-z0-9-]+)\/attempts$/);
if (req.method === "GET" && learningAttemptsMatch) {
  const attempts = await learningStore.listAttempts(learningAttemptsMatch[1], learningAttemptsMatch[2]);
  return json(res, 200, {
    attempts: attempts.map((entry) => ({ id: entry.id, ...entry.frontmatter, body: entry.body })),
  });
}
```

错误映射：middleware 现有 try/catch 兜底（确认其存在并）在 catch 前加 learning 专用错误映射。把上面写端点统一包一个 helper：

```js
function learningError(res, error) {
  const statusByCode = {
    AI_NOT_CONFIGURED: 503,
    DAG_INVALID: 422,
    EMPTY_SUBMISSION: 422,
    LEVEL_LOCKED: 409,
    LEVEL_MASTERED: 409,
    ATTEMPT_NOT_PENDING: 409,
    REF_OUT_OF_VAULT: 422,
  };
  const status = statusByCode[error.code] ?? (error.code === "ENOENT" ? 404 : 500);
  return json(res, status, { error: { code: error.code ?? "LEARNING_ERROR", message: error.message } });
}
```

所有 learning 写端点用 `try { ... } catch (error) { return learningError(res, error); }` 包裹。

- [x] **步骤 3：手动验证**

运行 `npm run dev`，浏览器或 curl 访问 `http://localhost:5173/api/learning/projects`，预期返回 `200` 且含 `projects` 数组与 `aiConfigured` 字段（此时为 0 个项目，`total: 0`）。

- [x] **步骤 4：Commit**

```bash
git add Workbench/server/vite-plugin-workbench.mjs
git commit -m "feat(learning): register learning read endpoints"
```

---

### 任务 7:vite-plugin 注册 learning 写端点

**文件：**
- 修改:`Workbench/server/vite-plugin-workbench.mjs`

- [x] **步骤 1：注册写端点**

在任务 6 的读端点之后插入（全部用 try/catch + learningError 包裹，写操作完成后调 `await refreshIndex({ reason: "learning" })` 刷新索引）:

```js
if (req.method === "POST" && url.pathname === "/api/learning/projects") {
  try {
    const body = await readJson(req, 64 * 1024);
    const created = await learningStore.createProject({
      title: String(body.title ?? "").trim(),
      description: String(body.description ?? ""),
      sources: Array.isArray(body.sources) ? body.sources.map(String) : [],
      slug: body.slug,
    });
    await refreshIndex({ reason: "learning" });
    return json(res, 200, created);
  } catch (error) { return learningError(res, error); }
}

const publishMatch = url.pathname.match(/^\/api\/learning\/projects\/([a-z0-9-]+)\/levels:publish$/);
if (req.method === "POST" && publishMatch) {
  try {
    const body = await readJson(req, 256 * 1024);
    const result = await learningStore.publishLevels(publishMatch[1], body.levels ?? []);
    await refreshIndex({ reason: "learning" });
    return json(res, 200, result);
  } catch (error) { return learningError(res, error); }
}

if (req.method === "PUT" && learningLevelMatch) {
  try {
    const body = await readJson(req, 256 * 1024);
    const result = await learningStore.updateLevel(learningLevelMatch[1], learningLevelMatch[2], body);
    await refreshIndex({ reason: "learning" });
    return json(res, 200, result);
  } catch (error) { return learningError(res, error); }
}

const submitMatch = url.pathname.match(/^\/api\/learning\/projects\/([a-z0-9-]+)\/levels\/([a-z0-9-]+)\/submit$/);
if (req.method === "POST" && submitMatch) {
  try {
    const body = await readJson(req, 512 * 1024);
    const result = await learningStore.submitAttempt(submitMatch[1], submitMatch[2], {
      contentMd: String(body.content_md ?? ""),
      vaultRefs: Array.isArray(body.vault_refs) ? body.vault_refs.map(String) : [],
    });
    await refreshIndex({ reason: "learning" });
    return json(res, 200, result);
  } catch (error) { return learningError(res, error); }
}

const probeMatch = url.pathname.match(/^\/api\/learning\/projects\/([a-z0-9-]+)\/levels\/([a-z0-9-]+)\/probe$/);
if (req.method === "POST" && probeMatch) {
  try {
    const body = await readJson(req, 256 * 1024);
    const result = await learningStore.answerProbe(probeMatch[1], probeMatch[2], String(body.attempt_id ?? ""), {
      answers: Array.isArray(body.answers) ? body.answers.map(String) : [],
    });
    await refreshIndex({ reason: "learning" });
    return json(res, 200, result);
  } catch (error) { return learningError(res, error); }
}

const retryMatch = url.pathname.match(/^\/api\/learning\/projects\/([a-z0-9-]+)\/levels\/([a-z0-9-]+)\/retry$/);
if (req.method === "POST" && retryMatch) {
  try {
    const result = await learningStore.retryVariant(retryMatch[1], retryMatch[2]);
    await refreshIndex({ reason: "learning" });
    return json(res, 200, result);
  } catch (error) { return learningError(res, error); }
}

const selfAssessMatch = url.pathname.match(/^\/api\/learning\/projects\/([a-z0-9-]+)\/levels\/([a-z0-9-]+)\/self-assess$/);
if (req.method === "POST" && selfAssessMatch) {
  try {
    const body = await readJson(req, 64 * 1024);
    const result = await learningStore.selfAssess(selfAssessMatch[1], selfAssessMatch[2], { score: body.score });
    await refreshIndex({ reason: "learning" });
    return json(res, 200, result);
  } catch (error) { return learningError(res, error); }
}

// AI 代理端点
if (req.method === "POST" && url.pathname === "/api/learning/ai/decompose") {
  try {
    if (!learningAiClient) throw Object.assign(new Error("AI 未配置"), { code: "AI_NOT_CONFIGURED" });
    const body = await readJson(req, 256 * 1024);
    const sourcesText = Array.isArray(body.sources)
      ? (await Promise.all(body.sources.map(async (ref) => {
          const absolute = path.join(defaultVaultRoot, String(ref));
          if (!absolute.startsWith(defaultVaultRoot)) return "";
          try { return await readFile(absolute, "utf8"); } catch { return ""; }
        }))).join("\n\n")
      : "";
    return json(res, 200, await learningAiClient.decompose({
      title: String(body.title ?? ""), description: String(body.description ?? ""), sourcesText,
    }));
  } catch (error) { return learningError(res, error); }
}

if (req.method === "POST" && url.pathname === "/api/learning/ai/challenge") {
  try {
    if (!learningAiClient) throw Object.assign(new Error("AI 未配置"), { code: "AI_NOT_CONFIGURED" });
    const body = await readJson(req, 256 * 1024);
    return json(res, 200, await learningAiClient.challenge({
      projectTitle: String(body.project_title ?? ""),
      levels: Array.isArray(body.levels) ? body.levels : [],
    }));
  } catch (error) { return learningError(res, error); }
}
```

注意：`learningLevelMatch` 在任务 6 已定义，本任务直接复用；decompose/challenge 走 `learningAiClient`（任务 6 初始化），不进 store。

- [x] **步骤 2：手动验证**

`npm run dev` 后用 curl 创建项目：

```bash
curl -X POST http://localhost:5173/api/learning/projects -H "Content-Type: application/json" -d "{\"title\":\"demo\",\"description\":\"\",\"slug\":\"demo\"}"
curl http://localhost:5173/api/learning/projects/demo
```

预期：创建返回 `{"slug":"demo"}`；详情返回 progress 为 `{total:0,...}`。验证后删除 `个人知识库/60_learning/demo/` 目录。

- [x] **步骤 3：Commit**

```bash
git add Workbench/server/vite-plugin-workbench.mjs
git commit -m "feat(learning): register learning write and ai endpoints"
```

---

### 任务 8:synthetic demo 数据

**文件：**
- 创建：`个人知识库/60_learning/react-state-management/index.md`
- 创建：`个人知识库/60_learning/react-state-management/levels/react-rerender.md`
- 创建：`个人知识库/60_learning/react-state-management/levels/context-basics.md`
- 创建：`个人知识库/60_learning/react-state-management/levels/zustand-store.md`
- 创建：`个人知识库/60_learning/react-state-management/attempts/react-rerender/20260901-200000.md`

- [x] **步骤 1：写 demo 文件**

`index.md`（注意所有内容为虚构，标注合成演示；日期用 2026-09-01，不引用任何真实个人数据）:

```markdown
---
type: learning-project
title: 学习 React 状态管理
slug: react-state-management
description: 合成演示项目：从重渲染原理到 Zustand 实践的闯关地图（synthetic demo）
created: 2026-09-01T09:00:00+08:00
sources: []
levels: [react-rerender, context-basics, zustand-store]
progress: {"total": 3, "mastered": 1, "percent": 33}
---

# 学习 React 状态管理

> 本文件是公开仓库的 synthetic demo 数据，内容为虚构，仅用于演示学习闯关模块。

目标：能解释重渲染触发机制，会用 Context 分层共享状态，能用 Zustand 搭建可测试的全局 store。
```

`levels/react-rerender.md`（已通关，带 ai-verified):

```markdown
---
type: learning-level
project: react-state-management
title: 理解 React 重渲染机制
status: mastered
mastery: 90
verified_by: ai-verified
pass_score: 80
depends_on: []
updated: 2026-09-01T20:00:00+08:00
---

## 知识点笔记

合成演示笔记：状态变更、父组件重渲染、context 值变化都会触发重渲染；memo 可以阻断 props 未变的子树。

## 挑战

合成演示挑战：写一个包含父子组件的计数器 demo，用 React DevTools Profiler 记录一次点击引发的重渲染范围，然后用 memo 优化并对比两份火焰图，提交优化前后的截图说明与关键代码。

## 评分细则

- [30分] 能准确说明触发重渲染的三个条件
- [30分] 提交的代码真实演示了 memo 的阻断效果
- [40分] 对 Profiler 火焰图的对比解释合理
```

`levels/context-basics.md`（可挑战，依赖 react-rerender):

```markdown
---
type: learning-level
project: react-state-management
title: 用 Context 分层共享状态
status: available
mastery: 0
verified_by: none
pass_score: null
depends_on: [react-rerender]
updated: 2026-09-01T20:00:00+08:00
---

## 知识点笔记

合成演示笔记：Context 适合低频变更的跨层数据；Provider 嵌套顺序影响订阅范围。

## 挑战

合成演示挑战：实现一个主题 + 用户会话的双 Provider 应用，故意制造一次「context 值变化导致全树重渲染」的问题，再用拆分 Provider 的方式修复，提交问题复现与修复后的代码。

## 评分细则

- [40分] 双 Provider 结构正确且职责分离
- [30分] 问题复现可运行、现象描述准确
- [30分] 修复方案解释了订阅范围变化
```

`levels/zustand-store.md`(locked):

```markdown
---
type: learning-level
project: react-state-management
title: 用 Zustand 搭建可测试的全局 store
status: locked
mastery: 0
verified_by: none
pass_score: null
depends_on: [context-basics]
updated: 2026-09-01T20:00:00+08:00
---

## 知识点笔记

合成演示笔记：Zustand 的 selector 订阅与 shallow 比较是性能关键；store 可以在 React 外单测。

## 挑战

合成演示挑战：为一个待办应用实现 Zustand store（含派生 selector 与异步 action），并为异步 action 编写不依赖 React 的单元测试，提交 store 代码与测试运行输出。

## 评分细则

- [30分] store 结构清晰，action 命名语义化
- [30分] selector 使用 shallow 避免无效重渲染
- [40分] 异步 action 的单元测试真实可运行
```

`attempts/react-rerender/20260901-200000.md`:

```markdown
---
type: learning-attempt
project: react-state-management
level: react-rerender
score: 90
verdict: passed
variant_of: null
probe: false
created: 2026-09-01T20:00:00+08:00
---

## 提交产物

合成演示提交：计数器 demo 关键代码（略），memo 优化前后 Profiler 对比说明（略）。

## 逐条评分

- [27分] 能准确说明触发重渲染的三个条件：三个条件全部覆盖，表述准确
- [27分] 提交的代码真实演示了 memo 的阻断效果：代码可运行，对比明显
- [36分] 对 Profiler 火焰图的对比解释合理：解释到位，注意到批量更新

## 总反馈

合成演示反馈：理解扎实，可以进入 Context 关卡。
```

- [x] **步骤 2：验证 demo 通过门禁**

运行：`node --test tests/data-authenticity.test.mjs tests/public-boundaries.test.mjs && node scripts/privacy-scan.mjs`
预期：全部 PASS（新 demo 不破坏既有测试；privacy-scan 无命中）

- [x] **步骤 3：手动验证 API 读到 demo**

`npm run dev` 后访问 `/api/learning/projects`，预期 `total: 1`，项目 `react-state-management` 的 progress 为 `{total: 3, mastered: 1, percent: 33}`。

- [x] **步骤 4：Commit**

```bash
git add 个人知识库/60_learning
git commit -m "feat(learning): add synthetic learning quest demo vault content"
```

---

### 任务 9:LearningPage — 项目列表与新建向导

**文件：**
- 创建：`Workbench/src/pages/LearningPage.jsx`
- 创建：`Workbench/src/styles/learning.css`

- [x] **步骤 1：编写组件与样式**

`Workbench/src/pages/LearningPage.jsx`:

```jsx
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";

const EMPTY_DRAFT = { title: "", description: "", sourcesText: "", slug: "" };

export function LearningPage() {
  const navigate = useNavigate();
  const [payload, setPayload] = useState(null);
  const [error, setError] = useState(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [decomposed, setDecomposed] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/learning/projects");
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setPayload(await response.json());
    } catch (loadError) {
      setError(loadError.message);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const runDecompose = async () => {
    setBusy(true);
    setError(null);
    try {
      const sources = draft.sourcesText.split("\n").map((line) => line.trim()).filter(Boolean);
      const response = await fetch("/api/learning/ai/decompose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: draft.title, description: draft.description, sources }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result?.error?.message ?? `HTTP ${response.status}`);
      setDecomposed(result.levels);
    } catch (decomposeError) {
      setError(decomposeError.message);
    } finally {
      setBusy(false);
    }
  };

  const confirmPublish = async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await fetch("/api/learning/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: draft.title,
          description: draft.description,
          slug: draft.slug || undefined,
          sources: draft.sourcesText.split("\n").map((line) => line.trim()).filter(Boolean),
        }),
      }).then(async (response) => {
        const result = await response.json();
        if (!response.ok) throw new Error(result?.error?.message ?? `HTTP ${response.status}`);
        return result;
      });
      const challengeResult = await fetch("/api/learning/ai/challenge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_title: draft.title, levels: decomposed }),
      }).then(async (response) => {
        const result = await response.json();
        if (!response.ok) throw new Error(result?.error?.message ?? `HTTP ${response.status}`);
        return result;
      });
      const challengeBySlug = new Map(challengeResult.challenges.map((entry) => [entry.slug, entry]));
      await fetch(`/api/learning/projects/${created.slug}/levels:publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          levels: decomposed.map((entry) => ({
            slug: entry.slug,
            title: entry.title,
            dependsOn: entry.depends_on,
            notes: entry.summary,
            challenge: challengeBySlug.get(entry.slug)?.challenge_md ?? "",
            rubric: challengeBySlug.get(entry.slug)?.rubric ?? [{ item: "待补充", points: 100 }],
          })),
        }),
      }).then(async (response) => {
        const result = await response.json();
        if (!response.ok) throw new Error(result?.error?.message ?? `HTTP ${response.status}`);
      });
      setWizardOpen(false);
      setDraft(EMPTY_DRAFT);
      setDecomposed(null);
      navigate(`/learning/${created.slug}`);
    } catch (publishError) {
      setError(publishError.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="learning-page">
      <PageHeader
        eyebrow="LEARNING QUESTS"
        title="学习闯关"
        description="知识点关卡地图：完成实践挑战，由 AI 按评分细则验证掌握度。"
      />
      {payload && !payload.aiConfigured ? (
        <p className="learning-notice">
          AI 未配置：复制 Workbench/.env.example 为 Workbench/.env 并填入 LEARNING_AI_* 后，才能使用拆解、出题与评分。浏览与手工自评不受影响。
        </p>
      ) : null}
      {error ? <p className="learning-error">{error}</p> : null}
      <div className="learning-toolbar">
        <button type="button" className="learning-primary" onClick={() => setWizardOpen(true)}>
          新建学习项目
        </button>
      </div>
      <div className="learning-grid">
        {(payload?.projects ?? []).map((project) => (
          <button
            key={project.slug}
            type="button"
            className="learning-card"
            onClick={() => navigate(`/learning/${project.slug}`)}
          >
            <span className="learning-card__title">{project.title}</span>
            <span className="learning-card__description">{project.description}</span>
            <span className="learning-progress">
              <span className="learning-progress__bar" style={{ width: `${project.progress.percent}%` }} />
            </span>
            <span className="learning-card__meta">
              已通关 {project.progress.mastered} / {project.progress.total} · {project.progress.percent}%
            </span>
          </button>
        ))}
        {payload && payload.total === 0 ? <p className="learning-empty">还没有学习项目，点击上方按钮创建。</p> : null}
      </div>

      {wizardOpen ? (
        <div className="learning-modal" role="dialog" aria-label="新建学习项目">
          <div className="learning-modal__body">
            <h2>新建学习项目</h2>
            <label>
              项目名称
              <input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
            </label>
            <label>
              slug（可选，小写字母数字连字符）
              <input value={draft.slug} onChange={(event) => setDraft({ ...draft, slug: event.target.value })} />
            </label>
            <label>
              学习目标描述
              <textarea rows={3} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} />
            </label>
            <label>
              挂接 Vault 资料路径（每行一个，可选）
              <textarea rows={3} value={draft.sourcesText} onChange={(event) => setDraft({ ...draft, sourcesText: event.target.value })} />
            </label>
            {!decomposed ? (
              <button type="button" className="learning-primary" disabled={busy || !draft.title.trim()} onClick={runDecompose}>
                {busy ? "AI 拆解中…" : "AI 拆解关卡"}
              </button>
            ) : (
              <>
                <h3>关卡草稿（可删除行、编辑依赖）</h3>
                <table className="learning-table">
                  <thead>
                    <tr><th>slug</th><th>标题</th><th>前置依赖（逗号分隔）</th><th /></tr>
                  </thead>
                  <tbody>
                    {decomposed.map((entry, index) => (
                      <tr key={entry.slug}>
                        <td>{entry.slug}</td>
                        <td>
                          <input
                            value={entry.title}
                            onChange={(event) => setDecomposed(decomposed.map((item, i) => i === index ? { ...item, title: event.target.value } : item))}
                          />
                        </td>
                        <td>
                          <input
                            value={entry.depends_on.join(",")}
                            onChange={(event) => setDecomposed(decomposed.map((item, i) => i === index
                              ? { ...item, depends_on: event.target.value.split(",").map((value) => value.trim()).filter(Boolean) }
                              : item))}
                          />
                        </td>
                        <td>
                          <button type="button" onClick={() => setDecomposed(decomposed.filter((_, i) => i !== index))}>删除</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <button type="button" className="learning-primary" disabled={busy || decomposed.length === 0} onClick={confirmPublish}>
                  {busy ? "生成挑战并上架中…" : "确认上架（AI 生成挑战）"}
                </button>
              </>
            )}
            <button type="button" className="learning-link" onClick={() => { setWizardOpen(false); setDecomposed(null); }}>
              取消
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
```

`Workbench/src/styles/learning.css`（在 `Workbench/src/styles.css` 顶部追加 `@import "./styles/learning.css";`）:

```css
.learning-page { padding: 24px; max-width: 1200px; margin: 0 auto; }
.learning-notice { padding: 12px 16px; border: 1px solid #b45309; border-radius: 8px; color: #b45309; background: #fffbeb; }
.learning-error { padding: 12px 16px; border: 1px solid #b91c1c; border-radius: 8px; color: #b91c1c; background: #fef2f2; white-space: pre-wrap; }
.learning-toolbar { margin: 16px 0; display: flex; gap: 12px; }
.learning-primary { padding: 8px 16px; border-radius: 8px; border: none; background: #2563eb; color: #fff; cursor: pointer; }
.learning-primary:disabled { opacity: 0.5; cursor: not-allowed; }
.learning-link { background: none; border: none; color: #2563eb; cursor: pointer; margin-left: 12px; }
.learning-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; }
.learning-card { text-align: left; padding: 16px; border: 1px solid #e5e7eb; border-radius: 12px; background: #fff; cursor: pointer; display: flex; flex-direction: column; gap: 8px; }
.learning-card:hover { border-color: #2563eb; }
.learning-card__title { font-weight: 600; font-size: 16px; }
.learning-card__description { color: #6b7280; font-size: 13px; }
.learning-card__meta { color: #6b7280; font-size: 12px; }
.learning-progress { height: 6px; border-radius: 3px; background: #e5e7eb; overflow: hidden; }
.learning-progress__bar { display: block; height: 100%; background: #2563eb; transition: width 0.3s; }
.learning-empty { color: #6b7280; }
.learning-modal { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45); display: flex; align-items: center; justify-content: center; z-index: 40; }
.learning-modal__body { background: #fff; border-radius: 12px; padding: 24px; width: min(720px, 92vw); max-height: 86vh; overflow: auto; display: flex; flex-direction: column; gap: 12px; }
.learning-modal__body label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: #374151; }
.learning-modal__body input, .learning-modal__body textarea { padding: 8px; border: 1px solid #d1d5db; border-radius: 6px; font: inherit; }
.learning-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.learning-table th, .learning-table td { border-bottom: 1px solid #e5e7eb; padding: 6px 8px; text-align: left; }
.learning-table input { width: 100%; padding: 4px 6px; border: 1px solid #d1d5db; border-radius: 4px; }
.learning-tabs { display: flex; gap: 8px; margin: 16px 0; }
.learning-tabs button { padding: 6px 14px; border-radius: 999px; border: 1px solid #d1d5db; background: #fff; cursor: pointer; }
.learning-tabs button[aria-pressed="true"] { background: #2563eb; color: #fff; border-color: #2563eb; }
.learning-drawer { position: fixed; top: 0; right: 0; bottom: 0; width: min(560px, 94vw); background: #fff; border-left: 1px solid #e5e7eb; box-shadow: -8px 0 24px rgba(15,23,42,0.12); padding: 24px; overflow: auto; z-index: 30; }
.learning-drawer h3 { margin: 18px 0 8px; }
.learning-drawer textarea { width: 100%; padding: 8px; border: 1px solid #d1d5db; border-radius: 6px; font: inherit; }
.learning-rubric { padding-left: 18px; }
.learning-attempt { border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px; margin-bottom: 8px; font-size: 13px; }
.learning-attempt pre { white-space: pre-wrap; background: #f9fafb; padding: 8px; border-radius: 6px; }
.quest-map { width: 100%; height: 70vh; border: 1px solid #e5e7eb; border-radius: 12px; background: #f8fafc; }
.quest-node { cursor: pointer; }
.quest-node--locked circle { fill: #d1d5db; }
.quest-node--available circle { fill: #fbbf24; filter: drop-shadow(0 0 6px #fbbf24); animation: quest-pulse 1.6s infinite; }
.quest-node--challenged circle { fill: #3b82f6; }
.quest-node--mastered circle { fill: #22c55e; }
.quest-node--self circle { stroke: #22c55e; stroke-dasharray: 4 3; stroke-width: 2; fill: #fff; }
.quest-node text { font-size: 11px; fill: #111827; pointer-events: none; }
.quest-edge { stroke: #cbd5e1; stroke-width: 1.5; }
.quest-edge--open { stroke: #22c55e; }
@keyframes quest-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.55; } }
```

- [x] **步骤 2：手动验证**

`npm run dev`，打开 `/learning`（路由在任务 12 注册，此步骤可先用直接组件渲染或等任务 12 一并验证）。预期：看到 demo 项目卡片，进度 33%；点「新建学习项目」弹出向导。

- [x] **步骤 3：Commit**

```bash
git add Workbench/src/pages/LearningPage.jsx Workbench/src/styles/learning.css Workbench/src/styles.css
git commit -m "feat(learning): add learning projects page with creation wizard"
```

---

### 任务 10:LearningProjectPage — 双 Tab 与关卡详情抽屉

**文件：**
- 创建：`Workbench/src/pages/LearningProjectPage.jsx`

- [x] **步骤 1：编写组件**

```jsx
import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";
import { QuestMap } from "../components/learning/QuestMap";

const STATUS_LABEL = { locked: "未解锁", available: "可挑战", challenged: "挑战中", mastered: "已通关" };

function LevelDrawer({ projectSlug, levelSlug, aiConfigured, onClose, onChanged }) {
  const [detail, setDetail] = useState(null);
  const [attempts, setAttempts] = useState([]);
  const [submission, setSubmission] = useState("");
  const [refsText, setRefsText] = useState("");
  const [pending, setPending] = useState(null); // { attemptId, probes }
  const [answers, setAnswers] = useState([]);
  const [message, setMessage] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [levelResponse, attemptsResponse] = await Promise.all([
      fetch(`/api/learning/projects/${projectSlug}/levels/${levelSlug}`),
      fetch(`/api/learning/projects/${projectSlug}/levels/${levelSlug}/attempts`),
    ]);
    setDetail(await levelResponse.json());
    setAttempts((await attemptsResponse.json()).attempts ?? []);
  }, [projectSlug, levelSlug]);

  useEffect(() => { void load(); }, [load]);

  const post = async (suffix, body) => {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/learning/projects/${projectSlug}/levels/${levelSlug}/${suffix}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result?.error?.message ?? `HTTP ${response.status}`);
      return result;
    } catch (error) {
      setMessage(error.message);
      return null;
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    const result = await post("submit", {
      content_md: submission,
      vault_refs: refsText.split("\n").map((line) => line.trim()).filter(Boolean),
    });
    if (!result) return;
    if (result.needsProbe) {
      setPending(result);
      setAnswers(result.probes.map(() => ""));
    } else {
      setMessage(result.verdict === "passed" ? `通关！得分 ${result.score}` : `未达标，得分 ${result.score}。${result.feedback ?? ""}`);
      setSubmission("");
      await load();
      onChanged();
    }
  };

  const answerProbe = async () => {
    const result = await post("probe", { attempt_id: pending.attemptId, answers });
    if (!result) return;
    setPending(null);
    setMessage(result.verdict === "passed" ? `追问通过，通关！得分 ${result.score}` : `追问未通过，得分 ${result.score}。${result.feedback ?? ""}`);
    await load();
    onChanged();
  };

  const retry = async () => {
    const result = await post("retry", {});
    if (result) await load();
  };

  const selfAssess = async () => {
    const result = await post("self-assess", {});
    if (result) {
      setMessage("已标记为自评掌握（与 AI 验证通关区分显示）。");
      await load();
      onChanged();
    }
  };

  if (!detail) return null;
  const status = detail.frontmatter.status;
  return (
    <aside className="learning-drawer" role="dialog" aria-label={`关卡 ${detail.frontmatter.title}`}>
      <button type="button" className="learning-link" onClick={onClose}>关闭</button>
      <h2>{detail.frontmatter.title}</h2>
      <p>
        状态：{STATUS_LABEL[status] ?? status} · 掌握度 {detail.frontmatter.mastery} · 过关线 {detail.frontmatter.pass_score ?? 80}
        {detail.frontmatter.verified_by === "self-assessed" ? " · 自评通关" : null}
        {detail.frontmatter.verified_by === "ai-verified" ? " · AI 验证通关" : null}
      </p>
      <h3>知识点笔记</h3>
      <p style={{ whiteSpace: "pre-wrap" }}>{detail.notes}</p>
      <h3>挑战</h3>
      <p style={{ whiteSpace: "pre-wrap" }}>{detail.challenge}</p>
      <h3>评分细则</h3>
      <ul className="learning-rubric">
        {detail.rubric.map((entry) => <li key={entry.item}>[{entry.points}分] {entry.item}</li>)}
      </ul>

      {status !== "locked" && status !== "mastered" ? (
        <>
          <h3>提交产物</h3>
          <textarea rows={8} placeholder="粘贴代码、练习结果、讲解文字（Markdown）" value={submission} onChange={(event) => setSubmission(event.target.value)} />
          <textarea rows={2} placeholder="引用 Vault 文件路径（每行一个，可选）" value={refsText} onChange={(event) => setRefsText(event.target.value)} />
          <div className="learning-toolbar">
            <button type="button" className="learning-primary" disabled={busy || !submission.trim() || !aiConfigured} onClick={submit}>
              {busy ? "AI 评审中…" : "提交验证"}
            </button>
            <button type="button" className="learning-link" disabled={busy || !aiConfigured} onClick={retry}>换一道变体题</button>
            <button type="button" className="learning-link" disabled={busy} onClick={selfAssess}>手工自评掌握</button>
          </div>
        </>
      ) : null}

      {pending ? (
        <>
          <h3>追问环节</h3>
          {pending.probes.map((probe, index) => (
            <div key={probe}>
              <p>{probe}</p>
              <textarea rows={3} value={answers[index]} onChange={(event) => setAnswers(answers.map((value, i) => i === index ? event.target.value : value))} />
            </div>
          ))}
          <button type="button" className="learning-primary" disabled={busy || answers.some((answer) => !answer.trim())} onClick={answerProbe}>
            {busy ? "判定中…" : "提交追问回答"}
          </button>
        </>
      ) : null}

      {message ? <p className="learning-notice">{message}</p> : null}

      <h3>验证历史</h3>
      {attempts.length === 0 ? <p className="learning-empty">还没有验证记录。</p> : null}
      {attempts.map((attempt) => (
        <div key={attempt.id} className="learning-attempt">
          <strong>{attempt.created}</strong> · {attempt.verdict} · {attempt.score} 分
          <pre>{attempt.body.slice(0, 600)}</pre>
        </div>
      ))}
    </aside>
  );
}

export function LearningProjectPage() {
  const { projectSlug } = useParams();
  const [detail, setDetail] = useState(null);
  const [tab, setTab] = useState("map");
  const [selected, setSelected] = useState(null);

  const load = useCallback(async () => {
    const response = await fetch(`/api/learning/projects/${projectSlug}`);
    if (response.ok) setDetail(await response.json());
  }, [projectSlug]);

  useEffect(() => { void load(); }, [load]);

  if (!detail) return <div className="learning-page">加载中…</div>;

  return (
    <div className="learning-page">
      <PageHeader eyebrow="LEARNING QUEST" title={detail.title} description={detail.description} />
      <div className="learning-progress" aria-label={`项目进度 ${detail.progress.percent}%`}>
        <span className="learning-progress__bar" style={{ width: `${detail.progress.percent}%` }} />
      </div>
      <p className="learning-card__meta">已通关 {detail.progress.mastered} / {detail.progress.total} · {detail.progress.percent}%</p>
      <div className="learning-tabs" role="tablist">
        <button type="button" aria-pressed={tab === "map"} onClick={() => setTab("map")}>闯关地图</button>
        <button type="button" aria-pressed={tab === "list"} onClick={() => setTab("list")}>关卡管理</button>
      </div>

      {tab === "map" ? (
        <QuestMap levels={detail.levels} onSelect={(level) => setSelected(level.slug)} />
      ) : (
        <table className="learning-table">
          <thead>
            <tr><th>关卡</th><th>状态</th><th>掌握度</th><th>前置</th><th>验证次数</th></tr>
          </thead>
          <tbody>
            {detail.levels.map((level) => (
              <tr key={level.slug} onClick={() => setSelected(level.slug)} style={{ cursor: "pointer" }}>
                <td>{level.title}</td>
                <td>{STATUS_LABEL[level.effectiveStatus]}{level.verifiedBy === "self-assessed" ? "（自评）" : ""}</td>
                <td>{level.mastery}</td>
                <td>{level.dependsOn.join(", ") || "—"}</td>
                <td>{level.attemptCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {selected ? (
        <LevelDrawer
          projectSlug={projectSlug}
          levelSlug={selected}
          aiConfigured={detail.aiConfigured}
          onClose={() => setSelected(null)}
          onChanged={load}
        />
      ) : null}
    </div>
  );
}
```

- [x] **步骤 2：手动验证**

`npm run dev`，进入 `/learning/react-state-management`：切到「关卡管理」Tab，点击 `context-basics` 行打开抽屉，看到挑战与 rubric；`react-rerender` 显示「已通关 · AI 验证通关」与 90 分掌握度，验证历史有 1 条。

- [x] **步骤 3：Commit**

```bash
git add Workbench/src/pages/LearningProjectPage.jsx
git commit -m "feat(learning): add project page with level drawer and challenge flow"
```

---

### 任务 11:QuestMap — d3-force 闯关地图

**文件：**
- 创建：`Workbench/src/components/learning/QuestMap.jsx`

- [x] **步骤 1：编写组件**

```jsx
import { useEffect, useMemo, useRef, useState } from "react";
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
} from "d3-force";

const NODE_RADIUS = 22;

function nodeClass(level) {
  if (level.effectiveStatus === "mastered" && level.verifiedBy === "self-assessed") return "quest-node quest-node--self";
  return `quest-node quest-node--${level.effectiveStatus}`;
}

export function QuestMap({ levels, onSelect }) {
  const containerRef = useRef(null);
  const [size, setSize] = useState({ width: 900, height: 560 });
  const [positions, setPositions] = useState([]);

  const nodes = useMemo(
    () => levels.map((level) => ({ id: level.slug, level })),
    [levels],
  );
  const links = useMemo(
    () => levels.flatMap((level) => level.dependsOn.map((source) => ({ source, target: level.slug }))),
    [levels],
  );

  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const simulation = forceSimulation(nodes)
      .force("link", forceLink(links).id((node) => node.id).distance(140))
      .force("charge", forceManyBody().strength(-260))
      .force("collide", forceCollide(NODE_RADIUS + 26))
      .force("center", forceCenter(size.width / 2, size.height / 2));
    simulation.on("tick", () => {
      setPositions(nodes.map((node) => ({ id: node.id, x: node.x, y: node.y, level: node.level })));
    });
    return () => simulation.stop();
  }, [nodes, links, size]);

  const positionById = new Map(positions.map((entry) => [entry.id, entry]));

  return (
    <div ref={containerRef} className="quest-map" role="img" aria-label="闯关地图">
      <svg width={size.width} height={size.height}>
        {links.map((link, index) => {
          const source = positionById.get(typeof link.source === "object" ? link.source.id : link.source);
          const target = positionById.get(typeof link.target === "object" ? link.target.id : link.target);
          if (!source || !target) return null;
          const open = source.level.effectiveStatus === "mastered";
          return (
            <line
              key={index}
              className={open ? "quest-edge quest-edge--open" : "quest-edge"}
              x1={source.x} y1={source.y} x2={target.x} y2={target.y}
            />
          );
        })}
        {positions.map((entry) => (
          <g
            key={entry.id}
            className={nodeClass(entry.level)}
            transform={`translate(${entry.x},${entry.y})`}
            onClick={() => onSelect(entry.level)}
          >
            <circle r={NODE_RADIUS} />
            <title>{`${entry.level.title} · ${entry.level.effectiveStatus} · 掌握度 ${entry.level.mastery}`}</title>
            <text y={NODE_RADIUS + 14} textAnchor="middle">{entry.level.title}</text>
            {entry.level.effectiveStatus === "mastered" ? (
              <text y={4} textAnchor="middle" fill="#fff">{entry.level.mastery}</text>
            ) : null}
          </g>
        ))}
      </svg>
    </div>
  );
}
```

- [x] **步骤 2：手动验证**

`npm run dev`，进入 `/learning/react-state-management` 的「闯关地图」Tab:`react-rerender` 绿色含 90 分、`context-basics` 黄色脉冲、`zustand-store` 灰色；边从 `react-rerender` 指向 `context-basics` 且为绿色。点击节点打开抽屉。

- [x] **步骤 3：Commit**

```bash
git add Workbench/src/components/learning/QuestMap.jsx
git commit -m "feat(learning): add d3-force quest map"
```

---

### 任务 12：路由、导航与 package.json 脚本

**文件：**
- 修改:`Workbench/src/App.jsx`
- 修改：`Workbench/src/components/AppShell.jsx`
- 修改：`Workbench/package.json`

- [x] **步骤 1:App.jsx 注册路由**

import 区加：

```js
import { LearningPage } from "./pages/LearningPage";
import { LearningProjectPage } from "./pages/LearningProjectPage";
```

在 `<Route path="/books" ... />` 之前加：

```jsx
<Route path="/learning" element={<LearningPage />} />
<Route path="/learning/:projectSlug" element={<LearningProjectPage />} />
```

- [x] **步骤 2:AppShell.jsx 注册导航**

import 区加 `IconTrophy`（来自 `@tabler/icons-react`，与现有 icon 同一来源），导航数组在 `{ to: "/books", ... }` 之后加：

```js
{ to: "/learning", label: "学习闯关", icon: IconTrophy },
```

- [x] **步骤 3:package.json 加脚本**

scripts 中 `"test:books"` 之后加：

```json
"test:learning": "node --test tests/learning-schema.test.mjs tests/learning-unlock.test.mjs tests/learning-ai.test.mjs",
```

- [x] **步骤 4：手动验证**

`npm run dev`：侧边导航出现「学习闯关」，点击进入 `/learning`；点击卡片进入项目页。

- [x] **步骤 5：Commit**

```bash
git add Workbench/src/App.jsx Workbench/src/components/AppShell.jsx Workbench/package.json
git commit -m "feat(learning): wire learning routes and navigation"
```

---

### 任务 13：发布门禁

**文件：** 无新文件

- [x] **步骤 1：全量测试**

运行（在 `Workbench/` 下）:`npm test`
预期：全部测试 PASS（含新增 20 个 learning 用例；`npm test` 内含 build）

- [x] **步骤 2:隐私扫描**

运行：`npm run privacy:scan`
预期：无命中（检查 `.env.example` 未被判为凭据赋值、demo 无个人标识）

- [x] **步骤 3:修复任何失败**

如有失败，修复后重跑步骤 1-2，直到全绿。

- [x] **步骤 4：最终 Commit**

```bash
git add -A
git commit -m "chore(learning): pass release gates" --allow-empty
```

---

## 自检结果

**规格覆盖度：**
- §3 Schema → 任务 1、8 ✓
- §4.1 数据端点 → 任务 3（store)+ 6、7（路由）✓;`updateLevel` 端点为 PUT，与规格一致 ✓
- §4.2 AI 端点 → 任务 4、5、7 ✓(grade 走 submit/probe 内部编排，不单独暴露，与规格「追问的回答走 grade 端点的追问模式」一致 ✓)
- §5 状态机/模糊带/mastery/ai-verified 保护 → 任务 3 `applyOutcome` 与 `submitAttempt` ✓
- §6 前端视图 → 任务 9、10、11 ✓
- §7 降级与自评 → `requireAi`、`aiConfigured` 提示、self-assess ✓
- §8 错误处理 → `learningError` 映射、原子写、环检测 422 ✓
- §9 测试 → 任务 1-5 的测试文件 + 任务 13 门禁 ✓
- §10 公开边界 → 任务 8 demo + 门禁验证 ✓

**已知偏差（有意为之，执行时保持一致）:**
- attempt frontmatter 的 `verdict` 增加了 `pending_probe` 中间态（规格只列终态），追问完成后落终态，属实现的必要补充。
- `serializeFrontmatter` 遇到嵌套对象时用 `JSON.stringify` 输出（如 `progress: {"total":0,...}`），`parseScalar` 不把它还原为对象而是当作字符串；但 `projectsPayload` 不读该字段、实时重算进度，所以无影响。

**占位符扫描：** 无 TODO/待定；所有代码步骤含完整代码。
**类型一致性：** store 方法名（`readProjectDetail`/`readLevelDetail`/`publishLevels`/`submitAttempt`/`answerProbe`/`retryVariant`/`selfAssess`/`listAttempts`/`updateLevel`/`createProject`）在任务 3 定义、任务 6-7 消费，一致；前端字段（`effectiveStatus`/`verifiedBy`/`passScore`/`attemptCount`）与任务 2 `projectDetailPayload` 输出一致。
