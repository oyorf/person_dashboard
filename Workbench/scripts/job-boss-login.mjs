// BOSS 直聘半自动登录（持久化 profile + 反检测）。
// 打开浏览器停在登录页，自动轮询登录状态，登录成功即退出（无需按 Enter）。
// 用法：node scripts/job-boss-login.mjs
import path from "node:path";
import { BOSS_SESSION_STATE_PATH, openBossContext } from "./boss-browser.mjs";

async function isLoggedIn(page) {
  try {
    const url = page.url();
    if (url.includes("/web/user")) return false; // 仍在登录页
    return await page.evaluate(() => {
      // 岗位卡片渲染出来才算真正进站（_security_check 参数验证完成后仍会留在 URL 里）
      if (document.querySelectorAll(".job-card-wrapper").length > 0) return true;
      const text = document.body?.innerText?.slice(0, 3000) ?? "";
      // 登录后页面通常出现「我的」/头像/消息入口，且不再是登录表单
      if (/登录\/注册|发送验证码|扫码.*登录|安全验证/.test(text)) return false;
      return true;
    });
  } catch {
    return false;
  }
}

async function main() {
  const context = await openBossContext({ headful: true });
  const page = context.pages()[0] ?? (await context.newPage());
  console.log("正在打开登录页…");
  try {
    await page.goto("https://www.zhipin.com/web/user/?ka=header-login", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
  } catch (error) {
    console.error(`导航异常（${error.message}），尝试首页…`);
    await page.goto("https://www.zhipin.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
  }
  console.log(`当前页面：${page.url()}`);
  console.log("请扫码登录；脚本会自动检测登录状态（最长等待 5 分钟）…");
  console.log("注意：扫码后若页面出现安全验证，请先在浏览器里完成验证再离开。");

  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(3000);
    if (await isLoggedIn(page)) {
      // 再等 5 秒确认没有跳回验证页，避免提前关闭浏览器导致 session 未生效
      await page.waitForTimeout(5000);
      if (!(await isLoggedIn(page))) continue;
      // 显式保存登录态备份，避免 profile cookie 库在二进制切换时丢字段
      const state = await context.storageState();
      const fs = await import("node:fs");
      fs.mkdirSync(path.dirname(BOSS_SESSION_STATE_PATH), { recursive: true });
      fs.writeFileSync(BOSS_SESSION_STATE_PATH, JSON.stringify(state), "utf8");
      console.log(`检测到已登录（当前页：${page.url()}），登录态已保存在浏览器 profile 中。`);
      await context.close();
      return;
    }
  }
  console.error("等待超时仍未检测到登录，请重试。");
  await context.close();
  process.exit(2);
}

main().catch((error) => {
  console.error("登录脚本失败：", error.message);
  process.exit(1);
});
