// =====================================================================
// SubFlow E2E — P2.2 自定义样式保存专项
// 覆盖：未登录 401 → 登录 → 模板 CRUD（创建/列表/删除/上限/越权/非法配置）
//       → 直连 DB 造 READY 项目（零 ASR 费用）→ 用「我的模板」创建导出
//       → 烧录 DONE → 下载成片 → ffprobe 校验 → 删除模板后再导出被拒（快照独立性）
//       → 显式 styleConfig（微调所见即所得）→ ASS 下载带 userStyleId
// 前提：生产或 dev server 已启动（进程内 Worker 开启）、Postgres/Redis 运行中。
// 运行：node scripts/e2e-user-style-test.mjs   （全程不调用 DashScope）
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

const db = new PrismaClient();

/** 断言辅助 */
function ok(cond, label) {
  if (cond) {
    console.log(`✅ ${label}`);
  } else {
    console.error(`❌ ${label}`);
    process.exitCode = 1;
    // 收集失败后继续跑完便于观察，但最终以非零退出
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
 * @returns 终态状态（DONE / FAILED）
 */
async function waitExportDone(cookie, taskId) {
  for (let i = 0; i < 90; i++) {
    const res = await jfetch(`${BASE}/api/exports/${taskId}`, { headers: { Cookie: cookie } });
    if (res.ok) {
      const body = await res.json();
      if (body.task.status === "DONE") return "DONE";
      if (body.task.status === "FAILED") {
        console.error(`  任务失败原因：${body.task.error}`);
        return "FAILED";
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return "TIMEOUT";
}

/** ffprobe 读取媒体时长（秒） */
function probeDuration(file) {
  const r = spawnSync(ffprobeStatic.path, [
    "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file,
  ]);
  if (r.status !== 0) return null;
  return Number(r.stdout.toString().trim());
}

/** 一份合法样式配置（可覆盖字段） */
function validConfig(patch = {}) {
  return {
    fontFamily: "Noto Sans SC",
    fontSize: 6,
    primaryColor: "#ffee00",
    outlineColor: "#000000",
    outlineWidth: 3,
    position: "bottom",
    marginV: 120,
    highlight: "#ff0000",
    ...patch,
  };
}

async function main() {
  console.log("[阶段①] 未登录访问…");
  let res = await jfetch(`${BASE}/api/user-styles`);
  ok(res.status === 401, "未登录 GET /api/user-styles → 401");
  res = await jfetch(`${BASE}/api/user-styles`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "x", config: validConfig() }),
  });
  ok(res.status === 401, "未登录 POST /api/user-styles → 401");

  console.log("[阶段②] 登录…");
  const cookieA = await login(PHONE_A);
  ok(true, `用户 A（${PHONE_A}）登录成功`);
  const userA = await db.user.findUnique({ where: { phone: PHONE_A } });

  console.log("[阶段③] 参数与配置校验…");
  res = await jfetch(`${BASE}/api/user-styles`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieA },
    body: JSON.stringify({ name: "", config: validConfig() }),
  });
  ok(res.status === 400, "空模板名 → 400");
  res = await jfetch(`${BASE}/api/user-styles`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieA },
    body: JSON.stringify({ name: "超长模板名超长模板名超长模板名超长模板名超长模板名x", config: validConfig() }),
  });
  ok(res.status === 400, "超长模板名 → 400");
  res = await jfetch(`${BASE}/api/user-styles`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieA },
    body: JSON.stringify({ name: "坏字号", config: validConfig({ fontSize: 99 }) }),
  });
  ok(res.status === 400, "fontSize 超范围 → 400");
  res = await jfetch(`${BASE}/api/user-styles`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieA },
    body: JSON.stringify({ name: "坏颜色", config: validConfig({ primaryColor: "red" }) }),
  });
  ok(res.status === 400, "primaryColor 非法 → 400");
  res = await jfetch(`${BASE}/api/user-styles`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieA },
    body: JSON.stringify({ name: "坏字体", config: validConfig({ fontFamily: 'Noto"; Evil' }) }),
  });
  ok(res.status === 400, "fontFamily 含特殊字符（ASS 注入）→ 400");

  console.log("[阶段④] 创建/列表/删除…");
  res = await jfetch(`${BASE}/api/user-styles`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieA },
    body: JSON.stringify({ name: "E2E模板A1", config: validConfig() }),
  });
  const created = await res.json();
  ok(res.status === 201 && created.style?.id, "创建合法模板 → 201");
  const styleA1 = created.style.id;

  res = await jfetch(`${BASE}/api/user-styles`, { headers: { Cookie: cookieA } });
  const listBody = await res.json();
  ok(
    res.status === 200 && Array.isArray(listBody.styles) && listBody.styles.some((s) => s.id === styleA1),
    "GET 列表包含新模板",
  );

  // 数量上限：循环创建直到被拒（手机号复用时已有存量也兼容）
  let limitHit = false;
  const createdIds = [styleA1];
  for (let i = 0; i < 25; i++) {
    const r = await jfetch(`${BASE}/api/user-styles`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieA },
      body: JSON.stringify({ name: `上限测试${i}`, config: validConfig() }),
    });
    if (r.status === 400) {
      const b = await r.json();
      limitHit = (b.error ?? "").includes("最多");
      break;
    }
    createdIds.push((await r.json()).style.id);
  }
  ok(limitHit, "模板数量达到 20 上限 → 400 提示");
  // 清理除 styleA1 外的所有模板，回到干净状态
  for (const id of createdIds) {
    if (id !== styleA1) {
      await jfetch(`${BASE}/api/user-styles/${id}`, { method: "DELETE", headers: { Cookie: cookieA } });
    }
  }

  console.log("[阶段⑤] 直连 DB 造 READY 项目（零 ASR 费用）…");
  const videoKey = `e2e-us-${Date.now()}.mp4`;
  fs.copyFileSync(
    path.join(process.cwd(), "test-media", "demo-video.mp4"),
    path.join(process.cwd(), UPLOAD_DIR, videoKey),
  );
  const project = await db.project.create({
    data: {
      userId: userA.id,
      title: "E2E-UserStyle",
      status: "READY",
      mediaKind: "video",
      videoKey,
      durationSec: 35,
    },
  });
  await db.transcript.create({
    data: {
      projectId: project.id,
      segments: [
        { start: 0.5, end: 3.5, text: "自定义样式测试第一句", keywords: ["自定义"] },
        { start: 4, end: 7, text: "第二句验证我的模板烧录效果", keywords: [] },
      ],
      llmPolished: true,
    },
  });
  ok(true, `READY 项目已建（${project.id}）`);

  console.log("[阶段⑥] 用我的模板创建导出并烧录…");
  res = await jfetch(`${BASE}/api/projects/${project.id}/exports`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieA },
    body: JSON.stringify({ userStyleId: styleA1 }),
  });
  const exp1 = await res.json();
  ok(res.status === 200 && exp1.taskId, "userStyleId 创建导出 → 200");
  const st1 = await waitExportDone(cookieA, exp1.taskId);
  ok(st1 === "DONE", "导出任务烧录完成（DONE）");

  res = await jfetch(`${BASE}/api/exports/${exp1.taskId}/download`, { headers: { Cookie: cookieA } });
  const buf1 = Buffer.from(await res.arrayBuffer());
  const out1 = path.join(process.cwd(), UPLOAD_DIR, "e2e-us-check-1.mp4");
  fs.writeFileSync(out1, buf1);
  const dur1 = probeDuration(out1);
  ok(res.status === 200 && buf1.length > 100 * 1024, "成片下载 200 且体积合理");
  ok(dur1 != null && Math.abs(dur1 - 35) < 3, `ffprobe 时长 ≈35s（实测 ${dur1?.toFixed(1)}s）`);

  console.log("[阶段⑦] 样式快照独立性 + 显式 styleConfig…");
  res = await jfetch(`${BASE}/api/user-styles/${styleA1}`, {
    method: "DELETE",
    headers: { Cookie: cookieA },
  });
  ok(res.status === 200, "删除我的模板 → 200");
  res = await jfetch(`${BASE}/api/projects/${project.id}/exports`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieA },
    body: JSON.stringify({ userStyleId: styleA1 }),
  });
  ok(res.status === 400, "已删除模板再建导出 → 400（模板引用实时校验）");

  // 微调样式随请求提交（不落模板库，所见即所得）
  res = await jfetch(`${BASE}/api/projects/${project.id}/exports`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieA },
    body: JSON.stringify({ styleConfig: validConfig({ fontSize: 8, position: "top", marginV: 60 }) }),
  });
  ok(res.status === 400, "缺少样式标识（仅 styleConfig）→ 400");

  res = await jfetch(`${BASE}/api/styles`, { headers: { Cookie: cookieA } });
  const official = (await res.json()).styles;
  const officialId = official.find((s) => s.isDefault)?.id ?? official[0]?.id;
  res = await jfetch(`${BASE}/api/projects/${project.id}/exports`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieA },
    body: JSON.stringify({
      styleId: officialId,
      styleConfig: validConfig({ fontSize: 99 }),
    }),
  });
  ok(res.status === 400, "显式 styleConfig 非法值 → 400");

  res = await jfetch(`${BASE}/api/projects/${project.id}/exports`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieA },
    body: JSON.stringify({
      styleId: officialId,
      styleConfig: validConfig({ fontSize: 8, position: "top", marginV: 60 }),
    }),
  });
  const exp2 = await res.json();
  ok(res.status === 200 && exp2.taskId, "官方模板 + 微调 styleConfig 创建导出 → 200");
  const st2 = await waitExportDone(cookieA, exp2.taskId);
  ok(st2 === "DONE", "微调样式烧录完成（DONE，快照生效）");

  console.log("[阶段⑧] ASS 下载带我的模板…");
  res = await jfetch(`${BASE}/api/user-styles`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieA },
    body: JSON.stringify({ name: "E2E模板A2", config: validConfig({ fontSize: 8 }) }),
  });
  const styleA2 = (await res.json()).style.id;
  res = await jfetch(
    `${BASE}/api/projects/${project.id}/ass?userStyleId=${styleA2}`,
    { headers: { Cookie: cookieA } },
  );
  const assText = await res.text();
  ok(res.status === 200 && assText.includes("Style: Default,"), "ASS 下载（userStyleId）→ 200");
  ok(assText.includes("Style: Default,Noto Sans SC,86,"), "ASS 按模板字号编译（8% → 86px）");
  res = await jfetch(
    `${BASE}/api/projects/${project.id}/ass?userStyleId=${styleA1}`,
    { headers: { Cookie: cookieA } },
  );
  ok(res.status === 400, "ASS 下载引用已删模板 → 400");

  console.log("[阶段⑨] 越权校验（用户 B）…");
  const cookieB = await login(PHONE_B);
  ok(true, `用户 B（${PHONE_B}）登录成功`);
  res = await jfetch(`${BASE}/api/user-styles/${styleA2}`, {
    method: "DELETE",
    headers: { Cookie: cookieB },
  });
  ok(res.status === 404, "B 删除 A 的模板 → 404");
  res = await jfetch(`${BASE}/api/projects/${project.id}/exports`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieB },
    body: JSON.stringify({ userStyleId: styleA2 }),
  });
  ok(res.status === 404, "B 访问 A 的项目导出 → 404（项目归属优先）");

  console.log("[阶段⑩] 清理…");
  await jfetch(`${BASE}/api/projects/${project.id}`, { method: "DELETE", headers: { Cookie: cookieA } });
  await jfetch(`${BASE}/api/user-styles/${styleA2}`, { method: "DELETE", headers: { Cookie: cookieA } });
  fs.unlinkSync(out1);
  console.log("  已删除测试项目/模板/临时文件");

  if (process.exitCode) {
    console.error("===== 存在失败断言 ❌ =====");
  } else {
    console.log("===== 结果：全部通过 🎉 P2.2 自定义样式 E2E 完成 =====");
  }
}

main()
  .catch((e) => {
    console.error("E2E 异常终止：", e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
