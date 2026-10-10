/**
 * @file POST /api/auth/login — 手机号 + 验证码登录/注册
 * @description 流程：
 *   1. 校验手机号格式与 6 位验证码
 *   2. 查找最新未消费且未过期的验证码记录，哈希比对，命中后立即消费（防重放）
 *   3. 用户不存在则注册：创建用户 + 发放注册赠送额度（余额 + 流水，事务保证一致）
 *   4. 创建会话并写入 httpOnly Cookie
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { PHONE_RE, SIGNUP_BONUS_SECONDS } from "@/lib/constants";
import { createSession, maskPhone, sha256 } from "@/lib/auth";
import { getClientIp, rateLimit } from "@/lib/rate-limit";

/** 同一 IP 每小时登录尝试上限（验证码穷举防御，覆盖换手机号攻击） */
const IP_HOURLY_LIMIT = 30;

/** 同一手机号每小时登录尝试上限 */
const PHONE_HOURLY_LIMIT = 10;

/** 登录接口 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as
    | { phone?: string; code?: string }
    | null;
  const phone = body?.phone ?? "";
  const code = body?.code ?? "";

  if (!PHONE_RE.test(phone)) {
    return NextResponse.json({ error: "手机号格式不正确" }, { status: 400 });
  }

  // 限流：IP 与手机号双维度（只计格式合法的请求）
  const byIp = await rateLimit(req, "login", `ip:${getClientIp(req)}`, IP_HOURLY_LIMIT, 60 * 60 * 1000);
  const byPhone = await rateLimit(req, "login", `phone:${phone}`, PHONE_HOURLY_LIMIT, 60 * 60 * 1000);
  if (!byIp.ok || !byPhone.ok) {
    const retry = Math.max(byIp.retryAfterSec, byPhone.retryAfterSec);
    return NextResponse.json(
      { error: `尝试过于频繁，请 ${retry > 60 ? `${Math.ceil(retry / 60)} 分钟` : `${retry} 秒`}后再试` },
      { status: 429, headers: { "Retry-After": String(retry) } },
    );
  }

  if (!/^\d{6}$/.test(code)) {
    return NextResponse.json({ error: "请输入 6 位数字验证码" }, { status: 400 });
  }

  // 查找最新可用验证码记录（未消费、未过期）
  const verification = await db.smsVerification.findFirst({
    where: {
      phone,
      consumed: false,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: "desc" },
  });
  if (!verification || verification.codeHash !== sha256(code)) {
    return NextResponse.json({ error: "验证码错误或已过期" }, { status: 401 });
  }
  await db.smsVerification.update({
    where: { id: verification.id },
    data: { consumed: true },
  });

  // 查找或创建用户（注册赠送额度与流水在同一事务中写入）
  let user = await db.user.findUnique({ where: { phone } });
  if (!user) {
    user = await db.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: { phone, balanceSeconds: SIGNUP_BONUS_SECONDS },
      });
      await tx.creditLedger.create({
        data: {
          userId: created.id,
          changeSeconds: SIGNUP_BONUS_SECONDS,
          balanceAfter: SIGNUP_BONUS_SECONDS,
          reason: "SIGNUP_BONUS",
        },
      });
      return created;
    });
  }

  await createSession(user.id);

  return NextResponse.json({
    user: {
      id: user.id,
      phone: maskPhone(user.phone),
      nickname: user.nickname,
      balanceSeconds: user.balanceSeconds,
    },
  });
}
