import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { PageHeader } from "../components/PageHeader";
import { QuestMap } from "../components/learning/QuestMap";
import { loadDocument } from "../lib/api";
import { readableDocumentBody, readerImageRequestProps } from "../lib/reader-ui";
import { readerRehypePlugins } from "../lib/reader-markdown";
import { buildCodexQuizPrompt } from "../lib/codex-quiz.mjs";

const STATUS_LABEL = { locked: "未解锁", available: "可挑战", challenged: "挑战中", mastered: "已通关" };

function chapterNumber(chapter) {
  const match = /第\s*(\d+)\s*章/.exec(chapter ?? "");
  return match ? match[1] : null;
}

// 章节目录：大章节（关卡 frontmatter 的 chapter）→ 小章节（关卡），直达原文
function ChapterCatalog({ levels, onSelect, onOpenDocument }) {
  const groups = [];
  const byChapter = new Map();
  for (const level of levels) {
    const key = level.chapter ?? "未分章";
    if (!byChapter.has(key)) {
      const group = { chapter: key, levels: [] };
      byChapter.set(key, group);
      groups.push(group);
    }
    byChapter.get(key).levels.push(level);
  }
  return (
    <div className="learning-catalog">
      {groups.map((group) => {
        const chapterNo = chapterNumber(group.chapter);
        const mastered = group.levels.filter((level) => level.effectiveStatus === "mastered").length;
        return (
          <section key={group.chapter} className="learning-catalog__group">
            <header className="learning-catalog__chapter">
              <span>{group.chapter}</span>
              <span className="learning-catalog__chapter-meta">已通关 {mastered} / {group.levels.length}</span>
            </header>
            <ol className="learning-catalog__items">
              {group.levels.map((level, index) => (
                <li key={level.slug} className={`learning-catalog__item learning-catalog__item--${level.effectiveStatus}`}>
                  <button type="button" className="learning-catalog__main" onClick={() => onSelect(level.slug)}>
                    <span className="learning-catalog__no">{chapterNo ? `${chapterNo}.${index + 1}` : `${index + 1}`}</span>
                    <span className="learning-catalog__title">{level.title}</span>
                    <span className="learning-catalog__status">{STATUS_LABEL[level.effectiveStatus] ?? level.effectiveStatus}</span>
                    <span className="learning-catalog__mastery">掌握度 {level.mastery}</span>
                  </button>
                  {level.source && onOpenDocument ? (
                    <button
                      type="button"
                      className="learning-catalog__source"
                      title="直接打开原文"
                      onClick={() => onOpenDocument(level.source)}
                    >
                      原文
                    </button>
                  ) : null}
                </li>
              ))}
            </ol>
          </section>
        );
      })}
    </div>
  );
}

// 关卡挂接的 Vault 原文，复用阅读器的 Markdown 渲染与图片代理
function SourceContent({ source }) {
  const [state, setState] = useState({ loading: true, document: null, error: null });

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true, document: null, error: null });
    loadDocument(source).then((response) => {
      if (cancelled) return;
      setState({ loading: false, document: response.data, error: response.error });
    });
    return () => { cancelled = true; };
  }, [source]);

  if (state.loading) return <p className="learning-empty">原文加载中…</p>;
  const body = readableDocumentBody(state.document);
  if (!body) return <p className="learning-empty">原文内容不可用。</p>;
  return (
    <article className="markdown reader-markdown learning-source">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={readerRehypePlugins}
        components={{
          img({ node, src, alt, ...props }) {
            return <img {...props} {...readerImageRequestProps(src, state.document.id)} alt={alt || ""} />;
          },
        }}
      >
        {body}
      </ReactMarkdown>
    </article>
  );
}

function CodexQuizModal({ projectTitle, detail, onClose }) {
  const [copied, setCopied] = useState(false);
  const prompt = buildCodexQuizPrompt({
    projectTitle,
    level: {
      title: detail.frontmatter.title,
      notes: detail.notes,
      rubric: detail.rubric,
      source: detail.frontmatter.source ?? null,
    },
  });

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
    } catch {
      // 剪贴板 API 不可用时退化为手动选择
    }
    setCopied(true);
  };

  return (
    <div className="learning-modal" role="dialog" aria-label="Codex 对话校验">
      <div className="learning-modal__body">
        <h2>Codex 对话校验</h2>
        <p className="learning-notice">
          复制下面的提示词，粘贴到 Codex 对话中。Codex 会阅读原文并逐题考察你对本关卡的掌握情况，结束后给出掌握度总评。
        </p>
        <textarea className="learning-codex-prompt" readOnly value={prompt} onFocus={(event) => event.target.select()} />
        <div className="learning-toolbar">
          <button type="button" className="learning-primary" onClick={copy}>
            {copied ? "已复制，去 Codex 粘贴" : "复制提示词"}
          </button>
          <button type="button" className="learning-link" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}

function LevelDrawer({ projectSlug, levelSlug, projectTitle, aiConfigured, onOpenDocument, onClose, onChanged }) {
  const [detail, setDetail] = useState(null);
  const [attempts, setAttempts] = useState([]);
  const [submission, setSubmission] = useState("");
  const [refsText, setRefsText] = useState("");
  const [pending, setPending] = useState(null); // { attemptId, probes }
  const [answers, setAnswers] = useState([]);
  const [message, setMessage] = useState(null);
  const [busy, setBusy] = useState(false);
  const [codexOpen, setCodexOpen] = useState(false);

  const load = useCallback(async () => {
    const [levelResponse, attemptsResponse] = await Promise.all([
      fetch(`/api/learning/projects/${projectSlug}/levels/${levelSlug}`),
      fetch(`/api/learning/projects/${projectSlug}/levels/${levelSlug}/attempts`),
    ]);
    setDetail(await levelResponse.json());
    setAttempts((await attemptsResponse.json()).attempts ?? []);
  }, [projectSlug, levelSlug]);

  useEffect(() => { void load(); }, [load]);

  const post = async (suffix, body) => {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/learning/projects/${projectSlug}/levels/${levelSlug}/${suffix}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result?.error?.message ?? `HTTP ${response.status}`);
      return result;
    } catch (error) {
      setMessage(error.message);
      return null;
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    const result = await post("submit", {
      content_md: submission,
      vault_refs: refsText.split("\n").map((line) => line.trim()).filter(Boolean),
    });
    if (!result) return;
    if (result.needsProbe) {
      setPending(result);
      setAnswers(result.probes.map(() => ""));
    } else {
      setMessage(result.verdict === "passed" ? `通关！得分 ${result.score}` : `未达标，得分 ${result.score}。${result.feedback ?? ""}`);
      setSubmission("");
      await load();
      onChanged();
    }
  };

  const answerProbe = async () => {
    const result = await post("probe", { attempt_id: pending.attemptId, answers });
    if (!result) return;
    setPending(null);
    setMessage(result.verdict === "passed" ? `追问通过，通关！得分 ${result.score}` : `追问未通过，得分 ${result.score}。${result.feedback ?? ""}`);
    await load();
    onChanged();
  };

  const retry = async () => {
    const result = await post("retry", {});
    if (result) await load();
  };

  const selfAssess = async () => {
    const result = await post("self-assess", {});
    if (result) {
      setMessage("已标记为自评掌握（与 AI 验证通关区分显示）。");
      await load();
      onChanged();
    }
  };

  if (!detail) return null;
  const status = detail.frontmatter.status;
  return (
    <aside className="learning-drawer" role="dialog" aria-label={`关卡 ${detail.frontmatter.title}`}>
      <button type="button" className="learning-link" onClick={onClose}>关闭</button>
      <h2>{detail.frontmatter.title}</h2>
      <p>
        状态：{STATUS_LABEL[status] ?? status} · 掌握度 {detail.frontmatter.mastery} · 过关线 {detail.frontmatter.pass_score ?? 80}
        {detail.frontmatter.verified_by === "self-assessed" ? " · 自评通关" : null}
        {detail.frontmatter.verified_by === "ai-verified" ? " · AI 验证通关" : null}
      </p>
      <h3>知识点笔记</h3>
      <p style={{ whiteSpace: "pre-wrap" }}>{detail.notes}</p>
      <h3>挑战</h3>
      <p style={{ whiteSpace: "pre-wrap" }}>{detail.challenge}</p>
      <h3>评分细则</h3>
      <ul className="learning-rubric">
        {detail.rubric.map((entry) => <li key={entry.item}>[{entry.points}分] {entry.item}</li>)}
      </ul>

      {detail.frontmatter.source ? (
        <>
          <h3>
            知识点原文（{detail.frontmatter.source.split("/").pop()}）
            {onOpenDocument ? (
              <button type="button" className="learning-link" onClick={() => onOpenDocument(detail.frontmatter.source)}>
                在阅读器中打开
              </button>
            ) : null}
          </h3>
          <SourceContent source={detail.frontmatter.source} />
        </>
      ) : null}

      <h3>Codex 对话校验</h3>
      <div className="learning-toolbar">
        <button type="button" className="learning-primary" onClick={() => setCodexOpen(true)}>
          生成考核提示词
        </button>
      </div>

      {status !== "locked" && status !== "mastered" ? (
        <>
          <h3>提交产物</h3>
          <textarea rows={8} placeholder="粘贴代码、练习结果、讲解文字（Markdown）" value={submission} onChange={(event) => setSubmission(event.target.value)} />
          <textarea rows={2} placeholder="引用 Vault 文件路径（每行一个，可选）" value={refsText} onChange={(event) => setRefsText(event.target.value)} />
          <div className="learning-toolbar">
            <button type="button" className="learning-primary" disabled={busy || !submission.trim() || !aiConfigured} onClick={submit}>
              {busy ? "AI 评审中…" : "提交验证"}
            </button>
            <button type="button" className="learning-link" disabled={busy || !aiConfigured} onClick={retry}>换一道变体题</button>
            <button type="button" className="learning-link" disabled={busy} onClick={selfAssess}>手工自评掌握</button>
          </div>
        </>
      ) : null}

      {pending ? (
        <>
          <h3>追问环节</h3>
          {pending.probes.map((probe, index) => (
            <div key={probe}>
              <p>{probe}</p>
              <textarea rows={3} value={answers[index]} onChange={(event) => setAnswers(answers.map((value, i) => i === index ? event.target.value : value))} />
            </div>
          ))}
          <button type="button" className="learning-primary" disabled={busy || answers.some((answer) => !answer.trim())} onClick={answerProbe}>
            {busy ? "判定中…" : "提交追问回答"}
          </button>
        </>
      ) : null}

      {message ? <p className="learning-notice">{message}</p> : null}

      <h3>验证历史</h3>
      {attempts.length === 0 ? <p className="learning-empty">还没有验证记录。</p> : null}
      {attempts.map((attempt) => (
        <div key={attempt.id} className="learning-attempt">
          <strong>{attempt.created}</strong> · {attempt.verdict} · {attempt.score} 分
          <pre>{attempt.body.slice(0, 600)}</pre>
        </div>
      ))}
      {codexOpen ? (
        <CodexQuizModal projectTitle={projectTitle} detail={detail} onClose={() => setCodexOpen(false)} />
      ) : null}
    </aside>
  );
}

export function LearningProjectPage({ onOpenDocument }) {
  const { projectSlug } = useParams();
  const [detail, setDetail] = useState(null);
  const [tab, setTab] = useState("map");
  const [selected, setSelected] = useState(null);

  const load = useCallback(async () => {
    const response = await fetch(`/api/learning/projects/${projectSlug}`);
    if (response.ok) setDetail(await response.json());
  }, [projectSlug]);

  useEffect(() => { void load(); }, [load]);

  if (!detail) return <div className="learning-page">加载中…</div>;

  return (
    <div className="learning-page">
      <PageHeader eyebrow="LEARNING QUEST" title={detail.title} description={detail.description} />
      <div className="learning-progress" aria-label={`项目进度 ${detail.progress.percent}%`}>
        <span className="learning-progress__bar" style={{ width: `${detail.progress.percent}%` }} />
      </div>
      <p className="learning-card__meta">已通关 {detail.progress.mastered} / {detail.progress.total} · {detail.progress.percent}%</p>
      <div className="learning-tabs" role="tablist">
        <button type="button" aria-pressed={tab === "map"} onClick={() => setTab("map")}>闯关地图</button>
        <button type="button" aria-pressed={tab === "list"} onClick={() => setTab("list")}>关卡管理</button>
      </div>

      {tab === "map" ? (
        <QuestMap levels={detail.levels} onSelect={(level) => setSelected(level.slug)} />
      ) : detail.levels.some((level) => level.chapter) ? (
        <ChapterCatalog
          levels={detail.levels}
          onSelect={(slug) => setSelected(slug)}
          onOpenDocument={onOpenDocument}
        />
      ) : (
        <table className="learning-table">
          <thead>
            <tr><th>关卡</th><th>状态</th><th>掌握度</th><th>前置</th><th>验证次数</th></tr>
          </thead>
          <tbody>
            {detail.levels.map((level) => (
              <tr key={level.slug} onClick={() => setSelected(level.slug)} style={{ cursor: "pointer" }}>
                <td>{level.title}</td>
                <td>{STATUS_LABEL[level.effectiveStatus]}{level.verifiedBy === "self-assessed" ? "（自评）" : ""}</td>
                <td>{level.mastery}</td>
                <td>{level.dependsOn.join(", ") || "—"}</td>
                <td>{level.attemptCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {selected ? (
        <LevelDrawer
          projectSlug={projectSlug}
          levelSlug={selected}
          projectTitle={detail.title}
          aiConfigured={detail.aiConfigured}
          onOpenDocument={onOpenDocument}
          onClose={() => setSelected(null)}
          onChanged={load}
        />
      ) : null}
    </div>
  );
}
