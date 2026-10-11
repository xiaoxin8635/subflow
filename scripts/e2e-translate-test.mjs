// =====================================================================
// SubFlow E2E — P2.4 字幕翻译专项
// 覆盖：未登录 401 → 登录 → 参数/语言白名单校验 → 直连 DB 造 READY 项目
//       （翻译只读 transcript，无需媒体文件，零存储准备）→ 真实 DashScope 翻译
//       （en + zh-TW 两语言）→ 三格式下载断言 → 计费（扣减 + 流水 + 通知）
//       → 同语言进行中 409 → 越权校验 → 未完成下载 409 → 限流 429（借 DB 注入
//       PENDING 行复用计数器，不触发 LLM 调用）→ 清理
// 前提：生产/dev server 已启动（进程内 Worker 开启）、Postgres/Redis 运行中、
//       DASHSCOPE_API_KEY 已配置（真实调用 qwen-flash，费用约几分钱）。
// 运行：node scripts/e2e-translate-test.mjs
// 注意：末段限流测试会耗尽用户 A 的翻译限流窗口（1 小时 10 次），重跑需等待或换号。
// =====================================================================
import { PrismaClient } from "@prisma/client";

const BASE = process.env.E2E_BASE ?? "http://localhost:3000";
const PHONE_A = process.env.E2E_PHONE_A ?? "13900002301";
const PHONE_B = process.env.E2E_PHONE_B ?? "13900002302";
const PHONE_C = process.env.E2E_PHONE_C ?? "13900002303"; // 余额不足专用
const CODE = "123456"; // SMS_DEV_MODE 万能码

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
 * 轮询翻译任务至终态
 * @param cookie   登录态
 * @param taskId   Translation ID
 * @returns 终态状态（DONE / FAILED）
 */
async function waitTranslationDone(cookie, taskId) {
  for (let i = 0; i < 60; i++) {
    const res = await jfetch(`${BASE}/api/translations/${taskId}`, { headers: { Cookie: cookie } });
    if (res.ok) {
      const body = await res.json();
      if (body.task.status === "DONE") return body.task;
      if (body.task.status === "FAILED") {
        console.error(`  任务失败原因：${body.task.error}`);
        return body.task;
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return { status: "TIMEOUT" };
}

/** 与 constants.ts 同构的计费函数（断言服务端扣费口径用） */
function expectCost(charCount) {
  return Math.max(60, Math.ceil((charCount / 1000) * 60));
}

/** 测试用源字幕分段（中文，关键词仅原文高亮语义，翻译产物不保留） */
const SOURCE_SEGMENTS = [
  { start: 0.5, end: 3.5, text: "大家好，欢迎来到我的频道", keywords: ["频道"] },
  { start: 4, end: 7.5, text: "今天我们聊聊字幕工具的制作流程", keywords: [] },
  { start: 8, end: 12, text: "如果喜欢这个视频，别忘了点赞关注", keywords: ["点赞"] },
];
const CHAR_COUNT = SOURCE_SEGMENTS.reduce((n, s) => n + s.text.length, 0);

async function main() {
  console.log("[阶段①] 未登录访问…");
  let res = await jfetch(`${BASE}/api/projects/fake-id/translations`, { method: "POST" });
  ok(res.status === 401, "未登录 POST translations → 401");
  res = await jfetch(`${BASE}/api/projects/fake-id/translations`);
  ok(res.status === 401, "未登录 GET translations 列表 → 401");
  res = await jfetch(`${BASE}/api/translations/fake-id`);
  ok(res.status === 401, "未登录 GET 翻译状态 → 401");

  console.log("[阶段②] 登录…");
  const cookieA = await login(PHONE_A);
  ok(true, `用户 A（${PHONE_A}）登录成功`);
  const userA = await db.user.findUnique({ where: { phone: PHONE_A } });
  const balanceBefore = userA.balanceSeconds;

  console.log("[阶段③] 参数与语言白名单校验…");
  res = await jfetch(`${BASE}/api/projects/fake-id/translations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieA },
    body: JSON.stringify({ targetLang: "en" }),
  });
  ok(res.status === 404, "不存在项目 → 404（归属优先）");
  res = await jfetch(`${BASE}/api/projects/whatever/translations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieA },
    body: JSON.stringify({ targetLang: "fr" }),
  });
  // 语言白名单校验先于项目归属（与 exports 路由「body 校验先行」约定一致）→ 400
  ok(res.status === 400, "非法目标语言 fr（不存在项目）→ 400（白名单先行）");

  console.log("[阶段④] 直连 DB 造 READY 项目（翻译只读 transcript，零存储准备）…");
  const project = await db.project.create({
    data: {
      userId: userA.id,
      title: "E2E-Translate",
      status: "READY",
      mediaKind: "video",
      videoKey: null, // 翻译链路不读媒体文件
      durationSec: 12,
    },
  });
  await db.transcript.create({
    data: { projectId: project.id, segments: SOURCE_SEGMENTS, llmPolished: true },
  });
  ok(true, `READY 项目已建（${project.id}，源字幕 ${CHAR_COUNT} 字）`);

  res = await jfetch(`${BASE}/api/projects/${project.id}/translations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieA },
    body: JSON.stringify({ targetLang: "fr" }),
  });
  ok(res.status === 400, "非法目标语言 fr → 400");

  console.log("[阶段⑤] 余额预检 402（用户 C 余额压到 10 秒）…");
  const cookieC = await login(PHONE_C);
  const userC = await db.user.findUnique({ where: { phone: PHONE_C } });
  const cBalanceBefore = userC.balanceSeconds;
  await db.user.update({ where: { id: userC.id }, data: { balanceSeconds: 10 } });
  // 项目归属 C 才能走到余额检查（归属不通过会先 404），给 C 复制一份同构项目
  const projectC = await db.project.create({
    data: {
      userId: userC.id,
      title: "E2E-Translate-C",
      status: "READY",
      mediaKind: "video",
      videoKey: null,
      durationSec: 12,
    },
  });
  await db.transcript.create({
    data: { projectId: projectC.id, segments: SOURCE_SEGMENTS, llmPolished: true },
  });
  res = await jfetch(`${BASE}/api/projects/${projectC.id}/translations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieC },
    body: JSON.stringify({ targetLang: "en" }),
  });
  const body402 = await res.json();
  ok(res.status === 402 && body402.required === expectCost(CHAR_COUNT), "余额不足 → 402 且 required 正确");
  await db.user.update({ where: { id: userC.id }, data: { balanceSeconds: cBalanceBefore } });

  console.log("[阶段⑥] 真实翻译（英语，调用 DashScope）…");
  res = await jfetch(`${BASE}/api/projects/${project.id}/translations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieA },
    body: JSON.stringify({ targetLang: "en" }),
  });
  const created = await res.json();
  ok(res.status === 200 && created.taskId, "POST 创建翻译任务 → 200");
  ok(created.charCount === CHAR_COUNT && created.costSeconds === expectCost(CHAR_COUNT),
    `计费快照正确（charCount=${created.charCount}，costSeconds=${created.costSeconds}）`);

  const taskEn = await waitTranslationDone(cookieA, created.taskId);
  ok(taskEn.status === "DONE", "英语翻译完成（DONE）");

  // 计费落库：余额扣减 + 流水 + 站内通知
  const userAfter = await db.user.findUnique({ where: { id: userA.id } });
  ok(balanceBefore - userAfter.balanceSeconds === expectCost(CHAR_COUNT),
    `余额扣减正确（${balanceBefore} → ${userAfter.balanceSeconds}）`);
  const ledger = await db.creditLedger.findFirst({
    where: { userId: userA.id, reason: "CONSUME_TRANSLATE", refId: created.taskId },
  });
  ok(ledger?.changeSeconds === -expectCost(CHAR_COUNT), "额度流水 CONSUME_TRANSLATE 已写");
  const notif = await db.notification.findFirst({
    where: { userId: userA.id, type: "TRANSLATE_DONE" },
    orderBy: { createdAt: "desc" },
  });
  ok(Boolean(notif), "站内通知 TRANSLATE_DONE 已写");

  console.log("[阶段⑦] 三格式下载断言…");
  res = await jfetch(`${BASE}/api/translations/${created.taskId}/srt`, { headers: { Cookie: cookieA } });
  const srt = await res.text();
  ok(res.status === 200 && srt.includes("-->"), "SRT 下载 200 且含时间轴箭头");
  res = await jfetch(`${BASE}/api/translations/${created.taskId}/vtt`, { headers: { Cookie: cookieA } });
  const vtt = await res.text();
  ok(res.status === 200 && vtt.startsWith("WEBVTT"), "VTT 下载 200 且以 WEBVTT 开头");
  res = await jfetch(`${BASE}/api/translations/${created.taskId}/ass`, { headers: { Cookie: cookieA } });
  const ass = await res.text();
  ok(res.status === 200 && ass.includes("Style: Default,"), "ASS 下载 200 且含默认样式行");
  res = await jfetch(`${BASE}/api/translations/${created.taskId}/txt`, { headers: { Cookie: cookieA } });
  ok(res.status === 404, "非法格式 txt → 404");
  // 译文应为英语（源句不含英语时译文里不应再有大段中文）——宽松断言：含 SRT 结构 + 非空
  ok(srt.length > 50, `SRT 内容非空（${srt.length} 字节）`);

  console.log("[阶段⑧] 同语言进行中 409 + 状态查询/归属…");
  // 直连 DB 注入一条 PENDING（日语）任务 → POST 同语言应 409 且不触发 LLM
  const pending = await db.translation.create({
    data: { projectId: project.id, targetLang: "ja", status: "PENDING" },
  });
  res = await jfetch(`${BASE}/api/projects/${project.id}/translations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieA },
    body: JSON.stringify({ targetLang: "ja" }),
  });
  const body409 = await res.json();
  ok(res.status === 409 && body409.taskId === pending.id, "同语言进行中 → 409");

  res = await jfetch(`${BASE}/api/translations/${created.taskId}`, { headers: { Cookie: cookieA } });
  ok(res.status === 200 && (await res.json()).task.status === "DONE", "GET 翻译状态 → 200 DONE");

  // 未完成任务下载 → 409
  res = await jfetch(`${BASE}/api/translations/${pending.id}/srt`, { headers: { Cookie: cookieA } });
  ok(res.status === 409, "未完成任务下载 → 409");

  console.log("[阶段⑨] 第二语言（繁体）+ 列表…");
  res = await jfetch(`${BASE}/api/projects/${project.id}/translations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieA },
    body: JSON.stringify({ targetLang: "zh-TW" }),
  });
  const createdTw = await res.json();
  ok(res.status === 200 && createdTw.taskId, "繁体中文翻译创建 → 200");
  const taskTw = await waitTranslationDone(cookieA, createdTw.taskId);
  ok(taskTw.status === "DONE", "繁体翻译完成（DONE）");
  res = await jfetch(`${BASE}/api/projects/${project.id}/translations`, { headers: { Cookie: cookieA } });
  const listBody = await res.json();
  // 含阶段⑧注入的 PENDING 日语行：en / ja / zh-TW 三条并存
  const langs = listBody.translations.map((t) => t.targetLang).sort();
  ok(res.status === 200 && langs.join(",") === "en,ja,zh-TW", "列表含 en + ja(注入) + zh-TW 三个版本");

  console.log("[阶段⑩] 越权校验（用户 B）…");
  const cookieB = await login(PHONE_B);
  ok(true, `用户 B（${PHONE_B}）登录成功`);
  res = await jfetch(`${BASE}/api/translations/${created.taskId}`, { headers: { Cookie: cookieB } });
  ok(res.status === 404, "B 查询 A 的翻译任务 → 404");
  res = await jfetch(`${BASE}/api/translations/${created.taskId}/srt`, { headers: { Cookie: cookieB } });
  ok(res.status === 404, "B 下载 A 的翻译 → 404");
  res = await jfetch(`${BASE}/api/projects/${project.id}/translations`, { headers: { Cookie: cookieB } });
  ok(res.status === 404, "B 查询 A 的项目翻译列表 → 404");
  res = await jfetch(`${BASE}/api/projects/${project.id}/translations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieB },
    body: JSON.stringify({ targetLang: "ko" }),
  });
  ok(res.status === 404, "B 给 A 的项目发起翻译 → 404");

  console.log("[阶段⑪] 限流 429（借注入 PENDING 复用计数器，零 LLM 成本）…");
  // 已消耗 2 次（en / zh-TW），再打满剩余次数后应 429（409 响应同样消耗限流计数）
  let rateLimited = false;
  for (let i = 0; i < 12; i++) {
    res = await jfetch(`${BASE}/api/projects/${project.id}/translations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieA },
      body: JSON.stringify({ targetLang: "ja" }), // 撞 PENDING 行 → 409，不触发 LLM
    });
    if (res.status === 429) {
      rateLimited = true;
      break;
    }
  }
  ok(rateLimited, "翻译创建达到每小时 10 次上限 → 429");

  console.log("[阶段⑫] 清理…");
  await db.translation.deleteMany({ where: { projectId: { in: [project.id, projectC.id] } } });
  await db.project.deleteMany({ where: { id: { in: [project.id, projectC.id] } } });
  ok(true, "测试项目与翻译任务已清理（流水/通知保留供观察）");

  if (process.exitCode) {
    console.error("===== 存在失败断言 ❌ =====");
  } else {
    console.log("===== 结果：全部通过 🎉 P2.4 字幕翻译 E2E 完成 =====");
  }
}

main()
  .catch((e) => {
    console.error("E2E 异常终止：", e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
