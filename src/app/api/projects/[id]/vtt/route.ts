/**
 * @file /api/projects/[id]/vtt — WebVTT 字幕文件下载接口（P1.4 多格式导出）
 * @description 将项目转写结果编译为 WebVTT 并以附件下载（文件名 = 项目名.vtt），
 *              供网页播放器（HTML5 <track>）与支持 VTT 的剪辑软件使用。
 *              鉴权/校验逻辑见 subtitle-download.ts；纯文本生成不扣额度。
 */
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { buildVtt } from "@/lib/vtt";
import { loadOwnedProjectSegments, subtitleAttachment } from "@/lib/subtitle-download";

/**
 * 下载项目 WebVTT 字幕文件
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

  // VTT 无 BOM：WEBVTT 魔数必须是文件首字节，部分解析器不容忍 BOM
  return subtitleAttachment(buildVtt(loaded.segments), loaded.title, "vtt", "text/vtt");
}
