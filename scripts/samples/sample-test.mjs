/**
 * @file 真实样本视频全流程测试（node scripts/samples/sample-test.mjs）
 * @description 用免版权真实视频（Big Buck Bunny，CC 授权）+ 中文 TTS 语音合成混流，
 *              覆盖三种规格（1080p 高码率 / 360p 低码率 / 60s 完整短片），
 *              逐个上传到本地 dev server 跑完整流水线并汇报转写结果。
 * 运行前提：dev server 已启动、PostgreSQL 运行中、samples 目录已就位
 *          （bbb_1080p.mp4 / bbb_360p.mp4 / bbb_full.mp4 / vlog-tts.wav）。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SAMPLES = path.join(ROOT, "scripts", "samples");
const BASE = "http://localhost:3000";
/** 测试手机号（全新号避免发码冷却） */
const TEST_PHONE = "13900001000";

const ffmpeg = (await import("ffmpeg-static")).default;
const ffprobe = (await import("ffprobe-static")).path;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 探测媒体时长（秒） */
function probe(file) {
  return Number(
    execFileSync(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString().trim(),
  );
}

/* ---------- ① 混流：真实画面 + 中文语音（视频流 copy 不重编码） ---------- */
console.log("[1/3] FFmpeg 混流（真实画面 + 中文 TTS 音轨）…");
const ttsWav = path.join(SAMPLES, "vlog-tts.wav");
const cases = [
  { src: "bbb_full.mp4", out: "mixed_full.mp4", label: "完整短片 60s（480p）+ 51s 语音" },
  { src: "bbb_1080p.mp4", out: "mixed_1080p.mp4", label: "1080p 高码率 10s 片段" },
  { src: "bbb_360p.mp4", out: "mixed_360p.mp4", label: "360p 低码率 10s 片段" },
];
for (const c of cases) {
  const src = path.join(SAMPLES, c.src);
  const out = path.join(SAMPLES, c.out);
  if (!fs.existsSync(out)) {
    execFileSync(ffmpeg, [
      "-y", "-i", src, "-i", ttsWav,
      "-map", "0:v:0", "-map", "1:a:0",
      "-c:v", "copy", "-c:a", "aac", "-b:a", "96k", "-shortest",
      out,
    ], { stdio: ["ignore", "ignore", "pipe"] });
  }
  console.log(`  ${c.out}：${(fs.statSync(out).size / 1024 / 1024).toFixed(1)}MB / ${probe(out).toFixed(1)}s（${c.label}）`);
}

/* ---------- ② 登录 ---------- */
console.log("[2/3] 登录…");
const smsRes = await fetch(`${BASE}/api/auth/sms`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ phone: TEST_PHONE }),
});
const smsBody = await smsRes.json();
if (!smsRes.ok) {
  console.error(`发码失败：`, smsBody);
  process.exit(1);
}
const loginRes = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ phone: TEST_PHONE, code: smsBody.devCode }),
});
if (!loginRes.ok) {
  console.error(`登录失败：HTTP ${loginRes.status}`);
  process.exit(1);
}
const cookie = (loginRes.headers.get("set-cookie") ?? "").split(";")[0];
console.log("[2/3] 登录成功");

/* ---------- ③ 逐个上传 + 轮询 ---------- */
console.log("[3/3] 逐个上传并等待转写…");
const results = [];
for (const c of cases) {
  const file = path.join(SAMPLES, c.out);
  const size = fs.statSync(file).size;
  const upRes = await fetch(`${BASE}/api/projects`, {
    method: "POST",
    headers: {
      "Content-Type": "video/mp4",
      "X-File-Name": encodeURIComponent(c.out),
      "Content-Length": String(size),
      Cookie: cookie,
    },
    body: Readable.toWeb(fs.createReadStream(file)),
    duplex: "half",
  });
  const upBody = await upRes.json().catch(() => ({}));
  if (!upRes.ok || !upBody.projectId) {
    console.error(`  ✗ ${c.out} 上传失败：HTTP ${upRes.status}`, upBody);
    results.push({ label: c.out, status: "UPLOAD_FAILED" });
    continue;
  }

  // 轮询至终态（上限 8 分钟）
  const deadline = Date.now() + 8 * 60 * 1000;
  let project = null;
  while (Date.now() < deadline) {
    await sleep(3000);
    const res = await fetch(`${BASE}/api/projects/${upBody.projectId}`, { headers: { Cookie: cookie } });
    if (!res.ok) continue;
    project = (await res.json()).project;
    if (project.status === "READY" || project.status === "FAILED") break;
  }
  if (!project || project.status === "FAILED") {
    console.error(`  ✗ ${c.out} 流水线失败：${project?.error ?? "超时"}`);
    results.push({ label: c.out, status: "FAILED", error: project?.error });
    continue;
  }
  const segs = project.transcript?.segments ?? [];
  console.log(`  ✓ ${c.out}：READY，${segs.length} 段（润色=${project.transcript.llmPolished}）`);
  for (const s of segs.slice(0, 3)) {
    console.log(`      [${s.start.toFixed(1)}s → ${s.end.toFixed(1)}s] ${s.text}`);
  }
  if (segs.length > 3) console.log(`      …共 ${segs.length} 段`);
  results.push({ label: c.out, status: "READY", segments: segs.length, durationSec: project.durationSec });
}

console.log("\n===== 样本测试汇总 =====");
for (const r of results) console.log(`${r.status.padEnd(14)} ${r.label}${r.segments ? `（${r.segments} 段）` : ""}${r.error ? ` → ${r.error}` : ""}`);
const allOk = results.every((r) => r.status === "READY");
process.exit(allOk ? 0 : 1);
