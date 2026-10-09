/**
 * @file /api/redeem — 激活码兑换
 * @description POST：兑换激活码，单事务完成「UNUSED → USED + 额度入账 + 流水留痕」。
 *              支持两类码：
 *              - 时长码（bonusSeconds）：直接加余额，写 CreditLedger(reason=REDEEM_BONUS)
 *              - 套餐码（planId）：创建 REDEEM 渠道订单 + 月订阅 + 按套餐月额度入账，
 *                写 CreditLedger(reason=REDEEM_PLAN)
 *              幂等/防刷：码状态在事务内条件更新，并发兑换同一码只会有一个成功。
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

/** 激活码展示格式清洗：去空格 + 统一大写（用户可能手动输入小写/带空格） */
function normalizeCode(raw: string): string {
  return raw.replace(/\s+/g, "").toUpperCase();
}

/**
 * 兑换激活码
 * @param request 请求体 { code: string }
 */
export async function POST(request: Request): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as { code?: unknown };
  const code = typeof body.code === "string" ? normalizeCode(body.code) : "";
  if (!code || code.length < 8 || code.length > 32) {
    return NextResponse.json({ error: "请输入有效的激活码" }, { status: 400 });
  }

  try {
    const result = await db.$transaction(async (tx) => {
      const record = await tx.redeemCode.findUnique({ where: { code } });
      if (!record) throw new RedeemError(404, "激活码不存在，请核对后重试");
      if (record.status === "USED") throw new RedeemError(409, "该激活码已被使用");
      if (record.status === "DISABLED") throw new RedeemError(403, "该激活码已停用，请联系客服");

      // 条件更新抢占：并发兑换同一码时只有一个事务能更新成功
      const claimed = await tx.redeemCode.updateMany({
        where: { id: record.id, status: "UNUSED" },
        data: { status: "USED", usedBy: user.id, usedAt: new Date() },
      });
      if (claimed.count !== 1) throw new RedeemError(409, "该激活码已被使用");

      let addedSeconds: number;
      let planName: string | null = null;

      if (record.planId) {
        // 套餐码：创建 REDEEM 渠道订单 + 月订阅 + 套餐月额度入账
        const plan = await tx.plan.findUnique({ where: { id: record.planId } });
        if (!plan || !plan.isActive) throw new RedeemError(403, "该激活码对应的套餐已下架，请联系客服");

        // 订单留痕（REDEEM 渠道，金额 0 = 兑换不产生新支付）
        await tx.order.create({
          data: {
            userId: user.id,
            planId: plan.id,
            amountCents: 0,
            status: "PAID",
            channel: "REDEEM",
            paidAt: new Date(),
          },
        });
        const startAt = new Date();
        const expireAt = new Date(startAt.getTime() + 30 * 24 * 60 * 60 * 1000); // 月订阅按 30 天
        await tx.subscription.create({
          data: { userId: user.id, planId: plan.id, startAt, expireAt, status: "ACTIVE" },
        });
        addedSeconds = plan.monthlySeconds;
        planName = plan.name;
      } else {
        // 时长码：直接赠送 bonusSeconds
        addedSeconds = record.bonusSeconds ?? 0;
      }

      if (addedSeconds <= 0) throw new RedeemError(500, "激活码配置异常（额度为 0），请联系客服");

      // 额度入账 + 流水留痕
      const updatedUser = await tx.user.update({
        where: { id: user.id },
        data: { balanceSeconds: { increment: addedSeconds } },
      });
      await tx.creditLedger.create({
        data: {
          userId: user.id,
          changeSeconds: addedSeconds,
          balanceAfter: updatedUser.balanceSeconds,
          reason: record.planId ? "REDEEM_PLAN" : "REDEEM_BONUS",
          refId: record.id,
        },
      });

      return { addedSeconds, balanceSeconds: updatedUser.balanceSeconds, planName };
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof RedeemError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[redeem] 兑换异常：", err);
    return NextResponse.json({ error: "兑换失败，请稍后重试" }, { status: 500 });
  }
}

/** 兑换业务错误（携带 HTTP 状态码，与系统异常区分） */
class RedeemError extends Error {
  /**
   * @param status HTTP 状态码
   * @param message 用户可读的错误信息
   */
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
