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
  return `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
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
    const client = typeof ai === "function" ? ai() : ai;
    if (!client) {
      const error = new Error("AI 未配置：请在「系统状态」页保存 LEARNING_AI 配置，或在 Workbench/.env 配置 LEARNING_AI_BASE_URL / LEARNING_AI_API_KEY / LEARNING_AI_MODEL。");
      error.code = "AI_NOT_CONFIGURED";
      throw error;
    }
    return client;
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
