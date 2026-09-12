// 求职匹配：硬过滤纯函数 + LLM 打分（复用 learning-ai 的 OpenAI 兼容配置）。
import { callChatCompletions, parseAiJson } from "./learning-ai.mjs";

// ---- 薪资解析 ----

function toK(value, unit) {
  if (unit === "万") return value * 10;
  return value; // K / 千 都按 K 处理
}

// "15-25K·14薪" → 15；"1.5-2.5万" → 15；"15K以上" → 15；面议/无法解析 → null
export function parseSalaryMinK(text) {
  const raw = String(text ?? "").trim();
  if (!raw || /面议/.test(raw)) return null;
  const range = raw.match(/(\d+(?:\.\d+)?)\s*[-~–—]\s*(\d+(?:\.\d+)?)\s*([kK万千])/);
  if (range) return toK(Number(range[1]), range[3]);
  const above = raw.match(/(\d+(?:\.\d+)?)\s*([kK万千])?\s*以上/);
  if (above) return toK(Number(above[1]), above[2] ?? "K");
  return null;
}

// ---- 经验年限解析（BOSS tag 如 "1-3年"、"经验不限"、"1年以内"） ----

export function parseExperienceRange(tags) {
  for (const tag of Array.isArray(tags) ? tags : []) {
    const text = String(tag);
    if (/经验不限|不限经验/.test(text)) return null;
    const range = text.match(/(\d+)\s*[-~–—]\s*(\d+)\s*年/);
    if (range) return [Number(range[1]), Number(range[2])];
    const within = text.match(/(\d+)\s*年以内/);
    if (within) return [0, Number(within[1])];
    const above = text.match(/(\d+)\s*年以上/);
    if (above) return [Number(above[1]), 99];
  }
  return null;
}

// ---- 公司规模解析（companyTags 如 "100-499人"、"10000人以上"） ----

export function parseCompanySize(companyTags) {
  for (const tag of Array.isArray(companyTags) ? companyTags : []) {
    const text = String(tag);
    const range = text.match(/(\d+)\s*[-~–—]\s*(\d+)\s*人/);
    if (range) return { min: Number(range[1]), max: Number(range[2]), label: text };
    const above = text.match(/(\d+)\s*人以上/);
    if (above) return { min: Number(above[1]), max: Number.POSITIVE_INFINITY, label: text };
    const below = text.match(/少于\s*(\d+)\s*人/);
    if (below) return { min: 0, max: Number(below[1]), label: text };
  }
  return null;
}

// ---- 硬过滤 ----

export function hardFilterJob(job, profile) {
  const reasons = [];

  const cities = Array.isArray(profile?.cities) ? profile.cities : [];
  const city =
    [job?.city, job?.queryCity, job?.area]
      .map((value) => String(value ?? "").trim())
      .find(Boolean) ?? "";
  if (cities.length && !cities.some((target) => city.includes(target))) {
    reasons.push(`城市「${city || "未知"}」不在目标范围（${cities.join("/")}）`);
  }

  const minK = parseSalaryMinK(job?.salary);
  const minSalaryK = Number(profile?.minSalaryK);
  if (minK != null && Number.isFinite(minSalaryK) && minK < minSalaryK) {
    reasons.push(`薪资下限 ${minK}K 低于要求 ${minSalaryK}K`);
  }

  const experience = parseExperienceRange(job?.tags);
  const wanted = Array.isArray(profile?.experienceYears) ? profile.experienceYears : null;
  if (experience && wanted?.length === 2) {
    const [low, high] = wanted.map(Number);
    // 岗位最低年限触及画像上限即视为超出（如画像 1-5 年 vs 岗位 5-10 年）
    if (experience[0] >= high || experience[1] < low) {
      reasons.push(`经验要求 ${experience[0]}-${experience[1]} 年超出 ${low}-${high} 年区间`);
    }
  }

  const keywords = profile?.exclude?.companyKeywords ?? [];
  const haystack = `${job?.company ?? ""} ${job?.title ?? ""}`;
  for (const keyword of keywords) {
    if (keyword && haystack.includes(keyword)) {
      reasons.push(`命中排除关键词「${keyword}」`);
    }
  }

  const size = parseCompanySize(job?.companyTags);
  const maxSize = Number(profile?.exclude?.maxCompanySize);
  if (size && Number.isFinite(maxSize) && size.min > maxSize) {
    reasons.push(`公司规模「${size.label}」超过 ${maxSize} 人上限`);
  }

  return { pass: reasons.length === 0, reasons };
}

// ---- LLM 打分 ----

const SYSTEM_JSON =
  "你是求职匹配评估助手。你只输出 JSON，不输出任何解释性文字，Markdown 代码围栏以外的内容也必须是合法 JSON。";

export function buildScorePrompt({ profile, job }) {
  return {
    system: SYSTEM_JSON,
    user: [
      "根据求职者画像为岗位打匹配分（0-10 整数）。",
      `求职者画像：${profile?.resumeSummary ?? "（未填写）"}`,
      `目标行业：${(profile?.industries ?? []).join("、") || "不限"}；目标公司：${(profile?.targetCompanies ?? []).join("、") || "无特定"}`,
      `岗位信息：${JSON.stringify({
        title: job?.title,
        company: job?.company,
        city: job?.city,
        salary: job?.salary,
        tags: job?.tags,
        companyTags: job?.companyTags,
        description: String(job?.description ?? "").slice(0, 2000),
      })}`,
      "评分维度：技术栈匹配、行业契合、成长空间、稳定性。目标公司/目标行业可加分。",
      '输出 JSON：{"score":0,"reasons":["理由1","理由2"]}（reasons 1-3 条，每条不超过 40 字）',
    ].join("\n"),
  };
}

export function parseScoreResult(text) {
  const output = parseAiJson(text);
  const score = Number(output.score);
  if (!Number.isFinite(score)) throw new TypeError("AI 输出缺少数值字段: score");
  return {
    score: Math.min(10, Math.max(0, Math.round(score))),
    reasons: (Array.isArray(output.reasons) ? output.reasons : []).map(String).filter(Boolean).slice(0, 3),
  };
}

// ---- 手动投喂 JD 清洗 ----

export function buildImportPrompt({ text }) {
  return {
    system: SYSTEM_JSON,
    user: [
      "从招聘 JD 原文中抽取结构化字段。无法确定的字段填空字符串或空数组，不要编造。",
      `JD 原文（截断于 4000 字）：\n${String(text ?? "").slice(0, 4000)}`,
      '输出 JSON：{"title":"","company":"","city":"","salary":"","tags":[],"companyTags":[],"description":""}',
      "salary 保留原文写法（如 15-25K·14薪）；tags 放经验/学历要求（如 1-3年、本科）；companyTags 放公司规模/融资阶段（如 100-499人）；description 放职责与要求正文。",
    ].join("\n"),
  };
}

export function parseImportResult(text) {
  const output = parseAiJson(text);
  const title = String(output.title ?? "").trim();
  if (!title) throw new TypeError("AI 输出缺少字符串字段: title");
  return {
    title,
    company: String(output.company ?? "").trim(),
    city: String(output.city ?? "").trim(),
    salary: String(output.salary ?? "").trim(),
    tags: (Array.isArray(output.tags) ? output.tags : []).map(String).filter(Boolean),
    companyTags: (Array.isArray(output.companyTags) ? output.companyTags : []).map(String).filter(Boolean),
    description: String(output.description ?? ""),
    source: "manual",
  };
}

export function createJobScorer(config) {
  const run = async (prompt, parse) =>
    parse(
      await callChatCompletions(config, [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ]),
    );
  return {
    score: (input) => run(buildScorePrompt(input), parseScoreResult),
    importJd: (input) => run(buildImportPrompt(input), parseImportResult),
  };
}
