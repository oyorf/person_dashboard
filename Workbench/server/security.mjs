import { constants as fsConstants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_VAULT_ROOT = path.resolve(
  process.env.PERSONAL_DASHBOARD_VAULT_ROOT ||
    fileURLToPath(new URL("../../个人知识库/", import.meta.url)),
);

export const DEFAULT_ALLOWED_ROOTS = Object.freeze([
  "10_raw",
  "40_topics",
  "50_scripts",
  "60_learning",
  "90_runs",
  "wiki",
]);

const MAX_SELECTIONS = 24;
const MAX_RELATIVE_PATH_LENGTH = 768;
const MAX_DRAFT_BYTES = 8 * 1024 * 1024;

export class WorkbenchSecurityError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "WorkbenchSecurityError";
    this.code = code;
    this.details = details;
  }
}

export function isPathInside(parentPath, candidatePath) {
  const relative = path.relative(parentPath, candidatePath);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function throwSecurity(code, message, details) {
  throw new WorkbenchSecurityError(code, message, details);
}

function normalizeAllowedRoots(allowedRoots) {
  if (!Array.isArray(allowedRoots) || allowedRoots.length === 0) {
    throwSecurity("INVALID_ALLOWLIST", "Vault 白名单不能为空。");
  }

  return allowedRoots.map((root) => {
    if (
      typeof root !== "string" ||
      root.length === 0 ||
      root.includes("/") ||
      root.includes("\\") ||
      root === "." ||
      root === ".."
    ) {
      throwSecurity("INVALID_ALLOWLIST", `非法白名单目录：${String(root)}`);
    }
    return root;
  });
}

function parseRelativeSelection(input) {
  if (typeof input !== "string") {
    throwSecurity("INVALID_SELECTION", "选择路径必须是字符串。");
  }

  const trimmed = input.trim();
  if (!trimmed || trimmed.length > MAX_RELATIVE_PATH_LENGTH) {
    throwSecurity("INVALID_SELECTION", "选择路径为空或过长。");
  }

  if (
    trimmed.includes("\0") ||
    trimmed.includes("\\") ||
    path.isAbsolute(trimmed) ||
    path.win32.isAbsolute(trimmed)
  ) {
    throwSecurity(
      "INVALID_SELECTION",
      "只接受使用 / 分隔的 Vault 相对路径。",
      { input },
    );
  }

  const segments = trimmed.split("/");
  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    throwSecurity(
      "PATH_TRAVERSAL",
      "路径不能包含空段、. 或 ..。",
      { input },
    );
  }

  return {
    inputPath: trimmed,
    segments,
    topLevel: segments[0],
  };
}

async function resolveDirectory(directoryPath, code, label) {
  let resolved;
  try {
    resolved = await realpath(directoryPath);
  } catch (error) {
    throwSecurity(code, `${label}不存在或不可访问。`, {
      path: directoryPath,
      cause: error?.code,
    });
  }

  const details = await stat(resolved);
  if (!details.isDirectory()) {
    throwSecurity(code, `${label}不是目录。`, { path: directoryPath });
  }
  return resolved;
}

/**
 * Resolve user-selected Vault paths to canonical paths.
 *
 * The returned relativePath is derived from realpath(), so later consumers do
 * not need to follow the user-supplied symlink. A symlink may point elsewhere
 * inside the same allowlisted root, but it may not cross that root or the Vault.
 */
export async function validateVaultSelections(
  selections,
  {
    vaultRoot = DEFAULT_VAULT_ROOT,
    allowedRoots = DEFAULT_ALLOWED_ROOTS,
    maxSelections = MAX_SELECTIONS,
  } = {},
) {
  if (
    !Array.isArray(selections) ||
    selections.length === 0 ||
    selections.length > maxSelections
  ) {
    throwSecurity(
      "INVALID_SELECTION_COUNT",
      `请选择 1–${maxSelections} 个 Vault 文件或目录。`,
    );
  }

  const allowlist = normalizeAllowedRoots(allowedRoots);
  const allowedSet = new Set(allowlist);
  const realVaultRoot = await resolveDirectory(
    path.resolve(vaultRoot),
    "INVALID_VAULT",
    "Vault",
  );

  const resolvedAllowedRoots = new Map();
  const validated = [];
  const seenCanonicalPaths = new Set();

  for (const selection of selections) {
    const parsed = parseRelativeSelection(selection);
    if (!allowedSet.has(parsed.topLevel)) {
      throwSecurity(
        "PATH_NOT_ALLOWLISTED",
        `路径不在 Vault 白名单中：${parsed.inputPath}`,
        { allowedRoots: allowlist },
      );
    }

    let realAllowedRoot = resolvedAllowedRoots.get(parsed.topLevel);
    if (!realAllowedRoot) {
      realAllowedRoot = await resolveDirectory(
        path.join(realVaultRoot, parsed.topLevel),
        "ALLOWLIST_ROOT_MISSING",
        `白名单目录 ${parsed.topLevel}`,
      );
      if (!isPathInside(realVaultRoot, realAllowedRoot)) {
        throwSecurity(
          "SYMLINK_ESCAPE",
          `白名单目录通过符号链接越出了 Vault：${parsed.topLevel}`,
        );
      }
      resolvedAllowedRoots.set(parsed.topLevel, realAllowedRoot);
    }

    const lexicalTarget = path.resolve(realVaultRoot, ...parsed.segments);
    if (!isPathInside(realVaultRoot, lexicalTarget)) {
      throwSecurity("PATH_TRAVERSAL", "路径越出了 Vault。", {
        input: parsed.inputPath,
      });
    }

    let realTarget;
    try {
      realTarget = await realpath(lexicalTarget);
    } catch (error) {
      throwSecurity("SELECTION_NOT_FOUND", `路径不存在：${parsed.inputPath}`, {
        cause: error?.code,
      });
    }

    if (
      !isPathInside(realVaultRoot, realTarget) ||
      !isPathInside(realAllowedRoot, realTarget)
    ) {
      throwSecurity(
        "SYMLINK_ESCAPE",
        `路径通过符号链接越出了白名单目录：${parsed.inputPath}`,
      );
    }

    const details = await stat(realTarget);
    if (!details.isFile() && !details.isDirectory()) {
      throwSecurity(
        "UNSUPPORTED_SELECTION_TYPE",
        `只允许选择普通文件或目录：${parsed.inputPath}`,
      );
    }

    const canonicalRelativePath = path
      .relative(realVaultRoot, realTarget)
      .split(path.sep)
      .join("/");

    if (seenCanonicalPaths.has(canonicalRelativePath)) continue;
    seenCanonicalPaths.add(canonicalRelativePath);
    validated.push({
      inputPath: parsed.inputPath,
      relativePath: canonicalRelativePath,
      absolutePath: realTarget,
      allowedRoot: parsed.topLevel,
      kind: details.isDirectory() ? "directory" : "file",
      size: details.isFile() ? details.size : null,
    });
  }

  return {
    vaultRoot: realVaultRoot,
    selections: validated,
  };
}

export async function isExecutableFile(candidatePath) {
  try {
    const details = await stat(candidatePath);
    if (!details.isFile()) return false;
    await access(candidatePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function sanitizeFilenamePart(value, fallback = "draft") {
  const normalized = String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  const clipped = Array.from(normalized).slice(0, 48).join("");
  return clipped || fallback;
}

function normalizeSingleLine(value, fallback) {
  const normalized = String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(normalized || fallback).slice(0, 120).join("");
}

function formatShanghaiDate(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

async function ensureSafeDraftDirectory(realVaultRoot) {
  const runsPath = path.join(realVaultRoot, "90_runs");
  const runsInfo = await lstat(runsPath).catch((error) => {
    throwSecurity("OUTPUT_ROOT_MISSING", "90_runs 目录不存在。", {
      cause: error?.code,
    });
  });
  if (runsInfo.isSymbolicLink() || !runsInfo.isDirectory()) {
    throwSecurity(
      "UNSAFE_OUTPUT_ROOT",
      "90_runs 必须是 Vault 内的真实目录，不能是符号链接。",
    );
  }

  const realRunsPath = await realpath(runsPath);
  if (!isPathInside(realVaultRoot, realRunsPath)) {
    throwSecurity("SYMLINK_ESCAPE", "90_runs 越出了 Vault。");
  }

  const draftsPath = path.join(realRunsPath, "content_drafts");
  let draftsInfo;
  try {
    draftsInfo = await lstat(draftsPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await mkdir(draftsPath, { mode: 0o700 });
    draftsInfo = await lstat(draftsPath);
  }

  if (draftsInfo.isSymbolicLink() || !draftsInfo.isDirectory()) {
    throwSecurity(
      "UNSAFE_OUTPUT_DIRECTORY",
      "content_drafts 必须是 Vault 内的真实目录，不能是符号链接。",
    );
  }

  const realDraftsPath = await realpath(draftsPath);
  if (
    !isPathInside(realVaultRoot, realDraftsPath) ||
    !isPathInside(realRunsPath, realDraftsPath)
  ) {
    throwSecurity("SYMLINK_ESCAPE", "content_drafts 越出了安全输出目录。");
  }

  return realDraftsPath;
}

/**
 * This is the only Vault-writing primitive used by the runner. Call it only
 * from an explicit review confirmation.
 */
export async function writeConfirmedDraft({
  vaultRoot = DEFAULT_VAULT_ROOT,
  jobId,
  title,
  markdown,
  relativeSources = [],
  now = new Date(),
}) {
  const body = String(markdown ?? "").trim();
  if (!body) {
    throwSecurity("EMPTY_DRAFT", "没有可保存的草稿内容。");
  }
  if (Buffer.byteLength(body, "utf8") > MAX_DRAFT_BYTES) {
    throwSecurity("DRAFT_TOO_LARGE", "草稿超过 8MB 安全上限。");
  }

  const realVaultRoot = await resolveDirectory(
    path.resolve(vaultRoot),
    "INVALID_VAULT",
    "Vault",
  );
  const outputDirectory = await ensureSafeDraftDirectory(realVaultRoot);
  const safeTitle = normalizeSingleLine(title, "小红书图文草稿");
  const safeJobId = sanitizeFilenamePart(jobId, "job").slice(0, 12);
  const isoDate = formatShanghaiDate(now);
  const dateStamp = isoDate.replaceAll("-", "");
  const slug = sanitizeFilenamePart(safeTitle, "xiaohongshu-draft");
  const sourceLines = relativeSources
    .map((source) => normalizeSingleLine(source, "unknown"))
    .map((source) => `  - ${JSON.stringify(source)}`)
    .join("\n");
  const header = [
    "---",
    "type: content-draft",
    "status: draft",
    `created: ${isoDate}`,
    "workflow: xiaohongshu-graphic-text",
    `title: ${JSON.stringify(safeTitle)}`,
    "sources:",
    sourceLines || "  - unknown",
    "---",
    "",
  ].join("\n");
  const payload = `${header}${body}\n`;

  for (let index = 0; index < 100; index += 1) {
    const suffix = index === 0 ? "" : `-${index + 1}`;
    const filename = `${dateStamp}-xhs-${slug}-${safeJobId}${suffix}.md`;
    const targetPath = path.join(outputDirectory, filename);
    if (!isPathInside(outputDirectory, targetPath)) {
      throwSecurity("UNSAFE_OUTPUT_FILENAME", "生成的草稿文件名不安全。");
    }

    try {
      await writeFile(targetPath, payload, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      return {
        absolutePath: targetPath,
        relativePath: path
          .relative(realVaultRoot, targetPath)
          .split(path.sep)
          .join("/"),
        filename,
      };
    } catch (error) {
      if (error?.code === "EEXIST") continue;
      throw error;
    }
  }

  throwSecurity(
    "OUTPUT_NAME_EXHAUSTED",
    "无法生成不冲突的草稿文件名，请稍后重试。",
  );
}
