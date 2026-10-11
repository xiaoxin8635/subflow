/**
 * @file /api/user-styles — 用户自定义样式模板（P2.2）
 * @description GET：列出当前登录用户的个人模板（createdAt 倒序）。
 *              POST：创建个人模板（名称 1-20 字符 + config 强校验，每人上限 20 条）。
 *              config 契约见 src/lib/style-config.ts（与全局 Style.config / ASS 烧录一致）。
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { validateStyleConfigInput } from "@/lib/style-config";

/** 每用户个人模板数量上限 */
const MAX_USER_STYLES = 20;

/**
 * 列出我的样式模板
 */
export async function GET(): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });

  const styles = await db.userStyle.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, config: true, createdAt: true },
  });
  return NextResponse.json({ styles });
}

/**
 * 创建我的样式模板
 * @param request 请求体 { name: string, config: StyleConfig }
 */
export async function POST(request: Request): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });

  // 限流：每用户每小时最多 30 次创建（防刷；模板上限本身也只有 20 条）
  const rl = await rateLimit(request, "user-style", user.id, 30, 60 * 60 * 1000);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "操作过于频繁，请稍后再试" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
    );
  }

  const body = (await request.json().catch(() => ({}))) as { name?: unknown; config?: unknown };
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name.length < 1 || name.length > 20) {
    return NextResponse.json({ error: "模板名须为 1-20 个字符" }, { status: 400 });
  }

  const checked = validateStyleConfigInput(body.config);
  if (!checked.ok) {
    return NextResponse.json({ error: `样式配置无效：${checked.error}` }, { status: 400 });
  }

  // 数量上限：超限拒绝并引导删除（count+create 非事务，极端并发下略超上限可接受）
  const count = await db.userStyle.count({ where: { userId: user.id } });
  if (count >= MAX_USER_STYLES) {
    return NextResponse.json(
      { error: `我的模板最多 ${MAX_USER_STYLES} 个，请先删除不需要的模板` },
      { status: 400 },
    );
  }

  const style = await db.userStyle.create({
    data: { userId: user.id, name, config: checked.config },
    select: { id: true, name: true, config: true, createdAt: true },
  });
  return NextResponse.json({ style }, { status: 201 });
}
