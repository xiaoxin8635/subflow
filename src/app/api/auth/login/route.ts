/**
 * @file POST /api/auth/login — 手机号 + 验证码登录/注册（支持邀请码，P2.5）
 * @description 流程：
 *   1. 校验手机号格式与 6 位验证码
 *   2. 查找最新未消费且未过期的验证码记录，哈希比对，命中后立即消费（防重放）
 *   3. 用户不存在则注册：创建用户 + 发放注册赠送额度（余额 + 流水，事务保证一致）；
 *      请求携带合法邀请码时双方发奖（新用户额外得邀请奖励，邀请人得邀请人奖励，
 *      同事务写入 InviteRecord + 双方流水；无效邀请码静默忽略不阻断注册）
 *   4. 创建会话并写入 httpOnly Cookie
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { PHONE_RE, SIGNUP_BONUS_SECONDS, INVITE_CODE_RE, INVITE_REWARD_INVITER_SECONDS, INVITE_REWARD_INVITEE_SECONDS } from "@/lib/constants";
import { createSession, maskPhone, sha256 } from "@/lib/auth";
import { findInviterByCode } from "@/lib/invite";
import { getClientIp, rateLimit } from "@/lib/rate-limit";

/** 同一 IP 每小时登录尝试上限（验证码穷举防御，覆盖换手机号攻击） */
const IP_HOURLY_LIMIT = 30;

/** 同一手机号每小时登录尝试上限 */
const PHONE_HOURLY_LIMIT = 10;

/** 登录接口 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as
    | { phone?: string; code?: string; inviteCode?: string }
    | null;
  const phone = body?.phone ?? "";
  const code = body?.code ?? "";
  // 邀请码：格式合法才保留（大写归一）；无效/查无此码在注册分支静默忽略
  const rawInvite = (body?.inviteCode ?? "").trim().toUpperCase();
  const inviteCode = INVITE_CODE_RE.test(rawInvite) ? rawInvite : "";

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

  // 查找或创建用户（注册赠送 / 邀请奖励与流水在同一事务中写入）
  let user = await db.user.findUnique({ where: { phone } });
  let inviteApplied = false;
  if (!user) {
    // 邀请码解析：格式合法才查邀请人；查无此人视为未携带（不阻断注册）
    const inviter = inviteCode ? await findInviterByCode(inviteCode) : null;
    const inviteeBonus = inviter ? INVITE_REWARD_INVITEE_SECONDS : 0;
    user = await db.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: { phone, balanceSeconds: SIGNUP_BONUS_SECONDS + inviteeBonus },
      });
      await tx.creditLedger.create({
        data: {
          userId: created.id,
          changeSeconds: SIGNUP_BONUS_SECONDS,
          balanceAfter: SIGNUP_BONUS_SECONDS,
          reason: "SIGNUP_BONUS",
        },
      });
      if (inviter) {
        // 被邀请人额外奖励流水
        await tx.creditLedger.create({
          data: {
            userId: created.id,
            changeSeconds: INVITE_REWARD_INVITEE_SECONDS,
            balanceAfter: SIGNUP_BONUS_SECONDS + INVITE_REWARD_INVITEE_SECONDS,
            reason: "INVITEE_BONUS",
          },
        });
        // 邀请记录：inviteeId unique 兜底防同一账号重复被邀请（并发注册竞态时事务回滚）
        await tx.inviteRecord.create({
          data: {
            inviterId: inviter.id,
            inviteeId: created.id,
            bonusInviterSec: INVITE_REWARD_INVITER_SECONDS,
            bonusInviteeSec: INVITE_REWARD_INVITEE_SECONDS,
          },
        });
        // 邀请人加额度 + 流水（refId 关联被邀请人，便于追溯）
        await tx.user.update({
          where: { id: inviter.id },
          data: { balanceSeconds: { increment: INVITE_REWARD_INVITER_SECONDS } },
        });
        const inviterAfter = await tx.user.findUnique({
          where: { id: inviter.id },
          select: { balanceSeconds: true },
        });
        await tx.creditLedger.create({
          data: {
            userId: inviter.id,
            changeSeconds: INVITE_REWARD_INVITER_SECONDS,
            balanceAfter: inviterAfter!.balanceSeconds,
            reason: "INVITE_REWARD",
            refId: created.id,
          },
        });
      }
      return created;
    });
    inviteApplied = Boolean(inviter);
  }

  await createSession(user.id);

  return NextResponse.json({
    user: {
      id: user.id,
      phone: maskPhone(user.phone),
      nickname: user.nickname,
      balanceSeconds: user.balanceSeconds,
    },
    inviteApplied,
  });
}
