/**
 * @file P2.1 音频直传专项 E2E（node scripts/e2e-audio-test.mjs）
 * @description 覆盖音频上传→转写→导出形态的完整链路（真实调用 DashScope ASR，约 1-2 分钟）：
 *   ① 未登录：init(audio/mpeg) → 401
 *   ② 登录（dev 万能码，含 60s 发码冷却重试）
 *   ③ MIME 白名单：text/plain init → 415
 *   ④ 魔数防御：伪内容声明 audio/mpeg → 分片 PUT 接受 → complete 415
 *   ⑤ 真实音频（test-media/demo-audio.mp3，35s 真人声）分片上传 → complete 200
 *   ⑥ 轮询 READY → 详情 mediaKind=audio → SRT 下载 200（带 BOM）
 *   ⑦ 导出成片被拒 → 400（音频不支持烧录）
 *   ⑧ 清理：删除音频项目（源文件与转写记录级联清理）
 * 运行前提：生产模式 server 已启动（:3000）、SMS_DEV_MODE=true、数据库已 seed。
 */
const BASE = process.env.E2E_BASE ?? "http://localhost:3000";
const PHONE = process.env.E2E_PHONE ?? "13900002222";
const DEV_CODE = process.env.E2E_DEV_CODE ?? "123456";
import { readFileSync } from "node:fs";

let failedCount = 0;
/** 断言（失败计数不中断） */
function check(name, cond, detail = "") {
  console.log(`${cond ? "✅" : "❌"} ${name}${cond || !detail ? "" : ` — ${detail}`}`);
  if (!cond) failedCount++;
}
/** 休眠 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- ① 未登录 ---------- */
console.log("[阶段①] 未登录…");
const anonInit = await fetch(`${BASE}/api/uploads/init`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ fileName: "a.mp3", contentType: "audio/mpeg", size: 100 }),
});
check("未登录 init → 401", anonInit.status === 401, `HTTP ${anonInit.status}`);

/* ---------- ② 登录 ---------- */
console.log("[阶段②] 登录…");
let sms = await (await fetch(`${BASE}/api/auth/sms`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ phone: PHONE }),
})).json();
if (!sms.devCode) {
  if (sms.error) {
    console.log("    发码冷却，等 65 秒重试…");
    await sleep(65 * 1000);
    sms = await (await fetch(`${BASE}/api/auth/sms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: PHONE }),
    })).json();
  }
}
if (!sms.devCode) {
  console.error("发码失败：", sms);
  process.exit(1);
}
const loginRes = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ phone: PHONE, code: sms.devCode ?? DEV_CODE }),
});
check("登录成功", loginRes.ok, `HTTP ${loginRes.status}`);
const cookie = (loginRes.headers.get("set-cookie") ?? "").split(";")[0];

/* ---------- ③ MIME 白名单 ---------- */
console.log("[阶段③] MIME 白名单…");
const badMime = await fetch(`${BASE}/api/uploads/init`, {
  method: "POST",
  headers: { Cookie: cookie, "Content-Type": "application/json" },
  body: JSON.stringify({ fileName: "x.txt", contentType: "text/plain", size: 100 }),
});
check("text/plain init → 415", badMime.status === 415, `HTTP ${badMime.status}`);

/* ---------- ④ 魔数防御（伪音频内容） ---------- */
console.log("[阶段④] 魔数防御…");
const fake = Buffer.from("THIS_IS_NOT_AN_AUDIO_XYZ");
const fakeInit = await (await fetch(`${BASE}/api/uploads/init`, {
  method: "POST",
  headers: { Cookie: cookie, "Content-Type": "application/json" },
  body: JSON.stringify({ fileName: "fake.mp3", contentType: "audio/mpeg", size: fake.length }),
})).json();
check("伪音频 init 成功", !!fakeInit.uploadId, JSON.stringify(fakeInit).slice(0, 120));
if (fakeInit.uploadId) {
  const put = await fetch(
    fakeInit.mode === "oss" ? fakeInit.partUrls[0] : `${BASE}/api/uploads/${fakeInit.uploadId}/chunks/0`,
    { method: "PUT", body: fake, headers: fakeInit.mode === "oss" ? {} : { Cookie: cookie } },
  );
  check("伪音频分片 PUT 接受", put.ok, `HTTP ${put.status}`);
  const complete = await fetch(`${BASE}/api/uploads/${fakeInit.uploadId}/complete`, {
    method: "POST", headers: { Cookie: cookie },
  });
  check("伪音频 complete → 415", complete.status === 415, `HTTP ${complete.status}`);
}

/* ---------- ⑤ 真实音频上传 ---------- */
console.log("[阶段⑤] 真实音频上传（demo-audio.mp3）…");
const audio = readFileSync("test-media/demo-audio.mp3");
const realInit = await (await fetch(`${BASE}/api/uploads/init`, {
  method: "POST",
  headers: { Cookie: cookie, "Content-Type": "application/json" },
  body: JSON.stringify({ fileName: "e2e-audio-test.mp3", contentType: "audio/mpeg", size: audio.length }),
})).json();
check("音频 init 成功", !!realInit.uploadId, JSON.stringify(realInit).slice(0, 120));
let projectId = null;
if (realInit.uploadId) {
  // 音频 416KB < 5MB，单分片
  const put = await fetch(
    realInit.mode === "oss" ? realInit.partUrls[0] : `${BASE}/api/uploads/${realInit.uploadId}/chunks/0`,
    { method: "PUT", body: audio, headers: realInit.mode === "oss" ? {} : { Cookie: cookie } },
  );
  check("音频分片 PUT 接受", put.ok, `HTTP ${put.status}`);
  const complete = await (await fetch(`${BASE}/api/uploads/${realInit.uploadId}/complete`, {
    method: "POST", headers: { Cookie: cookie },
  })).json();
  projectId = complete.projectId ?? null;
  check("音频 complete 建项目", !!projectId, JSON.stringify(complete).slice(0, 120));
}

/* ---------- ⑥ 轮询转写完成 ---------- */
if (projectId) {
  console.log("[阶段⑥] 轮询转写完成…");
  let detail = null;
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(4000);
    const res = await fetch(`${BASE}/api/projects/${projectId}`, { headers: { Cookie: cookie } });
    if (!res.ok) continue;
    const body = await res.json();
    if (body.project.status === "READY") { detail = body.project; break; }
    if (body.project.status === "FAILED") {
      check("音频转写完成", false, `FAILED：${JSON.stringify(body.project).slice(0, 200)}`);
      break;
    }
  }
  check("音频转写 READY（真实 ASR）", !!detail);
  check("mediaKind = audio", detail?.mediaKind === "audio", `实际 ${detail?.mediaKind}`);
  check("时长已探测", (detail?.durationSec ?? 0) > 30, `durationSec=${detail?.durationSec}`);
  check("转写分段非空", (detail?.transcript?.segments?.length ?? 0) > 0);

  const srt = await fetch(`${BASE}/api/projects/${projectId}/srt`, { headers: { Cookie: cookie } });
  const srtBuf = Buffer.from(await srt.arrayBuffer());
  check("SRT 下载 200", srt.ok, `HTTP ${srt.status}`);
  check("SRT 带 BOM（防乱码）", srtBuf[0] === 0xef && srtBuf[1] === 0xbb && srtBuf[2] === 0xbf);

  /* ---------- ⑦ 导出被拒 ---------- */
  console.log("[阶段⑦] 导出成片拒绝…");
  const exportRes = await fetch(`${BASE}/api/projects/${projectId}/exports`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ styleId: "any-style" }),
  });
  check("音频导出成片 → 400", exportRes.status === 400, `HTTP ${exportRes.status}`);
  const exportBody = await exportRes.json().catch(() => ({}));
  check("拒绝原因含「音频」", (exportBody.error ?? "").includes("音频"), exportBody.error ?? "");

  /* ---------- ⑧ 清理 ---------- */
  const del = await fetch(`${BASE}/api/projects/${projectId}`, {
    method: "DELETE", headers: { Cookie: cookie },
  });
  check("删除音频项目", del.ok, `HTTP ${del.status}`);
}

console.log(`\n===== 结果：${failedCount === 0 ? "全部通过 🎉 P2.1 音频直传 E2E 完成" : `${failedCount} 项失败 ✗`} =====`);
process.exit(failedCount === 0 ? 0 : 1);
