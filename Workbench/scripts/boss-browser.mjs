// 共享：启动带反检测的持久化浏览器上下文（专用 profile，登录态长期保留）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "rebrowser-playwright";

const workbenchRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
export const BOSS_PROFILE_DIR = path.join(workbenchRoot, "data", "boss-profile");
// 登录态的显式备份：Chromium profile 的 cookie 库在不同二进制间切换时可能丢字段，
// 登录成功后另存一份 storageState，启动时兜底注入。
export const BOSS_SESSION_STATE_PATH = path.join(
  workbenchRoot,
  "data",
  "boss-session.local.json",
);

const ANTI_DETECT_INIT = () => {
  Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  Object.defineProperty(navigator, "languages", { get: () => ["zh-CN", "zh"] });
  window.chrome = window.chrome || { runtime: {} };
};

// 有头模式优先捆绑 Chromium：登录与抓取必须共用同一浏览器内核，
// 否则系统 Chrome 的 App-Bound 加密 cookie 无法被 headless shell 解密，
// 且 headless shell 关闭时会用空 cookie 库覆盖 profile（登录态丢失）。
async function launchPersistent(headful) {
  const attempts = headful
    ? [{ args: ["--disable-gpu"] }, { channel: "chrome" }, { channel: "msedge" }]
    : [{}];
  let lastError = null;
  for (const options of attempts) {
    try {
      return await chromium.launchPersistentContext(BOSS_PROFILE_DIR, {
        headless: !headful,
        viewport: headful ? null : { width: 1366, height: 850 },
        locale: "zh-CN",
        ...options,
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export async function openBossContext({ headful = false } = {}) {
  const context = await launchPersistent(headful);
  await context.addInitScript(ANTI_DETECT_INIT);
  try {
    const state = JSON.parse(fs.readFileSync(BOSS_SESSION_STATE_PATH, "utf8"));
    if (Array.isArray(state.cookies) && state.cookies.length > 0) {
      const existing = await context.cookies("https://www.zhipin.com");
      if (!existing.some((cookie) => cookie.name === "__zp_stoken__")) {
        await context.addCookies(state.cookies);
      }
    }
  } catch {
    // 没有备份或解析失败时忽略，依赖 profile 自带登录态
  }
  return context;
}
