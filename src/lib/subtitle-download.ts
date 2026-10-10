/**
 * @file 字幕文件下载共享逻辑（P1.4 多格式导出）
 * @description SRT/VTT/ASS 三个下载接口共用的鉴权、项目加载与分段校验；
 *              统一错误语义：未登录 401、不存在/非本人 404（防项目 ID 探测）、
 *              未完成转写或无字幕内容 409。
 */
import { db } from "@/lib/db";
import type { StoredSegment } from "@/lib/asr/types";

/** 校验结果：成功携带项目与合法分段 */
export type LoadedSubtitles =
  | { ok: true; title: string; segments: StoredSegment[] }
  | { ok: false; status: 401 | 404 | 409; error: string };

/**
 * 加载当前用户项目的字幕分段（三个字幕下载接口共用）
 * @param projectId 项目 ID
 * @param userId    当前登录用户 ID
 */
export async function loadOwnedProjectSegments(
  projectId: string,
  userId: string | null,
): Promise<LoadedSubtitles> {
  if (!userId) return { ok: false, status: 401, error: "未登录" };

  const project = await db.project.findUnique({
    where: { id: projectId },
    include: { transcript: true },
  });
  // 不存在或非本人：统一 404，避免探测他人项目 ID
  if (!project || project.userId !== userId) {
    return { ok: false, status: 404, error: "项目不存在" };
  }
  if (!project.transcript) {
    return { ok: false, status: 409, error: "项目尚未完成转写" };
  }

  const segments = Array.isArray(project.transcript.segments)
    ? (project.transcript.segments as StoredSegment[])
    : [];
  if (segments.length === 0) {
    return { ok: false, status: 409, error: "项目没有字幕内容" };
  }
  return { ok: true, title: project.title || "subtitles", segments };
}

/**
 * 构造附件下载响应（文件名 = 项目名 + 扩展名，RFC 5987 中文编码）
 * @param body     文件内容文本
 * @param title    项目名（作为下载文件名）
 * @param ext      扩展名（如 "srt" / "vtt" / "ass"）
 * @param mimeType Content-Type（含 charset=utf-8）
 */
export function subtitleAttachment(body: string, title: string, ext: string, mimeType: string): Response {
  const filename = encodeURIComponent(`${title}.${ext}`);
  return new Response(body, {
    headers: {
      "Content-Type": `${mimeType}; charset=utf-8`,
      "Content-Disposition": `attachment; filename="subtitles.${ext}"; filename*=UTF-8''${filename}`,
      "Cache-Control": "no-store",
    },
  });
}
