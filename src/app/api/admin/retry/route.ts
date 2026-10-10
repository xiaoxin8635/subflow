/**
 * @file /api/admin/retry — 管理员重试失败任务（P1.6 可观测性）
 * @description POST：仅 ADMIN_PHONES 白名单用户可调用（否则 404）。
 *              对终态 FAILED 的任务重新入队：
 *              - type=project：转写重跑（置 TRANSCRIBING → 转写队列）
 *              - type=export ：导出重跑（置 PENDING → 导出队列）
 *              先移除 BullMQ 中同 jobId 的旧 failed job（否则同 jobId 入队被忽略），
 *              重试次数随新 job 重置。非 FAILED 状态返回 409，记录不存在返回 404。
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { isAdminPhone } from "@/lib/admin";
import {
  TRANSCRIPT_QUEUE_NAME,
  EXPORT_QUEUE_NAME,
  removeQueueJob,
  enqueueTranscribe,
  enqueueExport,
} from "@/lib/queue/queues";

/**
 * 重试失败任务
 * @param request 请求体 { type: "project" | "export", id: string }
 */
export async function POST(request: Request): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user || !isAdminPhone(user.phone)) {
    return NextResponse.json({ error: "不存在" }, { status: 404 });
  }

  const body = (await request.json().catch(() => ({}))) as { type?: unknown; id?: unknown };
  const { type, id } = body;
  if ((type !== "project" && type !== "export") || typeof id !== "string" || !id) {
    return NextResponse.json({ error: "参数无效（需 type 与 id）" }, { status: 400 });
  }

  if (type === "project") {
    const project = await db.project.findUnique({ where: { id }, select: { id: true, userId: true, status: true } });
    if (!project) return NextResponse.json({ error: "项目不存在" }, { status: 404 });
    if (project.status !== "FAILED") {
      return NextResponse.json({ error: `项目状态为 ${project.status}，仅 FAILED 可重试` }, { status: 409 });
    }
    await db.project.update({ where: { id }, data: { status: "TRANSCRIBING", error: null } });
    await removeQueueJob(TRANSCRIPT_QUEUE_NAME, `transcribe-${id}`);
    const queued = await enqueueTranscribe(id, project.userId);
    if (!queued) return NextResponse.json({ error: "Redis 不可用，重试入队失败" }, { status: 503 });
    return NextResponse.json({ ok: true, status: "TRANSCRIBING" });
  }

  // type === "export"
  const task = await db.exportTask.findUnique({
    where: { id },
    select: { id: true, status: true, project: { select: { userId: true } } },
  });
  if (!task) return NextResponse.json({ error: "任务不存在" }, { status: 404 });
  if (task.status !== "FAILED") {
    return NextResponse.json({ error: `任务状态为 ${task.status}，仅 FAILED 可重试` }, { status: 409 });
  }
  await db.exportTask.update({
    where: { id },
    data: { status: "PENDING", error: null, finishedAt: null },
  });
  await removeQueueJob(EXPORT_QUEUE_NAME, `export-${id}`);
  const queued = await enqueueExport(id, task.project.userId);
  if (!queued) return NextResponse.json({ error: "Redis 不可用，重试入队失败" }, { status: 503 });
  return NextResponse.json({ ok: true, status: "PENDING" });
}
