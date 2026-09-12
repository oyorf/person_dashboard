import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  getDocument,
  searchIndex,
} from "./vault-index.mjs";
import {
  cancelJob,
  confirmJob,
  createXhsDraftJob,
  detectCodexCli,
  getJob,
  listJobs,
  subscribeJob,
} from "./codex-runner.mjs";
import {
  createIngestSnapshot,
  createReaderNotesRepository,
  hashReaderDocumentContent,
} from "./reader-notes.mjs";
import { createReaderExplanationsService } from "./reader-explanations.mjs";
import {
  MATERIAL_READING_STATE_PATH,
  createMaterialReadingStateRepository,
} from "./material-reading-state.mjs";
import {
  materialFolderPayload,
  materialReadingQueuePayload,
  materialsHomePayload,
} from "./materials.mjs";
import { booksPayload } from "./books.mjs";
import { projectsPayload } from "./learning.mjs";
import { createLearningStore } from "./learning-store.mjs";
import { createLearningAiClient, describeLearningAiConfig, loadLearningAiConfig, readLearningAiFileConfig, resolveLearningAiConfig, saveLearningAiFileConfig } from "./learning-ai.mjs";
import {
  JOB_STATUS_LABELS,
  JOB_STATUSES,
  createJobStore,
  jobKey,
} from "./job-store.mjs";
import { createJobScorer, hardFilterJob } from "./job-match.mjs";
import {
  getSocialInsight,
  getSocialTrend,
  listSocialInsights,
  listSocialTrends,
} from "./social-insights.mjs";
import { validateVaultSelections } from "./security.mjs";
import {
  WIKI_INGEST_STATUS,
  createWikiIngestRunner,
} from "./wiki-ingest-runner.mjs";
import { createVaultSyncService } from "./vault-sync.mjs";
import { loadAttentionStrategy } from "./public-config.mjs";

const workbenchRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const defaultVaultRoot = path.resolve(
  process.env.PERSONAL_DASHBOARD_VAULT_ROOT ||
    path.join(workbenchRoot, "..", "个人知识库"),
);
const jsonHeaders = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
};
const imageContentTypes = {
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  webp: "image/webp",
};
const maximumVaultImageBytes = 8 * 1024 * 1024;
const readerImageAllowedRoots = [
  "10_raw",
  "30_self_media",
  "40_topics",
  "50_scripts",
  "60_learning",
  "wiki",
];

function json(res, status, value) {
  res.writeHead(status, jsonHeaders);
  res.end(JSON.stringify(value));
}

async function serveVaultImage(res, index, vaultRoot, id) {
  const document = getDocument(index, id);
  const contentType = imageContentTypes[document?.extension];
  const isAllowedCover =
    document?.path.startsWith("50_scripts/") ||
    document?.path.startsWith("10_raw/books/");
  if (
    !document ||
    document.previewKind !== "image" ||
    !contentType ||
    !isAllowedCover
  ) {
    return json(res, 404, {
      error: { code: "VAULT_IMAGE_NOT_FOUND", message: "封面图片不存在。" },
    });
  }

  const validated = await validateVaultSelections([document.path], {
    vaultRoot,
    allowedRoots: ["50_scripts", "10_raw"],
  });
  const selection = validated.selections[0];
  if (
    !selection ||
    selection.kind !== "file" ||
    selection.size > maximumVaultImageBytes
  ) {
    return json(res, 413, {
      error: { code: "VAULT_IMAGE_TOO_LARGE", message: "封面图片超过读取上限。" },
    });
  }

  const buffer = await readFile(selection.absolutePath);
  res.writeHead(200, {
    "Cache-Control": "private, max-age=60",
    "Content-Length": buffer.byteLength,
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
  });
  res.end(buffer);
}

function readerImageDocument(index, sourceId, rawSource) {
  const sourceDocument = getDocument(index, sourceId);
  const source = String(rawSource ?? "").trim();
  if (
    !sourceDocument ||
    sourceDocument.previewKind !== "markdown" ||
    !source ||
    /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(source)
  ) {
    return null;
  }

  let decoded;
  try {
    decoded = decodeURIComponent(source.split(/[?#]/, 1)[0]).replace(/\\/g, "/");
  } catch {
    return null;
  }
  if (!decoded || decoded.includes("\0")) return null;

  const candidate = decoded.startsWith("/")
    ? path.posix.normalize(decoded.replace(/^\/+/, ""))
    : path.posix.normalize(
        path.posix.join(path.posix.dirname(sourceDocument.path), decoded),
      );
  if (
    !candidate ||
    candidate === "." ||
    candidate === ".." ||
    candidate.startsWith("../") ||
    path.posix.isAbsolute(candidate)
  ) {
    return null;
  }

  const imageDocument = getDocument(index, candidate);
  return imageDocument?.previewKind === "image" ? imageDocument : null;
}

async function serveReaderImage(res, index, vaultRoot, sourceId, source) {
  const document = readerImageDocument(index, sourceId, source);
  const contentType = imageContentTypes[document?.extension];
  if (!document || !contentType) {
    return json(res, 404, {
      error: { code: "READER_IMAGE_NOT_FOUND", message: "文章图片不存在。" },
    });
  }

  const validated = await validateVaultSelections([document.path], {
    vaultRoot,
    allowedRoots: readerImageAllowedRoots,
  });
  const selection = validated.selections[0];
  if (
    !selection ||
    selection.kind !== "file" ||
    selection.size > maximumVaultImageBytes
  ) {
    return json(res, 413, {
      error: { code: "READER_IMAGE_TOO_LARGE", message: "文章图片超过读取上限。" },
    });
  }

  const buffer = await readFile(selection.absolutePath);
  res.writeHead(200, {
    "Cache-Control": "private, max-age=60",
    "Content-Length": buffer.byteLength,
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
  });
  res.end(buffer);
}

function learningError(res, error) {
  const statusByCode = {
    AI_NOT_CONFIGURED: 503,
    DAG_INVALID: 422,
    EMPTY_SUBMISSION: 422,
    LEARNING_AI_KEY_REQUIRED: 422,
    INVALID_LEARNING_AI_BASE_URL: 422,
    LEVEL_LOCKED: 409,
    LEVEL_MASTERED: 409,
    ATTEMPT_NOT_PENDING: 409,
    REF_OUT_OF_VAULT: 422,
  };
  const status = statusByCode[error.code] ?? (error.code === "ENOENT" ? 404 : 500);
  return json(res, status, { error: { code: error.code ?? "LEARNING_ERROR", message: error.message } });
}

function errorPayload(error) {
  return {
    error: {
      code: error?.code || "WORKBENCH_ERROR",
      message: error?.message || "工作台请求失败。",
    },
  };
}

function errorStatus(error) {
  const code = error?.code;
  if (code === "AI_NOT_CONFIGURED") return 503;
  if (code === "LOCAL_API_ORIGIN_DENIED") return 403;
  if (code === "UNSUPPORTED_MEDIA_TYPE") return 415;
  if (
    ["JOB_NOT_FOUND", "DOCUMENT_NOT_FOUND", "READER_EXPLANATION_NOT_FOUND"].includes(code) ||
    code?.endsWith("_NOT_FOUND")
  ) return 404;
  if (
    [
      "CONCURRENCY_LIMIT",
      "CONFIRMATION_IN_PROGRESS",
      "JOB_OPERATION_IN_PROGRESS",
      "JOB_NOT_AWAITING_REVIEW",
      "INVALID_STATUS_TRANSITION",
      "SOURCE_CHANGED_SINCE_REVIEW",
      "NOTES_CHANGED_SINCE_REVIEW",
      "REVIEW_PLAN_STALE",
      "HANDOFF_PATH_CONFLICT",
      "TURN_LIMIT_REACHED",
      "TOO_MANY_READER_DOCUMENTS",
      "TOO_MANY_READER_NOTES",
      "DUPLICATE_READER_NOTE_ID",
      "DOCUMENT_PATH_ALREADY_NOTED",
      "READER_EXPLANATION_CONCURRENCY_LIMIT",
      "READER_EXPLANATION_FOLLOW_UP_LIMIT",
      "READER_EXPLANATION_SOURCE_CHANGED",
      "READER_EXPLANATION_NOT_COMPLETED",
      "CONTENT_HASH_MISMATCH",
      "FOLLOW_UP_LIMIT_REACHED",
      "EXPLANATION_NOT_COMPLETED",
      "EXPLANATION_ALREADY_SAVED",
      "TOO_MANY_EXPLANATIONS",
      "DUPLICATE_EXPLANATION_ID",
      "SERVICE_CLOSED",
      "RESERVED_READER_NOTE",
      "READER_EXPLANATION_NOTE_ID_CONFLICT",
      "TOO_MANY_MATERIAL_READING_ITEMS",
      "JOB_NOT_ACTIVE",
      "WRITEBACK_PLAN_REQUIRED",
      "WRITEBACK_PLAN_STALE",
      "WRITEBACK_PLAN_CHANGED",
    ].includes(code)
  ) {
    return 409;
  }
  if (
    code === "READER_NOTES_STORE_CORRUPT" ||
    code === "READER_NOTES_STORE_TOO_LARGE" ||
    code?.startsWith("UNSAFE_READER_NOTES_") ||
    code?.startsWith("UNSAFE_READER_EXPLANATIONS_") ||
    code?.startsWith("READER_EXPLANATIONS_STORE_") ||
    code?.startsWith("MATERIAL_READING_STATE_") ||
    code === "SYMLINK_ESCAPE"
  ) {
    return 500;
  }
  if (
    code === "INVALID_JSON" ||
    code === "REQUEST_TOO_LARGE" ||
    code?.startsWith("INVALID_") ||
    code?.startsWith("READER_NOTE") ||
    code?.startsWith("INVALID_EXPLANATION") ||
    code?.startsWith("INVALID_QUOTE") ||
    code?.startsWith("SOURCE_") ||
    code?.startsWith("NOTES_") ||
    code?.startsWith("REVIEW_") ||
    code === "PATH_TRAVERSAL" ||
    code === "NO_READER_NOTES" ||
    code === "UNSUPPORTED_EXPLANATION_OVERRIDE" ||
    code === "EXPLANATION_INPUT_TOO_LONG" ||
    code === "QUOTE_CONTEXT_MISMATCH" ||
    code === "QUOTE_NOT_IN_DOCUMENT" ||
    code === "QUESTION_REQUIRED" ||
    code === "DOCUMENT_MISMATCH" ||
    code === "QUOTE_MISMATCH" ||
    code?.startsWith("INVALID_MATERIAL")
  ) {
    return 400;
  }
  return 500;
}

function assertLocalMutationRequest(req) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method || "")) return;
  const fetchSite = String(req.headers["sec-fetch-site"] || "").toLowerCase();
  if (fetchSite === "cross-site") {
    const error = new Error("本地工作台拒绝跨站修改请求。");
    error.code = "LOCAL_API_ORIGIN_DENIED";
    throw error;
  }

  const origin = req.headers.origin;
  const host = req.headers.host;
  if (origin && host) {
    let originHost = null;
    try {
      originHost = new URL(origin).host;
    } catch {
      // Invalid Origin headers are rejected below.
    }
    if (originHost !== host) {
      const error = new Error("本地工作台拒绝来自其他 Origin 的修改请求。");
      error.code = "LOCAL_API_ORIGIN_DENIED";
      throw error;
    }
  }

  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  if (!contentType.startsWith("application/json")) {
    const error = new Error("修改请求必须使用 application/json。");
    error.code = "UNSUPPORTED_MEDIA_TYPE";
    throw error;
  }
}

function assertAllowedObjectKeys(value, allowedKeys, code = "INVALID_READER_EXPLANATION_REQUEST") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    const error = new Error("请求必须是 JSON 对象。");
    error.code = code;
    throw error;
  }
  const unexpected = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unexpected.length) {
    const error = new Error(`请求包含不允许的字段：${unexpected.join("、")}`);
    error.code = code;
    throw error;
  }
}

function readerExplanationDocumentId(record) {
  if (record?.document && typeof record.document === "object") {
    return record.document.id ?? record.document.documentId ?? null;
  }
  return record?.documentId ?? record?.document ?? null;
}

function readerExplanationThread(records, targetId) {
  const rows = Array.isArray(records) ? records : [];
  const byId = new Map(rows.filter((record) => record?.id).map((record) => [String(record.id), record]));
  const rootOf = (record) => {
    let current = record;
    const seen = new Set();
    while (current?.parentId && byId.has(String(current.parentId))) {
      if (seen.has(String(current.id))) break;
      seen.add(String(current.id));
      current = byId.get(String(current.parentId));
    }
    return current;
  };
  const target = byId.get(String(targetId));
  if (!target) return [];
  const rootId = String(rootOf(target)?.id || target.id);
  return rows
    .filter((record) => String(rootOf(record)?.id || record.id) === rootId)
    .sort((left, right) =>
      (Number(left.followUpDepth) || 0) - (Number(right.followUpDepth) || 0) ||
      String(left.createdAt || "").localeCompare(String(right.createdAt || "")),
    );
}

function renderReaderExplanationNote(records) {
  const completed = (Array.isArray(records) ? records : [])
    .filter((record) => record?.status === "completed" && record?.result);
  const turns = completed.flatMap((record, index) => {
    const result = record.result || {};
    const answer = result.answer || result.plainLanguage || "_本轮没有生成回答。_";
    const question = String(record.question || "").trim();
    const questionLabel = index === 0 ? "我的问题" : `我的追问 ${index}`;
    const answerLabel = index === 0 ? "Codex 回答" : `Codex 继续回答 ${index}`;
    return [
      ...(index > 0 ? ["", "---", ""] : []),
      `**${questionLabel}**`,
      "",
      question || (index === 0 ? "_未填写问题，直接理解原文。_" : "_本轮问题缺失。_"),
      "",
      `**${answerLabel}**`,
      "",
      answer,
    ];
  });
  return [
    "> AI 阅读辅助，非用户判断。以下内容由 Codex 结合保存时对应版本的整篇原文生成，请回到原文核对。",
    "",
    ...turns,
  ].join("\n");
}

async function readJson(req, maximumBytes = 64 * 1024) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw, "utf8") > maximumBytes) {
      const error = new Error("请求内容超过安全上限。");
      error.code = "REQUEST_TOO_LARGE";
      throw error;
    }
  }

  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("请求 JSON 无法解析。");
    error.code = "INVALID_JSON";
    throw error;
  }
}

function groupDefinition(key, label, count, description = undefined) {
  return { key, label, count, ...(description ? { description } : {}) };
}

function materialGroup(document) {
  const section = document.section;
  if (["articles", "deep-reading", "web-search"].includes(section)) return "reading";
  if (["my-thoughts", "personal-reviews", "diagnosis-cases"].includes(section)) return "personal";
  if (section === "douyin") return "douyin";
  if (section === "codex-sessions") return "sessions";
  return "other";
}

function collectionPayload(index, kind) {
  if (kind === "materials") {
    const items = index.documents
      .filter(
        (item) =>
          item.layer === "raw" &&
          !item.path.startsWith("10_raw/books/") &&
          !item.path.startsWith("10_raw/social-insights/"),
      )
      .map((item) => ({ ...item, group: materialGroup(item) }));
    const counts = Object.groupBy
      ? Object.groupBy(items, (item) => item.group)
      : items.reduce((result, item) => {
          (result[item.group] ||= []).push(item);
          return result;
        }, {});
    return {
      total: items.length,
      groups: [
        groupDefinition("reading", "阅读与研究", counts.reading?.length ?? 0, "文章、深度阅读与网页研究"),
        groupDefinition("personal", "个人输入", counts.personal?.length ?? 0, "每日想法、读后思考与诊断案例"),
        groupDefinition("douyin", "抖音证据", counts.douyin?.length ?? 0, "作品数据、截图与复盘证据包"),
        groupDefinition("sessions", "Codex 活动", counts.sessions?.length ?? 0, "每周 Session 轻量索引"),
      ],
      items,
    };
  }

  if (kind === "wiki") {
    const typeLabels = {
      source: "来源拆解",
      framework: "方法框架",
      concept: "核心概念",
      diagnosis: "诊断判断",
      analysis: "综合分析",
      case: "具体案例",
      comparison: "比较选型",
      topic: "主题入口",
      conflict: "争议问题",
      question: "复用问答",
    };
    const groups = Object.entries(index.wiki.countsByType)
      .sort((left, right) => right[1] - left[1])
      .map(([key, count]) => groupDefinition(key, typeLabels[key] ?? key, count));
    return {
      total: index.wiki.pages.length,
      groups,
      items: index.wiki.pages,
    };
  }

  if (kind === "content") {
    const stageLabels = {
      idea: "候选",
      material_validating: "素材验证中",
      filmed: "已拍",
      published: "已发布",
      selected: "已确认",
      topic_selected: "已选题",
      ready_to_shoot: "准备完成",
    };
    const groups = Object.entries(index.topics.countsByPipelineStage)
      .sort((left, right) => right[1] - left[1])
      .map(([key, count]) => groupDefinition(key, stageLabels[key] ?? key, count));
    const items = index.topics.items.map((item) => ({
      ...item,
      layer: "topic",
      type: "Topic",
      section: item.series || item.folderStatus,
      status: item.pipelineStage,
      excerpt: [
        item.isFilmed ? "已拍" : null,
        item.isPublished ? "已发布" : null,
        item.displayFormat,
      ]
        .filter(Boolean)
        .join(" · "),
    }));
    return { total: items.length, groups, items };
  }

  if (kind === "archive") {
    const labels = {
      data_reviews: "数据复盘",
      weekly_reviews: "周复盘",
      content_strategy: "内容策略",
      content_reviews: "内容审查",
      system_design: "系统设计",
      rule_sync: "规则修复",
      topic_outputs: "选题探索",
      dashboards: "Dashboard",
    };
    const groups = Object.entries(index.runs.countsByCategory)
      .sort((left, right) => right[1] - left[1])
      .map(([key, count]) => groupDefinition(key, labels[key] ?? key, count));
    return { total: index.runs.items.length, groups, items: index.runs.items };
  }

  return { total: 0, groups: [], items: [] };
}

function overviewPayload(index) {
  const candidateCount = index.topics.items.filter(
    (topic) =>
      topic.folderStatus === "idea" &&
      !topic.isFilmed &&
      !topic.isPublished,
  ).length;
  const douyinAvailable = index.douyin.available === true;
  const personalKnowledgeLine = douyinAvailable
    ? index.douyin.contentLines.find((line) =>
        String(line.name || "").includes("个人知识库"),
      )
    : null;
  let cumulativePlays = 0;
  const douyinTrend = [...(douyinAvailable ? index.douyin.monthly ?? [] : [])]
    .filter((item) => item.month && Number.isFinite(item.views))
    .sort((left, right) => String(left.month).localeCompare(String(right.month)))
    .map((item) => {
      cumulativePlays += item.views;
      return {
        date: item.month,
        plays: item.views,
        cumulativePlays,
        workCount: item.workCount,
      };
    });
  const douyinRange = index.douyin.range ?? {};
  const douyinRangeLabel =
    douyinRange.from && douyinRange.to
      ? `${douyinRange.from} → ${douyinRange.to}`
      : null;
  const douyinQualityNotices = douyinAvailable
    ? [
        `来源：${index.douyin.sourcePath}；${index.douyin.comparableCount} 条可比作品${douyinRangeLabel ? `，作品发布时间范围 ${douyinRangeLabel}` : ""}。`,
        "图表按作品发布月份汇总当前累计播放，不代表账号每日新增播放。",
        ...(index.douyin.qualityIssues ?? [])
          .slice(0, 3)
          .map((issue) => `${issue.issue}${issue.affectedWorks ? `（${issue.affectedWorks}）` : ""}`),
      ]
    : [
        `抖音数据源不可用：${index.douyin.sourcePath} 未找到或无法解析。`,
      ];
  const filmedTopics = index.topics.items
    .filter((topic) => topic.isFilmed)
    .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
    .slice(0, 2);
  const byUpdated = (left, right) =>
    (Date.parse(right.updatedAt) || 0) - (Date.parse(left.updatedAt) || 0);
  const selectedRecent = [
    ...index.documents
      .filter((item) => !item.isArchived && item.layer === "wiki" && item.kind === "knowledge")
      .sort(byUpdated)
      .slice(0, 3),
    ...index.documents
      .filter((item) => !item.isArchived && item.layer === "raw")
      .sort(byUpdated)
      .slice(0, 3),
  ].sort(byUpdated);
  const sourceLabels = {
    source: "来源拆解",
    framework: "方法框架",
    concept: "核心概念",
    diagnosis: "诊断判断",
    analysis: "综合分析",
    comparison: "比较选型",
    case: "案例",
    articles: "文章原文",
    "deep-reading": "深度阅读",
    "web-search": "网页研究",
    "my-thoughts": "个人想法",
    "personal-reviews": "读后思考",
    "diagnosis-cases": "诊断案例",
    douyin: "抖音证据",
  };

  return {
    generatedAt: index.generatedAt,
    demoMode: index.demoMode === true,
    metrics: {
      raw: index.stats.rawFiles,
      wiki: index.stats.formalWikiPages,
      topics: index.stats.topics,
      candidates: candidateCount,
      filmed: index.stats.filmedTopics,
      publishedWorks: douyinAvailable ? index.stats.douyinWorks : null,
      runs: index.stats.runs,
      totalPlays: douyinAvailable
        ? index.douyin.summary.totalViews ?? null
        : null,
      profileVisits: douyinAvailable
        ? index.douyin.summary.totalProfileVisits ?? null
        : null,
      profileVisitsIsLowerBound:
        douyinAvailable &&
        index.douyin.summaryLowerBounds.totalProfileVisits === true,
      knowledgeContribution: personalKnowledgeLine?.viewSharePct ?? null,
    },
    wikiStatus: {
      active: index.wiki.countsByStatus.active ?? 0,
      needsReview:
        index.wiki.countsByStatus["needs-review"] ??
        index.wiki.countsByStatus.needs_review ??
        0,
      deprecated: index.wiki.countsByStatus.deprecated ?? 0,
    },
    recent: selectedRecent.map((item) => ({
      ...item,
      type: item.layer === "wiki" ? "Wiki" : "素材",
      section: sourceLabels[item.type] ?? sourceLabels[item.section] ?? item.section,
      relativePath: item.path,
    })),
    activity: filmedTopics.map((topic) => ({
      id: topic.id,
      documentId: topic.id,
      status: topic.isPublished ? "已拍摄 · 已发布" : "已拍摄",
      title: topic.title,
      meta: `更新于 ${String(topic.updatedAt || "").slice(5, 16).replace("T", " ")}`,
      dateTime: topic.updatedAt,
    })),
    douyinTrend,
    douyinAvailable,
    douyinQualityFlags: index.douyin.qualityFlags ?? [],
    douyinTrendTitle: douyinAvailable
      ? `作品播放汇总 · 按发布月份${douyinRange.to ? `（截至 ${String(douyinRange.to).slice(0, 10)}）` : ""}`
      : "抖音作品数据不可用",
    dataProvenance: douyinAvailable
      ? {
          sourcePath: index.douyin.sourcePath,
          sourceUpdatedAt: index.douyin.updatedAt,
          comparableWorks: index.douyin.comparableCount,
          range: douyinRange,
          trendGrain: "作品发布月份",
          trendMetric: "各月发布作品的当前累计播放",
          isRealtime: false,
        }
      : null,
    qualityNotices: douyinQualityNotices,
  };
}

function graphPayload(index) {
  const nodes = index.documents.filter(
    (document) =>
      document.layer === "wiki" &&
      document.kind === "knowledge" &&
      document.extension === "md",
  );
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edgeMap = new Map();
  for (const node of nodes) {
    for (const link of node.wikiLinks ?? []) {
      if (!link.resolvedId || !nodeIds.has(link.resolvedId)) continue;
      if (link.resolvedId === node.id) continue;
      const key = `${node.id}__${link.resolvedId}`;
      const existing = edgeMap.get(key);
      if (existing) existing.weight += 1;
      else edgeMap.set(key, { source: node.id, target: link.resolvedId, weight: 1 });
    }
  }
  const degree = new Map();
  const inDegree = new Map();
  const outDegree = new Map();
  for (const edge of edgeMap.values()) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
    outDegree.set(edge.source, (outDegree.get(edge.source) ?? 0) + 1);
    inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
  }
  return {
    generatedAt: index.generatedAt,
    stats: {
      nodeCount: nodes.length,
      edgeCount: edgeMap.size,
      isolatedCount: nodes.filter((node) => !degree.has(node.id)).length,
    },
    typeCounts: index.wiki?.countsByType ?? {},
    nodes: nodes.map((node) => ({
      id: node.id,
      title: node.title,
      type: node.type ?? "other",
      status: node.status ?? null,
      section: node.section ?? null,
      tags: node.tags ?? [],
      updatedAt: node.updatedAt,
      degree: degree.get(node.id) ?? 0,
      inDegree: inDegree.get(node.id) ?? 0,
      outDegree: outDegree.get(node.id) ?? 0,
    })),
    edges: [...edgeMap.values()],
  };
}

function readerBodyFromContent(content) {
  return typeof content === "string"
    ? content.replace(/^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/, "")
    : content;
}

function documentPayload(index, id) {
  const document = getDocument(index, id);
  if (!document) return null;
  const body = readerBodyFromContent(document.content);
  return {
    ...document,
    relativePath: document.path,
    body,
    contentHash:
      typeof body === "string" ? hashReaderDocumentContent(body) : null,
    outgoingLinks: (document.wikiLinks ?? [])
      .filter((link) => link.resolvedId)
      .map((link) => ({
        id: link.resolvedId,
        title: link.label || link.target,
      })),
  };
}

function requestFilters(url) {
  const filters = {};
  for (const key of ["layer", "kind", "section", "type", "status", "extension", "tags"]) {
    const values = url.searchParams.getAll(key).filter(Boolean);
    if (values.length) filters[key] = values.length === 1 ? values[0] : values;
  }
  if (url.searchParams.get("includeArchived") === "true") filters.includeArchived = true;
  filters.limit = Number(url.searchParams.get("limit") || 100);
  return filters;
}

function openLocalDocument(vaultRoot, document, target) {
  const absolutePath = path.resolve(vaultRoot, document.path);
  if (target === "finder") {
    const child = spawn("/usr/bin/open", ["-R", absolutePath], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return;
  }

  const vaultName = path.basename(vaultRoot);
  const url = `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(document.path)}`;
  const child = spawn("/usr/bin/open", [url], { detached: true, stdio: "ignore" });
  child.unref();
}

export function workbenchApiPlugin({
  vaultRoot = defaultVaultRoot,
  readerExplanationService = null,
} = {}) {
  let readerNoteApiMutationQueue = Promise.resolve();
  const readerNotes = createReaderNotesRepository({ vaultRoot });
  const materialReadingState = createMaterialReadingStateRepository({ vaultRoot });
  const wikiIngest = createWikiIngestRunner({ vaultRoot });
  const readerExplanations = readerExplanationService ??
    createReaderExplanationsService({ vaultRoot });
  const vaultSync = createVaultSyncService({ vaultRoot });
  const currentIndex = () => vaultSync.currentIndex();
  const refreshIndex = (options = {}) => vaultSync.refresh({
    reason: "manual",
    ...options,
  });
  loadLearningAiConfig({ workbenchRoot }); // 启动时把 .env 灌入 process.env
  let learningAi = { config: null, client: null, source: null };
  const rebuildLearningAi = () => {
    const fileConfig = readLearningAiFileConfig(workbenchRoot);
    const config = resolveLearningAiConfig({ fileConfig });
    learningAi = {
      config,
      client: config ? createLearningAiClient(config) : null,
      source: !config ? null : fileConfig?.apiKey ? "local-file" : "env",
    };
  };
  rebuildLearningAi();
  const learningStore = createLearningStore({
    vaultRoot,
    ai: () => learningAi.client,
  });
  const jobStore = createJobStore({
    filePath: path.join(workbenchRoot, "data", "job-tracker.local.json"),
  });
  const loadJobProfile = async () => {
    try {
      return JSON.parse(
        await readFile(path.join(workbenchRoot, "config", "job-profile.local.json"), "utf8"),
      );
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  };
  const jobTrackerPayload = async () => {
    const [jobs, followups, today] = await Promise.all([
      jobStore.list(),
      jobStore.pendingFollowups(),
      jobStore.todayRecommendations(),
    ]);
    const groups = JOB_STATUSES.map((status) => {
      const items = jobs.filter((job) => job.status === status);
      return { status, label: JOB_STATUS_LABELS[status], count: items.length, items };
    });
    return { generatedAt: new Date().toISOString(), total: jobs.length, followups, today, groups };
  };

  async function indexedReaderDocument(documentId) {
    const document = documentPayload(await currentIndex(), documentId);
    if (!document) {
      const error = new Error("文档不存在。");
      error.code = "DOCUMENT_NOT_FOUND";
      throw error;
    }
    return document;
  }

  async function freshIndexedReaderDocument(documentId) {
    const indexed = await indexedReaderDocument(documentId);
    if (typeof indexed.body !== "string") {
      const error = new Error("当前文档没有可可靠读取的文本正文。");
      error.code = "INVALID_DOCUMENT_BODY";
      throw error;
    }
    const validated = await validateVaultSelections([indexed.relativePath], {
      vaultRoot,
    });
    const selected = validated.selections[0];
    if (!selected || selected.kind !== "file") {
      const error = new Error("当前文档路径无法重新读取。");
      error.code = "DOCUMENT_NOT_FOUND";
      throw error;
    }
    const content = await readFile(selected.absolutePath, "utf8");
    const body = readerBodyFromContent(content);
    return {
      ...indexed,
      relativePath: selected.relativePath,
      content,
      body,
      contentHash: hashReaderDocumentContent(body),
    };
  }

  function queueReaderNoteMutation(operation) {
    const result = readerNoteApiMutationQueue.then(operation, operation);
    readerNoteApiMutationQueue = result.catch(() => {});
    return result;
  }

  function saveOneReaderNote(
    document,
    note,
    { allowCodexExplanation = false } = {},
  ) {
    return queueReaderNoteMutation(async () => {
      const existing = await readerNotes.get(document.id);
      const previousNotes = existing?.notes ?? [];
      const existingIndex = note?.id
        ? previousNotes.findIndex((item) => item.id === note.id)
        : -1;
      const previousNote = existingIndex >= 0 ? previousNotes[existingIndex] : null;
      if (!allowCodexExplanation && previousNote?.origin === "codex-explanation") {
        const error = new Error("AI 阅读辅助保持原始归属，不能通过普通笔记接口改写。");
        error.code = "RESERVED_READER_NOTE";
        throw error;
      }
      if (
        allowCodexExplanation &&
        previousNote &&
        (
          previousNote.origin !== "codex-explanation" ||
          previousNote.sourceAnalysisId !== note?.sourceAnalysisId
        )
      ) {
        const error = new Error("解释笔记 ID 已被其他笔记占用，已停止保存。");
        error.code = "READER_EXPLANATION_NOTE_ID_CONFLICT";
        throw error;
      }
      const nextNotes = [...previousNotes];
      if (existingIndex >= 0) nextNotes[existingIndex] = note;
      else nextNotes.push(note);

      const previousIds = new Set(previousNotes.map((item) => item.id));
      const saved = await readerNotes.save({
        documentId: document.id,
        relativePath: document.relativePath,
        title: document.title,
        contentHash: document.contentHash,
        notes: nextNotes,
      });
      const savedNote = note?.id
        ? saved.notes.find((item) => item.id === note.id)
        : saved.notes.find((item) => !previousIds.has(item.id));
      return { saved, savedNote: savedNote ?? null };
    });
  }

  function deleteOneReaderNote(document, noteId) {
    return queueReaderNoteMutation(async () => {
      const existing = await readerNotes.get(document.id);
      const nextNotes = (existing?.notes ?? []).filter((note) => note.id !== noteId);
      if (!existing || nextNotes.length === existing.notes.length) return false;
      if (nextNotes.length === 0) {
        await readerNotes.delete(document.id);
      } else {
        await readerNotes.save({
          ...existing,
          title: document.title,
          relativePath: document.relativePath,
          contentHash: document.contentHash,
          notes: nextNotes,
        });
      }
      return true;
    });
  }

  function snapshotReaderNotes(document, snapshotId) {
    return queueReaderNoteMutation(async () => {
      const existing = await readerNotes.get(document.id);
      const saved = await readerNotes.save({
        documentId: document.id,
        relativePath: document.relativePath,
        title: document.title,
        contentHash: document.contentHash,
        notes: existing?.notes ?? [],
      });
      return createIngestSnapshot(saved, saved.notes, {
        vaultRoot,
        jobId: snapshotId,
      });
    });
  }

  function refreshWhenIngestFinishes(jobId) {
    let unsubscribe = () => {};
    unsubscribe = wikiIngest.subscribeJob(jobId, (job) => {
      if (
        ![
          WIKI_INGEST_STATUS.COMPLETED,
          WIKI_INGEST_STATUS.FAILED,
          WIKI_INGEST_STATUS.CANCELLED,
        ].includes(job.status)
      ) {
        return;
      }
      queueMicrotask(async () => {
        unsubscribe();
        if (job.status === WIKI_INGEST_STATUS.COMPLETED) {
          await refreshIndex({
            reason: "wiki-ingest",
            paths: ["wiki"],
          }).catch(() => {});
        }
      });
    });
  }

  return {
    name: "personal-kb-workbench-api",
    async closeBundle() {
      await vaultSync.close();
      await readerExplanations.close?.();
    },
    configureServer(server) {
      vaultSync.attachWatcher(server.watcher);
      server.httpServer?.once("close", () => {
        void vaultSync.close();
      });
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url || "/", "http://127.0.0.1");
        if (!url.pathname.startsWith("/api/")) return next();

        try {
          assertLocalMutationRequest(req);
          if (
            url.pathname.startsWith("/api/brainstorm/") ||
            url.pathname === "/api/public-account/dashboard"
          ) {
            return json(res, 404, {
              code: "FEATURE_NOT_INCLUDED",
              message: "该模块未包含在公开版中。",
            });
          }
          if (req.method === "GET" && url.pathname === "/api/vault/events") {
            res.writeHead(200, {
              "Cache-Control": "no-cache, no-transform",
              Connection: "keep-alive",
              "Content-Type": "text/event-stream; charset=utf-8",
              "X-Accel-Buffering": "no",
            });
            res.write(": connected\n\n");
            const unsubscribe = vaultSync.subscribe((event) => {
              res.write(`data: ${JSON.stringify(event)}\n\n`);
            });
            req.on("close", unsubscribe);
            return;
          }

          if (req.method === "GET" && url.pathname === "/api/vault/sync") {
            return json(res, 200, vaultSync.getStatus());
          }

          if (req.method === "GET" && url.pathname === "/api/overview") {
            return json(res, 200, overviewPayload(await currentIndex()));
          }

          if (req.method === "GET" && url.pathname === "/api/config/attention") {
            return json(res, 200, await loadAttentionStrategy(workbenchRoot));
          }

          if (req.method === "GET" && url.pathname === "/api/config/learning-ai") {
            return json(res, 200, describeLearningAiConfig(learningAi.config, learningAi.source));
          }

          if (req.method === "PUT" && url.pathname === "/api/config/learning-ai") {
            try {
              const body = await readJson(req, 8 * 1024);
              await saveLearningAiFileConfig(workbenchRoot, {
                baseUrl: typeof body.baseUrl === "string" ? body.baseUrl : "",
                apiKey: typeof body.apiKey === "string" ? body.apiKey : "",
                model: typeof body.model === "string" ? body.model : "",
              });
              rebuildLearningAi();
              return json(res, 200, describeLearningAiConfig(learningAi.config, learningAi.source));
            } catch (error) { return learningError(res, error); }
          }

          if (req.method === "GET" && url.pathname === "/api/materials") {
            const [current, readingState] = await Promise.all([
              currentIndex(),
              materialReadingState.list(),
            ]);
            return json(res, 200, materialsHomePayload(current, readingState));
          }

          if (req.method === "GET" && url.pathname === "/api/books") {
            return json(res, 200, booksPayload(await currentIndex()));
          }

          if (req.method === "GET" && url.pathname === "/api/learning/projects") {
            return json(res, 200, {
              ...projectsPayload(await currentIndex()),
              aiConfigured: Boolean(learningAi.config),
            });
          }

          const learningProjectMatch = url.pathname.match(/^\/api\/learning\/projects\/([a-z0-9-]+)$/);
          if (req.method === "GET" && learningProjectMatch) {
            try {
              return json(res, 200, {
                ...(await learningStore.readProjectDetail(learningProjectMatch[1])),
                aiConfigured: Boolean(learningAi.config),
              });
            } catch (error) { return learningError(res, error); }
          }

          const learningLevelMatch = url.pathname.match(/^\/api\/learning\/projects\/([a-z0-9-]+)\/levels\/([a-z0-9-]+)$/);
          if (req.method === "GET" && learningLevelMatch) {
            try {
              return json(res, 200, await learningStore.readLevelDetail(learningLevelMatch[1], learningLevelMatch[2]));
            } catch (error) { return learningError(res, error); }
          }

          const learningAttemptsMatch = url.pathname.match(/^\/api\/learning\/projects\/([a-z0-9-]+)\/levels\/([a-z0-9-]+)\/attempts$/);
          if (req.method === "GET" && learningAttemptsMatch) {
            try {
              const attempts = await learningStore.listAttempts(learningAttemptsMatch[1], learningAttemptsMatch[2]);
              return json(res, 200, {
                attempts: attempts.map((entry) => ({ id: entry.id, ...entry.frontmatter, body: entry.body })),
              });
            } catch (error) { return learningError(res, error); }
          }

          if (req.method === "POST" && url.pathname === "/api/learning/projects") {
            try {
              const body = await readJson(req, 64 * 1024);
              const created = await learningStore.createProject({
                title: String(body.title ?? "").trim(),
                description: String(body.description ?? ""),
                sources: Array.isArray(body.sources) ? body.sources.map(String) : [],
                slug: body.slug,
              });
              await refreshIndex({ reason: "learning" });
              return json(res, 200, created);
            } catch (error) { return learningError(res, error); }
          }

          const publishMatch = url.pathname.match(/^\/api\/learning\/projects\/([a-z0-9-]+)\/levels:publish$/);
          if (req.method === "POST" && publishMatch) {
            try {
              const body = await readJson(req, 256 * 1024);
              const result = await learningStore.publishLevels(publishMatch[1], body.levels ?? []);
              await refreshIndex({ reason: "learning" });
              return json(res, 200, result);
            } catch (error) { return learningError(res, error); }
          }

          if (req.method === "PUT" && learningLevelMatch) {
            try {
              const body = await readJson(req, 256 * 1024);
              const result = await learningStore.updateLevel(learningLevelMatch[1], learningLevelMatch[2], body);
              await refreshIndex({ reason: "learning" });
              return json(res, 200, result);
            } catch (error) { return learningError(res, error); }
          }

          const submitMatch = url.pathname.match(/^\/api\/learning\/projects\/([a-z0-9-]+)\/levels\/([a-z0-9-]+)\/submit$/);
          if (req.method === "POST" && submitMatch) {
            try {
              const body = await readJson(req, 512 * 1024);
              const result = await learningStore.submitAttempt(submitMatch[1], submitMatch[2], {
                contentMd: String(body.content_md ?? ""),
                vaultRefs: Array.isArray(body.vault_refs) ? body.vault_refs.map(String) : [],
              });
              await refreshIndex({ reason: "learning" });
              return json(res, 200, result);
            } catch (error) { return learningError(res, error); }
          }

          const probeMatch = url.pathname.match(/^\/api\/learning\/projects\/([a-z0-9-]+)\/levels\/([a-z0-9-]+)\/probe$/);
          if (req.method === "POST" && probeMatch) {
            try {
              const body = await readJson(req, 256 * 1024);
              const result = await learningStore.answerProbe(probeMatch[1], probeMatch[2], String(body.attempt_id ?? ""), {
                answers: Array.isArray(body.answers) ? body.answers.map(String) : [],
              });
              await refreshIndex({ reason: "learning" });
              return json(res, 200, result);
            } catch (error) { return learningError(res, error); }
          }

          const retryMatch = url.pathname.match(/^\/api\/learning\/projects\/([a-z0-9-]+)\/levels\/([a-z0-9-]+)\/retry$/);
          if (req.method === "POST" && retryMatch) {
            try {
              const result = await learningStore.retryVariant(retryMatch[1], retryMatch[2]);
              await refreshIndex({ reason: "learning" });
              return json(res, 200, result);
            } catch (error) { return learningError(res, error); }
          }

          const selfAssessMatch = url.pathname.match(/^\/api\/learning\/projects\/([a-z0-9-]+)\/levels\/([a-z0-9-]+)\/self-assess$/);
          if (req.method === "POST" && selfAssessMatch) {
            try {
              const body = await readJson(req, 64 * 1024);
              const result = await learningStore.selfAssess(selfAssessMatch[1], selfAssessMatch[2], { score: body.score });
              await refreshIndex({ reason: "learning" });
              return json(res, 200, result);
            } catch (error) { return learningError(res, error); }
          }

          // 求职跟踪端点
          if (req.method === "GET" && url.pathname === "/api/job-tracker/jobs") {
            return json(res, 200, await jobTrackerPayload());
          }

          if (req.method === "POST" && url.pathname === "/api/job-tracker/jobs/import") {
            const body = await readJson(req, 256 * 1024);
            const text = String(body.text ?? "").trim();
            if (!text) {
              const error = new Error("JD 文本不能为空。");
              error.code = "INVALID_JOB_IMPORT";
              throw error;
            }
            if (!learningAi.config) {
              const error = new Error("AI 未配置：请先在「系统状态」页保存 LEARNING_AI 配置。");
              error.code = "AI_NOT_CONFIGURED";
              throw error;
            }
            const scorer = createJobScorer(learningAi.config);
            const cleaned = await scorer.importJd({ text });
            await jobStore.upsertMany([cleaned]);
            const jobs = await jobStore.list();
            const key = jobKey(cleaned);
            const job = jobs.find((entry) => entry.key === key);
            // 有画像时顺手过滤 + 打分，让投喂的岗位直接进入推荐视野
            const profile = await loadJobProfile();
            if (job && profile) {
              const filtered = hardFilterJob(job, profile);
              await jobStore.setMatchResult(job.id, {
                filterPass: filtered.pass,
                filterReasons: filtered.reasons,
              });
              if (filtered.pass) {
                try {
                  const scored = await scorer.score({ profile, job });
                  await jobStore.setMatchResult(job.id, {
                    score: scored.score,
                    scoreReasons: scored.reasons,
                  });
                } catch (scoreError) {
                  server.config.logger.warn(`job-tracker 投喂打分失败：${scoreError.message}`);
                }
              }
            }
            return json(res, 200, {
              job: (await jobStore.list()).find((entry) => entry.key === key) ?? null,
            });
          }

          const jobStatusMatch = url.pathname.match(/^\/api\/job-tracker\/jobs\/([^/]+)\/status$/);
          if (req.method === "POST" && jobStatusMatch) {
            const body = await readJson(req, 8 * 1024);
            const updated = await jobStore.setStatus(
              decodeURIComponent(jobStatusMatch[1]),
              String(body.status ?? ""),
              { appliedAt: typeof body.appliedAt === "string" ? body.appliedAt : undefined },
            );
            return json(res, 200, { job: updated });
          }

          // AI 代理端点
          if (req.method === "POST" && url.pathname === "/api/learning/ai/decompose") {
            try {
              if (!learningAi.client) throw Object.assign(new Error("AI 未配置"), { code: "AI_NOT_CONFIGURED" });
              const body = await readJson(req, 256 * 1024);
              const sourcesText = Array.isArray(body.sources)
                ? (await Promise.all(body.sources.map(async (ref) => {
                    const absolute = path.join(vaultRoot, String(ref));
                    if (!absolute.startsWith(vaultRoot)) return "";
                    try { return await readFile(absolute, "utf8"); } catch { return ""; }
                  }))).join("\n\n")
                : "";
              return json(res, 200, await learningAi.client.decompose({
                title: String(body.title ?? ""), description: String(body.description ?? ""), sourcesText,
              }));
            } catch (error) { return learningError(res, error); }
          }

          if (req.method === "POST" && url.pathname === "/api/learning/ai/challenge") {
            try {
              if (!learningAi.client) throw Object.assign(new Error("AI 未配置"), { code: "AI_NOT_CONFIGURED" });
              const body = await readJson(req, 256 * 1024);
              return json(res, 200, await learningAi.client.challenge({
                projectTitle: String(body.project_title ?? ""),
                levels: Array.isArray(body.levels) ? body.levels : [],
              }));
            } catch (error) { return learningError(res, error); }
          }

          if (req.method === "GET" && url.pathname === "/api/materials/folder") {
            const [current, readingState] = await Promise.all([
              currentIndex(),
              materialReadingState.list(),
            ]);
            return json(
              res,
              200,
              materialFolderPayload(
                current,
                readingState,
                url.searchParams.get("path") || "10_raw",
              ),
            );
          }

          if (req.method === "GET" && url.pathname === "/api/material-reading-queue") {
            const [current, readingState] = await Promise.all([
              currentIndex(),
              materialReadingState.list(),
            ]);
            return json(res, 200, materialReadingQueuePayload(current, readingState));
          }

          if (req.method === "POST" && url.pathname === "/api/material-reading-queue") {
            const body = await readJson(req, 16 * 1024);
            assertAllowedObjectKeys(
              body,
              new Set(["documentId", "contentHash"]),
              "INVALID_MATERIAL_READING_REQUEST",
            );
            const document = await indexedReaderDocument(body.documentId);
            if (document.layer !== "raw") {
              const error = new Error("只有素材层文档可以加入待看。");
              error.code = "INVALID_MATERIAL_DOCUMENT";
              throw error;
            }
            if (
              body.contentHash != null &&
              document.contentHash != null &&
              body.contentHash !== document.contentHash
            ) {
              const error = new Error("素材内容已经变化，请载入最新版本后再加入待看。");
              error.code = "CONTENT_HASH_MISMATCH";
              throw error;
            }
            const item = await materialReadingState.add({
              id: document.id,
              relativePath: document.relativePath,
              contentHash: document.contentHash,
              contentFingerprint: `${document.sizeBytes ?? "unknown"}:${document.modifiedAt ?? "unknown"}`,
            });
            vaultSync.notifyPaths([MATERIAL_READING_STATE_PATH]);
            return json(res, 200, item);
          }

          const materialQueueMatch = url.pathname.match(
            /^\/api\/material-reading-queue\/([^/]+)$/,
          );
          if (req.method === "DELETE" && materialQueueMatch) {
            const documentId = decodeURIComponent(materialQueueMatch[1]);
            const removed = await materialReadingState.remove({ documentId });
            if (removed) vaultSync.notifyPaths([MATERIAL_READING_STATE_PATH]);
            return json(res, 200, { removed });
          }

          if (req.method === "GET" && url.pathname.startsWith("/api/collections/")) {
            const kind = decodeURIComponent(url.pathname.slice("/api/collections/".length));
            return json(res, 200, collectionPayload(await currentIndex(), kind));
          }

          if (req.method === "GET" && url.pathname === "/api/search") {
            const query = url.searchParams.get("q") ?? "";
            const items = searchIndex(await currentIndex(), query, requestFilters(url));
            return json(res, 200, { query, total: items.length, items });
          }

          if (req.method === "GET" && url.pathname.startsWith("/api/vault-images/")) {
            const id = decodeURIComponent(url.pathname.slice("/api/vault-images/".length));
            const current = await currentIndex();
            return serveVaultImage(res, current, vaultRoot, id);
          }

          if (req.method === "GET" && url.pathname.startsWith("/api/reader-images/")) {
            const id = decodeURIComponent(url.pathname.slice("/api/reader-images/".length));
            const current = await currentIndex();
            try {
              return await serveReaderImage(
                res,
                current,
                vaultRoot,
                id,
                url.searchParams.get("src"),
              );
            } catch (error) {
              if (error?.code === "PATH_NOT_ALLOWLISTED") {
                return json(res, 403, { error: { message: error.message } });
              }
              throw error;
            }
          }

          if (req.method === "GET" && url.pathname.startsWith("/api/documents/")) {
            const id = decodeURIComponent(url.pathname.slice("/api/documents/".length));
            const document = documentPayload(await currentIndex(), id);
            if (!document) return json(res, 404, { error: { message: "文档不存在。" } });
            return json(res, 200, document);
          }

          if (req.method === "GET" && url.pathname === "/api/reader-notes") {
            const documentId = url.searchParams.get("documentId") ?? "";
            const document = await indexedReaderDocument(documentId);
            const saved = await readerNotes.get(document.id);
            const notes = saved?.notes ?? [];
            return json(res, 200, {
              documentId: document.id,
              relativePath: document.relativePath,
              title: document.title,
              contentHash: document.contentHash,
              notes,
              items: notes,
              updatedAt: saved?.updatedAt ?? null,
            });
          }

          if (req.method === "POST" && url.pathname === "/api/reader-notes") {
            const body = await readJson(req, 128 * 1024);
            const document = await indexedReaderDocument(body.documentId);
            const note = body.note && typeof body.note === "object"
              ? Object.fromEntries(
                  Object.entries(body.note).filter(
                    ([key]) => !["origin", "sourceAnalysisId"].includes(key),
                  ),
                )
              : body.note;
            const { saved, savedNote } = await saveOneReaderNote(document, note);
            return json(res, 200, {
              documentId: saved.documentId,
              contentHash: saved.contentHash,
              note: savedNote,
              notes: saved.notes,
              updatedAt: saved.updatedAt,
            });
          }

          const readerNoteMatch = url.pathname.match(/^\/api\/reader-notes\/([^/]+)$/);
          if (req.method === "DELETE" && readerNoteMatch) {
            const noteId = decodeURIComponent(readerNoteMatch[1]);
            const documentId = url.searchParams.get("documentId") ?? "";
            const document = await indexedReaderDocument(documentId);
            if (!(await deleteOneReaderNote(document, noteId))) {
              return json(res, 404, { error: { code: "NOTE_NOT_FOUND", message: "笔记不存在。" } });
            }
            return json(res, 200, { ok: true, documentId: document.id, noteId });
          }

          if (req.method === "GET" && url.pathname === "/api/reader-explanations") {
            const documentId = url.searchParams.get("documentId") ?? "";
            const document = await indexedReaderDocument(documentId);
            const items = await readerExplanations.list(document.id);
            return json(res, 200, {
              documentId: document.id,
              contentHash: document.contentHash,
              items,
              explanations: items,
            });
          }

          if (req.method === "POST" && url.pathname === "/api/reader-explanations") {
            const body = await readJson(req, 128 * 1024);
            assertAllowedObjectKeys(
              body,
              new Set(["documentId", "contentHash", "quoteText", "anchor", "mode", "question"]),
            );
            const document = await freshIndexedReaderDocument(body.documentId);
            if (body.contentHash !== document.contentHash) {
              const error = new Error("正文已变化，请重新选择需要理解的内容。");
              error.code = "CONTENT_HASH_MISMATCH";
              throw error;
            }
            const explanation = await readerExplanations.start({
              document,
              body: document.body,
              contentHash: body.contentHash,
              quoteText: body.quoteText,
              anchor: body.anchor,
              mode: body.mode,
              question: body.question,
            });
            return json(res, 202, { explanation });
          }

          const readerExplanationMatch = url.pathname.match(
            /^\/api\/reader-explanations\/([^/]+)(?:\/(follow-up|save-note))?$/,
          );
          if (readerExplanationMatch) {
            const analysisId = decodeURIComponent(readerExplanationMatch[1]);
            const action = readerExplanationMatch[2] || "read";

            if (req.method === "GET" && action === "read") {
              const documentId = url.searchParams.get("documentId") ?? "";
              const document = await indexedReaderDocument(documentId);
              const explanation = await readerExplanations.get(analysisId);
              if (readerExplanationDocumentId(explanation) !== document.id) {
                const error = new Error("解释记录不属于当前文档。");
                error.code = "EXPLANATION_NOT_FOUND";
                throw error;
              }
              return json(res, 200, {
                explanation,
              });
            }

            if (req.method === "POST" && action === "follow-up") {
              const body = await readJson(req, 32 * 1024);
              assertAllowedObjectKeys(
                body,
                new Set(["documentId", "contentHash", "mode", "question"]),
              );
              const document = await freshIndexedReaderDocument(body.documentId);
              if (body.contentHash !== document.contentHash) {
                const error = new Error("正文已变化，请重新选择内容后再提问。");
                error.code = "CONTENT_HASH_MISMATCH";
                throw error;
              }
              const explanation = await readerExplanations.followUp(analysisId, {
                document,
                body: document.body,
                contentHash: body.contentHash,
                mode: body.mode,
                question: body.question,
              });
              return json(res, 202, { explanation });
            }

            if (req.method === "POST" && action === "save-note") {
              const body = await readJson(req, 32 * 1024);
              assertAllowedObjectKeys(
                body,
                new Set(["documentId", "contentHash"]),
              );
              const document = await freshIndexedReaderDocument(body.documentId);
              const explanation = await readerExplanations.get(analysisId);
              if (readerExplanationDocumentId(explanation) !== document.id) {
                const error = new Error("解释记录不属于当前文档。");
                error.code = "INVALID_READER_EXPLANATION_DOCUMENT";
                throw error;
              }
              const explanationRecords = await readerExplanations.list(document.id);
              const thread = readerExplanationThread(explanationRecords, analysisId);
              const completedThread = thread.filter((record) =>
                record.status === "completed" && record.result,
              );
              const root = thread[0] || explanation;
              if (
                body.contentHash !== document.contentHash ||
                completedThread.some((record) => record.contentHash !== document.contentHash)
              ) {
                const error = new Error("正文已变化，请重新选择原文并生成解释后再保存。");
                error.code = "READER_EXPLANATION_SOURCE_CHANGED";
                throw error;
              }
              if (!completedThread.length || root.status !== "completed" || !root.result) {
                const error = new Error("本轮对话尚未形成完整回答，暂时不能保存到笔记。");
                error.code = "READER_EXPLANATION_NOT_COMPLETED";
                throw error;
              }

              const noteId = root.savedNoteId || `explanation-thread-${String(root.id)
                .replace(/[^A-Za-z0-9_-]/g, "-")
                .slice(0, 104)}`;
              const { savedNote } = await saveOneReaderNote(
                document,
                {
                  id: noteId,
                  type: "quote",
                  body: renderReaderExplanationNote(completedThread),
                  quoteText: root.quoteText,
                  anchor: root.anchor,
                  origin: "codex-explanation",
                  sourceAnalysisId: root.id,
                },
                { allowCodexExplanation: true },
              );
              const savedNoteId = savedNote?.id || noteId;
              const markedThread = typeof readerExplanations.markThreadSaved === "function"
                ? await readerExplanations.markThreadSaved(
                    completedThread.map((record) => record.id),
                    savedNoteId,
                  )
                : await Promise.all(completedThread.map((record) =>
                    readerExplanations.markSaved(record.id, savedNoteId),
                  ));
              const marked = markedThread.at(-1) || root;
              return json(res, 200, {
                analysisId: root.id,
                requestedAnalysisId: analysisId,
                savedNoteId,
                note: savedNote,
                explanation: marked,
                explanations: markedThread,
              });
            }
          }

          if (req.method === "POST" && url.pathname === "/api/wiki-ingest") {
            const body = await readJson(req);
            const document = await indexedReaderDocument(body.documentId);
            if (document.layer !== "raw") {
              const error = new Error("只有素材层（10_raw）的文档可以进入正式 Wiki Ingest。");
              error.code = "INVALID_INGEST_SOURCE";
              throw error;
            }
            if (typeof document.body !== "string" || !document.body.trim()) {
              const error = new Error("当前来源没有可可靠读取的文本正文，不能开始入库评估。");
              error.code = "INVALID_INGEST_SOURCE";
              throw error;
            }

            const snapshotId = `ingest-${randomUUID()}`;
            const snapshot = await snapshotReaderNotes(document, snapshotId);
            const job = await wikiIngest.startPlan({
              rawPath: document.relativePath,
              notesPath: snapshot.relativePath,
            });
            return json(res, 202, {
              ...job,
              notesSnapshotPath: snapshot.relativePath,
              noteCount: snapshot.noteCount,
            });
          }

          if (req.method === "GET" && url.pathname === "/api/wiki-ingest/jobs") {
            return json(res, 200, { items: wikiIngest.listJobs() });
          }

          if (req.method === "GET" && url.pathname === "/api/wiki-ingest/recovery") {
            const document = await indexedReaderDocument(
              url.searchParams.get("documentId"),
            );
            if (document.layer !== "raw") {
              const error = new Error("只有素材层（10_raw）的文档可以恢复 Wiki Ingest 任务。");
              error.code = "INVALID_INGEST_SOURCE";
              throw error;
            }
            const handoff = await wikiIngest.findClientHandoff(document.relativePath);
            return json(res, 200, { handoff });
          }

          const wikiIngestMatch = url.pathname.match(
            /^\/api\/wiki-ingest\/jobs\/([^/]+)(?:\/(events|message|handoff|confirm|cancel))?$/,
          );
          if (wikiIngestMatch) {
            const jobId = decodeURIComponent(wikiIngestMatch[1]);
            const action = wikiIngestMatch[2] || "read";
            if (req.method === "GET" && action === "read") {
              return json(res, 200, wikiIngest.getJob(jobId));
            }
            if (req.method === "POST" && action === "message") {
              const body = await readJson(req, 32 * 1024);
              const job = body.kind === "query"
                ? wikiIngest.queryJob(jobId, { message: body.message })
                : wikiIngest.reviseJob(jobId, { message: body.message });
              return json(res, 202, job);
            }
            if (req.method === "POST" && action === "confirm") {
              const body = await readJson(req, 256 * 1024);
              const job = await wikiIngest.confirmJob(jobId, body);
              refreshWhenIngestFinishes(jobId);
              return json(res, 202, job);
            }
            if (req.method === "POST" && action === "handoff") {
              const body = await readJson(req, 32 * 1024);
              const job = await wikiIngest.createClientHandoffJob(jobId, body);
              return json(res, 201, job);
            }
            if (req.method === "POST" && action === "cancel") {
              return json(res, 200, wikiIngest.cancelJob(jobId));
            }
            if (req.method === "GET" && action === "events") {
              // Validate the in-memory job before committing SSE headers. After
              // a local server restart the browser may briefly retain an old
              // job id; a normal JSON 404 lets the client recover, while
              // throwing after writeHead would crash the dev server with
              // ERR_HTTP_HEADERS_SENT.
              wikiIngest.getJob(jobId);
              res.writeHead(200, {
                "Cache-Control": "no-cache, no-transform",
                Connection: "keep-alive",
                "Content-Type": "text/event-stream; charset=utf-8",
                "X-Accel-Buffering": "no",
              });
              res.write(": connected\n\n");
              let unsubscribe = () => {};
              unsubscribe = wikiIngest.subscribeJob(jobId, (job) => {
                res.write(`data: ${JSON.stringify(job)}\n\n`);
                if (
                  [
                    WIKI_INGEST_STATUS.AWAITING_REVIEW,
                    WIKI_INGEST_STATUS.HANDOFF_READY,
                    WIKI_INGEST_STATUS.COMPLETED,
                    WIKI_INGEST_STATUS.FAILED,
                    WIKI_INGEST_STATUS.CANCELLED,
                  ].includes(job.status)
                ) {
                  queueMicrotask(() => {
                    unsubscribe();
                    res.end();
                  });
                }
              });
              req.on("close", unsubscribe);
              return;
            }
          }

          if (req.method === "GET" && url.pathname === "/api/graph") {
            return json(res, 200, graphPayload(await currentIndex()));
          }

          if (req.method === "GET" && url.pathname === "/api/douyin/works") {
            const current = await currentIndex();
            return json(res, 200, {
              generatedAt: current.generatedAt,
              total: current.douyin.works.length,
              items: current.douyin.works,
              comparableCount: current.douyin.comparableCount,
              summary: current.douyin.summary,
              summaryLowerBounds: current.douyin.summaryLowerBounds,
              contentLines: current.douyin.contentLines,
              formats: current.douyin.formats,
              roles: current.douyin.roles,
              monthly: current.douyin.monthly,
              reviewStatusCounts: current.douyin.reviewStatusCounts,
              available: current.douyin.available === true,
              sourcePath: current.douyin.sourcePath,
              sourceUpdatedAt: current.douyin.updatedAt,
              range: current.douyin.range,
              qualityIssues: current.douyin.qualityIssues,
              qualityFlags: current.douyin.qualityFlags,
              analytics: current.douyin.analytics,
              demoMode: current.douyin.demoMode === true,
            });
          }

          if (req.method === "GET" && url.pathname === "/api/social-insights") {
            return json(res, 200, listSocialInsights(await currentIndex()));
          }

          if (req.method === "GET" && url.pathname === "/api/social-trends") {
            return json(res, 200, listSocialTrends(await currentIndex()));
          }

          const socialInsightMatch = url.pathname.match(
            /^\/api\/social-insights\/([^/]+)$/,
          );
          if (req.method === "GET" && socialInsightMatch) {
            let reportId;
            try {
              reportId = decodeURIComponent(socialInsightMatch[1]);
            } catch {
              return json(res, 400, {
                error: {
                  code: "INVALID_SOCIAL_INSIGHT_ID",
                  message: "社媒洞察报告 ID 无法解析。",
                },
              });
            }
            const report = getSocialInsight(await currentIndex(), reportId);
            if (!report) {
              return json(res, 404, {
                error: {
                  code: "SOCIAL_INSIGHT_NOT_FOUND",
                  message: "社媒洞察报告不存在或已被移动。",
                },
              });
            }
            return json(res, 200, report);
          }

          const socialTrendMatch = url.pathname.match(
            /^\/api\/social-trends\/([^/]+)$/,
          );
          if (req.method === "GET" && socialTrendMatch) {
            let reportId;
            try {
              reportId = decodeURIComponent(socialTrendMatch[1]);
            } catch {
              return json(res, 400, {
                error: {
                  code: "INVALID_SOCIAL_TREND_ID",
                  message: "社媒风向报告 ID 无法解析。",
                },
              });
            }
            const report = getSocialTrend(await currentIndex(), reportId);
            if (!report) {
              return json(res, 404, {
                error: {
                  code: "SOCIAL_TREND_NOT_FOUND",
                  message: "社媒风向报告不存在或已被移动。",
                },
              });
            }
            return json(res, 200, report);
          }

          if (req.method === "POST" && url.pathname === "/api/refresh") {
            const refreshed = await refreshIndex({ reason: "manual" });
            return json(res, 200, {
              generatedAt: refreshed.generatedAt,
              stats: refreshed.stats,
              errors: refreshed.errors.length,
              sync: vaultSync.getStatus(),
            });
          }

          if (req.method === "GET" && url.pathname === "/api/runtime") {
            const [current, codex] = await Promise.all([currentIndex(), detectCodexCli()]);
            return json(res, 200, {
              vault: {
                connected: true,
                label: path.basename(vaultRoot),
                generatedAt: current.generatedAt,
                documents: current.stats.documents,
                errors: current.errors.length,
              },
              sync: vaultSync.getStatus(),
              codex: {
                available: codex.available,
                source: codex.source,
              },
            });
          }

          if (req.method === "POST" && url.pathname === "/api/open") {
            const body = await readJson(req);
            const current = await currentIndex();
            const document = getDocument(current, body.id);
            if (!document) return json(res, 404, { error: { message: "文档不存在。" } });
            if (!["obsidian", "finder"].includes(body.target)) {
              return json(res, 400, { error: { message: "不支持的打开方式。" } });
            }
            openLocalDocument(vaultRoot, document, body.target);
            return json(res, 200, { ok: true });
          }

          if (req.method === "POST" && url.pathname === "/api/workflows/xiaohongshu") {
            const body = await readJson(req);
            return json(res, 202, await createXhsDraftJob(body));
          }

          if (req.method === "GET" && url.pathname === "/api/workflows/jobs") {
            return json(res, 200, { items: listJobs() });
          }

          const jobMatch = url.pathname.match(
            /^\/api\/workflows\/jobs\/([^/]+)(?:\/(events|cancel|confirm))?$/,
          );
          if (jobMatch) {
            const jobId = decodeURIComponent(jobMatch[1]);
            const action = jobMatch[2] || "read";

            if (req.method === "GET" && action === "read") {
              return json(res, 200, getJob(jobId));
            }
            if (req.method === "POST" && action === "cancel") {
              return json(res, 200, cancelJob(jobId));
            }
            if (req.method === "POST" && action === "confirm") {
              const confirmed = await confirmJob(jobId);
              await refreshIndex();
              return json(res, 200, confirmed);
            }
            if (req.method === "GET" && action === "events") {
              res.writeHead(200, {
                "Cache-Control": "no-cache, no-transform",
                Connection: "keep-alive",
                "Content-Type": "text/event-stream; charset=utf-8",
                "X-Accel-Buffering": "no",
              });
              res.write(": connected\n\n");
              let unsubscribe = () => {};
              unsubscribe = subscribeJob(jobId, (job) => {
                res.write(`data: ${JSON.stringify(job)}\n\n`);
                if (
                  ["awaiting_review", "completed", "failed", "cancelled"].includes(job.status)
                ) {
                  queueMicrotask(() => {
                    unsubscribe();
                    res.end();
                  });
                }
              });
              req.on("close", unsubscribe);
              return;
            }
          }

          return json(res, 404, { error: { message: "API 路径不存在。" } });
        } catch (error) {
          server.config.logger.error(error);
          return json(res, errorStatus(error), errorPayload(error));
        }
      });
    },
  };
}
