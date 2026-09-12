import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  FOLLOWUP_DAYS,
  JobStoreError,
  createJobStore,
  dayStamp,
  jobKey,
  normalizeJobUrl,
} from "../server/job-store.mjs";

async function makeStore(t, { now } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "workbench-job-store-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createJobStore({
    filePath: path.join(dir, "job-tracker.local.json"),
    now: now ?? (() => new Date("2026-09-08T08:30:00")),
  });
  return { store, dir };
}

function job(overrides = {}) {
  return {
    title: "Java后端工程师",
    company: "示例能源科技",
    city: "广州",
    salary: "15-25K·14薪",
    tags: ["1-3年", "本科"],
    companyTags: ["100-499人"],
    url: "https://www.zhipin.com/job_detail/abc123.html?lid=xyz&sessionId=track",
    source: "boss",
    queryCity: "广州",
    queryKeyword: "Java后端",
    ...overrides,
  };
}

test("jobKey 以规范化 URL 为主键，无 URL 时用公司+标题+城市哈希兜底", () => {
  const byUrl = jobKey(job());
  assert.equal(byUrl, "url:https://www.zhipin.com/job_detail/abc123.html");
  assert.equal(normalizeJobUrl("not a url"), "not a url");
  const byHash = jobKey(job({ url: "" }));
  assert.match(byHash, /^hash:[0-9a-f]{40}$/);
  // 哈希兜底对字段顺序稳定、对 URL 无关
  assert.equal(byHash, jobKey(job({ url: "", salary: "99K" })));
});

test("upsert 去重：同 URL 静默更新采集字段并保留状态与评分", async (t) => {
  const { store } = await makeStore(t);
  assert.deepEqual(await store.upsertMany([job()]), { inserted: 1, updated: 0, total: 1 });

  const [before] = await store.list();
  await store.setStatus(before.id, "interested");
  await store.setMatchResult(before.id, { score: 8, scoreReasons: ["匹配"] });
  await store.markPushed([before.id], "2026-09-08");

  const result = await store.upsertMany([job({ salary: "18-30K", hr: "王女士" })]);
  assert.deepEqual(result, { inserted: 0, updated: 1, total: 1 });

  const [after] = await store.list();
  assert.equal(after.id, before.id);
  assert.equal(after.salary, "18-30K");
  assert.equal(after.status, "interested");
  assert.equal(after.score, 8);
  assert.equal(after.pushedAt, "2026-09-08");
  assert.equal(after.firstSeenAt, before.firstSeenAt);
});

test("状态机：合法流转记录历史，非法流转与未知状态被拒绝", async (t) => {
  const { store } = await makeStore(t);
  await store.upsertMany([job()]);
  const [{ id }] = await store.list();

  await assert.rejects(
    store.setStatus(id, "applied"),
    (error) => error instanceof JobStoreError && error.code === "INVALID_STATUS_TRANSITION",
  );
  await assert.rejects(
    store.setStatus(id, "nope"),
    (error) => error instanceof JobStoreError && error.code === "INVALID_JOB_STATUS",
  );
  await assert.rejects(
    store.setStatus("missing", "interested"),
    (error) => error instanceof JobStoreError && error.code === "JOB_TRACKER_JOB_NOT_FOUND",
  );

  await store.setStatus(id, "interested");
  await store.setStatus(id, "applied");
  const applied = await store.setStatus(id, "interviewing");
  assert.deepEqual(
    applied.statusHistory.map((entry) => entry.status),
    ["new", "interested", "applied", "interviewing"],
  );
  // 终态不可再流转
  await store.setStatus(id, "rejected");
  await assert.rejects(
    store.setStatus(id, "interviewing"),
    (error) => error.code === "INVALID_STATUS_TRANSITION",
  );
});

test("投递日期默认当天，可手动指定；格式非法被拒", async (t) => {
  const { store } = await makeStore(t);
  await store.upsertMany([job(), job({ title: "储能EMS工程师", url: "https://www.zhipin.com/job_detail/def456.html" })]);
  const [first, second] = await store.list();

  await store.setStatus(first.id, "interested");
  const applied = await store.setStatus(first.id, "applied");
  assert.equal(applied.appliedAt, "2026-09-08");

  await store.setStatus(second.id, "interested");
  await assert.rejects(
    store.setStatus(second.id, "applied", { appliedAt: "09/01" }),
    (error) => error.code === "INVALID_JOB_DATE",
  );
  const manual = await store.setStatus(second.id, "applied", { appliedAt: "2026-09-01" });
  assert.equal(manual.appliedAt, "2026-09-01");
});

test("pendingFollowups：投递满 3 天未推进才提醒", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "workbench-job-store-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let current = new Date("2026-09-01T08:30:00");
  const store = createJobStore({
    filePath: path.join(dir, "job-tracker.local.json"),
    now: () => current,
  });
  await store.upsertMany([job(), job({ title: "充电桩嵌入式", url: "https://www.zhipin.com/job_detail/ghi789.html" })]);
  const [first, second] = await store.list();
  await store.setStatus(first.id, "interested");
  await store.setStatus(first.id, "applied");
  await store.setStatus(second.id, "interested");

  // 第 2 天：不足 FOLLOWUP_DAYS，不提醒
  current = new Date("2026-09-03T08:30:00");
  assert.equal((await store.pendingFollowups()).length, 0);
  // 第 3 天：提醒
  current = new Date("2026-09-04T08:30:00");
  const followups = await store.pendingFollowups();
  assert.equal(followups.length, 1);
  assert.equal(followups[0].id, first.id);
  assert.equal(followups[0].waitingDays, FOLLOWUP_DAYS);
  // 推进到面试后不再提醒
  await store.setStatus(first.id, "interviewing");
  assert.equal((await store.pendingFollowups()).length, 0);
});

test("todayRecommendations 只含当日推送并按分数降序", async (t) => {
  const { store } = await makeStore(t);
  await store.upsertMany([
    job(),
    job({ title: "物联网平台开发", url: "https://www.zhipin.com/job_detail/jkl012.html" }),
  ]);
  const [low, high] = await store.list();
  await store.setMatchResult(low.id, { score: 7 });
  await store.setMatchResult(high.id, { score: 9 });
  await store.markPushed([low.id, high.id], "2026-09-08");

  const today = await store.todayRecommendations("2026-09-08");
  assert.deepEqual(today.map((entry) => entry.id), [high.id, low.id]);
  assert.deepEqual(await store.todayRecommendations("2026-09-06"), []);

  // 重复推送会覆盖日期：改记到 09-07 后，09-08 不再含该岗位
  await store.markPushed([low.id], "2026-09-07");
  assert.deepEqual(
    (await store.todayRecommendations("2026-09-08")).map((entry) => entry.id),
    [high.id],
  );
});

test("并发 upsert 串行化，岗位不丢失", async (t) => {
  const { store } = await makeStore(t);
  await Promise.all([
    store.upsertMany([job()]),
    store.upsertMany([job({ title: "新能源BMS软件", url: "https://www.zhipin.com/job_detail/mno345.html" })]),
  ]);
  assert.equal((await store.list()).length, 2);
});

test("损坏的岗位库文件被拒绝", async (t) => {
  const { store, dir } = await makeStore(t);
  const filePath = path.join(dir, "job-tracker.local.json");
  await import("node:fs/promises").then(({ writeFile }) => writeFile(filePath, "not json", "utf8"));
  await assert.rejects(
    store.list(),
    (error) => error instanceof JobStoreError && error.code === "JOB_STORE_CORRUPT",
  );
});

test("dayStamp 输出 YYYY-MM-DD 本地日期", () => {
  assert.equal(dayStamp(new Date("2026-09-08T08:30:00")), "2026-09-08");
});

test("岗位库落盘为合法 JSON 且无临时文件残留", async (t) => {
  const { store, dir } = await makeStore(t);
  await store.upsertMany([job()]);
  const persisted = JSON.parse(await readFile(path.join(dir, "job-tracker.local.json"), "utf8"));
  assert.equal(persisted.version, 1);
  assert.equal(persisted.jobs.length, 1);
  const { readdir } = await import("node:fs/promises");
  assert.equal((await readdir(dir)).some((name) => name.includes(".tmp")), false);
});
