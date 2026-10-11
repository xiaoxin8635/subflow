/**
 * @file /api/projects/[id]/exports — 创建导出任务（整片烧录 / 片段裁剪导出）
 * @description POST：为 READY 项目创建 FFmpeg 导出任务（异步执行）。
 *              请求体：{ styleId?, userStyleId?, styleConfig?, startSec?, endSec? }——
 *              样式标识二选一（官方模板 / 我的模板，本人校验）；styleConfig 可选，
 *              提供时以它为准（编辑器实时预览所见即所得），否则按所选模板的库内配置。
 *              startSec/endSec 同时提供时为片段导出（P2.6）：视频项目裁剪+烧录，
 *              音频项目纯裁剪（无样式语义，样式参数忽略）；缺省为整片烧录。
 *              targetLang 可选（P2.7 双语字幕）：提供时按「原文+译文」双语烧录
 *              （原文在上、译文在下），仅视频项目可用；该语言翻译必须已完成。
 *              最终配置以快照写入任务（styleConfig 列），烧录与模板后续删改解耦。
 *              校验链：登录 → 限流 → 片段参数形状 → targetLang 形状 → 项目归属 →
 *              状态就绪 → 片段区间合法 → 音频双语拦截 → 音频整片拦截 → 样式合法
 *              （音频片段跳过）→ 译文已完成（双语时）→ 余额预检（402）→
 *              无进行中任务（409）。创建后 fire-and-forget 启动流水线。
 * 说明：Next.js 15+ 动态路由参数为 Promise，必须 await；
 *      Cache Components 模式下禁止 export const runtime 路由配置。
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { startExport } from "@/lib/export-pipeline";
import { rateLimit } from "@/lib/rate-limit";
import { parseStyleConfig, validateStyleConfigInput } from "@/lib/style-config";
import { clipCostSeconds } from "@/lib/constants";
import type { StyleConfig } from "@/lib/style-config";

/**
 * 创建导出任务
 * @param request 请求体 { styleId?, userStyleId?, styleConfig?, startSec?, endSec?, targetLang? }
 * @param params  路由参数（Promise<{ id: string }>）
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });

  // 限流：每用户每小时最多 20 次导出创建（FFmpeg 吃 CPU，防刷）
  const rl = await rateLimit(request, "export", user.id, 20, 60 * 60 * 1000);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "导出操作过于频繁，请稍后再试" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
    );
  }

  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as {
    styleId?: unknown;
    userStyleId?: unknown;
    styleConfig?: unknown;
    startSec?: unknown;
    endSec?: unknown;
    targetLang?: unknown;
  };
  const styleId = typeof body.styleId === "string" ? body.styleId : "";
  const userStyleId = typeof body.userStyleId === "string" ? body.userStyleId : "";
  // 双语字幕（P2.7）：targetLang 提供时须为非空字符串（语言合法性在项目归属后校验）
  let targetLang: string | null = null;
  if (body.targetLang !== undefined && body.targetLang !== null && body.targetLang !== "") {
    if (typeof body.targetLang !== "string" || !body.targetLang.trim()) {
      return NextResponse.json({ error: "targetLang 必须是语言代码字符串" }, { status: 400 });
    }
    targetLang = body.targetLang.trim();
  }

  // 片段参数（P2.6）：startSec/endSec 必须成对出现；形状校验先于项目归属（与语言白名单约定一致）
  const hasStart = body.startSec !== undefined;
  const hasEnd = body.endSec !== undefined;
  if (hasStart !== hasEnd) {
    return NextResponse.json({ error: "startSec 与 endSec 必须同时提供" }, { status: 400 });
  }
  const isClip = hasStart;
  let startSec = 0;
  let endSec = 0;
  if (isClip) {
    if (typeof body.startSec !== "number" || !Number.isFinite(body.startSec) ||
        typeof body.endSec !== "number" || !Number.isFinite(body.endSec)) {
      return NextResponse.json({ error: "startSec/endSec 必须是数字" }, { status: 400 });
    }
    startSec = body.startSec;
    endSec = body.endSec;
    if (startSec < 0) {
      return NextResponse.json({ error: "startSec 不能为负数" }, { status: 400 });
    }
    if (endSec <= startSec) {
      return NextResponse.json({ error: "endSec 必须大于 startSec" }, { status: 400 });
    }
  }

  // 项目归属 + 就绪校验（不存在/非本人统一 404）
  const project = await db.project.findUnique({
    where: { id },
    include: { transcript: { select: { projectId: true } } },
  });
  if (!project || project.userId !== user.id) {
    return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  }
  if (project.status !== "READY" || !project.transcript || project.durationSec == null) {
    return NextResponse.json({ error: "项目未就绪或没有转写结果" }, { status: 400 });
  }
  // 片段区间须落在媒体时长内
  if (isClip && endSec > project.durationSec) {
    return NextResponse.json(
      { error: `endSec（${endSec}s）超出媒体时长（${project.durationSec}s）` },
      { status: 400 },
    );
  }
  // 双语（P2.7）仅对视频烧录有意义；音频项目携带 targetLang 直接拒绝（先于整片拦截，报因更精准）
  if (project.mediaKind === "audio" && targetLang) {
    return NextResponse.json({ error: "音频项目不支持双语烧录" }, { status: 400 });
  }
  // 纯音频项目：整片无烧录语义仍拒绝；片段裁剪放行（纯裁剪无样式语义，样式参数忽略）
  if (project.mediaKind === "audio" && !isClip) {
    return NextResponse.json({ error: "音频项目不支持整片烧录成片，请使用字幕文件下载（SRT/VTT/ASS）或片段裁剪导出" }, { status: 400 });
  }
  // 视频任务（整片/片段烧录）必须选样式；音频片段无样式语义
  const audioClip = isClip && project.mediaKind === "audio";
  if (!audioClip && !styleId && !userStyleId) {
    return NextResponse.json({ error: "缺少 styleId 或 userStyleId" }, { status: 400 });
  }
  // 双语：目标语言的翻译必须已完成（译文行与原文索引对齐是 P2.4 的产物契约）
  if (targetLang) {
    const translation = await db.translation.findUnique({
      where: { projectId_targetLang: { projectId: id, targetLang } },
      select: { status: true },
    });
    if (!translation || translation.status !== "DONE") {
      return NextResponse.json(
        { error: `「${targetLang}」翻译尚未完成，请先在翻译卡完成该语言翻译` },
        { status: 400 },
      );
    }
  }

  // 样式解析：官方模板（styleId）或我的模板（userStyleId，本人校验）二选一；音频片段跳过
  let taskStyleId: string | null = null;
  let resolvedConfig: StyleConfig | null = null;
  if (!audioClip) {
    if (styleId) {
      const style = await db.style.findUnique({ where: { id: styleId } });
      if (!style) return NextResponse.json({ error: "字幕样式不存在" }, { status: 400 });
      taskStyleId = styleId;
      resolvedConfig = parseStyleConfig(style.config);
    } else {
      const userStyle = await db.userStyle.findUnique({ where: { id: userStyleId } });
      if (!userStyle || userStyle.userId !== user.id) {
        return NextResponse.json({ error: "字幕样式不存在" }, { status: 400 });
      }
      resolvedConfig = parseStyleConfig(userStyle.config);
    }
    if (!resolvedConfig) return NextResponse.json({ error: "字幕样式配置异常" }, { status: 400 });

    // 显式携带 styleConfig 时以它为准（编辑器当前预览的微调结果，所见即所得）
    if (body.styleConfig !== undefined) {
      const checked = validateStyleConfigInput(body.styleConfig);
      if (!checked.ok) {
        return NextResponse.json({ error: `样式配置无效：${checked.error}` }, { status: 400 });
      }
      resolvedConfig = checked.config;
    }
  }

  // 余额预检：整片按视频时长、片段按片段时长（均向上取整为秒）扣费
  const costSeconds = isClip ? clipCostSeconds(startSec, endSec) : Math.ceil(project.durationSec);
  if (user.balanceSeconds < costSeconds) {
    return NextResponse.json(
      {
        error: `额度不足：本次导出需 ${costSeconds} 秒，当前余额 ${user.balanceSeconds} 秒`,
        required: costSeconds,
        balance: user.balanceSeconds,
      },
      { status: 402 },
    );
  }

  // 防并发：同一项目已有排队/执行中的任务则拒绝
  const inFlight = await db.exportTask.findFirst({
    where: { projectId: id, status: { in: ["PENDING", "PROCESSING"] } },
  });
  if (inFlight) {
    return NextResponse.json({ error: "该项目已有导出任务进行中，请稍候", taskId: inFlight.id }, { status: 409 });
  }

  const task = await db.exportTask.create({
    data: {
      projectId: id,
      styleId: taskStyleId,
      // 样式快照：烧录以快照为准，模板后续被删/改不影响本任务（音频片段无样式语义，不写入）
      ...(resolvedConfig ? { styleConfig: resolvedConfig } : {}),
      resolution: "original",
      ...(isClip ? { startSec, endSec } : {}),
      ...(targetLang ? { targetLang } : {}),
    },
  });
  void startExport(task.id, user.id);

  return NextResponse.json({
    taskId: task.id,
    costSeconds,
    balanceSeconds: user.balanceSeconds,
  });
}
