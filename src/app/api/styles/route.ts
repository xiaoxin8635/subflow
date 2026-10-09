/**
 * @file GET /api/styles — 字幕样式模板列表
 * @description 返回全部样式（含 config JSON），供编辑器切换预览与导出时选择。
 *              config 结构契约见 prisma/seed.mjs 头部注释（前端渲染器与
 *              FFmpeg ASS 生成器共同遵守）。
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

/** 样式列表接口 */
export async function GET(): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });

  const styles = await db.style.findMany({
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, config: true, isDefault: true },
  });

  return NextResponse.json({ styles });
}
