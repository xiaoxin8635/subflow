/**
 * @file GET /api/me — 获取当前登录用户信息
 * @description 返回脱敏手机号与剩余额度；未登录返回 401。
 *              前端工作台/账户页用此接口拉取登录态。
 */
import { NextResponse } from "next/server";
import { getCurrentUser, maskPhone } from "@/lib/auth";

/** 当前用户信息接口 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }

  return NextResponse.json({
    user: {
      id: user.id,
      phone: maskPhone(user.phone),
      nickname: user.nickname,
      balanceSeconds: user.balanceSeconds,
      createdAt: user.createdAt,
    },
  });
}
