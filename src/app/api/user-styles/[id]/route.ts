/**
 * @file /api/user-styles/[id] — 删除用户自定义样式模板（P2.2）
 * @description DELETE：删除本人模板；不存在或非本人统一 404（不泄露存在性）。
 *              说明：已创建的导出任务持有样式快照（ExportTask.styleConfig），
 *              删除模板不影响进行中/已完成任务的烧录结果。
 * 说明：Next.js 15+ 动态路由参数为 Promise，必须 await。
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

/**
 * 删除我的样式模板
 * @param params 路由参数（Promise<{ id: string }>）
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });

  const { id } = await params;
  const style = await db.userStyle.findUnique({ where: { id } });
  if (!style || style.userId !== user.id) {
    return NextResponse.json({ error: "模板不存在" }, { status: 404 });
  }

  await db.userStyle.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
