/**
 * @file /api/projects/[id]/ass — ASS 字幕文件下载接口（P1.4 多格式导出）
 * @description 将项目转写结果按指定样式编译为 ASS 并以附件下载（文件名 = 项目名.ass），
 *              供 mpv/PotPlayer 等播放器直接挂载或专业剪辑流程使用。
 *              可选 query 参数：styleId（官方模板）/ userStyleId（我的模板，本人校验）；
 *              缺省用系统默认样式，无默认样式时用内置兜底配置（与烧录链路一致）。
 *              纯文本生成不扣额度。
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { buildAss, DEFAULT_ASS_CONFIG } from "@/lib/ass";
import type { AssStyleConfig } from "@/lib/ass";
import { parseStyleConfig } from "@/lib/style-config";
import { loadOwnedProjectSegments, subtitleAttachment } from "@/lib/subtitle-download";

/**
 * 解析目标样式配置：我的模板 → 官方模板 → 系统默认样式 → 内置兜底
 * @param styleIdQuery     URL query 中的 styleId（可选）
 * @param userStyleIdQuery URL query 中的 userStyleId（可选，优先于 styleId）
 * @param userId           当前登录用户 ID（我的模板归属校验；未登录为 null）
 * @returns 样式配置；样式标识非法时返回错误信息
 */
async function resolveAssConfig(
  styleIdQuery: string | null,
  userStyleIdQuery: string | null,
  userId: string | null,
): Promise<{ ok: true; config: AssStyleConfig } | { ok: false; error: string }> {
  if (userStyleIdQuery) {
    if (!userId) return { ok: false, error: "登录后可使用我的模板" };
    const userStyle = await db.userStyle.findUnique({ where: { id: userStyleIdQuery } });
    if (!userStyle || userStyle.userId !== userId) return { ok: false, error: "样式不存在" };
    const config = parseStyleConfig(userStyle.config);
    return config ? { ok: true, config } : { ok: false, error: "样式配置异常" };
  }
  if (styleIdQuery) {
    const style = await db.style.findUnique({ where: { id: styleIdQuery } });
    if (!style) return { ok: false, error: "样式不存在" };
    const config = parseStyleConfig(style.config);
    return config ? { ok: true, config } : { ok: false, error: "样式配置异常" };
  }
  const fallback = await db.style.findFirst({ where: { isDefault: true } });
  return { ok: true, config: parseStyleConfig(fallback?.config) ?? DEFAULT_ASS_CONFIG };
}

/**
 * 下载项目 ASS 字幕文件
 * @param request 原始请求（query 可带 styleId / userStyleId）
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

  const search = new URL(request.url).searchParams;
  const resolved = await resolveAssConfig(
    search.get("styleId"),
    search.get("userStyleId"),
    user?.id ?? null,
  );
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
