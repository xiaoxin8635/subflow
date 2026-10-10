/**
 * @file /api/projects/[id]/ass — ASS 字幕文件下载接口（P1.4 多格式导出）
 * @description 将项目转写结果按指定样式编译为 ASS 并以附件下载（文件名 = 项目名.ass），
 *              供 mpv/PotPlayer 等播放器直接挂载或专业剪辑流程使用。
 *              可选 query 参数 styleId 指定样式模板；缺省用系统默认样式，
 *              无默认样式时用内置兜底配置（与烧录链路一致）。纯文本生成不扣额度。
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { buildAss, DEFAULT_ASS_CONFIG } from "@/lib/ass";
import { loadOwnedProjectSegments, subtitleAttachment } from "@/lib/subtitle-download";

/**
 * 解析目标样式配置：styleId 优先 → 系统默认样式 → 内置兜底
 * @param styleIdQuery URL query 中的 styleId（可选）
 * @returns 样式配置；styleId 非法时返回错误信息
 */
async function resolveAssConfig(styleIdQuery: string | null): Promise<
  { ok: true; config: Parameters<typeof buildAss>[0] } | { ok: false; error: string }
> {
  if (styleIdQuery) {
    const style = await db.style.findUnique({ where: { id: styleIdQuery } });
    if (!style) return { ok: false, error: "样式不存在" };
    return { ok: true, config: (style.config as unknown as Parameters<typeof buildAss>[0]) ?? DEFAULT_ASS_CONFIG };
  }
  const fallback = await db.style.findFirst({ where: { isDefault: true } });
  return {
    ok: true,
    config: (fallback?.config as unknown as Parameters<typeof buildAss>[0]) ?? DEFAULT_ASS_CONFIG,
  };
}

/**
 * 下载项目 ASS 字幕文件
 * @param request 原始请求（query 可带 styleId）
 * @param params  路由参数（Promise<{ id: string }>）
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await getCurrentUser();
  const { id } = await params;
  const loaded = await loadOwnedProjectSegments(id, user?.id ?? null);
  if (!loaded.ok) {
    return NextResponse.json({ error: loaded.error }, { status: loaded.status });
  }

  const styleId = new URL(request.url).searchParams.get("styleId");
  const resolved = await resolveAssConfig(styleId);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: 400 });
  }

  // ASS 含高亮标签的关键词沿用分段内 keywords（与烧录行为一致）
  return subtitleAttachment(
    buildAss(resolved.config, loaded.segments),
    loaded.title,
    "ass",
    "text/x-ssa",
  );
}
