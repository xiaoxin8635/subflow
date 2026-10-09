/**
 * @file SubFlow 模块② E2E 测试脚本（node scripts/e2e-pipeline-test.mjs）
 * @description 验证完整转写流水线：
 *   ① FFmpeg 合成测试视频（TTS 语音 + 纯色画面，视频已存在则跳过合成）
 *   ② 调 /api/auth/login 登录（开发模式万能验证码 123456）拿会话 Cookie
 *   ③ 流式上传测试视频到 POST /api/projects（raw body，与浏览器 XHR 行为一致）
 *   ④ 轮询 GET /api/projects/[id] 直至 READY / FAILED，校验分段结构并打印结果
 * 运行前提：dev server 已启动（localhost:3000）、PostgreSQL 容器运行中、SMS_DEV_MODE=true
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";

/** 项目根目录（scripts 的上一级） */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** dev server 地址 */
const BASE = "http://localhost:3000";
/** 测试手机号（开发模式任意 11 位号码即可） */
const TEST_PHONE = "13800008000";

/** ffmpeg / ffprobe 二进制路径 */
const ffmpeg = (await import("ffmpeg-static")).default;
const ffprobe = (await import("ffprobe-static")).path;

/** 休眠工具 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- ① 合成测试视频（已存在则复用） ---------- */
const videoPath = path.join(ROOT, "scripts", "test-video.mp4");
const wavPath = path.join(ROOT, "scripts", "test-tts.wav");
if (!fs.existsSync(wavPath)) {
  console.error("缺少 scripts/test-tts.wav（请先用 PowerShell SAPI 生成中文语音）");
  process.exit(1);
}
if (!fs.existsSync(videoPath)) {
  console.log("[1/4] FFmpeg 合成测试视频…");
  execFileSync(ffmpeg, [
    "-y", "-f", "lavfi", "-i", "color=c=steelblue:s=640x360:r=15",
    "-i", wavPath, "-shortest",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k",
    videoPath,
  ], { stdio: ["ignore", "ignore", "pipe"] });
}
const durationSec = Number(
  execFileSync(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", videoPath]).toString().trim(),
);
console.log(`[1/4] 测试视频就绪：${(fs.statSync(videoPath).size / 1024 / 1024).toFixed(2)}MB / ${durationSec.toFixed(1)}s`);

/* ---------- ② 登录拿会话 Cookie ---------- */
console.log("[2/4] 登录…");
// 固定码也需要先入库：开发模式先调发码接口（响应携带 devCode），再登录
const smsRes = await fetch(`${BASE}/api/auth/sms`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ phone: TEST_PHONE }),
});
const smsBody = await smsRes.json().catch(() => ({}));
if (!smsRes.ok || !smsBody.devCode) {
  console.error(`发码失败：HTTP ${smsRes.status}`, smsBody);
  process.exit(1);
}
const loginRes = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ phone: TEST_PHONE, code: smsBody.devCode }),
});
if (!loginRes.ok) {
  console.error(`登录失败：HTTP ${loginRes.status} ${await loginRes.text()}`);
  process.exit(1);
}
// 取 SET-COKIE 首段的 name=value
const cookie = (loginRes.headers.get("set-cookie") ?? "").split(";")[0];
if (!cookie) {
  console.error("登录响应未携带 Cookie");
  process.exit(1);
}
console.log(`[2/4] 登录成功（${cookie.split("=")[0]}）`);

/* ---------- ③ 流式上传 ---------- */
console.log("[3/4] 流式上传视频…");
const fileStream = Readable.toWeb(fs.createReadStream(videoPath));
const upRes = await fetch(`${BASE}/api/projects`, {
  method: "POST",
  headers: {
    "Content-Type": "video/mp4",
    "X-File-Name": encodeURIComponent("e2e-字幕测试.mp4"),
    "Content-Length": String(fs.statSync(videoPath).size),
    Cookie: cookie,
  },
  body: fileStream,
  duplex: "half",
});
const upBody = await upRes.json().catch(() => ({}));
if (!upRes.ok || !upBody.projectId) {
  console.error(`上传失败：HTTP ${upRes.status}`, upBody);
  process.exit(1);
}
const projectId = upBody.projectId;
console.log(`[3/4] 上传成功，项目 ID：${projectId}`);

/* ---------- ④ 轮询至终态并校验 ---------- */
console.log("[4/4] 轮询转写状态…");
const deadline = Date.now() + 8 * 60 * 1000; // 上限 8 分钟
let project = null;
while (Date.now() < deadline) {
  await sleep(3000);
  const res = await fetch(`${BASE}/api/projects/${projectId}`, { headers: { Cookie: cookie } });
  if (!res.ok) {
    console.warn(`  轮询瞬时错误 HTTP ${res.status}，继续`);
    continue;
  }
  project = (await res.json()).project;
  console.log(`  状态：${project.status}`);
  if (project.status === "READY" || project.status === "FAILED") break;
}

if (!project) {
  console.error("轮询超时且无结果");
  process.exit(1);
}
if (project.status === "FAILED") {
  console.error(`流水线失败：${project.error}`);
  process.exit(1);
}

// 校验分段结构
const segs = project.transcript?.segments;
if (!Array.isArray(segs) || segs.length === 0) {
  console.error("READY 但分段为空", project.transcript);
  process.exit(1);
}
const badSeg = segs.find(
  (s) => typeof s.start !== "number" || typeof s.end !== "number" || !s.text || s.end <= s.start,
);
if (badSeg) {
  console.error("存在非法分段：", badSeg);
  process.exit(1);
}
const overlaps = segs.slice(1).some((s, i) => s.start < segs[i].start);
if (overlaps) {
  console.error("分段时间轴乱序");
  process.exit(1);
}

console.log("\n===== E2E 通过 =====");
console.log(`分段数：${segs.length}（润色=${project.transcript.llmPolished}，引擎=${project.transcript.asrProvider}）`);
for (const s of segs.slice(0, 10)) {
  const t = (v) => `${String(Math.floor(v / 60)).padStart(2, "0")}:${String(Math.floor(v % 60)).padStart(2, "0")}`;
  console.log(`  [${t(s.start)} → ${t(s.end)}] ${s.text}`);
}
