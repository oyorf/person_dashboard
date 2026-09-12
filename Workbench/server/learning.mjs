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
  if (value === "") return '""';
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
  // 关卡顺序以项目 frontmatter 的 levels 数组为准（章节顺序），未列出的关卡排在最后
  const declaredOrder = project.frontmatter.levels ?? [];
  const orderIndex = new Map(declaredOrder.map((slug, index) => [slug, index]));
  const ordered = [...levels].sort((left, right) => {
    const leftIndex = orderIndex.get(left.slug) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = orderIndex.get(right.slug) ?? Number.MAX_SAFE_INTEGER;
    return leftIndex - rightIndex || left.slug.localeCompare(right.slug, "en");
  });
  return {
    slug: project.frontmatter.slug,
    title: project.frontmatter.title,
    description: project.frontmatter.description ?? "",
    sources: project.frontmatter.sources ?? [],
    body: project.body,
    progress: computeProgress(levels),
    levels: ordered.map((entry) => ({
      slug: entry.slug,
      title: entry.frontmatter.title,
      chapter: entry.frontmatter.chapter ?? null,
      source: entry.frontmatter.source ?? null,
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
