/**
 * @file /api/projects/[id]/srt — SRT 字幕文件下载接口
 * @description 将项目转写结果编译为 SRT 并以附件下载（文件名 = 项目名.srt，RFC 5987 中文编码）。
 *              仅本人可见（不存在/非本人统一 404）；未就绪或无字幕返回 409。
 *              SRT 为纯文本生成、零算力成本，不扣额度（付费点在烧录导出）。
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { buildSrt } from "@/lib/srt";
import type { StoredSegment } from "@/lib/asr/types";

/**
 * 下载项目 SRT 字幕文件
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
  const project = await db.project.findUnique({
    where: { id },
    include: { transcript: true },
  });
  // 不存在或非本人：统一 404，避免探测他人项目 ID
  if (!project || project.userId !== user.id) {
    return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  }
  // 无转写内容：409 冲突（项目存在但拿不到 SRT）
  if (!project.transcript) {
    return NextResponse.json({ error: "项目尚未完成转写" }, { status: 409 });
  }

  const segments = Array.isArray(project.transcript.segments)
    ? (project.transcript.segments as StoredSegment[])
    : [];
  if (segments.length === 0) {
    return NextResponse.json({ error: "项目没有字幕内容" }, { status: 409 });
  }

  // UTF-8 BOM：防止部分 Windows 播放器/剪辑软件把无 BOM 文件按 GBK 误读导致中文乱码
  const srtBody = "﻿" + buildSrt(segments);
  const filename = encodeURIComponent(`${project.title || "subtitles"}.srt`);

  return new Response(srtBody, {
    headers: {
      "Content-Type": "application/x-subrip; charset=utf-8",
      "Content-Disposition": `attachment; filename="subtitles.srt"; filename*=UTF-8''${filename}`,
      "Cache-Control": "no-store",
    },
  });
}
