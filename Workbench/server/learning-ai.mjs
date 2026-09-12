import { readFileSync, promises as fsp } from "node:fs";
import path from "node:path";

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

const AI_TIMEOUT_MS = 60_000;
const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o-mini";
export const LEARNING_AI_CONFIG_FILE = "config/learning-ai.local.json";

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
    baseUrl: (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    apiKey,
    model: model || DEFAULT_MODEL,
  };
}

// ---- 系统设置页维护的本地配置文件（gitignored，优先级高于 .env） ----

export function readLearningAiFileConfig(workbenchRoot) {
  try {
    const raw = JSON.parse(readFileSync(path.join(workbenchRoot, LEARNING_AI_CONFIG_FILE), "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const parsed = {
      baseUrl: typeof raw.baseUrl === "string" ? raw.baseUrl.trim() : "",
      apiKey: typeof raw.apiKey === "string" ? raw.apiKey.trim() : "",
      model: typeof raw.model === "string" ? raw.model.trim() : "",
    };
    if (raw.headers && typeof raw.headers === "object" && !Array.isArray(raw.headers)) {
      parsed.headers = Object.fromEntries(
        Object.entries(raw.headers).map(([k, v]) => [k, String(v)]),
      );
    }
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export function resolveLearningAiConfig({ env = process.env, fileConfig = null } = {}) {
  const envConfig = loadLearningAiConfig({ env });
  if (fileConfig?.apiKey) {
    const resolved = {
      baseUrl: (fileConfig.baseUrl || envConfig?.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, ""),
      apiKey: fileConfig.apiKey,
      model: fileConfig.model || envConfig?.model || DEFAULT_MODEL,
    };
    if (fileConfig.headers && Object.keys(fileConfig.headers).length > 0) {
      resolved.headers = fileConfig.headers;
    }
    return resolved;
  }
  return envConfig;
}

export async function saveLearningAiFileConfig(workbenchRoot, { baseUrl = "", apiKey = "", model = "" } = {}) {
  const existing = readLearningAiFileConfig(workbenchRoot) ?? { baseUrl: "", apiKey: "", model: "" };
  const next = {
    schemaVersion: 1,
    baseUrl: String(baseUrl || existing.baseUrl || "").trim(),
    apiKey: String(apiKey || existing.apiKey || "").trim(),
    model: String(model || existing.model || "").trim(),
  };
  if (!next.apiKey) {
    const error = new Error("保存 AI 配置需要 API Key（首次保存时必填）。");
    error.code = "LEARNING_AI_KEY_REQUIRED";
    throw error;
  }
  if (next.baseUrl && !/^https?:\/\//.test(next.baseUrl)) {
    const error = new Error("Base URL 必须以 http:// 或 https:// 开头。");
    error.code = "INVALID_LEARNING_AI_BASE_URL";
    throw error;
  }
  const filePath = path.join(workbenchRoot, LEARNING_AI_CONFIG_FILE);
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}`;
  await fsp.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await fsp.rename(temporary, filePath);
  return next;
}

export function describeLearningAiConfig(config, source = null) {
  if (!config) {
    return { configured: false, baseUrl: null, model: null, apiKeyPreview: null, source: null };
  }
  const key = String(config.apiKey ?? "");
  return {
    configured: true,
    baseUrl: config.baseUrl,
    model: config.model,
    apiKeyPreview: key.length > 4 ? `****${key.slice(-4)}` : "****",
    source: source ?? "unknown",
  };
}

export async function callChatCompletions(config, messages) {
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
          ...(config.headers ?? {}),
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
