// 每日求职 pipeline：BOSS 抓取 → 入库去重 → 硬过滤 → LLM 打分 → Vault 日报。
// 用法：
//   node scripts/job-digest.mjs                # 完整 pipeline（先跑爬虫）
//   node scripts/job-digest.mjs --no-fetch     # 跳过抓取，只对库存岗位过滤打分
//   node scripts/job-digest.mjs --input data/job-inbox.json   # 从 JSON 文件导入（WebSearch 采集路线）
//   node scripts/job-digest.mjs --date 2026-09-08 --limit 10
// --input 文件格式：数组，元素字段 { title, company, city, salary, url, tags[], companyTags[], description, source }
// （缺失字段允许为空，但至少要有 title + company + city 用于去重与过滤。）
// Windows 计划任务示例（每日 8:30）：
//   schtasks /create /tn "PersonalWorkbench-JobDigest" /tr "\"C:\\Program Files\\nodejs\\node.exe\" scripts\\job-digest.mjs" /sc daily /st 08:30
//   （工作目录设为 Workbench/）
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createJobStore, dayStamp } from "../server/job-store.mjs";
import { createJobScorer, hardFilterJob } from "../server/job-match.mjs";
import {
  readLearningAiFileConfig,
  resolveLearningAiConfig,
} from "../server/learning-ai.mjs";

const workbenchRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const vaultRoot = path.resolve(
  process.env.PERSONAL_DASHBOARD_VAULT_ROOT || path.join(workbenchRoot, "..", "个人知识库"),
);
const STORE_PATH = path.join(workbenchRoot, "data", "job-tracker.local.json");
const PROFILE_PATH = path.join(workbenchRoot, "config", "job-profile.local.json");
const DAILY_DIR = path.join(vaultRoot, "70_career", "daily");

function parseArgs(argv) {
  const args = { fetch: true, date: null, limit: null, input: null };
  for (let index = 2; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--no-fetch") args.fetch = false;
    else if (key === "--date") args.date = argv[++index];
    else if (key === "--limit") args.limit = Number(argv[++index]) || null;
    else if (key === "--input") args.input = argv[++index];
  }
  if (args.input) args.fetch = false;
  return args;
}

async function loadInputJobs(inputPath) {
  const raw = await fs.readFile(path.resolve(workbenchRoot, inputPath), "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`--input 文件必须是 JSON 数组：${inputPath}`);
  }
  const stamp = new Date().toISOString();
  return parsed
    .filter((job) => job && (job.url || (job.title && job.company)))
    .map((job) => ({
      title: String(job.title ?? "").trim(),
      company: String(job.company ?? "").trim(),
      city: String(job.city ?? "").trim(),
      salary: String(job.salary ?? "").trim(),
      url: String(job.url ?? "").trim(),
      area: String(job.area ?? "").trim(),
      tags: Array.isArray(job.tags) ? job.tags.map(String) : [],
      companyTags: Array.isArray(job.companyTags) ? job.companyTags.map(String) : [],
      description: String(job.description ?? "").slice(0, 2000),
      hr: String(job.hr ?? "").trim(),
      source: job.source ?? "websearch",
      fetchedAt: job.fetchedAt ?? stamp,
    }));
}

async function loadProfile() {
  try {
    return JSON.parse(await fs.readFile(PROFILE_PATH, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(
        `求职画像不存在：${PROFILE_PATH}\n请复制 config/job-profile.local.example.json 为 job-profile.local.json 并填入真实画像。`,
      );
    }
    throw error;
  }
}

function runFetch() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(workbenchRoot, "scripts", "job-boss-fetch.mjs")], {
      cwd: workbenchRoot,
      stdio: ["ignore", "pipe", "inherit"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      // 退出码 3 = 风控中止但保留了部分结果，仍尝试解析
      if (code !== 0 && code !== 3) {
        reject(new Error(`抓取脚本退出码 ${code}（session 缺失或失效时请先运行 npm run job:login）`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error("抓取脚本输出无法解析为 JSON。"));
      }
    });
  });
}

function escapeCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function renderDailyMarkdown({ date, jobs, stats }) {
  const lines = [
    "---",
    "type: job-daily",
    `date: ${date}`,
    `generated: ${new Date().toISOString()}`,
    `count: ${jobs.length}`,
    "---",
    "",
    `# 求职日报 · ${date}`,
    "",
    "> 由 `job-digest` 自动生成。分数为 LLM 对画像匹配度的 0-10 评分（≥7 进入日报）。",
    "",
    `抓取 ${stats.fetched} 条 · 新增入库 ${stats.inserted} 条 · 硬过滤通过 ${stats.filterPassed} 条 · 今日推荐 ${jobs.length} 条`,
    "",
  ];
  if (!jobs.length) {
    lines.push("_今日没有达到推荐阈值的岗位。_", "");
    return lines.join("\n");
  }
  lines.push("| 公司 | 职位 | 城市 | 薪资 | 分数 | 推荐理由 |", "|---|---|---|---|---|---|");
  for (const job of jobs) {
    const title = job.url ? `[${escapeCell(job.title)}](${job.url})` : escapeCell(job.title);
    lines.push(
      `| ${escapeCell(job.company)} | ${title} | ${escapeCell(job.city)} | ${escapeCell(job.salary)} | ${job.score} | ${escapeCell((job.scoreReasons ?? []).join("；"))} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv);
  const date = args.date ?? dayStamp();
  console.error(`[digest] 日期 ${date}，Vault：${vaultRoot}`);

  const store = createJobStore({ filePath: STORE_PATH });

  let fetched = [];
  if (args.input) {
    fetched = await loadInputJobs(args.input);
    console.error(`[digest] 从 ${args.input} 导入 ${fetched.length} 条`);
  } else if (args.fetch) {
    fetched = await runFetch();
    console.error(`[digest] 抓取 ${fetched.length} 条`);
  }
  const upsertResult = fetched.length
    ? await store.upsertMany(fetched)
    : { inserted: 0, updated: 0 };
  console.error(`[digest] 入库：新增 ${upsertResult.inserted}，更新 ${upsertResult.updated}`);

  const profile = await loadProfile();
  const aiConfig = resolveLearningAiConfig({ fileConfig: readLearningAiFileConfig(workbenchRoot) });
  const scorer = aiConfig ? createJobScorer(aiConfig) : null;
  if (!scorer) {
    console.error("[digest] 未配置 LLM（learning-ai），跳过打分，仅执行过滤。");
  }
  const threshold = Number(profile?.llm?.threshold) || 7;
  const dailyLimit = args.limit ?? (Number(profile?.llm?.dailyLimit) || 20);

  // 硬过滤：只处理尚未定性、且未推送过的新岗位
  const pending = (await store.list()).filter(
    (job) => job.status === "new" && job.pushedAt == null && job.filterPass !== false,
  );
  const toScore = [];
  let filterPassed = 0;
  for (const job of pending) {
    if (job.filterPass == null) {
      const result = hardFilterJob(job, profile);
      await store.setMatchResult(job.id, { filterPass: result.pass, filterReasons: result.reasons });
      if (!result.pass) continue;
    }
    filterPassed += 1;
    toScore.push(job.id);
  }
  console.error(`[digest] 硬过滤通过 ${filterPassed} 条`);

  // LLM 打分（每日上限）
  const pushed = [];
  for (const id of toScore.slice(0, dailyLimit)) {
    if (!scorer) break;
    const job = (await store.list()).find((entry) => entry.id === id);
    try {
      const scored = await scorer.score({ profile, job });
      await store.setMatchResult(id, { score: scored.score, scoreReasons: scored.reasons });
      if (scored.score >= threshold) {
        pushed.push(id);
        console.error(`[digest] 推荐 ${job?.company} / ${job?.title}（${scored.score} 分）`);
      }
    } catch (error) {
      console.error(`[digest] 打分失败 ${job?.company} / ${job?.title}：${error.message}`);
    }
  }
  await store.markPushed(pushed, date);

  const recommended = await store.todayRecommendations(date);
  const markdown = renderDailyMarkdown({
    date,
    jobs: recommended,
    stats: { fetched: fetched.length, inserted: upsertResult.inserted, filterPassed },
  });
  const dailyPath = path.join(DAILY_DIR, `${date}.md`);
  await fs.mkdir(path.dirname(dailyPath), { recursive: true });
  await fs.writeFile(dailyPath, markdown, "utf8");
  console.error(`[digest] 日报已写入 ${dailyPath}（推荐 ${recommended.length} 条）`);
}

main().catch((error) => {
  console.error("每日 pipeline 失败：", error.message);
  process.exit(1);
});
