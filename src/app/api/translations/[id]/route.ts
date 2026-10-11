/**
 * @file /api/translations/[id] — 翻译任务状态查询（P2.4）
 * @description GET：单个翻译任务的状态轮询（前端翻译卡 2-3 秒轮询推进状态机）。
 *              本人校验：非本人/不存在统一 404（防任务 ID 探测）。
 *              响应不含 segments 大字段（下载走 /api/translations/[id]/[format]）。
 * 说明：Next.js 15+ 动态路由参数为 Promise，必须 await；
 *      Cache Components 模式下禁止 export const runtime 路由配置。
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

/**
 * 查询翻译任务状态
 * @param params 路由参数（Promise<{ id: string }>）
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });

  const { id } = await params;
  const task = await db.translation.findUnique({
    where: { id },
    include: { project: { select: { userId: true } } },
  });
  if (!task || task.project.userId !== user.id) {
    return NextResponse.json({ error: "翻译任务不存在" }, { status: 404 });
  }

  return NextResponse.json({
    task: {
      id: task.id,
      projectId: task.projectId,
      targetLang: task.targetLang,
      status: task.status,
      charCount: task.charCount,
      costSeconds: task.costSeconds,
      error: task.error,
      createdAt: task.createdAt,
      finishedAt: task.finishedAt,
    },
  });
}
