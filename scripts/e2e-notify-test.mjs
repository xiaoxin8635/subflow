/**
 * @file P1.3 任务完成通知 E2E 测试（node scripts/e2e-notify-test.mjs）
 * @description 运行前提：server 已启动（:3000，ENABLE_INPROCESS_WORKER=1 进程内 Worker）、
 *              SMS_DEV_MODE=true、test-media/demo-video.mp4 存在（35s 带音轨）、ffmpeg-static 可用。
 *              STORAGE_DRIVER 双模式均兼容（上传走 init 返回的分片通道）。
 *   ① 未登录访问 /api/notifications 与 /read → 401
 *   ② 已读接口参数校验：无 ids/all → 400；ids 含非字符串 → 400
 *   ③ 并发上传两个带音轨视频 → 转写 READY → 每个都产生 TRANSCRIBE_DONE 通知
 *     （unread 增长、title 含项目标题、link 指向 /project/{id}、readAt 为空）
 *   ④ 单条已读：updated=1 → 重复已读同一幂等 updated=0 → 未读数递减
 *   ⑤ 越权：admin 账号 read 他人通知 → updated=0（where 绑定本人 userId）
 *   ⑥ 全部已读：unread 归零
 *   ⑦ 失败通知：上传无音轨视频 → FAILED → TRANSCRIBE_FAILED 通知出现且含失败原因
 *   ⑧ 导出通知：生成激活码兑换 → 创建导出 → DONE → EXPORT_DONE 通知出现
 *     （EXPORT_FAILED 与 TRANSCRIBE_FAILED 共用同一 notify 写入模式，不重复制造）
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { PrismaClient } from "@prisma/client";
import ffmpegPath from "ffmpeg-static";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "http://localhost:3000";
/** 普通测试账号 */
const PHONE = "13800006000";
/** 管理员账号（须在 .env ADMIN_PHONES 白名单内，用于越权用例） */
const ADMIN_PHONE = "13800008001";
/** 带音轨演示视频（转写成功用） */
const DEMO_VIDEO = path.join(ROOT, "test-media", "demo-video.mp4");
/** 无音轨视频（失败通知用） */
const NO_AUDIO_VIDEO = path.join(ROOT, "test-media", "notify-no-audio.mp4");

const db = new PrismaClient();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failedCount = 0;
/** 断言（失败计数不中断） */
function check(name, cond, detail = "") {
  console.log(`${cond ? "✅" : "❌"} ${name}${cond || !detail ? "" : ` — ${detail}`}`);
  if (!cond) failedCount++;
}

/**
 * 登录指定手机号（dev 万能码，含 60s 发码冷却重试）
 * @param phone 手机号
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
 * 分片上传视频文件并创建项目（oss/local 双模式兼容）
 * @param cookie   会话 cookie
 * @param filePath 本地视频路径
 * @param name     项目文件名
 * @returns 项目 ID
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

/**
 * 轮询项目至终态（READY/FAILED）
 * @param cookie    会话 cookie
 * @param projectId 项目 ID
 * @param minutes   超时（分钟）
 */
async function waitTerminal(cookie, projectId, minutes = 4) {
  const deadline = Date.now() + minutes * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(3000);
    try {
      const r = await fetch(`${BASE}/api/projects/${projectId}`, { headers: { Cookie: cookie } });
      if (!r.ok) continue;
      const status = (await r.json()).project?.status ?? "";
      if (status === "READY" || status === "FAILED") return status;
    } catch { /* 网络抖动忽略 */ }
  }
  return "TIMEOUT";
}

/** 生成一枚随机激活码（字符集与 gen-redeem-codes.mjs 一致） */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
function generateCode() {
  const group = () =>
    Array.from({ length: 4 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join("");
  return `SUBF-${group()}-${group()}-${group()}`;
}

/* ---------- ① 未登录 → 401 ---------- */
console.log("[阶段①] 未登录访问通知接口…");
const anonList = await fetch(`${BASE}/api/notifications`);
check("未登录 GET /api/notifications → 401", anonList.status === 401, `HTTP ${anonList.status}`);
const anonRead = await fetch(`${BASE}/api/notifications/read`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ all: true }),
});
check("未登录 POST /api/notifications/read → 401", anonRead.status === 401, `HTTP ${anonRead.status}`);

/* ---------- ② 参数校验 ---------- */
console.log("[阶段②] 已读接口参数校验…");
const cookie = await login(PHONE);
const bad1 = await fetch(`${BASE}/api/notifications/read`, {
  method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({}),
});
check("无 ids 无 all → 400", bad1.status === 400, `HTTP ${bad1.status}`);
const bad2 = await fetch(`${BASE}/api/notifications/read`, {
  method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" },
  body: JSON.stringify({ ids: [123, null] }),
});
check("ids 含非字符串 → 400", bad2.status === 400, `HTTP ${bad2.status}`);

/* ---------- ③ 转写完成通知（并发两个视频） ---------- */
console.log("[阶段③] 上传两个带音轨视频，等待 TRANSCRIBE_DONE 通知…");
const before = await (await fetch(`${BASE}/api/notifications`, { headers: { Cookie: cookie } })).json();
console.log(`    初始 unread=${before.unread}`);

const t0 = Date.now();
const [pid1, pid2] = await Promise.all([
  uploadVideo(cookie, DEMO_VIDEO, `notify-e2e-a-${t0}.mp4`),
  uploadVideo(cookie, DEMO_VIDEO, `notify-e2e-b-${t0}.mp4`),
]);
const s1 = await waitTerminal(cookie, pid1);
const s2 = await waitTerminal(cookie, pid2);
check("两个视频转写成功", s1 === "READY" && s2 === "READY", `${s1} / ${s2}`);

const after = await (await fetch(`${BASE}/api/notifications`, { headers: { Cookie: cookie } })).json();
check("未读数 +2", after.unread === before.unread + 2, `unread ${before.unread} → ${after.unread}`);
const doneForPid1 = after.items.find((n) => n.type === "TRANSCRIBE_DONE" && n.link === `/project/${pid1}`);
const doneForPid2 = after.items.find((n) => n.type === "TRANSCRIBE_DONE" && n.link === `/project/${pid2}`);
check("项目 A 的 TRANSCRIBE_DONE 通知存在", !!doneForPid1, JSON.stringify(after.items.slice(0, 2)));
check("项目 B 的 TRANSCRIBE_DONE 通知存在", !!doneForPid2);
check("通知标题为「转写完成」", doneForPid1?.title === "转写完成", doneForPid1?.title ?? "");
check("通知正文含项目标题与就绪信息", (doneForPid1?.body ?? "").includes("notify-e2e-a") && (doneForPid1?.body ?? "").includes("字幕已就绪"), doneForPid1?.body ?? "");
check("新通知未读（readAt 为空）", doneForPid1?.readAt === null);
check("列表按时间倒序", after.items.length < 2 || new Date(after.items[0].createdAt) >= new Date(after.items[after.items.length - 1].createdAt));

/* ---------- ④ 单条已读 + 幂等 ---------- */
console.log("[阶段④] 单条已读与幂等…");
const read1 = await (await fetch(`${BASE}/api/notifications/read`, {
  method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" },
  body: JSON.stringify({ ids: [doneForPid1.id] }),
})).json();
check("单条已读 updated=1", read1.updated === 1, JSON.stringify(read1));
const read1Again = await (await fetch(`${BASE}/api/notifications/read`, {
  method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" },
  body: JSON.stringify({ ids: [doneForPid1.id] }),
})).json();
check("重复已读幂等 updated=0", read1Again.updated === 0, JSON.stringify(read1Again));
const mid = await (await fetch(`${BASE}/api/notifications`, { headers: { Cookie: cookie } })).json();
check("未读数 -1", mid.unread === after.unread - 1, `unread=${mid.unread}`);

/* ---------- ⑤ 越权：admin 不能已读他人通知 ---------- */
console.log("[阶段⑤] 越权校验…");
const adminCookie = await login(ADMIN_PHONE);
const cross = await (await fetch(`${BASE}/api/notifications/read`, {
  method: "POST", headers: { Cookie: adminCookie, "Content-Type": "application/json" },
  body: JSON.stringify({ ids: [doneForPid2.id] }),
})).json();
check("admin read 他人通知 updated=0", cross.updated === 0, JSON.stringify(cross));
const crossGet = await fetch(`${BASE}/api/notifications`, { headers: { Cookie: adminCookie } });
const adminView = await crossGet.json();
check("admin 列表不含他人通知", !adminView.items.some((n) => n.id === doneForPid2.id));

/* ---------- ⑥ 全部已读 ---------- */
console.log("[阶段⑥] 全部已读…");
const readAll = await (await fetch(`${BASE}/api/notifications/read`, {
  method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" },
  body: JSON.stringify({ all: true }),
})).json();
check("全部已读 updated 与未读数一致", readAll.updated === mid.unread, `updated=${readAll.updated} unread=${mid.unread}`);
const zero = await (await fetch(`${BASE}/api/notifications`, { headers: { Cookie: cookie } })).json();
check("unread 归零", zero.unread === 0, `unread=${zero.unread}`);

/* ---------- ⑦ 失败通知 ---------- */
console.log("[阶段⑦] 上传无音轨视频制造失败通知…");
if (!ffmpegPath) throw new Error("ffmpeg-static 不可用");
const gen = spawnSync(ffmpegPath, [
  "-y", "-f", "lavfi", "-i", "color=c=black:s=320x240:d=1",
  "-c:v", "libx264", "-preset", "ultrafast", "-an", NO_AUDIO_VIDEO,
], { timeout: 30_000 });
if (gen.status !== 0) throw new Error(`无音轨视频生成失败：${gen.stderr?.toString().slice(-200)}`);
const badPid = await uploadVideo(cookie, NO_AUDIO_VIDEO, `notify-e2e-noaudio-${Date.now()}.mp4`);
const badStatus = await waitTerminal(cookie, badPid, 5);
check("无音轨视频最终 FAILED", badStatus === "FAILED", `状态 ${badStatus}`);
// 失败通知需等重试用尽后由 markProjectFailed 写入（可能略晚于状态落库，给 15s 缓冲轮询）
let failedNote = null;
for (let i = 0; i < 6 && !failedNote; i++) {
  await sleep(2500);
  const r = await (await fetch(`${BASE}/api/notifications`, { headers: { Cookie: cookie } })).json();
  failedNote = r.items.find((n) => n.type === "TRANSCRIBE_FAILED" && n.link === `/project/${badPid}`) ?? null;
}
check("TRANSCRIBE_FAILED 通知出现", !!failedNote);
check("失败通知含失败原因", (failedNote?.body ?? "").includes("处理失败"), failedNote?.body ?? "");
check("失败通知为未读", failedNote?.readAt === null);

/* ---------- ⑧ 导出完成通知 ---------- */
console.log("[阶段⑧] 创建导出任务，等待 EXPORT_DONE 通知…");
const code = generateCode();
await db.redeemCode.create({ data: { code, bonusSeconds: 600 } });
const redeem = await fetch(`${BASE}/api/redeem`, {
  method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" },
  body: JSON.stringify({ code }),
});
check("激活码兑换成功", redeem.ok, `HTTP ${redeem.status}`);

const styles = (await (await fetch(`${BASE}/api/styles`, { headers: { Cookie: cookie } })).json()).styles;
const defaultStyle = styles.find((s) => s.isDefault) ?? styles[0];
const exportRes = await fetch(`${BASE}/api/projects/${pid2}/exports`, {
  method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" },
  body: JSON.stringify({ styleId: defaultStyle.id }),
});
const exportBody = await exportRes.json();
check("导出任务创建成功", exportRes.ok && !!exportBody.taskId, JSON.stringify(exportBody));

let taskStatus = "";
{
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(2000);
    const r = await fetch(`${BASE}/api/exports/${exportBody.taskId}`, { headers: { Cookie: cookie } });
    if (!r.ok) continue;
    taskStatus = (await r.json()).task?.status ?? "";
    if (taskStatus === "DONE" || taskStatus === "FAILED") break;
  }
}
check("导出任务完成", taskStatus === "DONE", `状态 ${taskStatus}`);

let exportNote = null;
for (let i = 0; i < 6 && !exportNote; i++) {
  await sleep(2500);
  const r = await (await fetch(`${BASE}/api/notifications`, { headers: { Cookie: cookie } })).json();
  exportNote = r.items.find((n) => n.type === "EXPORT_DONE" && n.link === `/project/${pid2}`) ?? null;
}
check("EXPORT_DONE 通知出现", !!exportNote);
check("导出通知含额度信息", (exportNote?.body ?? "").includes("额度"), exportNote?.body ?? "");

/* ---------- 清理与结果 ---------- */
await db.$disconnect();
console.log(`\n===== 结果：${failedCount === 0 ? "全部通过 🎉 P1.3 通知 E2E 完成" : `${failedCount} 项失败 ✗`} =====`);
process.exit(failedCount === 0 ? 0 : 1);
