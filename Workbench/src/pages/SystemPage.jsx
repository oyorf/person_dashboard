import { useEffect, useState } from "react";
import { PageHeader } from "../components/PageHeader";
import { getRuntimeStatus, refreshVault } from "../lib/api";
import { formatFullDate } from "../lib/format";

export function SystemPage() {
  const [runtime, setRuntime] = useState({ data: null, source: "loading", error: null });
  const [refreshing, setRefreshing] = useState(false);
  const [aiConfig, setAiConfig] = useState(null);
  const [aiForm, setAiForm] = useState({ baseUrl: "", apiKey: "", model: "" });
  const [aiSaving, setAiSaving] = useState(false);
  const [aiMessage, setAiMessage] = useState(null);

  const loadRuntime = async () => {
    const response = await getRuntimeStatus();
    setRuntime(response);
  };

  useEffect(() => {
    let cancelled = false;
    getRuntimeStatus().then((response) => {
      if (!cancelled) setRuntime(response);
    });
    fetch("/api/config/learning-ai")
      .then(async (response) => {
        if (!response.ok || cancelled) return;
        const config = await response.json();
        setAiConfig(config);
        setAiForm({ baseUrl: config.baseUrl ?? "", apiKey: "", model: config.model ?? "" });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const saveAiConfig = async () => {
    setAiSaving(true);
    setAiMessage(null);
    try {
      const response = await fetch("/api/config/learning-ai", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(aiForm),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result?.error?.message ?? `HTTP ${response.status}`);
      setAiConfig(result);
      setAiForm({ baseUrl: result.baseUrl ?? "", apiKey: "", model: result.model ?? "" });
      setAiMessage("已保存并即时生效（无需重启）。");
    } catch (error) {
      setAiMessage(error.message);
    } finally {
      setAiSaving(false);
    }
  };

  const isLoading = runtime.source === "loading";
  const vault = runtime.data?.vault;
  const sync = runtime.data?.sync;
  const codex = runtime.data?.codex;
  const vaultConnected = vault?.connected === true;
  const vaultHasErrors = (vault?.errors ?? 0) > 0;
  const codexAvailable = codex?.available === true;

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await refreshVault();
      await loadRuntime();
    } catch (error) {
      console.error("刷新失败:", error);
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="page page--system">
      <PageHeader
        eyebrow="SYSTEM"
        title="系统状态"
        description="检查本地 Vault 索引与 Codex 运行时连接状态"
      />

      <div className="system-grid">
        {/* Vault Index Panel */}
        <div className="panel">
          <div className="panel__head">
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <span
                className={`status-dot ${
                  isLoading
                    ? ""
                    : vaultConnected && !vaultHasErrors
                      ? "status-dot--ok"
                      : "status-dot--warn"
                }`}
              />
              <h2 className="panel__title">Vault 索引</h2>
            </div>
          </div>

          <div>
            <div className="system-kv">
              <dt>标签</dt>
              <dd>{vault?.label || "本地 Vault"}</dd>
            </div>
            <div className="system-kv">
              <dt>文档数</dt>
              <dd>{isLoading ? "—" : vault?.documents ?? "—"}</dd>
            </div>
            <div className="system-kv">
              <dt>索引时间</dt>
              <dd>{formatFullDate(vault?.generatedAt)}</dd>
            </div>
            <div className="system-kv">
              <dt>错误数</dt>
              <dd>{isLoading ? "—" : vault?.errors ?? "—"}</dd>
            </div>
            <div className="system-kv">
              <dt>文件同步</dt>
              <dd>{isLoading ? "—" : sync?.status || "—"}</dd>
            </div>
            <div className="system-kv">
              <dt>索引版本</dt>
              <dd>{isLoading ? "—" : sync?.indexVersion ?? "—"}</dd>
            </div>
          </div>

          <button
            type="button"
            className="graph-filter"
            onClick={handleRefresh}
            disabled={refreshing || !vaultConnected}
            style={{ marginTop: "16px", width: "100%" }}
          >
            {refreshing ? "重建中…" : "重建索引"}
          </button>
        </div>

        {/* Codex Runtime Panel */}
        <div className="panel">
          <div className="panel__head">
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <span
                className={`status-dot ${
                  isLoading ? "" : codexAvailable ? "status-dot--ok" : ""
                }`}
              />
              <h2 className="panel__title">Codex 运行时</h2>
            </div>
          </div>

          <div>
            <div className="system-kv">
              <dt>可用性</dt>
              <dd>
                {isLoading
                  ? "检测中"
                  : codexAvailable
                    ? "可用"
                    : "不可用"}
              </dd>
            </div>
            <div className="system-kv">
              <dt>来源</dt>
              <dd>{isLoading ? "—" : codex?.source || "—"}</dd>
            </div>
          </div>
        </div>

        {/* Learning AI Panel */}
        <div className="panel">
          <div className="panel__head">
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <span
                className={`status-dot ${
                  aiConfig ? (aiConfig.configured ? "status-dot--ok" : "status-dot--warn") : ""
                }`}
              />
              <h2 className="panel__title">学习闯关 AI</h2>
            </div>
          </div>

          <div>
            <div className="system-kv">
              <dt>状态</dt>
              <dd>{aiConfig ? (aiConfig.configured ? "已配置" : "未配置") : "—"}</dd>
            </div>
            <div className="system-kv">
              <dt>配置来源</dt>
              <dd>
                {aiConfig?.source === "local-file"
                  ? "本页面保存的配置"
                  : aiConfig?.source === "env"
                    ? "Workbench/.env"
                    : "—"}
              </dd>
            </div>
            <div className="system-kv">
              <dt>API Key</dt>
              <dd>{aiConfig?.apiKeyPreview ?? "—"}</dd>
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginTop: "12px" }}>
            <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "13px" }}>
              Base URL（OpenAI 兼容接口）
              <input
                value={aiForm.baseUrl}
                placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1"
                onChange={(event) => setAiForm({ ...aiForm, baseUrl: event.target.value })}
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "13px" }}>
              API Key（留空则保留已保存的 Key）
              <input
                type="password"
                value={aiForm.apiKey}
                placeholder={aiConfig?.configured ? "已保存，留空保持不变" : "填入你的 API Key"}
                onChange={(event) => setAiForm({ ...aiForm, apiKey: event.target.value })}
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "13px" }}>
              模型
              <input
                value={aiForm.model}
                placeholder="qwen-plus"
                onChange={(event) => setAiForm({ ...aiForm, model: event.target.value })}
              />
            </label>
          </div>

          {aiMessage ? <p className="provenance" style={{ marginTop: "8px" }}>{aiMessage}</p> : null}

          <button
            type="button"
            className="graph-filter"
            onClick={saveAiConfig}
            disabled={aiSaving}
            style={{ marginTop: "16px", width: "100%" }}
          >
            {aiSaving ? "保存中…" : "保存 AI 配置"}
          </button>
        </div>
      </div>

      {/* Data boundary note */}
      <div className="panel" style={{ marginTop: "20px" }}>
        <p className="provenance">
          工作台通过本地文件事件自动更新 Vault 索引；数据缺失显示为 —，不做估算。
        </p>
      </div>
    </div>
  );
}
