// =====================================================================
// SubFlow E2E — P2.6 片段导出专项
// 覆盖：未登录 401 → 参数校验（成对/类型/负数/区间/越界/无样式）→ 余额 402
//       → 音频项目整片 400（回归）+ 音频片段裁剪 DONE（mp3 产物 + 计费/流水）
//       → 视频片段烧录 DONE（时间轴 clamp + 扣费 + 文件名/Content-Type）
//       → 无字幕交集片段纯裁剪 DONE → in-flight 409 → 越权 404
//       → 整片导出回归（CONSUME_EXPORT 计费不变）→ 清理
// 前提：server 以 STORAGE_DRIVER=local 启动（FFmpeg 需读本地源文件）、
//       Postgres/Redis 运行中。全程不调用 DashScope（FFmpeg 本地裁剪零 API 费用）。
// 运行：node scripts/e2e-clip-test.mjs
// =====================================================================
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import ffprobeStatic from "ffprobe-static";

const BASE = process.env.E2E_BASE ?? "http://localhost:3000";
const PHONE_A = process.env.E2E_PHONE_A ?? "13900002301";
const PHONE_B = process.env.E2E_PHONE_B ?? "13900002302";
const CODE = "123456"; // SMS_DEV_MODE 万能码

/** 与服务器 uploads 目录一致的本地根（videoKey 直接映射该目录下文件） */
const UPLOAD_DIR = process.env.LOCAL_UPLOAD_DIR ?? "./uploads";

/** 片段区间（视频/音频片段共用）：5s → 15s，计费 ceil(10) = 10 秒 */
const CLIP_START = 5;
const CLIP_END = 15;
const CLIP_COST = CLIP_END - CLIP_START; // 整数无需 ceil

const db = new PrismaClient();

/** 断言辅助 */
function ok(cond, label) {
  if (cond) {
    console.log(`✅ ${label}`);
  } else {
    console.error(`❌ ${label}`);
    process.exitCode = 1;
  }
}

/** 带重试的 JSON fetch（网络抖动重试 2 次） */
async function jfetch(url, opts = {}, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fetch(url, opts);
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw lastErr;
}

/**
 * 登录并返回 Cookie（发码 60s 冷却 429 时等 65s 重试一次）
 * @param phone 手机号
 */
async function login(phone) {
  let res = await jfetch(`${BASE}/api/auth/sms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone }),
  });
  if (res.status === 429) {
    console.log("  ⏳ 发码冷却中，等待 65 秒后重试…");
    await new Promise((r) => setTimeout(r, 65000));
    res = await jfetch(`${BASE}/api/auth/sms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone }),
    });
  }
  if (!res.ok) throw new Error(`发码失败 HTTP ${res.status}`);

  res = await jfetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone, code: CODE }),
  });
  if (!res.ok) throw new Error(`登录失败 HTTP ${res.status}`);
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("登录响应缺少 set-cookie");
  return setCookie.split(";")[0];
}

/**
 * 轮询导出任务至终态
 * @param cookie 登录态
 * @param taskId 任务 ID
 * @returns 终态任务对象（含 status/error/outputKey/startSec/endSec）
 */
async function waitExportDone(cookie, taskId) {
  for (let i = 0; i < 90; i++) {
    const res = await jfetch(`${BASE}/api/exports/${taskId}`, { headers: { Cookie: cookie } });
    if (res.ok) {
      const body = await res.json();
      if (body.task.status === "DONE" || body.task.status === "FAILED") return body.task;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return { status: "TIMEOUT" };
}

/** ffprobe 读取媒体时长（秒；解析失败返回 null） */
function probeDuration(file) {
  const r = spawnSync(ffprobeStatic.path, [
    "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file,
  ]);
  if (r.status !== 0) return null;
  const n = Number(r.stdout.toString().trim());
  return Number.isFinite(n) ? n : null;
}

/** 下载产物到本地临时文件并返回 { res, file }（断言 Content-Type/文件名用 res 头） */
async function downloadArtifact(cookie, taskId, saveName) {
  const res = await jfetch(`${BASE}/api/exports/${taskId}/download`, { headers: { Cookie: cookie } });
  const buf = Buffer.from(await res.arrayBuffer());
  const file = path.join(process.cwd(), UPLOAD_DIR, saveName);
  fs.writeFileSync(file, buf);
  return { res, file };
}

async function main() {
  console.log("[阶段①] 未登录访问…");
  let res = await jfetch(`${BASE}/api/projects/whatever/exports`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ startSec: 5, endSec: 15 }),
  });
  ok(res.status === 401, "未登录创建片段导出 → 401");

  console.log("[阶段②] 登录…");
  const cookieA = await login(PHONE_A);
  const userA = await db.user.findUnique({ where: { phone: PHONE_A } });
  ok(true, `用户 A（${PHONE_A}）登录成功`);
  const cookieB = await login(PHONE_B);
  const userB = await db.user.findUnique({ where: { phone: PHONE_B } });
  ok(true, `用户 B（${PHONE_B}）登录成功（越权对照）`);

  console.log("[阶段③] 直连 DB 造 READY 项目（零 ASR 费用）…");
  // 视频项目：demo-video.mp4（35.4s），字幕落在 0.5-7s（与片段 5-15s 部分交集，与 20-30s 无交集）
  const videoKey = `e2e-clip-v-${Date.now()}.mp4`;
  fs.copyFileSync(
    path.join(process.cwd(), "test-media", "demo-video.mp4"),
    path.join(process.cwd(), UPLOAD_DIR, videoKey),
  );
  const videoDur = probeDuration(path.join(process.cwd(), UPLOAD_DIR, videoKey));
  const projectV = await db.project.create({
    data: {
      userId: userA.id,
      title: "E2E-Clip-Video",
      status: "READY",
      mediaKind: "video",
      videoKey,
      videoName: "e2e-clip-source.mp4",
      durationSec: Math.round(videoDur),
    },
  });
  await db.transcript.create({
    data: {
      projectId: projectV.id,
      segments: [
        { start: 0.5, end: 3.5, text: "片段导出测试第一句", keywords: ["片段"] },
        { start: 4, end: 7, text: "第二句跨越片段边界验证时间轴平移", keywords: [] },
      ],
      llmPolished: true,
    },
  });
  // 音频项目：demo-audio.mp3（35.5s）
  const audioKey = `e2e-clip-a-${Date.now()}.mp3`;
  fs.copyFileSync(
    path.join(process.cwd(), "test-media", "demo-audio.mp3"),
    path.join(process.cwd(), UPLOAD_DIR, audioKey),
  );
  const audioDur = probeDuration(path.join(process.cwd(), UPLOAD_DIR, audioKey));
  const projectA = await db.project.create({
    data: {
      userId: userA.id,
      title: "E2E-Clip-Audio",
      status: "READY",
      mediaKind: "audio",
      videoKey: audioKey,
      videoName: "e2e-clip-source.mp3",
      durationSec: Math.round(audioDur),
    },
  });
  await db.transcript.create({
    data: {
      projectId: projectA.id,
      segments: [{ start: 1, end: 4, text: "音频项目字幕占位", keywords: [] }],
      llmPolished: true,
    },
  });
  const officialStyle = await db.style.findFirst();
  ok(projectV.id && projectA.id && officialStyle,
    `READY 项目已建（视频 ${Math.round(videoDur)}s / 音频 ${Math.round(audioDur)}s，官方样式 ${officialStyle.id}）`);

  console.log("[阶段④] 片段参数校验（视频项目）…");
  const clipBody = { styleId: officialStyle.id };
  const post = (body, projectId = projectV.id) =>
    jfetch(`${BASE}/api/projects/${projectId}/exports`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieA },
      body: JSON.stringify(body),
    });

  res = await post({ ...clipBody, startSec: CLIP_START });
  ok(res.status === 400, "只传 startSec 不传 endSec → 400");
  res = await post({ ...clipBody, startSec: "5", endSec: 15 });
  ok(res.status === 400, "startSec 为字符串 → 400");
  res = await post({ ...clipBody, startSec: -1, endSec: 15 });
  ok(res.status === 400, "startSec 为负数 → 400");
  res = await post({ ...clipBody, startSec: 20, endSec: 5 });
  ok(res.status === 400, "endSec 小于 startSec → 400");
  res = await post({ ...clipBody, startSec: 30, endSec: Math.round(videoDur) + 10 });
  ok(res.status === 400, "endSec 超出媒体时长 → 400");
  res = await post({ startSec: CLIP_START, endSec: CLIP_END });
  ok(res.status === 400, "片段导出但缺样式 → 400（视频任务必须选样式）");
  res = await post({});
  ok(res.status === 400, "整片导出缺样式 → 400（回归确认）");

  console.log("[阶段⑤] 余额不足 402…");
  const balanceA0 = userA.balanceSeconds;
  await db.user.update({ where: { id: userA.id }, data: { balanceSeconds: 5 } });
  res = await post({ ...clipBody, startSec: CLIP_START, endSec: CLIP_END });
  const p402 = await res.json();
  ok(res.status === 402 && p402.required === CLIP_COST,
    `片段导出余额不足 → 402（需 ${CLIP_COST} 秒）`);
  await db.user.update({ where: { id: userA.id }, data: { balanceSeconds: balanceA0 } });

  console.log("[阶段⑥] 音频项目：整片 400（回归）+ 片段裁剪…");
  res = await post({ styleId: officialStyle.id }, projectA.id);
  ok(res.status === 400, "音频项目整片烧录 → 400（回归）");
  res = await post({ startSec: CLIP_START, endSec: CLIP_END }, projectA.id);
  const expAudio = await res.json();
  ok(res.status === 200 && expAudio.taskId && expAudio.costSeconds === CLIP_COST,
    `音频片段创建 → 200（计费 ${expAudio.costSeconds} 秒 = 片段时长）`);
  const stAudio = await waitExportDone(cookieA, expAudio.taskId);
  ok(stAudio.status === "DONE", "音频片段任务 DONE");
  ok((stAudio.outputKey ?? "").endsWith(".mp3"), `产物为 mp3（${stAudio.outputKey}）`);
  ok(stAudio.startSec === CLIP_START && stAudio.endSec === CLIP_END, "任务记录片段区间");
  const { res: dlAudio, file: fAudio } = await downloadArtifact(cookieA, expAudio.taskId, "e2e-clip-check.mp3");
  ok(dlAudio.headers.get("content-type") === "audio/mpeg", "下载 Content-Type 为 audio/mpeg");
  const cdAudio = decodeURIComponent(dlAudio.headers.get("content-disposition") ?? "");
  ok(cdAudio.includes("片段") && cdAudio.includes("5-15s"), `下载文件名含片段区间（${cdAudio.match(/filename\*=UTF-8''(.+?);?$/) ? "已编码" : "未找到"}）`);
  const audioOutDur = probeDuration(fAudio);
  ok(audioOutDur != null && Math.abs(audioOutDur - CLIP_COST) <= 1,
    `音频片段时长 ≈ ${CLIP_COST}s（实测 ${audioOutDur?.toFixed(2)}s）`);
  fs.unlinkSync(fAudio);

  console.log("[阶段⑦] 视频片段烧录（时间轴 clamp + 平移）…");
  const balBeforeV = (await db.user.findUnique({ where: { id: userA.id } })).balanceSeconds;
  res = await post({ ...clipBody, startSec: CLIP_START, endSec: CLIP_END });
  const expV = await res.json();
  ok(res.status === 200 && expV.taskId && expV.costSeconds === CLIP_COST,
    `视频片段创建 → 200（计费 ${expV.costSeconds} 秒）`);
  const stV = await waitExportDone(cookieA, expV.taskId);
  ok(stV.status === "DONE", "视频片段任务 DONE（烧录 + 裁剪）");
  const { res: dlV, file: fV } = await downloadArtifact(cookieA, expV.taskId, "e2e-clip-check.mp4");
  ok(dlV.headers.get("content-type") === "video/mp4", "下载 Content-Type 为 video/mp4");
  const vOutDur = probeDuration(fV);
  ok(vOutDur != null && Math.abs(vOutDur - CLIP_COST) <= 1.5,
    `视频片段时长 ≈ ${CLIP_COST}s（实测 ${vOutDur?.toFixed(2)}s）`);
  fs.unlinkSync(fV);
  // 计费与流水
  const balAfterV = (await db.user.findUnique({ where: { id: userA.id } })).balanceSeconds;
  ok(balBeforeV - balAfterV === CLIP_COST, `余额扣减 ${CLIP_COST} 秒（${balBeforeV} → ${balAfterV}）`);
  const ledgerV = await db.creditLedger.findFirst({ where: { userId: userA.id, reason: "CONSUME_CLIP", refId: expV.taskId } });
  ok(ledgerV?.changeSeconds === -CLIP_COST, "CONSUME_CLIP 流水落库（changeSeconds 为负）");
  const notif = await db.notification.findFirst({
    where: { userId: userA.id, type: "EXPORT_DONE" },
    orderBy: { createdAt: "desc" },
  });
  ok(notif?.body?.includes("片段"), "站内通知标注片段导出");
  const audioClipLedgerCount = await db.creditLedger.count({
    where: { userId: userA.id, reason: "CONSUME_CLIP", refId: expAudio.taskId },
  });
  ok(audioClipLedgerCount === 1, "音频片段同样产生 CONSUME_CLIP 流水");

  console.log("[阶段⑧] 无字幕交集片段（纯裁剪）…");
  res = await post({ ...clipBody, startSec: 20, endSec: 30 });
  const expV2 = await res.json();
  ok(res.status === 200, "无字幕区间片段创建 → 200");
  const stV2 = await waitExportDone(cookieA, expV2.taskId);
  ok(stV2.status === "DONE", "无字幕交集片段 DONE（区间无字幕行不挂 ass 滤镜）");
  const { file: fV2 } = await downloadArtifact(cookieA, expV2.taskId, "e2e-clip-check2.mp4");
  const v2Dur = probeDuration(fV2);
  ok(v2Dur != null && Math.abs(v2Dur - 10) <= 1.5, `纯裁剪时长 ≈ 10s（实测 ${v2Dur?.toFixed(2)}s）`);
  fs.unlinkSync(fV2);

  console.log("[阶段⑨] in-flight 409 + 越权 404…");
  const pendingRow = await db.exportTask.create({
    data: { projectId: projectV.id, styleId: officialStyle.id, resolution: "original" },
  });
  res = await post({ ...clipBody, startSec: CLIP_START, endSec: CLIP_END });
  ok(res.status === 409, "已有进行中任务 → 409");
  await db.exportTask.delete({ where: { id: pendingRow.id } });
  res = await jfetch(`${BASE}/api/projects/${projectV.id}/exports`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieB },
    body: JSON.stringify({ ...clipBody, startSec: CLIP_START, endSec: CLIP_END }),
  });
  ok(res.status === 404, "非本人项目片段导出 → 404");

  console.log("[阶段⑩] 整片导出回归（原链路不受影响）…");
  const balBeforeFull = (await db.user.findUnique({ where: { id: userA.id } })).balanceSeconds;
  res = await post({ ...clipBody });
  const expFull = await res.json();
  ok(res.status === 200 && expFull.costSeconds === Math.round(videoDur),
    `整片导出创建 → 200（计费 ${expFull.costSeconds} 秒 = ceil(时长)）`);
  const stFull = await waitExportDone(cookieA, expFull.taskId);
  ok(stFull.status === "DONE", "整片烧录 DONE");
  ok(stFull.startSec == null && stFull.endSec == null, "整片任务区间字段为 null");
  const ledgerFull = await db.creditLedger.findFirst({ where: { userId: userA.id, reason: "CONSUME_EXPORT", refId: expFull.taskId } });
  ok(ledgerFull?.changeSeconds === -Math.round(videoDur), "整片仍走 CONSUME_EXPORT 流水");
  const { file: fFull } = await downloadArtifact(cookieA, expFull.taskId, "e2e-clip-full.mp4");
  const fullDur = probeDuration(fFull);
  ok(fullDur != null && Math.abs(fullDur - videoDur) <= 1.5, `整片时长 ≈ ${videoDur.toFixed(1)}s（实测 ${fullDur?.toFixed(2)}s）`);
  fs.unlinkSync(fFull);
  const balAfterFull = (await db.user.findUnique({ where: { id: userA.id } })).balanceSeconds;
  ok(balBeforeFull - balAfterFull === Math.round(videoDur), "整片扣费 = ceil(时长)（回归）");

  console.log("[阶段⑪] 清理…");
  // 删项目（ExportTask/Transcript 级联）+ 产物文件；流水无级联需先删
  const taskIds = [expAudio.taskId, expV.taskId, expV2.taskId, expFull.taskId];
  await db.creditLedger.deleteMany({ where: { refId: { in: taskIds } } });
  await db.project.deleteMany({ where: { id: { in: [projectV.id, projectA.id] } } });
  for (const k of [videoKey, audioKey]) {
    fs.promises.unlink(path.join(process.cwd(), UPLOAD_DIR, k)).catch(() => {});
  }
  const leftTasks = await db.exportTask.count({ where: { projectId: { in: [projectV.id, projectA.id] } } });
  ok(leftTasks === 0, "项目删除后任务级联清空");
  console.log("  测试项目/任务/流水/产物已清理（余额保留扣减后的真实状态）");

  if (process.exitCode) {
    console.error("===== 存在失败断言 ❌ =====");
  } else {
    console.log("===== 结果：全部通过 🎉 P2.6 片段导出 E2E 完成 =====");
  }
}

main()
  .catch((e) => {
    console.error("E2E 异常终止：", e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
