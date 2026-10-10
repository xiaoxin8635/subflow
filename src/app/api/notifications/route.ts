/**
 * @file 站内通知读取接口（P1.3 任务完成通知）
 * @description GET /api/notifications：返回当前用户未读数 + 最近 30 条通知列表
 *              （铃铛组件 60s 轮询此接口）。未登录 401。
 */
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";

/** 列表返回条数上限（铃铛下拉展示容量） */
const LIST_LIMIT = 30;

/**
 * GET 处理：未读计数 + 最近通知列表
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });

  const [unread, items] = await Promise.all([
    db.notification.count({ where: { userId: user.id, readAt: null } }),
    db.notification.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      take: LIST_LIMIT,
    }),
  ]);
  return NextResponse.json({ unread, items });
}
