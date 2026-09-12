// BOSS 直聘岗位搜索抓取（基于 Playwright + 已保存 session）。
// 用法：
//   node scripts/job-boss-fetch.mjs                      # 默认 4 城 × 默认关键词矩阵，输出 JSON 到 stdout
//   node scripts/job-boss-fetch.mjs --query Java --city 101280600 --pages 2
//   node scripts/job-boss-fetch.mjs --out data/boss-jobs.local.json
// 风控说明：请先用 scripts/job-boss-login.mjs 保存 session；抓取带随机延时，
// 遇到滑块/验证码会中止并提示（--headful 可打开浏览器人工过验证后继续）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openBossContext } from "./boss-browser.mjs";

const workbenchRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const DEFAULT_CITIES = {
  广州: "101280100",
  深圳: "101280600",
  杭州: "101210100",
  苏州: "101190400",
};
const DEFAULT_KEYWORDS = ["Java后端", "储能EMS", "充电桩", "物联网", "新能源"];

function parseArgs(argv) {
  const args = { pages: 1, out: null, query: null, city: null, headful: false };
  for (let index = 2; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--headful") args.headful = true;
    else if (key === "--query") args.query = argv[++index];
    else if (key === "--city") args.city = argv[++index];
    else if (key === "--pages") args.pages = Number(argv[++index]) || 1;
    else if (key === "--out") args.out = argv[++index];
  }
  return args;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const jitter = (min, max) => min + Math.floor(Math.random() * (max - min));

async function detectBlock(page) {
  const url = page.url();
  const text = await page.evaluate(() => document.body?.innerText?.slice(0, 2000) ?? "");
  if (/安全验证|滑块|拖动下方滑块|异常流量|访问受限/.test(text) || url.includes("captcha")) {
    return "触发风控验证（滑块/验证码）。请用 --headful 人工过验证后重试，或重新登录。";
  }
  if (url.includes("/web/user") || url.includes("/verify")) {
    return "session 已失效，请重新运行 scripts/job-boss-login.mjs。";
  }
  if (/登录后查看|请先登录|扫码.*登录|验证码登录/.test(text) && !(await page.$(".job-list-box"))) {
    return "session 已失效，请重新运行 scripts/job-boss-login.mjs。";
  }
  return null;
}

async function scrapeJobList(page) {
  await page.waitForSelector(".job-list-box, .job-card-wrapper", { timeout: 15000 }).catch(() => {});
  return page.evaluate(() => {
    const cards = document.querySelectorAll(".job-list-box .job-card-wrapper");
    const jobs = [];
    for (const card of cards) {
      const text = (selector) => card.querySelector(selector)?.textContent?.trim() ?? "";
      const all = (selector) =>
        [...card.querySelectorAll(selector)].map((node) => node.textContent.trim()).filter(Boolean);
      const link = card.querySelector("a.job-card-left")?.getAttribute("href") ?? "";
      const jobName = text(".job-name");
      if (!jobName || !link) continue;
      const areaText = text(".job-area-wrapper");
      jobs.push({
        title: jobName,
        salary: text(".salary"),
        area: areaText,
        tags: all(".tag-list li"),
        company: text(".company-name"),
        companyTags: all(".company-tag-list li"),
        hr: text(".info-public"),
        url: link.startsWith("http") ? link : `https://www.zhipin.com${link}`,
        source: "boss",
        fetchedAt: new Date().toISOString(),
      });
    }
    return jobs;
  });
}

async function main() {
  const args = parseArgs(process.argv);

  const combos = args.query
    ? [{ cityName: args.city ?? "全国", cityCode: args.city ?? "100010000", keyword: args.query }]
    : Object.entries(DEFAULT_CITIES).flatMap(([cityName, cityCode]) =>
        DEFAULT_KEYWORDS.map((keyword) => ({ cityName, cityCode, keyword })),
      );

  const context = await openBossContext({ headful: args.headful });
  const page = context.pages()[0] ?? (await context.newPage());

  const results = [];
  let aborted = null;
  for (const combo of combos) {
    for (let pageNum = 1; pageNum <= args.pages; pageNum += 1) {
      const url =
        `https://www.zhipin.com/web/geek/job?query=${encodeURIComponent(combo.keyword)}` +
        `&city=${combo.cityCode}&page=${pageNum}`;
      console.error(`[fetch] ${combo.cityName} / ${combo.keyword} / 第${pageNum}页`);
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      } catch {
        aborted = `页面加载失败：${url}`;
        break;
      }
      const blocked = await detectBlock(page);
      if (blocked) {
        aborted = blocked;
        break;
      }
      const jobs = await scrapeJobList(page);
      for (const job of jobs) {
        results.push({ ...job, queryCity: combo.cityName, queryKeyword: combo.keyword });
      }
      console.error(`  -> ${jobs.length} 条`);
      await sleep(jitter(3000, 6000));
    }
    if (aborted) break;
  }

  // 关闭前等待 cookies 落盘（持久化 profile 自动保存登录态）
  await context.close();

  const payload = JSON.stringify(results, null, 2);
  if (args.out) {
    const outPath = path.resolve(workbenchRoot, args.out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, payload, "utf8");
    console.error(`已写入 ${results.length} 条 -> ${outPath}`);
  } else {
    console.log(payload);
  }
  if (aborted) {
    console.error(`[warn] 抓取中止：${aborted}（已保留中止前抓到的 ${results.length} 条）`);
    process.exit(3);
  }
}

main().catch((error) => {
  console.error("抓取失败：", error.message);
  process.exit(1);
});
