// 求职跟踪岗位库：JSON 原子读写、URL 主键去重、状态机流转、逾期跟进提醒。
// 存储文件默认 Workbench/data/job-tracker.local.json（已被 .gitignore 忽略）。
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export const JOB_STORE_VERSION = 1;

export const JOB_STATUSES = [
  "new",
  "interested",
  "applied",
  "interviewing",
  "offer",
  "rejected",
  "unsuitable",
];

export const JOB_STATUS_LABELS = {
  new: "新推荐",
  interested: "感兴趣",
  applied: "已投递",
  interviewing: "面试中",
  offer: "Offer",
  rejected: "已拒绝",
  unsuitable: "不合适",
};

export const FOLLOWUP_DAYS = 3;

// 状态机：新推荐 → 感兴趣 → 已投递 → 面试中 → offer / 已拒绝 / 不合适
const TRANSITIONS = {
  new: ["interested", "unsuitable"],
  interested: ["new", "applied", "unsuitable"],
  applied: ["interviewing", "rejected", "unsuitable"],
  interviewing: ["offer", "rejected"],
  offer: [],
  rejected: [],
  unsuitable: [],
};

export class JobStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function normalizeJobUrl(url) {
  const raw = String(url ?? "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    // 去掉 lid/sessionId 等跟踪参数，pathname 即岗位稳定标识
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return raw;
  }
}

export function jobKey(job) {
  const url = normalizeJobUrl(job?.url);
  if (url) return `url:${url}`;
  const basis = [job?.company, job?.title, job?.city ?? job?.queryCity]
    .map((value) => String(value ?? "").trim())
    .join("|");
  return `hash:${createHash("sha1").update(basis).digest("hex")}`;
}

function jobId(key) {
  return createHash("sha1").update(key).digest("hex").slice(0, 16);
}

export function dayStamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function daysBetween(fromStamp, toStamp) {
  const from = Date.parse(`${fromStamp}T00:00:00Z`);
  const to = Date.parse(`${toStamp}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.floor((to - from) / 86_400_000);
}

function assertDayStamp(value, field) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ""))) {
    throw new JobStoreError("INVALID_JOB_DATE", `${field} 必须是 YYYY-MM-DD 格式。`);
  }
}

function emptyStore() {
  return { version: JOB_STORE_VERSION, updatedAt: null, jobs: [] };
}

export function createJobStore({ filePath, now = () => new Date() }) {
  let queue = Promise.resolve();
  const mutate = (operation) => {
    const result = queue.then(operation, operation);
    queue = result.catch(() => {});
    return result;
  };

  async function readStore() {
    let raw;
    try {
      raw = await fs.readFile(filePath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return emptyStore();
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new JobStoreError("JOB_STORE_CORRUPT", `岗位库文件无法解析：${filePath}`);
    }
    if (!parsed || parsed.version !== JOB_STORE_VERSION || !Array.isArray(parsed.jobs)) {
      throw new JobStoreError("JOB_STORE_CORRUPT", "岗位库文件结构不符合 schemaVersion 1。");
    }
    const ids = new Set();
    for (const job of parsed.jobs) {
      if (!job?.id || ids.has(job.id)) {
        throw new JobStoreError("JOB_STORE_CORRUPT", "岗位库存在重复或缺失的岗位 id。");
      }
      ids.add(job.id);
    }
    return parsed;
  }

  async function writeStore(store) {
    store.updatedAt = now().toISOString();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.tmp-${process.pid}`;
    await fs.writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    await fs.rename(temporary, filePath);
    return store;
  }

  function normalizeInput(raw) {
    const title = String(raw?.title ?? "").trim();
    if (!title) {
      throw new JobStoreError("INVALID_JOB_RECORD", "岗位缺少 title。");
    }
    return {
      title,
      company: String(raw?.company ?? "").trim(),
      city: String(raw?.city ?? raw?.queryCity ?? "").trim(),
      salary: String(raw?.salary ?? "").trim(),
      area: String(raw?.area ?? "").trim(),
      tags: Array.isArray(raw?.tags) ? raw.tags.map(String).filter(Boolean) : [],
      companyTags: Array.isArray(raw?.companyTags) ? raw.companyTags.map(String).filter(Boolean) : [],
      hr: String(raw?.hr ?? "").trim(),
      url: String(raw?.url ?? "").trim(),
      source: String(raw?.source ?? "unknown").trim(),
      description: typeof raw?.description === "string" ? raw.description : "",
      queryCity: String(raw?.queryCity ?? "").trim(),
      queryKeyword: String(raw?.queryKeyword ?? "").trim(),
    };
  }

  function findIndex(store, id) {
    const index = store.jobs.findIndex((job) => job.id === id);
    if (index < 0) {
      throw new JobStoreError("JOB_TRACKER_JOB_NOT_FOUND", `岗位不存在：${id}`);
    }
    return index;
  }

  return {
    async list() {
      return mutate(async () => (await readStore()).jobs);
    },

    async upsertMany(rawJobs) {
      return mutate(async () => {
        const store = await readStore();
        const byKey = new Map(store.jobs.map((job) => [job.key, job]));
        let inserted = 0;
        let updated = 0;
        const stamp = now().toISOString();
        for (const raw of rawJobs) {
          const input = normalizeInput(raw);
          const key = jobKey(input);
          const existing = byKey.get(key);
          if (existing) {
            // 变更静默更新：仅刷新采集字段，保留状态/评分/推送记录
            Object.assign(existing, {
              title: input.title,
              company: input.company,
              city: input.city,
              salary: input.salary,
              area: input.area,
              tags: input.tags,
              companyTags: input.companyTags,
              hr: input.hr,
              url: input.url,
              queryCity: input.queryCity,
              queryKeyword: input.queryKeyword,
              lastSeenAt: stamp,
            });
            if (input.description) existing.description = input.description;
            updated += 1;
          } else {
            const job = {
              id: jobId(key),
              key,
              ...input,
              status: "new",
              statusHistory: [{ status: "new", at: stamp }],
              appliedAt: null,
              score: null,
              scoreReasons: [],
              filterPass: null,
              filterReasons: [],
              pushedAt: null,
              firstSeenAt: stamp,
              lastSeenAt: stamp,
            };
            store.jobs.push(job);
            byKey.set(key, job);
            inserted += 1;
          }
        }
        await writeStore(store);
        return { inserted, updated, total: store.jobs.length };
      });
    },

    async setStatus(id, nextStatus, { appliedAt } = {}) {
      return mutate(async () => {
        if (!JOB_STATUSES.includes(nextStatus)) {
          throw new JobStoreError("INVALID_JOB_STATUS", `未知岗位状态：${nextStatus}`);
        }
        const store = await readStore();
        const job = store.jobs[findIndex(store, id)];
        const allowed = TRANSITIONS[job.status] ?? [];
        if (job.status !== nextStatus && !allowed.includes(nextStatus)) {
          throw new JobStoreError(
            "INVALID_STATUS_TRANSITION",
            `不允许从「${JOB_STATUS_LABELS[job.status]}」流转到「${JOB_STATUS_LABELS[nextStatus]}」。`,
          );
        }
        if (job.status === nextStatus) return job;
        const stamp = now().toISOString();
        job.status = nextStatus;
        job.statusHistory = [...(job.statusHistory ?? []), { status: nextStatus, at: stamp }];
        if (nextStatus === "applied") {
          const applied = appliedAt ?? dayStamp(now());
          assertDayStamp(applied, "appliedAt");
          job.appliedAt = applied;
        }
        await writeStore(store);
        return job;
      });
    },

    async setMatchResult(id, { filterPass, filterReasons, score, scoreReasons } = {}) {
      return mutate(async () => {
        const store = await readStore();
        const job = store.jobs[findIndex(store, id)];
        if (filterPass !== undefined) job.filterPass = filterPass === true;
        if (filterReasons !== undefined) job.filterReasons = filterReasons.map(String);
        if (score !== undefined) job.score = score == null ? null : Number(score);
        if (scoreReasons !== undefined) job.scoreReasons = scoreReasons.map(String);
        await writeStore(store);
        return job;
      });
    },

    async markPushed(ids, dateStamp = dayStamp(now())) {
      return mutate(async () => {
        assertDayStamp(dateStamp, "dateStamp");
        const store = await readStore();
        const wanted = new Set(ids);
        let marked = 0;
        for (const job of store.jobs) {
          if (wanted.has(job.id) && job.pushedAt !== dateStamp) {
            job.pushedAt = dateStamp;
            marked += 1;
          }
        }
        await writeStore(store);
        return { marked };
      });
    },

    async pendingFollowups() {
      return mutate(async () => {
        const store = await readStore();
        const today = dayStamp(now());
        return store.jobs
          .filter((job) => job.status === "applied" && job.appliedAt)
          .map((job) => ({ ...job, waitingDays: daysBetween(job.appliedAt, today) }))
          .filter((job) => job.waitingDays >= FOLLOWUP_DAYS)
          .sort((left, right) => right.waitingDays - left.waitingDays);
      });
    },

    async todayRecommendations(dateStamp = dayStamp(now())) {
      return mutate(async () => {
        const store = await readStore();
        return store.jobs
          .filter((job) => job.pushedAt === dateStamp)
          .sort((left, right) => (right.score ?? 0) - (left.score ?? 0));
      });
    },
  };
}
