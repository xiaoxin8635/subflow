/**
 * @file 站内通知已读接口（P1.3 任务完成通知）
 * @description POST /api/notifications/read：批量或全量标记已读。
 *              入参二选一：{ ids: string[] }（指定通知）/ { all: true }（全部已读）。
 */
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";

/**
 * POST 处理：标记已读（只更新本人且未读的通知，防越权）
 */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });

  let body: { ids?: unknown; all?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "参数错误" }, { status: 400 });
  }

  const where =
    body.all === true
      ? { userId: user.id, readAt: null }
      : Array.isArray(body.ids) && body.ids.length > 0 && body.ids.every((i) => typeof i === "string")
        ? { userId: user.id, readAt: null, id: { in: body.ids } }
        : null;
  if (!where) return NextResponse.json({ error: "参数错误：需提供 ids 数组或 all=true" }, { status: 400 });

  const result = await db.notification.updateMany({ where, data: { readAt: new Date() } });
  return NextResponse.json({ updated: result.count });
}
