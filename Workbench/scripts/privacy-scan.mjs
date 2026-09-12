import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workbenchRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = path.resolve(workbenchRoot, "..");
const excludedDirectories = new Set([".git", "dist", "node_modules", "qa"]);
const excludedFiles = new Set([
  "Workbench/package-lock.json",
  "Workbench/scripts/privacy-scan.mjs",
  // Gitignored local credential store written by the System page; same trust level as .env.
  "Workbench/config/learning-ai.local.json",
]);
const binaryExtensions = new Set([
  ".gif", ".ico", ".jpeg", ".jpg", ".pdf", ".png", ".webp",
]);

const checks = [
  {
    label: "absolute macOS home path",
    expression: /\/Users\/[^/\s"'`<>]+/g,
  },
  {
    label: "private Vault or product identifier",
    expression: /MediaContentVault|OBSIDIAN\/MediaContentVault|小戴AI|小戴一直在学习/g,
  },
  {
    label: "credential-like assignment",
    expression: /(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*["'][^"'\n]{8,}["']/gi,
  },
  {
    label: "private key material",
    expression: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  },
];

async function collectFiles(directory) {
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".DS_Store")) continue;
    const absolutePath = path.join(directory, entry.name);
    const relativePath = path.relative(repositoryRoot, absolutePath).split(path.sep).join("/");
    if (entry.isDirectory()) {
      if (!excludedDirectories.has(entry.name)) files.push(...await collectFiles(absolutePath));
      continue;
    }
    if (!entry.isFile() || excludedFiles.has(relativePath)) continue;
    if (binaryExtensions.has(path.extname(entry.name).toLowerCase())) continue;
    const details = await stat(absolutePath);
    if (details.size > 5 * 1024 * 1024) continue;
    files.push({ absolutePath, relativePath });
  }
  return files;
}

const findings = [];
for (const file of await collectFiles(repositoryRoot)) {
  const source = await readFile(file.absolutePath, "utf8");
  for (const check of checks) {
    check.expression.lastIndex = 0;
    for (const match of source.matchAll(check.expression)) {
      const line = source.slice(0, match.index).split("\n").length;
      findings.push({
        file: file.relativePath,
        line,
        label: check.label,
        sample: match[0].slice(0, 120),
      });
    }
  }
}

if (findings.length > 0) {
  process.stderr.write("Privacy scan failed:\n");
  for (const finding of findings) {
    process.stderr.write(
      `- ${finding.file}:${finding.line} [${finding.label}] ${finding.sample}\n`,
    );
  }
  process.exitCode = 1;
} else {
  process.stdout.write("Privacy scan passed: no blocked personal identifiers or credential assignments found.\n");
}
