/**
 * @file P1.2 OSS 直传模式全链路 E2E 测试（node scripts/e2e-oss-test.mjs）
 * @description 验证 STORAGE_DRIVER=oss 下的完整业务闭环，运行前提：
 *              server 已启动（:3000，进程内 Worker 即可）、.env STORAGE_DRIVER=oss、
 *              Bucket CORS 已配置（scripts/setup-oss-cors.ts）、SMS_DEV_MODE=true、
 *              test-media/demo-video.mp4 存在。
 *   ① 登录
 *   ② 整传端点在 OSS 模式被禁用（409）
 *   ③ OSS 直传上传：init 返回签名 partUrls → 直传 OSS → complete 建项目
 *   ④ 转写闭环：轮询至 READY（worker 从 OSS 拉源视频）
 *   ⑤ 视频预览：/video 返回 302 → 签名 URL 可取回 video/mp4
 *   ⑥ 导出闭环：DONE → 下载 302 → 签名 URL 取回成片 → 余额扣减正确
 *   ⑦ 删除项目：项目与 OSS 对象清理（再次访问 404）
 *   注意：脚本会真实调用 DashScope 与 OSS（产生少量费用）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 项目根目录 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** server 地址 */
const BASE = "http://localhost:3000";
/** 测试手机号（与其他 E2E 号段区分） */
const PHONE = "13800007000";
/** 测试视频（约 35s，转写走真实 DashScope） */
const VIDEO = path.join(ROOT, "test-media", "demo-video.mp4");

/** 休眠工具 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 断言工具：失败即退出 */
function check(name, cond, detail = "") {
  console.log(`${cond ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) process.exit(1);
}

/**
 * 轮询项目状态直到到达目标状态或超时
 * @param cookie    会话 cookie
 * @param projectId 项目 ID
 * @param target    目标状态（如 "READY"）
 * @param timeoutMs 超时毫秒
 * @returns 最终状态字符串
 */
async function pollStatus(cookie, projectId, target, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let status = "";
  while (Date.now() < deadline) {
    await sleep(2000);
    const r = await fetch(`${BASE}/api/projects/${projectId}`, { headers: { Cookie: cookie } });
    if (!r.ok) continue;
    status = (await r.json()).project?.status ?? "";
    if (status === target || status === "FAILED") break;
  }
  return status;
}

/* ---------- ① 登录 ---------- */
/** 发码（撞 60s 冷却限流时等 65s 重试一次，P0 已知防刷行为） */
async function sendCode() {
  let res = await fetch(`${BASE}/api/auth/sms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone: PHONE }),
  });
  if (res.status === 429) {
    console.log("发码触发冷却限流，等待 65 秒后重试…");
    await sleep(65 * 1000);
    res = await fetch(`${BASE}/api/auth/sms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: PHONE }),
    });
  }
  return res;
}
const sms = await sendCode();
const smsBody = await sms.json();
check("发码成功", sms.ok && smsBody.devCode, `HTTP ${sms.status}`);
const login = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ phone: PHONE, code: smsBody.devCode }),
});
check("登录成功", login.ok, `HTTP ${login.status}`);
const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
const me0 = await (await fetch(`${BASE}/api/me`, { headers: { Cookie: cookie } })).json();
const balance0 = me0.user.balanceSeconds;
console.log(`    初始余额：${balance0}s`);

/* ---------- ② 整传端点在 OSS 模式被禁用 ---------- */
console.log("[阶段②] 验证整传端点禁用…");
const rawRes = await fetch(`${BASE}/api/projects`, {
  method: "POST",
  headers: { Cookie: cookie, "Content-Type": "video/mp4", "X-File-Name": "raw.mp4" },
  body: Buffer.alloc(1024),
});
check("OSS 模式整传返回 409 引导走分片直传", rawRes.status === 409, `HTTP ${rawRes.status}`);

/* ---------- ③ OSS 直传上传 ---------- */
console.log("[阶段③] OSS 直传上传…");
const videoBuf = fs.readFileSync(VIDEO);
const init = await fetch(`${BASE}/api/uploads/init`, {
  method: "POST",
  headers: { Cookie: cookie, "Content-Type": "application/json" },
  body: JSON.stringify({ fileName: "oss-e2e.mp4", contentType: "video/mp4", size: videoBuf.length }),
});
const initBody = await init.json();
check(
  "init 返回 oss 模式与签名分片 URL",
  init.ok && initBody.mode === "oss" && Array.isArray(initBody.partUrls) && initBody.partUrls.length > 0,
  `mode=${initBody.mode} parts=${initBody.partUrls?.length}`,
);

for (let i = 0; i < initBody.chunkCount; i++) {
  const blob = videoBuf.subarray(i * initBody.chunkSize, Math.min((i + 1) * initBody.chunkSize, videoBuf.length));
  // 浏览器同款行为：直接 PUT 签名 URL（不带 cookie）
  const r = await fetch(initBody.partUrls[i], { method: "PUT", body: blob });
  if (!r.ok) throw new Error(`分片 ${i} 直传 OSS 失败：HTTP ${r.status}`);
}
console.log(`    ${initBody.chunkCount} 个分片已直传 OSS`);

// 缺片负向用例：假 size=12MB 的会话有 3 片，只传第 1 片就 complete，应 409
//（409 在魔数校验之前抛出，故无需真实视频内容）
{
  const fakeSize = 12 * 1024 * 1024;
  const nInit = await (await fetch(`${BASE}/api/uploads/init`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ fileName: "partial.mp4", contentType: "video/mp4", size: fakeSize }),
  })).json();
  await fetch(nInit.partUrls[0], { method: "PUT", body: Buffer.alloc(nInit.chunkSize, 0x61) });
  const nComp = await fetch(`${BASE}/api/uploads/${nInit.uploadId}/complete`, { method: "POST", headers: { Cookie: cookie } });
  const nBody = await nComp.json();
  check("缺片 complete 被 409 拦截", nComp.status === 409, JSON.stringify(nBody));
}

const complete = await fetch(`${BASE}/api/uploads/${initBody.uploadId}/complete`, {
  method: "POST",
  headers: { Cookie: cookie },
});
const completeBody = await complete.json();
check("complete 建项目成功", complete.ok && !!completeBody.projectId, JSON.stringify(completeBody));
const projectId = completeBody.projectId;

/* ---------- ④ 转写闭环 ---------- */
console.log("[阶段④] 等待转写完成（worker 从 OSS 拉取源视频）…");
const status = await pollStatus(cookie, projectId, "READY", 3 * 60 * 1000);
check("项目转写至 READY", status === "READY", `最终状态 ${status}`);

/* ---------- ⑤ 视频预览 302 → 签名 URL ---------- */
console.log("[阶段⑤] 验证视频预览 302…");
const videoRes = await fetch(`${BASE}/api/projects/${projectId}/video`, {
  headers: { Cookie: cookie }, redirect: "manual",
});
check("预览接口返回 302", videoRes.status === 302, `HTTP ${videoRes.status}`);
const previewRes = await fetch(videoRes.headers.get("location"));
const previewBuf = Buffer.from(await previewRes.arrayBuffer());
check(
  "签名 URL 可取回视频且大小一致",
  previewRes.ok && previewRes.headers.get("content-type")?.includes("video/") && previewBuf.length === videoBuf.length,
  `HTTP ${previewRes.status} ${(previewBuf.length / 1024).toFixed(0)}KB type=${previewRes.headers.get("content-type")}`,
);

/* ---------- ⑥ 导出闭环 + 余额扣减 ---------- */
console.log("[阶段⑥] 创建导出任务…");
const projRes = await fetch(`${BASE}/api/projects/${projectId}`, { headers: { Cookie: cookie } });
const durationSec = (await projRes.json()).project.durationSec;
const { styles } = await (await fetch(`${BASE}/api/styles`, { headers: { Cookie: cookie } })).json();
const style = styles.find((s) => s.isDefault) ?? styles[0];

const exportRes = await fetch(`${BASE}/api/projects/${projectId}/exports`, {
  method: "POST",
  headers: { Cookie: cookie, "Content-Type": "application/json" },
  body: JSON.stringify({ styleId: style.id }),
});
const exportBody = await exportRes.json();
check("导出任务创建成功", exportRes.ok && !!exportBody.taskId, JSON.stringify(exportBody));

let taskStatus = "";
let taskError = "";
{
  const deadline = Date.now() + 4 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(2000);
    const r = await fetch(`${BASE}/api/exports/${exportBody.taskId}`, { headers: { Cookie: cookie } });
    if (!r.ok) continue;
    const t = (await r.json()).task;
    taskStatus = t.status;
    taskError = t.error ?? "";
    if (taskStatus === "DONE" || taskStatus === "FAILED") break;
  }
}
check("导出任务 DONE（成片已传 OSS）", taskStatus === "DONE", `状态 ${taskStatus} ${taskError}`);

const dlRes = await fetch(`${BASE}/api/exports/${exportBody.taskId}/download`, {
  headers: { Cookie: cookie }, redirect: "manual",
});
check("下载接口返回 302", dlRes.status === 302, `HTTP ${dlRes.status}`);
const dlFinal = await fetch(dlRes.headers.get("location"));
const dlBuf = Buffer.from(await dlFinal.arrayBuffer());
check("签名 URL 取回成片非空", dlFinal.ok && dlBuf.length > 100 * 1024, `${(dlBuf.length / 1024).toFixed(0)}KB`);

const costSeconds = Math.ceil(durationSec);
const me1 = await (await fetch(`${BASE}/api/me`, { headers: { Cookie: cookie } })).json();
check(
  "余额扣减恰好为 ceil(时长)",
  me1.user.balanceSeconds === balance0 - costSeconds,
  `${me1.user.balanceSeconds} = ${balance0} - ${costSeconds}`,
);

/* ---------- ⑦ 删除项目清理 OSS 对象 ---------- */
console.log("[阶段⑦] 删除项目…");
const delRes = await fetch(`${BASE}/api/projects/${projectId}`, { method: "DELETE", headers: { Cookie: cookie } });
check("删除成功", delRes.ok, `HTTP ${delRes.status}`);
const goneRes = await fetch(`${BASE}/api/projects/${projectId}/video`, {
  headers: { Cookie: cookie }, redirect: "manual",
});
check("删除后预览 404（项目行与签名入口均消失）", goneRes.status === 404, `HTTP ${goneRes.status}`);

console.log("\n全部通过 🎉 P1.2 OSS 直传模式全链路 E2E 完成");
