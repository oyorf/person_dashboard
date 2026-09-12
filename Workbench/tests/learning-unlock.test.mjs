import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildLevelStates,
  computeProgress,
  projectDetailPayload,
  projectsPayload,
  validateDag,
} from "../server/learning.mjs";

import { createLearningStore } from "../server/learning-store.mjs";

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
      { path: "60_learning/demo/index.md", fileName: "index.md", title: "演示项目",
        frontmatter: { type: "learning-project", title: "演示项目", slug: "demo", description: "合成演示", created: "2026-09-01T00:00:00+08:00", sources: [], levels: ["a", "b"] } },
      { path: "60_learning/demo/levels/a.md", fileName: "a.md", title: "A",
        frontmatter: { type: "learning-level", project: "demo", title: "A", status: "mastered", mastery: 90, depends_on: [] } },
      { path: "60_learning/demo/levels/b.md", fileName: "b.md", title: "B",
        frontmatter: { type: "learning-level", project: "demo", title: "B", status: "locked", mastery: 0, depends_on: ["a"] } },
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
  await assert.rejects(() => store.createProject({ title: "演示项目", description: "", sources: [] }), /slug/);

  await store.publishLevels(slug, [
    { slug: "root", title: "入口关", dependsOn: [], notes: "学这个", challenge: "做练习", rubric: [{ item: "完成练习", points: 100 }] },
    { slug: "next", title: "进阶关", dependsOn: ["root"], notes: "", challenge: "", rubric: [{ item: "待定", points: 100 }] },
  ]);
  const detail = await store.readProjectDetail(slug);
  assert.equal(detail.levels.length, 2);
  assert.equal(detail.levels.find((item) => item.slug === "root").effectiveStatus, "available");
  assert.equal(detail.levels.find((item) => item.slug === "next").effectiveStatus, "locked");

  await assert.rejects(
    () => store.publishLevels(slug, [{ slug: "loop", title: "环", dependsOn: ["loop"], notes: "", challenge: "", rubric: [{ item: "x", points: 100 }] }]),
    /环/,
  );
});

test("submitAttempt grades via ai client, writes attempt and masters level", async (t) => {
  const vaultRoot = await makeVault(t);
  const store = createLearningStore({
    vaultRoot,
    ai: {
      async grade(input) {
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
  assert.equal(pending.needsProbe, true);
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
  assert.equal(detail.levels[0].verifiedBy, "ai-verified");
});
