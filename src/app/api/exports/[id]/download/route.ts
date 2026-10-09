/**
 * @file /api/exports/[id]/download — 下载导出成品
 * @description GET：仅 DONE 任务可下载；流式输出 mp4，Content-Disposition
 *              使用 RFC 5987 filename* 编码中文文件名（原视频名_字幕.mp4）。
 */
import { NextResponse } from "next/server";
import fs from "node:fs";
import { Readable } from "node:stream";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { exportAbsPath } from "@/lib/export-pipeline";

/**
 * 下载导出成品
 * @param _request 原始请求（未使用）
 * @param params   路由参数（Promise<{ id: string }>）
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });

  const { id } = await params;
  const task = await db.exportTask.findUnique({
    where: { id },
    include: { project: { select: { userId: true, title: true, videoName: true } } },
  });
  if (!task || task.project.userId !== user.id) {
    return NextResponse.json({ error: "任务不存在" }, { status: 404 });
  }
  if (task.status !== "DONE" || !task.outputKey) {
    return NextResponse.json({ error: "导出尚未完成，无法下载" }, { status: 409 });
  }

  const absPath = exportAbsPath(task.outputKey);
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(absPath);
  } catch {
    return NextResponse.json({ error: "导出文件已丢失，请重新导出" }, { status: 410 });
  }

  // 下载文件名：原视频名去扩展名 + "_字幕.mp4"（无原名时退回项目标题）
  const baseName = (task.project.videoName ?? task.project.title).replace(/\.[^.]+$/, "");
  const fileName = `${baseName || "video"}_字幕.mp4`;
  const encoded = encodeURIComponent(fileName);

  const stream = Readable.toWeb(fs.createReadStream(absPath)) as ReadableStream;
  return new Response(stream, {
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": String(stat.size),
      // filename 兜底（老客户端）+ filename*（RFC 5987 中文文件名）
      "Content-Disposition": `attachment; filename="export_${task.id}.mp4"; filename*=UTF-8''${encoded}`,
      "Cache-Control": "private, no-store",
    },
  });
}
