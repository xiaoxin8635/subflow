/**
 * @file /api/projects/[id] — 项目详情接口
 * @description
 *   GET：项目详情（READY 时附带转写分段）；仅本人可见，不存在/非本人统一返回 404。
 *   DELETE：删除项目（级联删除转写记录，同时清理当前驱动下的源视频与导出产物）。
 * 说明：Next.js 15+ 动态路由参数为 Promise，必须 await。
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { removeVideo, removeExportArtifact } from "@/lib/storage";

/**
 * 查询项目详情（含转写结果）
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
  const project = await db.project.findUnique({
    where: { id },
    include: { transcript: true },
  });
  // 不存在或非本人：统一 404，避免探测他人项目 ID
  if (!project || project.userId !== user.id) {
    return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  }

  return NextResponse.json({
    project: {
      id: project.id,
      title: project.title,
      status: project.status,
      durationSec: project.durationSec,
      error: project.error,
      videoName: project.videoName,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      transcript: project.transcript
        ? {
            segments: project.transcript.segments,
            rawText: project.transcript.rawText,
            asrProvider: project.transcript.asrProvider,
            llmPolished: project.transcript.llmPolished,
          }
        : null,
    },
  });
}

/**
 * 删除项目（级联删转写记录 + 清理当前驱动下的源视频与导出产物）
 * @param _request 原始请求（未使用）
 * @param params   路由参数（Promise<{ id: string }>）
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });

  const { id } = await params;
  const project = await db.project.findUnique({ where: { id } });
  if (!project || project.userId !== user.id) {
    return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  }

  // 存储对象先收集：导出产物（exports/{taskId}.mp4）与源视频
  const exportFiles = await db.exportTask.findMany({
    where: { projectId: id, outputKey: { not: null } },
    select: { outputKey: true },
  });

  await db.project.delete({ where: { id } }); // transcript/exportTask 由 onDelete: Cascade 级联删除
  // 级联删除不会清理存储对象，这里逐个删除防孤儿文件（含 oss 模式的本地缓存副本）
  if (project.videoKey) await removeVideo(project.videoKey);
  await Promise.all(exportFiles.map((t) => removeExportArtifact(t.outputKey!)));

  return NextResponse.json({ ok: true });
}
