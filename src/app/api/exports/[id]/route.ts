/**
 * @file /api/exports/[id] — 导出任务状态查询
 * @description GET：返回导出任务状态（PENDING/PROCESSING/DONE/FAILED）、费用与错误信息。
 *              前端导出卡片轮询此接口直至终态。仅任务所属项目的所有者可查。
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

/**
 * 查询导出任务状态
 * @param _request 原始请求（未使用）
 * @param params   路由参数（Promise<{ id: string }>）
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });

  const { id } = await params;
  const task = await db.exportTask.findUnique({
    where: { id },
    include: { project: { select: { userId: true, title: true, durationSec: true } } },
  });
  // 不存在或非本人：统一 404
  if (!task || task.project.userId !== user.id) {
    return NextResponse.json({ error: "任务不存在" }, { status: 404 });
  }

  return NextResponse.json({
    task: {
      id: task.id,
      status: task.status,
      error: task.error,
      outputKey: task.outputKey,
      resolution: task.resolution,
      // 片段导出（P2.6）：起止秒；整片导出为 null
      startSec: task.startSec,
      endSec: task.endSec,
      createdAt: task.createdAt,
      finishedAt: task.finishedAt,
      projectTitle: task.project.title,
    },
  });
}
