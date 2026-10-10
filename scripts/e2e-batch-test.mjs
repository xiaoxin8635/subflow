/**
 * @file P1.5 批量处理 E2E 测试（node scripts/e2e-batch-test.mjs）
 * @description 运行前提：server 已启动（:3000，ENABLE_INPROCESS_WORKER=1）、
 *              SMS_DEV_MODE=true、test-media/demo-video.mp4 存在、Redis 可达。
 *   ① 暂停转写队列（queue.pause()）→ 上传 2 个视频 complete 入队 →
 *     任务滞留 waiting（worker 拉不到）
 *   ② 断言详情 API：status=UPLOADED 且 queuePosition 按入队顺序为 1、2
 *     （BullMQ 同优先级 FIFO；付费优先级由既有逻辑保证，此处同用户同优先级）
 *   ③ 恢复队列（resume）→ 轮询两项目至 READY → 断言 queuePosition 归 null
 *   ④ 批量上传入口渲染：/dashboard/new 页面含「可多选」文案
 *   说明：多文件选择/串行进度是浏览器交互，脚本覆盖其后端等价链路
 *   （逐文件 init→分片→complete→入队，上传接口本身已被 P0/OSS E2E 覆盖）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Queue } from "bullmq";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "http://localhost:3000";
/** 普通测试账号 */
const PHONE = "13800006000";
const DEMO_VIDEO = path.join(ROOT, "test-media", "demo-video.mp4");
const QUEUE_NAME = "transcript";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failedCount = 0;
/** 断言（失败计数不中断） */
function check(name, cond, detail = "") {
  console.log(`${cond ? "✅" : "❌"} ${name}${cond || !detail ? "" : ` — ${detail}`}`);
  if (!cond) failedCount++;
}

/**
 * 登录指定手机号（dev 万能码，含 60s 发码冷却重试）
 */
async function login(phone) {
  let res = await fetch(`${BASE}/api/auth/sms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone }),
  });
  if (res.status === 429) {
    console.log(`    ${phone} 发码冷却，等 65 秒重试…`);
    await sleep(65 * 1000);
    res = await fetch(`${BASE}/api/auth/sms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone }),
    });
  }
  const body = await res.json();
  if (!res.ok || !body.devCode) throw new Error(`发码失败 HTTP ${res.status}`);
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone, code: body.devCode }),
  });
  if (!loginRes.ok) throw new Error(`登录失败 HTTP ${loginRes.status}`);
  return (loginRes.headers.get("set-cookie") ?? "").split(";")[0];
}

/**
 * 分片上传视频文件并创建项目（oss/local 双模式兼容），返回项目 ID
 */
async function uploadVideo(cookie, filePath, name) {
  const buf = fs.readFileSync(filePath);
  const init = await (await fetch(`${BASE}/api/uploads/init`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ fileName: name, contentType: "video/mp4", size: buf.length }),
  })).json();
  if (!init.uploadId) throw new Error(`上传 init 失败：${JSON.stringify(init)}`);
  for (let i = 0; i < init.chunkCount; i++) {
    const blob = buf.subarray(i * init.chunkSize, Math.min((i + 1) * init.chunkSize, buf.length));
    const url = init.mode === "oss" ? init.partUrls[i] : `${BASE}/api/uploads/${init.uploadId}/chunks/${i}`;
    const r = await fetch(url, { method: init.mode === "oss" ? "PUT" : "POST", body: blob });
    if (!r.ok) throw new Error(`分片 ${i} 上传失败 HTTP ${r.status}`);
  }
  const complete = await (await fetch(`${BASE}/api/uploads/${init.uploadId}/complete`, {
    method: "POST", headers: { Cookie: cookie },
  })).json();
  if (!complete.projectId) throw new Error(`complete 失败：${JSON.stringify(complete)}`);
  return complete.projectId;
}

/** 拉取项目详情 */
async function getProject(cookie, projectId) {
  const r = await fetch(`${BASE}/api/projects/${projectId}`, { headers: { Cookie: cookie } });
  if (!r.ok) throw new Error(`详情 HTTP ${r.status}`);
  return (await r.json()).project;
}

/* ---------- ① 暂停队列 + 上传 2 个视频入队滞留 ---------- */
console.log("[阶段①] 暂停转写队列，上传 2 个视频…");
const connection = new (await import("ioredis")).default(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: null });
const queue = new Queue(QUEUE_NAME, { connection });
await queue.pause();
console.log("    队列已暂停");

const cookie = await login(PHONE);
const t0 = Date.now();
const [pid1, pid2] = await Promise.all([
  uploadVideo(cookie, DEMO_VIDEO, `batch-e2e-a-${t0}.mp4`),
  uploadVideo(cookie, DEMO_VIDEO, `batch-e2e-b-${t0}.mp4`),
]);

// 等状态落为 UPLOADED 后确认任务滞留 waiting（complete 入队是异步边路）
let d1 = null;
for (let i = 0; i < 10; i++) {
  await sleep(1000);
  d1 = await getProject(cookie, pid1);
  if (d1.queuePosition != null) break;
}

/* ---------- ② 断言排队位置（FIFO） ---------- */
console.log("[阶段②] 断言排队位置…");
const d2 = await getProject(cookie, pid2);
check("项目 1 状态 UPLOADED（任务滞留）", d1?.status === "UPLOADED", `状态 ${d1?.status}`);
check("项目 2 状态 UPLOADED（任务滞留）", d2.status === "UPLOADED", `状态 ${d2.status}`);
check("项目 1 排队位置为第 1 位", d1?.queuePosition === 1, `position=${d1?.queuePosition}`);
check("项目 2 排队位置为第 2 位（FIFO）", d2.queuePosition === 2, `position=${d2.queuePosition}`);

/* ---------- ③ 恢复队列 → 等待转写完成 → 位置清空 ---------- */
console.log("[阶段③] 恢复队列，等待转写完成…");
await queue.resume();

let s1 = "";
let s2 = "";
{
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(3000);
    const [a, b] = await Promise.all([getProject(cookie, pid1), getProject(cookie, pid2)]);
    s1 = a.status;
    s2 = b.status;
    if ((s1 === "READY" || s1 === "FAILED") && (s2 === "READY" || s2 === "FAILED")) break;
  }
}
check("两个项目转写完成", s1 === "READY" && s2 === "READY", `${s1} / ${s2}`);
const f1 = await getProject(cookie, pid1);
const f2 = await getProject(cookie, pid2);
check("完成后 queuePosition 归 null", f1.queuePosition === null && f2.queuePosition === null,
  `${f1.queuePosition} / ${f2.queuePosition}`);

/* ---------- ④ 批量上传入口渲染 ---------- */
console.log("[阶段④] 批量上传入口…");
const newPage = await fetch(`${BASE}/dashboard/new`, { headers: { Cookie: cookie } });
const html = await newPage.text();
check("new 页 200 且含多选文案", newPage.ok && html.includes("可多选"), `HTTP ${newPage.status}`);

/* ---------- 清理 ---------- */
await queue.close();
connection.disconnect();
console.log(`\n===== 结果：${failedCount === 0 ? "全部通过 🎉 P1.5 批量处理 E2E 完成" : `${failedCount} 项失败 ✗`} =====`);
process.exit(failedCount === 0 ? 0 : 1);
