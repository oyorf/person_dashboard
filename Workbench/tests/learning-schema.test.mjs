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
