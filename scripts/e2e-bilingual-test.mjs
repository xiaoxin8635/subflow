// =====================================================================
// SubFlow E2E — P2.7 双语字幕专项
// 覆盖：未登录 401 → 参数校验（targetLang 非法 / 译文不存在 / 译文未完成 /
//       音频项目双语拦截）→ 双语整片烧录 DONE（任务落库 targetLang + 计费 +
//       CONSUME_EXPORT 流水 + 通知标注双语）→ 双语片段烧录 DONE（与片段导出
//       组合，真 FFmpeg 裁剪）→ 双语 SRT/ASS 文件下载内容断言（原文在上译文在下）
//       → 单语下载回归（不带 bilingual 无原文行）→ 越权 404 → 清理
// 前提：server 以 STORAGE_DRIVER=local 启动（FFmpeg 需读本地源文件）、
//       Postgres/Redis 运行中。译文为直插 DB 的 DONE 行（零 LLM/API 费用）。
// 重跑注意：POST exports 限流 20 次/h 计入所有 POST（含 400），连续重跑前
//       先清 Redis：docker exec subflow-redis redis-cli --scan --pattern 'rl:export:*'
//       然后 DEL。
// 运行：node scripts/e2e-bilingual-test.mjs
// =====================================================================
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import ffprobeStatic from "ffprobe-static";

const BASE = process.env.E2E_BASE ?? "http://localhost:3000";
const PHONE_A = process.env.E2E_PHONE_A ?? "13900002401";
const PHONE_B = process.env.E2E_PHONE_B ?? "13900002402";
const CODE = "123456"; // SMS_DEV_MODE 万能码

/** 与服务器 uploads 目录一致的本地根（videoKey 直接映射该目录下文件） */
const UPLOAD_DIR = process.env.LOCAL_UPLOAD_DIR ?? "./uploads";

/** 双语片段区间：5s → 15s，计费 ceil(10) = 10 秒 */
const CLIP_START = 5;
const CLIP_END = 15;
const CLIP_COST = CLIP_END - CLIP_START;

/** 原文字幕（两行）与对应英文假译文（索引严格对齐——P2.4 产物契约） */
const SOURCE_SEGS = [
  { start: 0.5, end: 3.5, text: "这是第一句原文", keywords: ["第一句"] },
  { start: 4, end: 7, text: "这是第二句原文", keywords: [] },
];
const EN_TEXTS = ["This is the first line", "This is the second line"];

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
 * 直插 Session 造登录态（绕开发码冷却与 IP 限流；清理按 tokenHash 精确定位）
 * @param phone 手机号
 * @returns Cookie 串
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

/**
 * 下载文本产物（字幕文件）并返回 { res, text }
 * @param cookie 登录态
 * @param url    下载地址
 */
async function downloadText(cookie, url) {
  const res = await jfetch(url, { headers: { Cookie: cookie } });
  const buf = Buffer.from(await res.arrayBuffer());
  return { res, text: buf.toString("utf8"), bytes: buf };
}

async function main() {
  console.log("[阶段①] 未登录访问…");
  let res = await jfetch(`${BASE}/api/projects/whatever/exports`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ styleId: "x", targetLang: "en" }),
  });
  ok(res.status === 401, "未登录创建双语导出 → 401");
  res = await jfetch(`${BASE}/api/translations/whatever/srt?bilingual=1`);
  ok(res.status === 401, "未登录双语字幕下载 → 401");

  console.log("[阶段②] 登录…");
  const cookieA = await login(PHONE_A);
  const userA = await db.user.findUnique({ where: { phone: PHONE_A } });
  ok(true, `用户 A（${PHONE_A}）登录成功`);
  const cookieB = await login(PHONE_B);
  const userB = await db.user.findUnique({ where: { phone: PHONE_B } });
  ok(true, `用户 B（${PHONE_B}）登录成功（越权对照）`);

  console.log("[阶段③] 直连 DB 造数据（零 LLM 费用）…");
  // 视频项目 + 原文转写 + 已完成英文翻译
  const videoKey = `e2e-bi-v-${Date.now()}.mp4`;
  fs.copyFileSync(
    path.join(process.cwd(), "test-media", "demo-video.mp4"),
    path.join(process.cwd(), UPLOAD_DIR, videoKey),
  );
  const videoDur = probeDuration(path.join(process.cwd(), UPLOAD_DIR, videoKey));
  const projectV = await db.project.create({
    data: {
      userId: userA.id,
      title: "E2E-Bilingual-Video",
      status: "READY",
      mediaKind: "video",
      videoKey,
      videoName: "e2e-bilingual-source.mp4",
      durationSec: Math.round(videoDur),
    },
  });
  await db.transcript.create({
    data: { projectId: projectV.id, segments: SOURCE_SEGS, llmPolished: true },
  });
  const translationEn = await db.translation.create({
    data: {
      projectId: projectV.id,
      targetLang: "en",
      status: "DONE",
      segments: SOURCE_SEGS.map((s, i) => ({ start: s.start, end: s.end, text: EN_TEXTS[i] })),
      charCount: SOURCE_SEGS.reduce((n, s) => n + s.text.length, 0),
      costSeconds: 60,
      finishedAt: new Date(),
    },
  });
  // 日语翻译停在 PENDING（校验「译文未完成」用）
  await db.translation.create({
    data: { projectId: projectV.id, targetLang: "ja", status: "PENDING" },
  });
  // 音频项目：有转写 + 已完成英文翻译（校验「音频双语拦截」而非「无翻译拦截」）
  const audioKey = `e2e-bi-a-${Date.now()}.mp3`;
  fs.copyFileSync(
    path.join(process.cwd(), "test-media", "demo-audio.mp3"),
    path.join(process.cwd(), UPLOAD_DIR, audioKey),
  );
  const audioDur = probeDuration(path.join(process.cwd(), UPLOAD_DIR, audioKey));
  const projectA = await db.project.create({
    data: {
      userId: userA.id,
      title: "E2E-Bilingual-Audio",
      status: "READY",
      mediaKind: "audio",
      videoKey: audioKey,
      videoName: "e2e-bilingual-source.mp3",
      durationSec: Math.round(audioDur),
    },
  });
  await db.transcript.create({
    data: {
      projectId: projectA.id,
      segments: [{ start: 1, end: 4, text: "音频项目原文", keywords: [] }],
      llmPolished: true,
    },
  });
  await db.translation.create({
    data: {
      projectId: projectA.id,
      targetLang: "en",
      status: "DONE",
      segments: [{ start: 1, end: 4, text: "Audio source line" }],
      charCount: 6,
      costSeconds: 60,
      finishedAt: new Date(),
    },
  });
  const officialStyle = await db.style.findFirst();
  ok(projectV.id && projectA.id && translationEn && officialStyle,
    `数据已建（视频 ${Math.round(videoDur)}s / 音频 ${Math.round(audioDur)}s，样式 ${officialStyle.id}）`);

  console.log("[阶段④] 双语参数校验…");
  const post = (body, projectId = projectV.id) =>
    jfetch(`${BASE}/api/projects/${projectId}/exports`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieA },
      body: JSON.stringify(body),
    });

  res = await post({ styleId: officialStyle.id, targetLang: 123 });
  ok(res.status === 400, "targetLang 为数字 → 400");
  res = await post({ styleId: officialStyle.id, targetLang: "fr" });
  ok(res.status === 400, "目标语言无翻译记录 → 400");
  res = await post({ styleId: officialStyle.id, targetLang: "ja" });
  ok(res.status === 400, "目标语言翻译进行中（PENDING）→ 400");
  res = await post({ styleId: officialStyle.id, targetLang: "en" }, projectA.id);
  const audioErr = await res.json();
  ok(res.status === 400 && audioErr.error.includes("音频项目不支持双语烧录"),
    "音频项目双语烧录 → 400（音频已有 en 翻译，证明拦截在媒体类型）");

  console.log("[阶段⑤] 双语整片烧录…");
  const balBeforeFull = (await db.user.findUnique({ where: { id: userA.id } })).balanceSeconds;
  res = await post({ styleId: officialStyle.id, targetLang: "en" });
  const expFull = await res.json();
  ok(res.status === 200 && expFull.taskId && expFull.costSeconds === Math.round(videoDur),
    `双语整片创建 → 200（计费 ${expFull.costSeconds} 秒 = ceil(时长)，双语不额外加价）`);
  const stFull = await waitExportDone(cookieA, expFull.taskId);
  ok(stFull.status === "DONE", "双语整片烧录 DONE");
  ok(stFull.targetLang === "en", "任务记录 targetLang=en");
  const balAfterFull = (await db.user.findUnique({ where: { id: userA.id } })).balanceSeconds;
  ok(balBeforeFull - balAfterFull === Math.round(videoDur), `余额扣减 ${Math.round(videoDur)} 秒`);
  const ledgerFull = await db.creditLedger.findFirst({
    where: { userId: userA.id, reason: "CONSUME_EXPORT", refId: expFull.taskId },
  });
  ok(ledgerFull?.changeSeconds === -Math.round(videoDur), "CONSUME_EXPORT 流水落库");
  const notifFull = await db.notification.findFirst({
    where: { userId: userA.id, type: "EXPORT_DONE" },
    orderBy: { createdAt: "desc" },
  });
  ok(notifFull?.body?.includes("双语·en"), `通知标注双语（${notifFull?.body?.slice(0, 40)}…）`);

  console.log("[阶段⑥] 双语 + 片段组合烧录…");
  res = await post({ styleId: officialStyle.id, targetLang: "en", startSec: CLIP_START, endSec: CLIP_END });
  const expClip = await res.json();
  ok(res.status === 200 && expClip.costSeconds === CLIP_COST,
    `双语片段创建 → 200（计费 ${CLIP_COST} 秒）`);
  const stClip = await waitExportDone(cookieA, expClip.taskId);
  ok(stClip.status === "DONE", "双语片段烧录 DONE（双语合并 → clamp 平移 → 烧录）");
  ok(stClip.startSec === CLIP_START && stClip.endSec === CLIP_END && stClip.targetLang === "en",
    "任务同时记录片段区间与双语语言");
  const dlRes = await jfetch(`${BASE}/api/exports/${expClip.taskId}/download`, { headers: { Cookie: cookieA } });
  const clipBuf = Buffer.from(await dlRes.arrayBuffer());
  const clipFile = path.join(process.cwd(), UPLOAD_DIR, "e2e-bilingual-clip.mp4");
  fs.writeFileSync(clipFile, clipBuf);
  const clipDurOut = probeDuration(clipFile);
  ok(clipDurOut != null && Math.abs(clipDurOut - CLIP_COST) <= 1.5,
    `双语片段时长 ≈ ${CLIP_COST}s（实测 ${clipDurOut?.toFixed(2)}s）`);
  fs.unlinkSync(clipFile);
  const ledgerClip = await db.creditLedger.findFirst({
    where: { userId: userA.id, reason: "CONSUME_CLIP", refId: expClip.taskId },
  });
  ok(ledgerClip?.changeSeconds === -CLIP_COST, "双语片段走 CONSUME_CLIP 流水");

  console.log("[阶段⑦] 双语字幕文件下载内容断言…");
  // 双语 SRT：原文在上、译文在下（同一块内真实换行）
  const srtBi = await downloadText(cookieA, `${BASE}/api/translations/${translationEn.id}/srt?bilingual=1`);
  ok(srtBi.res.status === 200, "双语 SRT 下载 → 200");
  ok(srtBi.bytes[0] === 0xef && srtBi.bytes[1] === 0xbb && srtBi.bytes[2] === 0xbf, "双语 SRT 带 BOM");
  ok(srtBi.text.includes(`${SOURCE_SEGS[0].text}\n${EN_TEXTS[0]}`), "SRT 第一块为「原文\\n译文」双行");
  ok(srtBi.text.includes(`${SOURCE_SEGS[1].text}\n${EN_TEXTS[1]}`), "SRT 第二块为「原文\\n译文」双行");
  ok(srtBi.text.includes("00:00:00,500 --> 00:00:03,500"), "双语 SRT 时间轴与原文一致");
  const cdSrt = decodeURIComponent(srtBi.res.headers.get("content-disposition") ?? "");
  ok(cdSrt.includes("双语") && cdSrt.includes("en"), "双语 SRT 文件名含「双语」与语言代码");
  // 双语 ASS：同一 Dialogue 内 \N 双行
  const assBi = await downloadText(cookieA, `${BASE}/api/translations/${translationEn.id}/ass?bilingual=1`);
  ok(assBi.res.status === 200, "双语 ASS 下载 → 200");
  ok(assBi.text.includes(`${SOURCE_SEGS[0].text}\\N${EN_TEXTS[0]}`), "ASS Dialogue 内原文\\N译文双行");
  ok(assBi.text.includes("[V4+ Styles]") && assBi.text.includes("Style: Default"), "双语 ASS 带样式头");
  // 单语回归：不带 bilingual 的 SRT 无原文行
  const srtMono = await downloadText(cookieA, `${BASE}/api/translations/${translationEn.id}/srt`);
  ok(srtMono.res.status === 200 && !srtMono.text.includes(SOURCE_SEGS[0].text) && srtMono.text.includes(EN_TEXTS[0]),
    "单语 SRT 回归：仅译文无原文行");
  const vttBi = await downloadText(cookieA, `${BASE}/api/translations/${translationEn.id}/vtt?bilingual=1`);
  ok(vttBi.res.status === 200 && vttBi.text.startsWith("WEBVTT") &&
    vttBi.text.includes(`${SOURCE_SEGS[0].text}\n${EN_TEXTS[0]}`), "双语 VTT 下载（WEBVTT 头 + 双行）");

  console.log("[阶段⑧] 越权 404…");
  res = await jfetch(`${BASE}/api/projects/${projectV.id}/exports`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieB },
    body: JSON.stringify({ styleId: officialStyle.id, targetLang: "en" }),
  });
  ok(res.status === 404, "非本人项目双语导出 → 404");
  const dlBi404 = await jfetch(`${BASE}/api/translations/${translationEn.id}/srt?bilingual=1`, {
    headers: { Cookie: cookieB },
  });
  ok(dlBi404.status === 404, "非本人双语字幕下载 → 404");

  console.log("[阶段⑨] 清理…");
  const taskIds = [expFull.taskId, expClip.taskId];
  await db.creditLedger.deleteMany({ where: { refId: { in: taskIds } } });
  await db.translation.deleteMany({ where: { projectId: { in: [projectV.id, projectA.id] } } });
  await db.project.deleteMany({ where: { id: { in: [projectV.id, projectA.id] } } });
  for (const k of [videoKey, audioKey]) {
    fs.promises.unlink(path.join(process.cwd(), UPLOAD_DIR, k)).catch(() => {});
  }
  const leftTasks = await db.exportTask.count({ where: { projectId: { in: [projectV.id, projectA.id] } } });
  ok(leftTasks === 0, "项目删除后导出任务级联清空");
  const leftTrans = await db.translation.count({ where: { projectId: { in: [projectV.id, projectA.id] } } });
  ok(leftTrans === 0, "翻译行已删除");
  console.log("  测试项目/翻译/任务/流水/产物已清理（余额保留扣减后的真实状态）");

  if (process.exitCode) {
    console.error("===== 存在失败断言 ❌ =====");
  } else {
    console.log("===== 结果：全部通过 🎉 P2.7 双语字幕 E2E 完成 =====");
  }
}

main()
  .catch((e) => {
    console.error("E2E 异常终止：", e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
