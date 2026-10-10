/**
 * @file POST /api/auth/sms — 发送登录短信验证码
 * @description 限流策略：
 *   - 同一手机号 60 秒内只能发 1 次
 *   - 同一手机号每小时最多 5 次
 * 验证码生成后以 SHA-256 哈希入库（5 分钟有效），开发模式下额外在响应中
 * 返回 devCode 方便本地联调（生产模式不返回）。
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { PHONE_RE } from "@/lib/constants";
import { isSmsDevMode, sendVerificationCode } from "@/lib/sms";
import { sha256 } from "@/lib/auth";
import { getClientIp, rateLimit } from "@/lib/rate-limit";

/** 重发冷却时间（毫秒） */
const RESEND_COOLDOWN_MS = 60 * 1000;

/** 每小时发送上限（同一手机号） */
const HOURLY_LIMIT = 5;

/** 每小时发送上限（同一 IP，防换号绕过） */
const IP_HOURLY_LIMIT = 20;

/** 验证码有效期（毫秒） */
const CODE_TTL_MS = 5 * 60 * 1000;

/** 发送验证码接口 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { phone?: string } | null;
  const phone = body?.phone ?? "";
  if (!PHONE_RE.test(phone)) {
    return NextResponse.json({ error: "手机号格式不正确" }, { status: 400 });
  }

  // 限流 0：同一 IP 每小时最多 20 次（攻击者换手机号也无法绕过）
  const byIp = rateLimit(req, "sms", `ip:${getClientIp(req)}`, IP_HOURLY_LIMIT, 60 * 60 * 1000);
  if (!byIp.ok) {
    return NextResponse.json(
      { error: "操作过于频繁，请 1 小时后再试" },
      { status: 429, headers: { "Retry-After": String(byIp.retryAfterSec) } },
    );
  }

  // 限流 1：60 秒冷却
  const latest = await db.smsVerification.findFirst({
    where: { phone },
    orderBy: { createdAt: "desc" },
  });
  if (latest && Date.now() - latest.createdAt.getTime() < RESEND_COOLDOWN_MS) {
    return NextResponse.json({ error: "发送过于频繁，请稍后再试" }, { status: 429 });
  }

  // 限流 2：每小时最多 5 条
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const recentCount = await db.smsVerification.count({
    where: { phone, createdAt: { gte: hourAgo } },
  });
  if (recentCount >= HOURLY_LIMIT) {
    return NextResponse.json({ error: "今日发送次数已达上限，请 1 小时后再试" }, { status: 429 });
  }

  // 生成验证码：开发模式用固定码，生产模式随机 6 位（crypto 级随机）
  const code =
    isSmsDevMode() && process.env.DEV_FIXED_CODE
      ? process.env.DEV_FIXED_CODE
      : String(Math.floor(100000 + Math.random() * 900000));

  await db.smsVerification.create({
    data: {
      phone,
      codeHash: sha256(code),
      expiresAt: new Date(Date.now() + CODE_TTL_MS),
    },
  });

  try {
    await sendVerificationCode(phone, code);
  } catch (e) {
    console.error("[sms] 发送失败：", e);
    return NextResponse.json({ error: "短信发送失败，请稍后再试" }, { status: 502 });
  }

  return NextResponse.json({
    ok: true,
    // 仅开发模式回传验证码，便于联调；生产模式绝不返回
    ...(isSmsDevMode() ? { devCode: code } : {}),
  });
}
