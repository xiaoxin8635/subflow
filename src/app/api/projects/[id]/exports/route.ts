/**
 * @file /api/projects/[id]/exports — 创建导出任务
 * @description POST：为 READY 项目创建 FFmpeg 烧录导出任务（异步执行）。
 *              请求体：{ styleId?, userStyleId?, styleConfig? }——样式标识二选一
 *              （官方模板 / 我的模板，本人校验）；styleConfig 可选，提供时以它为准
 *              （编辑器实时预览所见即所得），否则按所选模板的库内配置。
 *              最终配置以快照写入任务（styleConfig 列），烧录与模板后续删改解耦。
 *              校验链：登录 → 项目归属 → 状态就绪 → 样式合法 → 余额预检（402）
 *              → 无进行中任务（409）。创建后 fire-and-forget 启动流水线。
 * 说明：Next.js 15+ 动态路由参数为 Promise，必须 await；
 *      Cache Components 模式下禁止 export const runtime 路由配置。
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { startExport } from "@/lib/export-pipeline";
import { rateLimit } from "@/lib/rate-limit";
import { parseStyleConfig, validateStyleConfigInput } from "@/lib/style-config";
import type { StyleConfig } from "@/lib/style-config";

/**
 * 创建导出任务
 * @param request 请求体 { styleId?, userStyleId?, styleConfig? }（样式标识 styleId / userStyleId 二选一）
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
  };
  const styleId = typeof body.styleId === "string" ? body.styleId : "";
  const userStyleId = typeof body.userStyleId === "string" ? body.userStyleId : "";
  if (!styleId && !userStyleId) {
    return NextResponse.json({ error: "缺少 styleId 或 userStyleId" }, { status: 400 });
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
  // 纯音频项目无画面可烧录：只提供字幕文件下载（前端同步隐藏成片导出入口）
  if (project.mediaKind === "audio") {
    return NextResponse.json({ error: "音频项目不支持烧录成片，请使用字幕文件下载（SRT/VTT/ASS）" }, { status: 400 });
  }

  // 样式解析：官方模板（styleId）或我的模板（userStyleId，本人校验）二选一
  let taskStyleId: string | null = null;
  let resolvedConfig: StyleConfig | null = null;
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

  // 余额预检：导出按视频时长（向上取整为秒）扣费
  const costSeconds = Math.ceil(project.durationSec);
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
      // 样式快照：烧录以快照为准，模板后续被删/改不影响本任务
      styleConfig: resolvedConfig,
      resolution: "original",
    },
  });
  void startExport(task.id, user.id);

  return NextResponse.json({
    taskId: task.id,
    costSeconds,
    balanceSeconds: user.balanceSeconds,
  });
}
