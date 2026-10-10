/**
 * @file P1.6 可观测性 E2E 测试（node scripts/e2e-observability-test.mjs）
 * @description 运行前提：server 已启动（:3000，进程内 Worker 即可）、SMS_DEV_MODE=true、
 *              test-media 目录可写（生成无音轨测试视频）、ffmpeg-static 可用。
 *   ① 告警模块单测：本地 webhook 收包服务器 + tsx 子进程调 sendAlert——
 *     验证钉钉加签请求可达、同 key 冷却限频、不同 key 正常发送
 *   ② 权限：普通账号调用 /api/admin/retry → 404
 *   ③ 制造真实失败：上传无音轨视频 → 抽音频失败 → 重试用尽 → FAILED 落库
 *   ④ admin 重试：FAILED 项目重试 → 状态复位 TRANSCRIBING 并重新入队；
 *     立即二次重试 → 409（非 FAILED 状态拦截）
 *   ⑤ 重试闭环：重新入队的任务再次走到最终失败（验证旧 failed job 被
 *     remove + 新 job 真实入队，而非同 jobId 静默忽略）
 *   ⑥ retry 不存在的 ID → 404
 *   注意：脚本会真实调用 DashScope（失败任务不含转写调用，费用可忽略）。
 */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import ffmpegPath from "ffmpeg-static";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "http://localhost:3000";
/** 普通测试账号（与其他 E2E 号段区分） */
const PHONE = "13800006000";
/** 管理员账号（须在 .env ADMIN_PHONES 白名单内） */
const ADMIN_PHONE = "13800008001";
/** 无音轨测试视频（魔数合法但转写抽音频必失败） */
const NO_AUDIO_VIDEO = path.join(ROOT, "test-media", "no-audio.mp4");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 断言工具：失败即退出 */
function check(name, cond, detail = "") {
  console.log(`${cond ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) process.exit(1);
}

/**
 * 登录指定手机号（dev 万能码流程，含 60s 冷却重试）
 * @param phone 手机号
 * @returns 会话 cookie
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
 * 用 ffmpeg 生成无音轨视频（黑屏 1 秒，-an 去掉音轨）
 */
function generateNoAudioVideo() {
  if (!ffmpegPath) throw new Error("ffmpeg-static 不可用");
  const r = spawnSync(ffmpegPath, [
    "-y", "-f", "lavfi", "-i", "color=c=black:s=320x240:d=1",
    "-c:v", "libx264", "-preset", "ultrafast", "-an", NO_AUDIO_VIDEO,
  ], { timeout: 30_000 });
  if (r.status !== 0 || !fs.existsSync(NO_AUDIO_VIDEO)) {
    throw new Error(`无音轨视频生成失败：${r.stderr?.toString().slice(-300)}`);
  }
}

/* ---------- ① 告警模块单测（webhook 收包 + 冷却） ---------- */
console.log("[阶段①] 告警模块：钉钉加签收包 + 冷却限频…");
const received = [];
/** 临时 webhook 收包服务器 */
const hookServer = http.createServer((req, res) => {
  let data = "";
  req.on("data", (c) => (data += c));
  req.on("end", () => {
    received.push(data);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ errcode: 0 }));
  });
});
await new Promise((resolve) => hookServer.listen(0, "127.0.0.1", resolve));
const hookPort = hookServer.address().port;

// 临时探针脚本：连发 3 条告警（同 key × 2 + 异 key × 1），打印发送结果
//（包 async main：项目无 "type":"module" 时 tsx 按 CJS 编译，顶层 await 会报 TransformError）
const probePath = path.join(ROOT, "scripts", ".tmp-alert-probe.ts");
fs.writeFileSync(
  probePath,
  [
    `import { sendAlert } from "../src/lib/alert";`,
    `async function main() {`,
    `  const a = await sendAlert("e2e-key", "E2E 告警一", ["应收到"]);`,
    `  const b = await sendAlert("e2e-key", "E2E 告警二", ["应被冷却拦截"]);`,
    `  const c = await sendAlert("e2e-key-2", "E2E 告警三", ["不同 key 应收到"]);`,
    `  console.log("ALERT_RESULT", JSON.stringify({ a, b, c }));`,
    `}`,
    `main();`,
  ].join("\n"),
  "utf8",
);
/** 执行探针（webhook/密钥指向本脚本起的服务器；冷却设 60s 保证第二个被拦）。
 *  必须用异步 spawn：spawnSync 会阻塞主进程事件循环，webhook 服务器将无法
 *  响应请求，探针侧 fetch 全部超时 */
const probe = await new Promise((resolve) => {
  const p = spawn(
    process.execPath,
    [path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), probePath],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        ALERT_DINGTALK_WEBHOOK: `http://127.0.0.1:${hookPort}/hook?access_token=e2e-token`,
        ALERT_DINGTALK_SECRET: "SEC-e2e-test-secret",
        ALERT_COOLDOWN_SECONDS: "60",
      },
    },
  );
  let stdout = "";
  let stderr = "";
  p.stdout.on("data", (d) => (stdout += d));
  p.stderr.on("data", (d) => (stderr += d));
  const timer = setTimeout(() => p.kill(), 60_000);
  p.on("error", (e) => {
    clearTimeout(timer);
    resolve({ status: -1, stdout, stderr: `${stderr}${e}` });
  });
  p.on("close", (code) => {
    clearTimeout(timer);
    resolve({ status: code, stdout, stderr });
  });
});
const probeOut = probe.stdout?.toString() ?? "";
const resultMatch = probeOut.match(/ALERT_RESULT (\{.*\})/);
check("探针执行成功", probe.status === 0 && resultMatch, `exit=${probe.status} ${probe.stderr?.toString().slice(-200)}`);
if (resultMatch) {
  const { a, b, c } = JSON.parse(resultMatch[1]);
  check("首条告警发送成功", a === true);
  check("同 key 冷却期内被拦截", b === false);
  check("不同 key 正常发送", c === true);
}
check("webhook 服务器恰好收到 2 条", received.length === 2, `收到 ${received.length} 条`);
check(
  "收到内容含标题且为钉钉 text 格式",
  received.every((d) => {
    const p = JSON.parse(d);
    return p.msgtype === "text" && typeof p.text?.content === "string" && p.text.content.includes("【SubFlow 告警】");
  }),
);
fs.unlinkSync(probePath);
hookServer.close();

/* ---------- ② 权限：普通账号不可调 admin API ---------- */
console.log("[阶段②] admin API 权限…");
const cookie = await login(PHONE);
const forbidden = await fetch(`${BASE}/api/admin/retry`, {
  method: "POST",
  headers: { Cookie: cookie, "Content-Type": "application/json" },
  body: JSON.stringify({ type: "project", id: "whatever" }),
});
check("普通账号调用 retry 返回 404", forbidden.status === 404, `HTTP ${forbidden.status}`);

/* ---------- ③ 制造真实失败（无音轨视频 → FAILED 落库） ---------- */
console.log("[阶段③] 上传无音轨视频制造转写失败…");
generateNoAudioVideo();
const videoBuf = fs.readFileSync(NO_AUDIO_VIDEO);
const init = await (await fetch(`${BASE}/api/uploads/init`, {
  method: "POST",
  headers: { Cookie: cookie, "Content-Type": "application/json" },
  body: JSON.stringify({ fileName: "no-audio.mp4", contentType: "video/mp4", size: videoBuf.length }),
})).json();
for (let i = 0; i < init.chunkCount; i++) {
  const blob = videoBuf.subarray(i * init.chunkSize, Math.min((i + 1) * init.chunkSize, videoBuf.length));
  const url = init.mode === "oss" ? init.partUrls[i] : `${BASE}/api/uploads/${init.uploadId}/chunks/${i}`;
  const r = await fetch(url, { method: init.mode === "oss" ? "PUT" : "POST", body: blob });
  if (!r.ok) throw new Error(`分片 ${i} 上传失败 HTTP ${r.status}`);
}
const complete = await (await fetch(`${BASE}/api/uploads/${init.uploadId}/complete`, {
  method: "POST", headers: { Cookie: cookie },
})).json();
check("项目创建成功", !!complete.projectId, JSON.stringify(complete));
const projectId = complete.projectId;

// 轮询至 FAILED（重试 3 次 + 指数退避 ≈ 30-60 秒）
let status = "";
{
  const deadline = Date.now() + 3 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(3000);
    const r = await fetch(`${BASE}/api/projects/${projectId}`, { headers: { Cookie: cookie } });
    if (!r.ok) continue;
    status = (await r.json()).project?.status ?? "";
    if (status === "FAILED" || status === "READY") break;
  }
}
check("无音轨视频最终标记 FAILED", status === "FAILED", `最终状态 ${status}`);
const failInfo = await (await fetch(`${BASE}/api/projects/${projectId}`, { headers: { Cookie: cookie } })).json();
check("失败原因已落库", !!failInfo.project.error, failInfo.project.error ?? "");

/* ---------- ④ admin 重试 + 409 拦截 ---------- */
console.log("[阶段④] admin 重试失败项目…");
const adminCookie = await login(ADMIN_PHONE);
const retryRes = await fetch(`${BASE}/api/admin/retry`, {
  method: "POST",
  headers: { Cookie: adminCookie, "Content-Type": "application/json" },
  body: JSON.stringify({ type: "project", id: projectId }),
});
check("admin 重试成功（重新入队）", retryRes.ok, `HTTP ${retryRes.status} ${JSON.stringify(await retryRes.json())}`);
const conflict = await fetch(`${BASE}/api/admin/retry`, {
  method: "POST",
  headers: { Cookie: adminCookie, "Content-Type": "application/json" },
  body: JSON.stringify({ type: "project", id: projectId }),
});
check("非 FAILED 状态二次重试被 409 拦截", conflict.status === 409, `HTTP ${conflict.status}`);
const adminPage = await fetch(`${BASE}/admin`, { headers: { Cookie: adminCookie } });
check("admin 后台页面 200", adminPage.ok, `HTTP ${adminPage.status}`);

/* ---------- ⑤ 重试闭环：再次走到最终失败 ---------- */
console.log("[阶段⑤] 等待重试后的任务再次最终失败（验证重新入队真实生效）…");
let status2 = "";
{
  const deadline = Date.now() + 3 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(3000);
    const r = await fetch(`${BASE}/api/projects/${projectId}`, { headers: { Cookie: cookie } });
    if (!r.ok) continue;
    status2 = (await r.json()).project?.status ?? "";
    if (status2 === "FAILED" || status2 === "READY") break;
  }
}
check("重试后任务再次最终 FAILED（旧 job 已移除、新 job 已消费）", status2 === "FAILED", `最终状态 ${status2}`);

/* ---------- ⑥ retry 不存在的 ID ---------- */
const notFound = await fetch(`${BASE}/api/admin/retry`, {
  method: "POST",
  headers: { Cookie: adminCookie, "Content-Type": "application/json" },
  body: JSON.stringify({ type: "project", id: "nonexistent-id" }),
});
check("retry 不存在 ID 返回 404", notFound.status === 404, `HTTP ${notFound.status}`);

console.log("\n全部通过 🎉 P1.6 可观测性 E2E 完成");
