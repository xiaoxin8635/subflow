/**
 * @file GET /api/invite — 我的邀请码与邀请记录（P2.5 邀请裂变）
 * @description 返回当前用户的邀请码（懒生成：首次访问自动生成落库）、奖励规则
 *              （双方各得秒数）、累计邀请人数与累计获得奖励、邀请记录列表
 *              （被邀请人手机号脱敏）。本人校验：未登录 401。
 * 说明：Cache Components 模式下禁止 export const runtime 路由配置。
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser, maskPhone } from "@/lib/auth";
import { ensureInviteCode } from "@/lib/invite";
import { INVITE_REWARD_INVITER_SECONDS, INVITE_REWARD_INVITEE_SECONDS } from "@/lib/constants";

/** 邀请记录列表最多返回条数（超出部分仅计入统计，不逐条展示） */
const RECORD_LIST_LIMIT = 50;

/**
 * 查询我的邀请信息
 */
export async function GET(): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });

  const inviteCode = await ensureInviteCode(user.id);
  const [invitedCount, agg, records] = await Promise.all([
    db.inviteRecord.count({ where: { inviterId: user.id } }),
    db.inviteRecord.aggregate({
      where: { inviterId: user.id },
      _sum: { bonusInviterSec: true },
    }),
    db.inviteRecord.findMany({
      where: { inviterId: user.id },
      orderBy: { createdAt: "desc" },
      take: RECORD_LIST_LIMIT,
      include: { invitee: { select: { phone: true } } },
    }),
  ]);

  return NextResponse.json({
    inviteCode,
    rewardInviterSeconds: INVITE_REWARD_INVITER_SECONDS,
    rewardInviteeSeconds: INVITE_REWARD_INVITEE_SECONDS,
    invitedCount,
    totalRewardSeconds: agg._sum.bonusInviterSec ?? 0,
    records: records.map((r) => ({
      id: r.id,
      phone: maskPhone(r.invitee.phone),
      rewardSec: r.bonusInviterSec,
      createdAt: r.createdAt,
    })),
  });
}
