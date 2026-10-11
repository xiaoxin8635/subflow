/**
 * @file /api/translations/[id]/[format] — 翻译结果字幕文件下载（P2.4，双语扩展 P2.7）
 * @description 将已完成的翻译结果下载为 SRT / VTT / ASS 三格式字幕文件
 *              （文件名 = 项目名.语言代码.扩展名）。校验链：格式白名单（404）→
 *              登录 → 任务归属（不存在/非本人统一 404）→ 任务已完成（409）→
 *              分段非空（409）。纯文本生成不扣额度。
 *              ASS 使用系统默认样式（译文无中文关键词，高亮不适用；
 *              样式自定义后续按需扩展）。
 *              双语下载（P2.7）：`?bilingual=1` 时每条字幕为「原文在上、译文在下」
 *              双行——读取项目 Transcript.segments 与译文按索引逐行合并
 *              （P2.4 保证行数/时间轴一致），文件名追加「双语」与语言代码标识。
 * 说明：Next.js 15+ 动态路由参数为 Promise，必须 await；
 *      Cache Components 模式下禁止 export const runtime 路由配置。
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { buildSrt } from "@/lib/srt";
import { buildVtt } from "@/lib/vtt";
import { buildAss, buildBilingualAss, DEFAULT_ASS_CONFIG } from "@/lib/ass";
import { subtitleAttachment } from "@/lib/subtitle-download";
import type { StoredSegment } from "@/lib/asr/types";
import type { TranslatedSegment } from "@/lib/translate-pipeline";

/** 支持的下载格式 → MIME 映射（SRT 带 BOM 由路由层拼装，防 Windows 记事本乱码） */
const FORMAT_MIME: Record<string, string> = {
  srt: "application/x-subrip",
  vtt: "text/vtt",
  ass: "text/x-ssa",
};

/**
 * 下载翻译结果字幕文件
 * @param request 原始请求（双语开关走 `?bilingual=1` 查询参数）
 * @param params  路由参数（Promise<{ id: string; format: string }>）
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
  const bilingual = new URL(request.url).searchParams.get("bilingual") === "1";

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });

  const task = await db.translation.findUnique({
    where: { id },
    include: { project: { select: { userId: true, title: true, transcript: true } } },
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

  // 双语模式：原文分段与译文按索引逐行合并（原文在上、译文在下）
  let bilingualSource: StoredSegment[] | null = null;
  if (bilingual) {
    const source = Array.isArray(task.project.transcript?.segments)
      ? (task.project.transcript!.segments as StoredSegment[])
      : [];
    if (source.length === 0) {
      return NextResponse.json({ error: "项目没有原文转写内容，无法生成双语字幕" }, { status: 409 });
    }
    bilingualSource = source;
  }

  const suffix = bilingual ? `_双语_${task.targetLang}` : `.${task.targetLang}`;
  const filename = `${task.project.title || "subtitles"}${suffix}`;
  if (format === "srt") {
    const body = bilingual
      ? buildSrt(mergeBilingual(bilingualSource!, segments))
      : buildSrt(segments);
    // BOM 前缀：Windows 记事本/剪映识别 UTF-8 依赖它
    return subtitleAttachment("﻿" + body, filename, "srt", mimeType);
  }
  if (format === "vtt") {
    const body = bilingual
      ? buildVtt(mergeBilingual(bilingualSource!, segments))
      : buildVtt(segments);
    return subtitleAttachment(body, filename, "vtt", mimeType);
  }
  // ASS：系统默认样式（译文不保留中文关键词，高亮不适用）
  const body = bilingual
    ? buildBilingualAss(
        DEFAULT_ASS_CONFIG,
        bilingualSource!,
        segments.map((s) => s.text),
      )
    : buildAss(DEFAULT_ASS_CONFIG, segments);
  return subtitleAttachment(body, filename, "ass", mimeType);
}

/**
 * 双语文本合并（SRT/VTT 用）：按索引把译文以真实换行并入原文文本
 * @param source    原文字幕分段
 * @param translated 译文分段（时间轴与原文逐行对齐）
 * @returns 合并后的分段（text = 原文\n译文；译文缺失的行退化为原文）
 */
function mergeBilingual(
  source: StoredSegment[],
  translated: TranslatedSegment[],
): { start: number; end: number; text: string }[] {
  return source.map((s, i) => {
    const transText = typeof translated[i]?.text === "string" ? translated[i]!.text.trim() : "";
    return {
      start: s.start,
      end: s.end,
      text: transText ? `${s.text}\n${transText}` : s.text,
    };
  });
}
