/**
 * @file /api/exports/[id]/download — 下载导出成品
 * @description GET：仅 DONE 任务可下载。
 *              local 模式：流式输出文件，Content-Disposition 使用 RFC 5987 filename*
 *              编码中文文件名（整片：原视频名_字幕.mp4；片段：原视频名_片段_5-15s.mp4，
 *              音频片段为 .mp3）。
 *              oss   模式：302 跳转到签名 URL（10 分钟有效，response-content-disposition
 *              由 OSS 侧返回 attachment，下载流量直达 OSS 不经服务器）。
 */
import { NextResponse } from "next/server";
import fs from "node:fs";
import { Readable } from "node:stream";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { exportAbsPath, isOss } from "@/lib/storage";
import { presignGetUrl } from "@/lib/oss";
import { clipFileLabel } from "@/lib/export-pipeline";

/** oss 签名 URL 有效期（秒）：10 分钟，足够浏览器发起下载 */
const DOWNLOAD_URL_TTL_SEC = 10 * 60;

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
    include: { project: { select: { userId: true, title: true, videoName: true, mediaKind: true } } },
  });
  if (!task || task.project.userId !== user.id) {
    return NextResponse.json({ error: "任务不存在" }, { status: 404 });
  }
  if (task.status !== "DONE" || !task.outputKey) {
    return NextResponse.json({ error: "导出尚未完成，无法下载" }, { status: 409 });
  }

  // 下载文件名与 Content-Type：音频片段为 .mp3，其余为 .mp4
  const isAudioClip = task.startSec != null && task.endSec != null && task.project.mediaKind === "audio";
  const ext = isAudioClip ? "mp3" : "mp4";
  const contentType = isAudioClip ? "audio/mpeg" : "video/mp4";
  // 原媒体名去扩展名（无原名时退回项目标题）；整片带「_字幕」、片段带区间标签
  const baseName = (task.project.videoName ?? task.project.title).replace(/\.[^.]+$/, "");
  const kindSuffix = task.startSec != null && task.endSec != null
    ? `_片段_${clipFileLabel(task.startSec, task.endSec)}`
    : "_字幕";
  const fileName = `${baseName || "video"}${kindSuffix}.${ext}`;
  const encoded = encodeURIComponent(fileName);

  // oss 模式：授权后 302 到签名 URL，下载流量直达 OSS
  if (isOss()) {
    return new Response(null, {
      status: 302,
      headers: {
        Location: presignGetUrl(task.outputKey, DOWNLOAD_URL_TTL_SEC, "attachment", fileName),
        "Cache-Control": "private, no-store",
      },
    });
  }

  const absPath = exportAbsPath(task.outputKey);
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(absPath);
  } catch {
    return NextResponse.json({ error: "导出文件已丢失，请重新导出" }, { status: 410 });
  }

  const stream = Readable.toWeb(fs.createReadStream(absPath)) as ReadableStream;
  return new Response(stream, {
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(stat.size),
      // filename 兜底（老客户端）+ filename*（RFC 5987 中文文件名）
      "Content-Disposition": `attachment; filename="export_${task.id}.${ext}"; filename*=UTF-8''${encoded}`,
      "Cache-Control": "private, no-store",
    },
  });
}
