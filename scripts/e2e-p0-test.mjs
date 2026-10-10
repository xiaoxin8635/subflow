/**
 * @file P0 专项 E2E 测试脚本（node scripts/e2e-p0-test.mjs）
 * @description 验证第一期 P0 新增能力，运行前提：生产/开发 server 已启动（localhost:3000）、
 *              PostgreSQL 容器运行中、SMS_DEV_MODE=true、test-media/demo-video.mp4 已生成。
 *   ① 登录拿会话
 *   ② 分片上传链路：init → 只传一半分片（模拟中断）→ resume 查询 → 续传剩余片 → complete
 *   ③ 轮询项目至 READY（真实走 DashScope 转写）
 *   ④ SRT 下载断言：BOM 头、序号/时间轴格式、文本内容
 *   ⑤ 魔数拒绝：上传伪造内容 → complete 返回 415
 *   ⑥ 项目列表分页断言：page/pageSize/totalPages 字段
 *   ⑦ 登录限流断言：连续错误验证码触发 429
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 项目根目录 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** server 地址 */
const BASE = "http://localhost:3000";
/** 测试手机号（与既有 E2E 号段区分，避免历史数据干扰） */
const PHONE = "13800005000";
/** 测试视频（gen-demo-tts.ps1 + FFmpeg 合成的演示片） */
const VIDEO = path.join(ROOT, "test-media", "demo-video.mp4");

/** 休眠工具 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 断言工具：失败即退出 */
function check(name, cond, detail = "") {
  console.log(`${cond ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) process.exit(1);
}

/** 从登录响应提取会话 cookie */
function pickSession(res) {
  const raw = res.headers.getSetCookie?.() ?? [];
  for (const c of raw) {
    const pair = c.split(";")[0];
    if (/session/i.test(pair)) return pair;
  }
  return (raw[0] ?? "").split(";")[0];
}

/* ---------- ① 登录 ---------- */
// 发码受 60 秒冷却限制（防刷），脚本重跑时可能撞上：429 则等 60 秒重试一次
async function sendCode(phone) {
  let res = await fetch(`${BASE}/api/auth/sms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone }),
  });
  if (res.status === 429) {
    console.log("发码触发冷却限流，等待 65 秒后重试…");
    await sleep(65 * 1000);
    res = await fetch(`${BASE}/api/auth/sms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone }),
    });
  }
  return res;
}

const sms = await sendCode(PHONE);
const smsBody = await sms.json();
check("发码成功", sms.ok && smsBody.devCode, `HTTP ${sms.status}`);

const login = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ phone: PHONE, code: smsBody.devCode }),
});
check("登录成功", login.ok, `HTTP ${login.status}`);
const cookie = pickSession(login);
check("会话 cookie 就绪", Boolean(cookie));
const authHeaders = { Cookie: cookie };

/* ---------- ② 分片上传 + 模拟中断续传 ---------- */
const videoBuf = fs.readFileSync(VIDEO);
const MIME = "video/mp4";
const init = await fetch(`${BASE}/api/uploads/init`, {
  method: "POST",
  headers: { ...authHeaders, "Content-Type": "application/json" },
  body: JSON.stringify({ fileName: "demo-video.mp4", contentType: MIME, size: videoBuf.length }),
});
const initBody = await init.json();
check("init 创建会话", init.ok && initBody.uploadId, `chunkSize=${initBody.chunkSize}, chunkCount=${initBody.chunkCount}`);

const { uploadId, chunkSize, chunkCount } = initBody;

/** 上传第 index 片 */
async function putChunk(index) {
  const start = index * chunkSize;
  const blob = videoBuf.subarray(start, Math.min(start + chunkSize, videoBuf.length));
  return fetch(`${BASE}/api/uploads/${uploadId}/chunks/${index}`, {
    method: "PUT",
    headers: { ...authHeaders, "Content-Type": "application/octet-stream" },
    body: blob,
  });
}

// 模拟中断：只传前一半分片
for (let i = 0; i < Math.floor(chunkCount / 2); i++) {
  const r = await putChunk(i);
  if (!r.ok) {
    console.error(`分片 ${i} 上传失败：HTTP ${r.status}`, await r.text());
    process.exit(1);
  }
}
console.log(`[中断模拟] 已传 ${Math.floor(chunkCount / 2)}/${chunkCount} 片`);

// resume 查询已到齐分片
const resume = await fetch(`${BASE}/api/uploads/${uploadId}`, { headers: authHeaders });
const resumeBody = await resume.json();
check(
  "resume 返回已传分片",
  resume.ok && resumeBody.uploadedIndexes?.length === Math.floor(chunkCount / 2),
  `uploadedIndexes=${JSON.stringify(resumeBody.uploadedIndexes)}`,
);

// 续传剩余分片
for (let i = Math.floor(chunkCount / 2); i < chunkCount; i++) {
  const r = await putChunk(i);
  if (!r.ok) {
    console.error(`续传分片 ${i} 失败：HTTP ${r.status}`);
    process.exit(1);
  }
}
console.log("[续传] 剩余分片全部到齐");

// complete 合并
const complete = await fetch(`${BASE}/api/uploads/${uploadId}/complete`, {
  method: "POST",
  headers: authHeaders,
});
const completeBody = await complete.json();
check("complete 合并并创建项目", complete.ok && completeBody.projectId, `projectId=${completeBody.projectId}`);
const projectId = completeBody.projectId;

/* ---------- ③ 轮询至 READY ---------- */
console.log("[转写] 轮询项目状态（真实 DashScope 转写，最长等 3 分钟）…");
let ready = false;
let detail = null;
for (let i = 0; i < 90; i++) {
  await sleep(2000);
  const r = await fetch(`${BASE}/api/projects/${projectId}`, { headers: authHeaders });
  const b = await r.json();
  if (b.project?.status === "READY") {
    ready = true;
    detail = b.project;
    break;
  }
  if (b.project?.status === "FAILED") {
    console.error("转写失败：", b.project.error);
    process.exit(1);
  }
}
check("项目转写就绪", ready, `segments=${detail?.transcript?.segments?.length ?? 0}`);

/* ---------- ④ SRT 下载断言 ---------- */
const srt = await fetch(`${BASE}/api/projects/${projectId}/srt`, { headers: authHeaders });
const srtBuf = Buffer.from(await srt.arrayBuffer());
// 注意：Response.text() 按 WHATWG 规范会剥掉开头 BOM，因此用字节级断言验证 BOM（EF BB BF）
const srtText = srtBuf.subarray(3).toString("utf8");
check("SRT 下载 200", srt.ok, `Content-Disposition=${srt.headers.get("content-disposition")?.slice(0, 60)}`);
check("SRT 含 UTF-8 BOM（EF BB BF）", srtBuf[0] === 0xef && srtBuf[1] === 0xbb && srtBuf[2] === 0xbf);
check(
  "SRT 首块格式合法（序号 + HH:MM:SS,mmm 时间轴）",
  /^1\n\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}\n/.test(srtText),
);
check("SRT 含转写文本（字幕工坊）", srtText.includes("字幕工坊"));
check("SRT 段间空行分隔", srtText.includes("\n\n"));

// 未登录访问 SRT 应 401
const srtAnon = await fetch(`${BASE}/api/projects/${projectId}/srt`);
check("未登录 SRT 401", srtAnon.status === 401);

/* ---------- ⑤ 魔数拒绝 ---------- */
// size 声明为精确字节数，让分片校验通过、一路走到合并后的魔数复查（验证 415 路径）
const fakeContent = Buffer.from("THIS_IS_NOT_A_VIDEO_XYZ");
const badInit = await fetch(`${BASE}/api/uploads/init`, {
  method: "POST",
  headers: { ...authHeaders, "Content-Type": "application/json" },
  body: JSON.stringify({ fileName: "fake.mp4", contentType: MIME, size: fakeContent.length }),
});
const badInitBody = await badInit.json();
const badId = badInitBody.uploadId;
await fetch(`${BASE}/api/uploads/${badId}/chunks/0`, {
  method: "PUT",
  headers: { ...authHeaders, "Content-Type": "application/octet-stream" },
  body: fakeContent,
});
const badComplete = await fetch(`${BASE}/api/uploads/${badId}/complete`, {
  method: "POST",
  headers: authHeaders,
});
check("伪造内容 complete 被拒（415）", badComplete.status === 415, `HTTP ${badComplete.status}`);

// 附：片大小不符的会话应在 complete 时以 409 拦截（分片不齐防御路径）
const badInit2 = await fetch(`${BASE}/api/uploads/init`, {
  method: "POST",
  headers: { ...authHeaders, "Content-Type": "application/json" },
  body: JSON.stringify({ fileName: "fake2.mp4", contentType: MIME, size: fakeContent.length + 10 }),
});
const badId2 = (await badInit2.json()).uploadId;
await fetch(`${BASE}/api/uploads/${badId2}/chunks/0`, {
  method: "PUT",
  headers: { ...authHeaders, "Content-Type": "application/octet-stream" },
  body: fakeContent,
});
const badComplete2 = await fetch(`${BASE}/api/uploads/${badId2}/complete`, {
  method: "POST",
  headers: authHeaders,
});
check("片大小不符 complete 被拒（409）", badComplete2.status === 409, `HTTP ${badComplete2.status}`);

/* ---------- ⑥ 列表分页 ---------- */
const list = await fetch(`${BASE}/api/projects?page=1&pageSize=1`, { headers: authHeaders });
const listBody = await list.json();
check(
  "列表分页字段完整",
  list.ok && Number.isInteger(listBody.total) && listBody.page === 1 && listBody.totalPages >= 1 && Array.isArray(listBody.projects),
  `total=${listBody.total}, totalPages=${listBody.totalPages}`,
);
check("分页 pageSize 生效", listBody.projects.length <= 1);

/* ---------- ⑦ 登录限流（错误验证码连续尝试触发 429） ---------- */
const rlPhone = "13800004000";
let gotLimited = false;
let lastStatus = 0;
for (let i = 0; i < 12; i++) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone: rlPhone, code: "000000" }),
  });
  lastStatus = r.status;
  if (r.status === 429) {
    gotLimited = true;
    break;
  }
}
check("登录连续失败触发 429 限流", gotLimited, `lastStatus=${lastStatus}`);

console.log("\n全部通过 🎉 P0 专项 E2E 完成");
