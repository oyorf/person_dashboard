import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader } from "../components/PageHeader";

const NEXT_ACTIONS = {
  new: [
    { to: "interested", label: "感兴趣" },
    { to: "unsuitable", label: "不合适" },
  ],
  interested: [
    { to: "applied", label: "已投递" },
    { to: "unsuitable", label: "不合适" },
    { to: "new", label: "放回新推荐" },
  ],
  applied: [
    { to: "interviewing", label: "面试中" },
    { to: "rejected", label: "已拒绝" },
    { to: "unsuitable", label: "不合适" },
  ],
  interviewing: [
    { to: "offer", label: "拿到 Offer" },
    { to: "rejected", label: "已拒绝" },
  ],
  offer: [],
  rejected: [],
  unsuitable: [],
};

function todayStamp() {
  const pad = (value) => String(value).padStart(2, "0");
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error?.message ?? `请求失败（HTTP ${response.status}）`);
  }
  return payload;
}

function JobCard({ job, onAction, applyingId, onApplyConfirm, onApplyCancel }) {
  const [appliedAt, setAppliedAt] = useState(todayStamp());
  const actions = NEXT_ACTIONS[job.status] ?? [];
  return (
    <article className={`job-card${job.filterPass === false ? " job-card--filtered" : ""}`}>
      <header className="job-card__head">
        <div>
          <h3 className="job-card__title">
            {job.url ? (
              <a href={job.url} target="_blank" rel="noreferrer">
                {job.title}
              </a>
            ) : (
              job.title
            )}
          </h3>
          <p className="job-card__company">{job.company || "未知公司"}</p>
        </div>
        {job.score != null ? <span className="job-card__score">{job.score} 分</span> : null}
      </header>
      <p className="job-card__meta">
        {[job.city || job.queryCity, job.salary, job.hr].filter(Boolean).join(" · ")}
      </p>
      {job.tags?.length ? (
        <p className="job-card__tags">
          {job.tags.map((tag) => (
            <span key={tag} className="job-card__tag">
              {tag}
            </span>
          ))}
        </p>
      ) : null}
      {job.scoreReasons?.length ? (
        <p className="job-card__reasons">{job.scoreReasons.join("；")}</p>
      ) : null}
      {job.filterPass === false && job.filterReasons?.length ? (
        <p className="job-card__filtered-note">硬过滤未通过：{job.filterReasons.join("；")}</p>
      ) : null}
      {job.appliedAt ? <p className="job-card__meta">投递于 {job.appliedAt}</p> : null}
      {applyingId === job.id ? (
        <div className="job-card__apply-form">
          <input
            aria-label="投递日期"
            onChange={(event) => setAppliedAt(event.target.value)}
            type="date"
            value={appliedAt}
          />
          <button type="button" onClick={() => onApplyConfirm(job, appliedAt)}>
            确认投递
          </button>
          <button type="button" onClick={onApplyCancel}>
            取消
          </button>
        </div>
      ) : actions.length ? (
        <footer className="job-card__actions">
          {actions.map((action) => (
            <button
              key={action.to}
              type="button"
              className={`job-card__action${action.to === "offer" ? " job-card__action--primary" : ""}`}
              onClick={() => onAction(job, action.to)}
            >
              {action.label}
            </button>
          ))}
        </footer>
      ) : null}
    </article>
  );
}

export function JobTrackerPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("");
  const [importText, setImportText] = useState("");
  const [importing, setImporting] = useState(false);
  const [applyingId, setApplyingId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api("/api/job-tracker/jobs"));
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const runAction = useCallback(
    async (job, status, appliedAt) => {
      setNotice(null);
      try {
        await api(`/api/job-tracker/jobs/${encodeURIComponent(job.id)}/status`, {
          method: "POST",
          body: JSON.stringify({ status, ...(appliedAt ? { appliedAt } : {}) }),
        });
        setApplyingId(null);
        await load();
      } catch (actionError) {
        setNotice(actionError.message);
      }
    },
    [load],
  );

  const handleAction = useCallback(
    (job, status) => {
      if (status === "applied") {
        setApplyingId(job.id);
        return;
      }
      runAction(job, status);
    },
    [runAction],
  );

  const handleImport = useCallback(async () => {
    if (!importText.trim() || importing) return;
    setImporting(true);
    setNotice(null);
    try {
      const result = await api("/api/job-tracker/jobs/import", {
        method: "POST",
        body: JSON.stringify({ text: importText }),
      });
      setImportText("");
      setNotice(`已入库：${result.job?.company ?? ""} / ${result.job?.title ?? ""}`);
      await load();
    } catch (importError) {
      setNotice(importError.message);
    } finally {
      setImporting(false);
    }
  }, [importText, importing, load]);

  const keyword = filter.trim().toLowerCase();
  const matches = useCallback(
    (job) =>
      !keyword ||
      [job.title, job.company, job.city, job.salary, ...(job.tags ?? [])]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(keyword)),
    [keyword],
  );

  const groups = useMemo(
    () =>
      (data?.groups ?? [])
        .map((group) => ({ ...group, items: group.items.filter(matches) }))
        .filter((group) => group.items.length),
    [data, matches],
  );
  const todayJobs = useMemo(() => (data?.today ?? []).filter(matches), [data, matches]);

  return (
    <div className="job-tracker">
      <PageHeader
        eyebrow="CAREER"
        title="求职跟踪"
        description="BOSS 直聘每日抓取 · 硬过滤 + LLM 打分 · 投递状态机"
      />

      {notice ? <p className="job-tracker__notice">{notice}</p> : null}
      {error ? <p className="job-tracker__notice job-tracker__notice--error">{error}</p> : null}

      {data?.followups?.length ? (
        <section className="job-tracker__alerts" aria-label="跟进提醒">
          <h2>跟进提醒</h2>
          <ul>
            {data.followups.map((job) => (
              <li key={job.id}>
                <strong>{job.company}</strong> / {job.title} — 已投递 {job.waitingDays} 天未推进，
                记得主动跟进或标记结果。
                <span className="job-tracker__alert-actions">
                  {(NEXT_ACTIONS.applied ?? []).map((action) => (
                    <button key={action.to} type="button" onClick={() => handleAction(job, action.to)}>
                      {action.label}
                    </button>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="job-tracker__section" aria-label="今日推荐">
        <div className="job-tracker__section-head">
          <h2>今日推荐</h2>
          <input
            aria-label="筛选岗位"
            className="job-tracker__filter"
            onChange={(event) => setFilter(event.target.value)}
            placeholder="筛选公司 / 职位 / 城市…"
            type="search"
            value={filter}
          />
        </div>
        {loading ? <p className="job-tracker__empty">加载中…</p> : null}
        {!loading && !todayJobs.length ? (
          <p className="job-tracker__empty">
            今日暂无推荐。每日 8:30 的计划任务会生成日报；也可以在下方手动投喂 JD。
          </p>
        ) : null}
        <div className="job-tracker__grid">
          {todayJobs.map((job) => (
            <JobCard
              key={job.id}
              job={job}
              applyingId={applyingId}
              onAction={handleAction}
              onApplyConfirm={(target, date) => runAction(target, "applied", date)}
              onApplyCancel={() => setApplyingId(null)}
            />
          ))}
        </div>
      </section>

      <section className="job-tracker__section" aria-label="全部岗位">
        <h2>全部岗位（{data?.total ?? 0}）</h2>
        {groups.map((group) => (
          <div key={group.status} className="job-tracker__group">
            <h3>
              {group.label} · {group.items.length}
            </h3>
            <div className="job-tracker__grid">
              {group.items.map((job) => (
                <JobCard
                  key={job.id}
                  job={job}
                  applyingId={applyingId}
                  onAction={handleAction}
                  onApplyConfirm={(target, date) => runAction(target, "applied", date)}
                  onApplyCancel={() => setApplyingId(null)}
                />
              ))}
            </div>
          </div>
        ))}
      </section>

      <section className="job-tracker__section" aria-label="手动投喂">
        <h2>手动投喂 JD</h2>
        <p className="job-tracker__hint">
          粘贴任意招聘 JD 原文，LLM 会清洗成结构化岗位入库（兜底通道，需已配置 AI）。
        </p>
        <textarea
          aria-label="JD 原文"
          className="job-tracker__import"
          onChange={(event) => setImportText(event.target.value)}
          placeholder="粘贴 JD 原文…"
          rows={6}
          value={importText}
        />
        <button
          type="button"
          className="job-tracker__import-button"
          disabled={importing || !importText.trim()}
          onClick={handleImport}
        >
          {importing ? "清洗入库中…" : "清洗并入库"}
        </button>
      </section>
    </div>
  );
}
