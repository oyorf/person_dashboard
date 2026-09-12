import assert from "node:assert/strict";
import test from "node:test";

import {
  buildScorePrompt,
  createJobScorer,
  hardFilterJob,
  parseCompanySize,
  parseExperienceRange,
  parseImportResult,
  parseSalaryMinK,
  parseScoreResult,
} from "../server/job-match.mjs";

const profile = {
  cities: ["广州", "深圳", "杭州", "苏州"],
  minSalaryK: 12,
  experienceYears: [1, 5],
  industries: ["储能", "IoT", "物联网", "新能源", "充电桩"],
  targetCompanies: ["固德威", "阳光电源"],
  exclude: {
    companyKeywords: ["外包", "劳务派遣", "驻场"],
    maxCompanySize: 300,
  },
  resumeSummary: "合成示例：3 年 Java 后端。",
};

function job(overrides = {}) {
  return {
    title: "Java后端工程师",
    company: "示例能源科技",
    city: "广州",
    salary: "15-25K·14薪",
    tags: ["1-3年", "本科"],
    companyTags: ["100-499人"],
    ...overrides,
  };
}

test("parseSalaryMinK 解析常见薪资格式", () => {
  assert.equal(parseSalaryMinK("15-25K·14薪"), 15);
  assert.equal(parseSalaryMinK("12-20K"), 12);
  assert.equal(parseSalaryMinK("1.5-2.5万"), 15);
  assert.equal(parseSalaryMinK("15K以上"), 15);
  assert.equal(parseSalaryMinK("面议"), null);
  assert.equal(parseSalaryMinK(""), null);
});

test("parseExperienceRange 解析年限区间", () => {
  assert.deepEqual(parseExperienceRange(["1-3年", "本科"]), [1, 3]);
  assert.deepEqual(parseExperienceRange(["1年以内"]), [0, 1]);
  assert.deepEqual(parseExperienceRange(["5年以上"]), [5, 99]);
  assert.equal(parseExperienceRange(["经验不限"]), null);
  assert.equal(parseExperienceRange(["本科"]), null);
});

test("parseCompanySize 解析公司规模", () => {
  assert.deepEqual(parseCompanySize(["100-499人"]), { min: 100, max: 499, label: "100-499人" });
  assert.deepEqual(parseCompanySize(["10000人以上"]), {
    min: 10000,
    max: Number.POSITIVE_INFINITY,
    label: "10000人以上",
  });
  assert.equal(parseCompanySize(["A轮"]), null);
});

test("硬过滤：完全匹配的岗位通过", () => {
  const result = hardFilterJob(job(), profile);
  assert.equal(result.pass, true);
  assert.deepEqual(result.reasons, []);
});

test("硬过滤：城市白名单", () => {
  assert.equal(hardFilterJob(job({ city: "北京" }), profile).pass, false);
  assert.equal(hardFilterJob(job({ city: "深圳" }), profile).pass, true);
  // area 兜底（抓取字段缺失时）
  assert.equal(hardFilterJob(job({ city: "", queryCity: "", area: "广州·天河区" }), profile).pass, true);
});

test("硬过滤：薪资下限（面议不拦截）", () => {
  assert.equal(hardFilterJob(job({ salary: "8-12K" }), profile).pass, false);
  assert.equal(hardFilterJob(job({ salary: "12-18K" }), profile).pass, true);
  assert.equal(hardFilterJob(job({ salary: "面议" }), profile).pass, true);
});

test("硬过滤：经验区间重叠判断", () => {
  assert.equal(hardFilterJob(job({ tags: ["5-10年"] }), profile).pass, false);
  assert.equal(hardFilterJob(job({ tags: ["3-5年"] }), profile).pass, true);
  assert.equal(hardFilterJob(job({ tags: ["经验不限"] }), profile).pass, true);
});

test("硬过滤：外包关键词与公司规模上限", () => {
  assert.equal(hardFilterJob(job({ company: "某人力外包服务" }), profile).pass, false);
  assert.equal(hardFilterJob(job({ title: "Java开发（驻场）" }), profile).pass, false);
  // 规模区间下限 >300 才排除：100-499 保留，500-999 排除
  assert.equal(hardFilterJob(job({ companyTags: ["100-499人"] }), profile).pass, true);
  assert.equal(hardFilterJob(job({ companyTags: ["500-999人"] }), profile).pass, false);
  assert.equal(hardFilterJob(job({ companyTags: ["A轮"] }), profile).pass, true);
});

test("parseScoreResult 校验并收敛分数", () => {
  assert.deepEqual(parseScoreResult('{"score":8,"reasons":["技术栈匹配"]}'), {
    score: 8,
    reasons: ["技术栈匹配"],
  });
  assert.equal(parseScoreResult('```json\n{"score":11}\n```').score, 10);
  assert.throws(() => parseScoreResult('{"reasons":[]}'), /score/);
  assert.throws(() => parseScoreResult("不是 JSON"), /JSON/);
});

test("parseImportResult 要求 title，其余字段容忍缺失", () => {
  const parsed = parseImportResult('{"title":"Java后端工程师","company":"示例科技","tags":["1-3年"]}');
  assert.equal(parsed.title, "Java后端工程师");
  assert.equal(parsed.source, "manual");
  assert.deepEqual(parsed.companyTags, []);
  assert.throws(() => parseImportResult('{"company":"示例科技"}'), /title/);
});

test("buildScorePrompt 注入画像与岗位信息", () => {
  const prompt = buildScorePrompt({ profile, job: job() });
  assert.match(prompt.user, /3 年 Java 后端/);
  assert.match(prompt.user, /固德威/);
  assert.match(prompt.user, /示例能源科技/);
  assert.match(prompt.user, /"score"/);
});

test("createJobScorer 通过 OpenAI 兼容接口打分（mock fetch）", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: '{"score":8,"reasons":["Java 技术栈匹配","储能行业契合"]}' } }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const scorer = createJobScorer({ baseUrl: "https://example.test/v1", apiKey: "tk", model: "test-model" });
  const result = await scorer.score({ profile, job: job() });
  assert.deepEqual(result, { score: 8, reasons: ["Java 技术栈匹配", "储能行业契合"] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://example.test/v1/chat/completions");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, "test-model");
  assert.equal(body.messages[0].role, "system");
});

test("createJobScorer.importJd 清洗 JD 文本（mock fetch）", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: '{"title":"储能EMS开发","company":"示例新能源","city":"杭州","salary":"18-30K","tags":["3-5年"],"companyTags":["100-299人"],"description":"负责 EMS 平台后端。"}',
            },
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );

  const scorer = createJobScorer({ baseUrl: "https://example.test/v1", apiKey: "tk", model: "test-model" });
  const parsed = await scorer.importJd({ text: "某 JD 原文" });
  assert.equal(parsed.title, "储能EMS开发");
  assert.equal(parsed.city, "杭州");
  assert.equal(parsed.source, "manual");
});
