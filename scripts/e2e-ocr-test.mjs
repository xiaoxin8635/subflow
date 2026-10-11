/**
 * @file OCR 硬字幕提取 E2E 测试脚本（node scripts/e2e-ocr-test.mjs）
 * @description 验证 processMode=ocr 全链路：
 *   ① FFmpeg 合成带硬字幕测试视频（4 句中文各 5s，已存在则复用）
 *   ② 登录（开发模式万能验证码）
 *   ③ 整传上传（X-Process-Mode: ocr 头）→ 轮询 READY
 *   ④ 断言：processMode=ocr / asrProvider 前缀 ocr- / 4 段字幕 /
 *      rawText 含全部造数原文（润色可能微调 segments 文本，故比对 rawText 留底）/
 *      时间轴单调且各段约 5s
 *   ⑤ 音频项目强制 asr：传 mp3 + ocr 头 → 列表接口 processMode 应回归 asr
 *   ⑥ 清理：删除测试项目（联动封面）
 * 运行前提：生产 server 已启动（STORAGE_DRIVER=local）、PostgreSQL/Redis 运行中、
 *   SMS_DEV_MODE=true、DASHSCOPE_API_KEY 可用（OCR 与润色烧真实费用）
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import ffmpegPath from "ffmpeg-static";

const execFileAsync = promisify(execFile);
/** 项目根目录（scripts 的上一级） */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** dev server 地址 */
const BASE = "http://localhost:3000";
/** 测试手机号（独立号码避免与其他 E2E 撞发码冷却） */
const TEST_PHONE = "13800009000";

/** 造数字幕句（各展示 5 秒） */
const LINES = [
  "大家好欢迎来到我的频道",
  "今天教大家三个剪辑技巧",
  "第一个是跳剪让节奏更快",
  "我们下期再见记得关注我",
];

/** 休眠工具 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 断言工具（失败即退出非零） */
let passed = 0;
function ok(cond, label) {
  if (!cond) {
    console.error(`FAIL ${label}`);
    process.exit(1);
  }
  passed++;
  console.log(`PASS ${label}`);
}

/**
 * 合成带硬字幕的测试视频（drawtext 必须在 concat 之后：输入段是局部时间轴，
 * enable between 的全局时间在局部轴上永不命中——项目已踩坑）
 */
async function buildVideo() {
  const videoPath = path.join(ROOT, "scripts", "test-ocr-video.mp4");
  if (fs.existsSync(videoPath)) return videoPath;
  console.log("[1/6] FFmpeg 合成硬字幕测试视频…");
  // 滤镜内字体用相对路径（Windows 盘符冒号在滤镜参数中会被误解析）
  fs.copyFileSync("C:\\Windows\\Fonts\\simhei.ttf", path.join(ROOT, "tmp-e2e-font.ttf"));
  const inputs = [];
  for (let i = 0; i < LINES.length; i++) {
    inputs.push("-f", "lavfi", "-i", "color=c=steelblue:s=640x360:r=15:d=5");
  }
  const draws = LINES.map(
    (text, i) =>
      `drawtext=fontfile=tmp-e2e-font.ttf:text='${text}':fontsize=30:fontcolor=white:borderw=2:bordercolor=black:x=(w-text_w)/2:y=h-70:enable='between(t,${i * 5},${i * 5 + 5})'`,
  ).join(",");
  const filterChain =
    LINES.map((_, i) => `[${i}:v]`).join("") + `concat=n=${LINES.length}:v=1:a=0[cat];[cat]${draws}[out]`;
  await execFileAsync(
    ffmpegPath,
    ["-y", ...inputs, "-filter_complex", filterChain, "-map", "[out]", "-c:v", "libx264", "-pix_fmt", "yuv420p", videoPath],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  fs.unlinkSync(path.join(ROOT, "tmp-e2e-font.ttf"));
  return videoPath;
}

async function main() {
  const videoPath = await buildVideo();
  ok(fs.statSync(videoPath).size > 10 * 1024, "硬字幕测试视频就绪");

  /* ---------- ② 登录 ---------- */
  console.log("[2/6] 登录…");
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
  ok(loginRes.ok, "登录成功");
  const cookie = (loginRes.headers.get("set-cookie") ?? "").split(";")[0];
  ok(Boolean(cookie), "取到会话 Cookie");

  /* ---------- ③ 整传上传（OCR 模式） ---------- */
  console.log("[3/6] 上传（X-Process-Mode: ocr）…");
  const upRes = await fetch(`${BASE}/api/projects`, {
    method: "POST",
    headers: {
      "Content-Type": "video/mp4",
      "X-File-Name": encodeURIComponent("e2e-硬字幕测试.mp4"),
      "X-Process-Mode": "ocr",
      "Content-Length": String(fs.statSync(videoPath).size),
      Cookie: cookie,
    },
    body: Readable.toWeb(fs.createReadStream(videoPath)),
    duplex: "half",
  });
  const upBody = await upRes.json().catch(() => ({}));
  ok(upRes.ok && upBody.projectId, `上传成功（项目 ${upBody.projectId}）`);
  const projectId = upBody.projectId;

  /* ---------- ④ 轮询 READY 并校验 ---------- */
  console.log("[4/6] 轮询 OCR 识别状态…");
  const deadline = Date.now() + 8 * 60 * 1000;
  let project = null;
  while (Date.now() < deadline) {
    await sleep(3000);
    const res = await fetch(`${BASE}/api/projects/${projectId}`, { headers: { Cookie: cookie } });
    if (!res.ok) continue;
    project = (await res.json()).project;
    console.log(`  状态：${project.status}`);
    if (project.status === "READY" || project.status === "FAILED") break;
  }
  ok(project && project.status === "READY", `识别完成 READY${project && project.status === "FAILED" ? `（失败原因：${project.error}）` : ""}`);
  ok(project.processMode === "ocr", "项目 processMode=ocr");
  ok(String(project.transcript.asrProvider).startsWith("ocr-"), `识别引擎为 OCR provider（${project.transcript.asrProvider}）`);

  const segs = project.transcript.segments;
  ok(Array.isArray(segs) && segs.length === LINES.length, `字幕段数 ${segs.length}（造数 ${LINES.length} 段）`);
  const rawText = project.transcript.rawText ?? "";
  for (const line of LINES) {
    ok(rawText.includes(line), `原文留底含「${line}」`);
  }
  ok(segs.every((s, i) => i === 0 || s.start >= segs[i - 1].start), "时间轴单调不回退");
  const spansOk = segs.every((s) => s.end - s.start > 2 && s.end - s.start < 8);
  ok(spansOk, "各段时长在 2-8s 合理区间（1fps 采样精度）");

  console.log("\n识别结果：");
  for (const s of segs) {
    const t = (v) => `${String(Math.floor(v / 60)).padStart(2, "0")}:${String(Math.floor(v % 60)).padStart(2, "0")}`;
    console.log(`  [${t(s.start)} → ${t(s.end)}] ${s.text}`);
  }

  /* ---------- ⑤ 音频项目强制 asr ---------- */
  console.log("[5/6] 音频 + ocr 头 → 应强制 asr…");
  const audioPath = path.join(ROOT, "scripts", "test-audio.mp3");
  const auRes = await fetch(`${BASE}/api/projects`, {
    method: "POST",
    headers: {
      "Content-Type": "audio/mpeg",
      "X-File-Name": encodeURIComponent("e2e-ocr-audio.mp3"),
      "X-Process-Mode": "ocr",
      "Content-Length": String(fs.statSync(audioPath).size),
      Cookie: cookie,
    },
    body: Readable.toWeb(fs.createReadStream(audioPath)),
    duplex: "half",
  });
  const auBody = await auRes.json().catch(() => ({}));
  ok(auRes.ok && auBody.projectId, "音频上传成功");
  const listRes = await fetch(`${BASE}/api/projects?pageSize=100`, { headers: { Cookie: cookie } });
  const listBody = await listRes.json();
  const audioRow = listBody.projects.find((p) => p.id === auBody.projectId);
  ok(audioRow && audioRow.processMode === "asr", "音频项目 processMode 强制为 asr");
  ok(listBody.projects.every((p) => typeof p.processMode === "string"), "列表接口返回 processMode 字段");
  // 立即删除音频项目（无需等转写，省 ASR 费用与队列占用）
  await fetch(`${BASE}/api/projects/${auBody.projectId}`, { method: "DELETE", headers: { Cookie: cookie } });
  console.log("  音频项目已删除（跳过转写）");

  /* ---------- ⑥ 清理 ---------- */
  console.log("[6/6] 清理…");
  const delRes = await fetch(`${BASE}/api/projects/${projectId}`, { method: "DELETE", headers: { Cookie: cookie } });
  ok(delRes.ok, "测试项目已删除（含封面联动清理）");

  console.log(`\n===== OCR E2E 通过（${passed} 断言）=====`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
