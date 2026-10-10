/**
 * @file P1 队列专项 E2E 测试（node scripts/e2e-queue-test.mjs）
 * @description 验证 Redis/BullMQ 任务队列三大核心能力，运行前提：
 *              server 已启动（:3000，且未开进程内 Worker）、无独立 Worker 在跑、
 *              Redis 容器运行中、SMS_DEV_MODE=true、test-media/demo-video.mp4 存在。
 *   ① 登录
 *   ② 队列持有：无 Worker 时上传视频 → 项目保持 UPLOADED（任务滞留 Redis 不丢失）
 *   ③ 启动 Worker 子进程 → 滞留任务被消费，轮询至 READY
 *   ④ 导出队列：创建导出任务 → DONE → 下载成片非空 → 余额扣减正确
 *   ⑤ 宕机恢复：转写进行中 SIGKILL Worker → 重启 → stalled 任务自动重试至 READY
 *   注意：全程由本脚本拉起/杀死 Worker 子进程，请勿同时运行其他 Worker。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 项目根目录 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** server 地址 */
const BASE = "http://localhost:3000";
/** 测试手机号（与其他 E2E 号段区分） */
const PHONE = "13800006000";
/** 测试视频（约 35s，转写走真实 DashScope） */
const VIDEO = path.join(ROOT, "test-media", "demo-video.mp4");
/** tsx CLI（单进程直启，避免 npm 包装进程导致 kill 不干净） */
const TSX_CLI = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");

/** 休眠工具 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 断言工具：失败即退出（并清理子进程） */
function check(name, cond, detail = "") {
  console.log(`${cond ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) {
    cleanupWorkers();
    process.exit(1);
  }
}

/** 本脚本拉起的 Worker 子进程（退出时统一清理） */
const workers = [];

/**
 * 启动一个 Worker 子进程（tsx 直跑，独立 node 进程）
 * @returns 子进程对象
 */
function startWorker() {
  const child = spawn(process.execPath, [TSX_CLI, "src/worker/index.ts"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => {
    out += d.toString();
    if (out.length > 4000) out = out.slice(-4000);
  });
  child.stderr.on("data", (d) => {
    out += d.toString();
    if (out.length > 4000) out = out.slice(-4000);
  });
  workers.push(child);
  return child;
}

/** 强杀所有本脚本拉起的 Worker（SIGKILL 语义，模拟宕机） */
function killWorker(child) {
  if (child && child.exitCode === null && !child.killed) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* 进程可能已退出 */
    }
  }
}

/** 清理全部子进程 */
function cleanupWorkers() {
  for (const w of workers) killWorker(w);
}
process.on("exit", cleanupWorkers);

/**
 * 轮询项目状态直到到达目标状态或超时
 * @param cookie   会话 cookie
 * @param projectId 项目 ID
 * @param target   目标状态（如 "READY"）
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

/**
 * 用分片上传接口上传整个视频并创建项目
 * @param cookie 会话 cookie
 * @param name   展示文件名
 * @returns projectId
 */
async function uploadViaChunks(cookie, name) {
  const videoBuf = fs.readFileSync(VIDEO);
  const init = await fetch(`${BASE}/api/uploads/init`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ fileName: name, contentType: "video/mp4", size: videoBuf.length }),
  });
  const { uploadId, chunkSize, chunkCount } = await init.json();
  if (!init.ok) throw new Error(`init 失败：HTTP ${init.status}`);
  for (let i = 0; i < chunkCount; i++) {
    const blob = videoBuf.subarray(i * chunkSize, Math.min((i + 1) * chunkSize, videoBuf.length));
    const r = await fetch(`${BASE}/api/uploads/${uploadId}/chunks/${i}`, {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/octet-stream" },
      body: blob,
    });
    if (!r.ok) throw new Error(`分片 ${i} 上传失败：HTTP ${r.status}`);
  }
  const complete = await fetch(`${BASE}/api/uploads/${uploadId}/complete`, {
    method: "POST",
    headers: { Cookie: cookie },
  });
  const body = await complete.json();
  if (!complete.ok) throw new Error(`complete 失败：${JSON.stringify(body)}`);
  return body.projectId;
}

/* ---------- ① 登录 ---------- */
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

/* ---------- ② 队列持有：无 Worker 时任务滞留不丢失 ---------- */
console.log("[阶段②] 上传视频 A（无 Worker 在跑）…");
const projectA = await uploadViaChunks(cookie, "queue-test-a.mp4");
console.log(`    项目 A：${projectA}`);

let held = true;
for (let i = 0; i < 6; i++) {
  await sleep(2000);
  const r = await fetch(`${BASE}/api/projects/${projectA}`, { headers: { Cookie: cookie } });
  const st = (await r.json()).project?.status;
  if (st !== "UPLOADED") {
    held = false;
    console.log(`    状态意外变为 ${st}（第 ${i + 1} 次轮询）`);
    break;
  }
}
check("无 Worker 时项目保持 UPLOADED（任务滞留 Redis 队列）", held);

/* ---------- ③ 启动 Worker → 滞留任务被消费 ---------- */
console.log("[阶段③] 启动 Worker，消费滞留任务…");
const worker1 = startWorker();
const statusA = await pollStatus(cookie, projectA, "READY", 3 * 60 * 1000);
check("滞留任务被 Worker 消费至 READY", statusA === "READY", `最终状态 ${statusA}`);

/* ---------- ④ 导出队列 + 余额扣减 ---------- */
console.log("[阶段④] 创建导出任务（队列路径）…");
const me0 = await (await fetch(`${BASE}/api/me`, { headers: { Cookie: cookie } })).json();
const balance0 = me0.user.balanceSeconds;

const projRes = await fetch(`${BASE}/api/projects/${projectA}`, { headers: { Cookie: cookie } });
const durationSec = (await projRes.json()).project.durationSec;
const stylesRes = await fetch(`${BASE}/api/styles`, { headers: { Cookie: cookie } });
const { styles } = await stylesRes.json();
const style = styles.find((s) => s.isDefault) ?? styles[0];

const exportRes = await fetch(`${BASE}/api/projects/${projectA}/exports`, {
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
check("导出任务经队列完成 DONE", taskStatus === "DONE", `状态 ${taskStatus} ${taskError}`);

const dlRes = await fetch(`${BASE}/api/exports/${exportBody.taskId}/download`, { headers: { Cookie: cookie } });
const dlBuf = Buffer.from(await dlRes.arrayBuffer());
check("成片下载 200 且非空", dlRes.ok && dlBuf.length > 100 * 1024, `${(dlBuf.length / 1024).toFixed(0)}KB`);

const costSeconds = Math.ceil(durationSec);
const me1 = await (await fetch(`${BASE}/api/me`, { headers: { Cookie: cookie } })).json();
check(
  "余额扣减恰好为 ceil(时长)",
  me1.user.balanceSeconds === balance0 - costSeconds,
  `${me1.user.balanceSeconds} = ${balance0} - ${costSeconds}`,
);

/* ---------- ⑤ 宕机恢复：转写中 SIGKILL Worker → 重启 → 自动重试 ---------- */
console.log("[阶段⑤] 宕机恢复：转写进行中强杀 Worker 再重启…");
const projectB = await uploadViaChunks(cookie, "queue-test-b.mp4");
console.log(`    项目 B：${projectB}`);

// 等待转写真正开始（worker1 仍在跑，会立刻消费）
let started = false;
{
  const deadline = Date.now() + 30 * 1000;
  while (Date.now() < deadline) {
    await sleep(1000);
    const r = await fetch(`${BASE}/api/projects/${projectB}`, { headers: { Cookie: cookie } });
    const st = (await r.json()).project?.status;
    if (st === "TRANSCRIBING" || st === "POLISHING") {
      started = true;
      break;
    }
  }
}
check("转写已开始（TRANSCRIBING）", started);

// 模拟宕机：SIGKILL 在跑任务的 Worker
killWorker(worker1);
console.log("    Worker 已被 SIGKILL（模拟宕机）");

// 重启 Worker：stalled 检测（约 30s）后任务自动重新入队并重试
const worker2 = startWorker();
const statusB = await pollStatus(cookie, projectB, "READY", 5 * 60 * 1000);
check("宕机后 stalled 任务自动重试至 READY", statusB === "READY", `最终状态 ${statusB}`);

/* ---------- 清理并收尾 ---------- */
killWorker(worker2);
console.log("\n全部通过 🎉 P1 队列专项 E2E 完成");
