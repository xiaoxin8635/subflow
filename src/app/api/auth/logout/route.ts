/**
 * @file POST /api/auth/logout — 退出登录
 * @description 删除数据库会话记录并清除 Cookie，幂等（未登录调用也返回成功）。
 */
import { NextResponse } from "next/server";
import { destroySession } from "@/lib/auth";

/** 退出登录接口 */
export async function POST() {
  await destroySession();
  return NextResponse.json({ ok: true });
}
