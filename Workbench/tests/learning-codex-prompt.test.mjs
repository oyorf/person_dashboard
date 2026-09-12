import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { buildCodexQuizPrompt } from "../src/lib/codex-quiz.mjs";
import { parseLearningDocument, parseRubric, validateDag } from "../server/learning.mjs";

const VAULT_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)), "..", "个人知识库");
const NETTY_ROOT = path.join(VAULT_ROOT, "60_learning", "netty");

const LEVEL = {
  title: "TCP 粘包与拆包",
  notes: "TCP 是流协议，没有消息边界。",
  source: "60_learning/netty-handbook/_content/chapter09.md",
  rubric: [
    { item: "复现粘包", points: 30 },
    { item: "协议解码", points: 70 },
  ],
};

test("buildCodexQuizPrompt 包含关卡上下文、原文路径与 grill-me 流程要求", () => {
  const prompt = buildCodexQuizPrompt({ projectTitle: "Netty 网络编程闯关", level: LEVEL });
  assert.match(prompt, /Netty 网络编程闯关/);
  assert.match(prompt, /TCP 粘包与拆包/);
  assert.match(prompt, /chapter09\.md/);
  assert.match(prompt, /TCP 是流协议/);
  assert.match(prompt, /- \[30分\] 复现粘包/);
  assert.match(prompt, /- \[70分\] 协议解码/);
  // grill-me 流程关键约束
  assert.match(prompt, /一次只向我提一个问题/);
  assert.match(prompt, /不要给提示/);
  assert.match(prompt, /掌握度评分/);
});

test("buildCodexQuizPrompt 缺少原文时退化为按笔记判分", () => {
  const prompt = buildCodexQuizPrompt({ projectTitle: "Demo", level: { ...LEVEL, source: null } });
  assert.match(prompt, /以关卡笔记与挑战描述为准/);
  assert.doesNotMatch(prompt, /chapter09/);
});

test("netty 学习项目的 vault 文件符合 learning schema 且 DAG 合法", async () => {
  const project = parseLearningDocument(
    await readFile(path.join(NETTY_ROOT, "index.md"), "utf8"),
    "netty/index.md",
  );
  assert.equal(project.frontmatter.type, "learning-project");
  assert.equal(project.frontmatter.slug, "netty");

  const levels = [];
  for (const slug of project.frontmatter.levels) {
    const entry = parseLearningDocument(
      await readFile(path.join(NETTY_ROOT, "levels", `${slug}.md`), "utf8"),
      `netty/levels/${slug}.md`,
    );
    assert.equal(entry.frontmatter.type, "learning-level");
    assert.equal(entry.frontmatter.project, "netty");
    assert.ok(entry.frontmatter.source, `${slug} 应挂接原文 source`);
    // 每关评分细则必须可解析且总分 100
    assert.equal(parseRubric(entry.body).length > 0, true);
    levels.push({ slug, frontmatter: entry.frontmatter });
  }

  assert.equal(levels.length, 13);
  assert.equal(validateDag(levels).errors.length, 0);
  assert.equal(levels.filter((entry) => entry.frontmatter.depends_on.length === 0).length, 1);
});
