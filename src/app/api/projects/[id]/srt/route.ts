/**
 * @file /api/projects/[id]/srt — SRT 字幕文件下载接口
 * @description 将项目转写结果编译为 SRT 并以附件下载（文件名 = 项目名.srt，RFC 5987 中文编码）。
 *              鉴权/校验逻辑见 subtitle-download.ts（401/404/409 语义统一）。
 *              SRT 为纯文本生成、零算力成本，不扣额度（付费点在烧录导出）。
 */
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { buildSrt } from "@/lib/srt";
import { loadOwnedProjectSegments, subtitleAttachment } from "@/lib/subtitle-download";

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
  const { id } = await params;
  const loaded = await loadOwnedProjectSegments(id, user?.id ?? null);
  if (!loaded.ok) {
    return NextResponse.json({ error: loaded.error }, { status: loaded.status });
  }

  // UTF-8 BOM：防止部分 Windows 播放器/剪辑软件把无 BOM 文件按 GBK 误读导致中文乱码
  return subtitleAttachment("﻿" + buildSrt(loaded.segments), loaded.title, "srt", "application/x-subrip");
}
