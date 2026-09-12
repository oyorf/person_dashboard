import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";

const EMPTY_DRAFT = { title: "", description: "", sourcesText: "", slug: "" };

export function LearningPage() {
  const navigate = useNavigate();
  const [payload, setPayload] = useState(null);
  const [error, setError] = useState(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [decomposed, setDecomposed] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/learning/projects");
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setPayload(await response.json());
    } catch (loadError) {
      setError(loadError.message);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const runDecompose = async () => {
    setBusy(true);
    setError(null);
    try {
      const sources = draft.sourcesText.split("\n").map((line) => line.trim()).filter(Boolean);
      const response = await fetch("/api/learning/ai/decompose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: draft.title, description: draft.description, sources }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result?.error?.message ?? `HTTP ${response.status}`);
      setDecomposed(result.levels);
    } catch (decomposeError) {
      setError(decomposeError.message);
    } finally {
      setBusy(false);
    }
  };

  const confirmPublish = async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await fetch("/api/learning/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: draft.title,
          description: draft.description,
          slug: draft.slug || undefined,
          sources: draft.sourcesText.split("\n").map((line) => line.trim()).filter(Boolean),
        }),
      }).then(async (response) => {
        const result = await response.json();
        if (!response.ok) throw new Error(result?.error?.message ?? `HTTP ${response.status}`);
        return result;
      });
      const challengeResult = await fetch("/api/learning/ai/challenge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_title: draft.title, levels: decomposed }),
      }).then(async (response) => {
        const result = await response.json();
        if (!response.ok) throw new Error(result?.error?.message ?? `HTTP ${response.status}`);
        return result;
      });
      const challengeBySlug = new Map(challengeResult.challenges.map((entry) => [entry.slug, entry]));
      await fetch(`/api/learning/projects/${created.slug}/levels:publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          levels: decomposed.map((entry) => ({
            slug: entry.slug,
            title: entry.title,
            dependsOn: entry.depends_on,
            notes: entry.summary,
            challenge: challengeBySlug.get(entry.slug)?.challenge_md ?? "",
            rubric: challengeBySlug.get(entry.slug)?.rubric ?? [{ item: "待补充", points: 100 }],
          })),
        }),
      }).then(async (response) => {
        const result = await response.json();
        if (!response.ok) throw new Error(result?.error?.message ?? `HTTP ${response.status}`);
      });
      setWizardOpen(false);
      setDraft(EMPTY_DRAFT);
      setDecomposed(null);
      navigate(`/learning/${created.slug}`);
    } catch (publishError) {
      setError(publishError.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="learning-page">
      <PageHeader
        eyebrow="LEARNING QUESTS"
        title="学习闯关"
        description="知识点关卡地图：完成实践挑战，由 AI 按评分细则验证掌握度。"
      />
      {payload && !payload.aiConfigured ? (
        <p className="learning-notice">
          AI 未配置：前往<Link to="/system">系统状态</Link>页保存 LEARNING_AI 配置后，才能使用拆解、出题与评分。浏览与手工自评不受影响。
        </p>
      ) : null}
      {error ? <p className="learning-error">{error}</p> : null}
      <div className="learning-toolbar">
        <button type="button" className="learning-primary" onClick={() => setWizardOpen(true)}>
          新建学习项目
        </button>
      </div>
      <div className="learning-grid">
        {(payload?.projects ?? []).map((project) => (
          <button
            key={project.slug}
            type="button"
            className="learning-card"
            onClick={() => navigate(`/learning/${project.slug}`)}
          >
            <span className="learning-card__title">{project.title}</span>
            <span className="learning-card__description">{project.description}</span>
            <span className="learning-progress">
              <span className="learning-progress__bar" style={{ width: `${project.progress.percent}%` }} />
            </span>
            <span className="learning-card__meta">
              已通关 {project.progress.mastered} / {project.progress.total} · {project.progress.percent}%
            </span>
          </button>
        ))}
        {payload && payload.total === 0 ? <p className="learning-empty">还没有学习项目，点击上方按钮创建。</p> : null}
      </div>

      {wizardOpen ? (
        <div className="learning-modal" role="dialog" aria-label="新建学习项目">
          <div className="learning-modal__body">
            <h2>新建学习项目</h2>
            <label>
              项目名称
              <input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
            </label>
            <label>
              slug（可选，小写字母数字连字符）
              <input value={draft.slug} onChange={(event) => setDraft({ ...draft, slug: event.target.value })} />
            </label>
            <label>
              学习目标描述
              <textarea rows={3} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} />
            </label>
            <label>
              挂接 Vault 资料路径（每行一个，可选）
              <textarea rows={3} value={draft.sourcesText} onChange={(event) => setDraft({ ...draft, sourcesText: event.target.value })} />
            </label>
            {!decomposed ? (
              <button type="button" className="learning-primary" disabled={busy || !draft.title.trim()} onClick={runDecompose}>
                {busy ? "AI 拆解中…" : "AI 拆解关卡"}
              </button>
            ) : (
              <>
                <h3>关卡草稿（可删除行、编辑依赖）</h3>
                <table className="learning-table">
                  <thead>
                    <tr><th>slug</th><th>标题</th><th>前置依赖（逗号分隔）</th><th /></tr>
                  </thead>
                  <tbody>
                    {decomposed.map((entry, index) => (
                      <tr key={entry.slug}>
                        <td>{entry.slug}</td>
                        <td>
                          <input
                            value={entry.title}
                            onChange={(event) => setDecomposed(decomposed.map((item, i) => i === index ? { ...item, title: event.target.value } : item))}
                          />
                        </td>
                        <td>
                          <input
                            value={entry.depends_on.join(",")}
                            onChange={(event) => setDecomposed(decomposed.map((item, i) => i === index
                              ? { ...item, depends_on: event.target.value.split(",").map((value) => value.trim()).filter(Boolean) }
                              : item))}
                          />
                        </td>
                        <td>
                          <button type="button" onClick={() => setDecomposed(decomposed.filter((_, i) => i !== index))}>删除</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <button type="button" className="learning-primary" disabled={busy || decomposed.length === 0} onClick={confirmPublish}>
                  {busy ? "生成挑战并上架中…" : "确认上架（AI 生成挑战）"}
                </button>
              </>
            )}
            <button type="button" className="learning-link" onClick={() => { setWizardOpen(false); setDecomposed(null); }}>
              取消
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
