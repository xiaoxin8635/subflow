/**
 * @file /api/translations/[id]/[format] — 翻译结果字幕文件下载（P2.4）
 * @description 将已完成的翻译结果下载为 SRT / VTT / ASS 三格式字幕文件
 *              （文件名 = 项目名.语言代码.扩展名）。校验链：格式白名单（404）→
 *              登录 → 任务归属（不存在/非本人统一 404）→ 任务已完成（409）→
 *              分段非空（409）。纯文本生成不扣额度。
 *              ASS 使用系统默认样式（译文无中文关键词，高亮不适用；
 *              样式自定义后续按需扩展）。
 * 说明：Next.js 15+ 动态路由参数为 Promise，必须 await；
 *      Cache Components 模式下禁止 export const runtime 路由配置。
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { buildSrt } from "@/lib/srt";
import { buildVtt } from "@/lib/vtt";
import { buildAss, DEFAULT_ASS_CONFIG } from "@/lib/ass";
import { subtitleAttachment } from "@/lib/subtitle-download";
import type { TranslatedSegment } from "@/lib/translate-pipeline";

/** 支持的下载格式 → MIME 映射（SRT 带 BOM 由路由层拼装，防 Windows 记事本乱码） */
const FORMAT_MIME: Record<string, string> = {
  srt: "application/x-subrip",
  vtt: "text/vtt",
  ass: "text/x-ssa",
};

/**
 * 下载翻译结果字幕文件
 * @param params 路由参数（Promise<{ id: string; format: string }>）
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; format: string }> },
): Promise<Response> {
  const { id, format } = await params;
  const mimeType = FORMAT_MIME[format];
  if (!mimeType) {
    return NextResponse.json({ error: "不支持的格式" }, { status: 404 });
  }

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });

  const task = await db.translation.findUnique({
    where: { id },
    include: { project: { select: { userId: true, title: true } } },
  });
  // 不存在或非本人：统一 404，避免探测他人任务 ID
  if (!task || task.project.userId !== user.id) {
    return NextResponse.json({ error: "翻译任务不存在" }, { status: 404 });
  }
  if (task.status !== "DONE" || !task.segments) {
    return NextResponse.json({ error: "翻译尚未完成" }, { status: 409 });
  }
  const segments = Array.isArray(task.segments)
    ? (task.segments as TranslatedSegment[])
    : [];
  if (segments.length === 0) {
    return NextResponse.json({ error: "翻译内容为空" }, { status: 409 });
  }

  const filename = `${task.project.title || "subtitles"}.${task.targetLang}`;
  if (format === "srt") {
    // BOM 前缀：Windows 记事本/剪映识别 UTF-8 依赖它
    return subtitleAttachment("﻿" + buildSrt(segments), filename, "srt", mimeType);
  }
  if (format === "vtt") {
    return subtitleAttachment(buildVtt(segments), filename, "vtt", mimeType);
  }
  // ASS：系统默认样式（译文不保留中文关键词，高亮不适用）
  return subtitleAttachment(buildAss(DEFAULT_ASS_CONFIG, segments), filename, "ass", mimeType);
}
