/**
 * @file 邀请好友页面（P2.5 邀请裂变）
 * @description 服务端组件：未登录重定向 /login；展示我的邀请码（懒生成：首次
 *              访问自动生成落库）、奖励规则、复制邀请链接/邀请码（客户端组件）、
 *              累计邀请人数与累计奖励、邀请记录列表（手机号脱敏）。
 *              数据直读数据库（与工作台同模式，不经自有 API）。
 */
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { getCurrentUser, maskPhone } from "@/lib/auth";
import { ensureInviteCode } from "@/lib/invite";
import { INVITE_REWARD_INVITER_SECONDS, INVITE_REWARD_INVITEE_SECONDS, SIGNUP_BONUS_SECONDS } from "@/lib/constants";
import { BackLink } from "@/components/back-link";
import { MailEmpty3D } from "@/components/empty-illustration";
import { InviteActions } from "./invite-actions";

// 登录态页面：读取 cookie + 数据库，按需阻塞渲染（Cache Components 下必须显式声明）
export const instant = false;

/** 邀请记录列表最多展示条数（与 /api/invite 一致） */
const RECORD_LIST_LIMIT = 50;

/** 秒数格式化为「X 分钟 / X 小时 Y 分钟」 */
function formatBonus(total: number): string {
  if (total % 60 === 0) return `${total / 60} 分钟`;
  return `${total} 秒`;
}

/** 邀请好友页组件 */
export default async function InvitePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

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
  const totalReward = agg._sum.bonusInviterSec ?? 0;

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-8 sm:px-6 lg:py-10">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">邀请好友</h1>
          <p className="mt-1 text-sm text-neutral-500">
            把邀请码分享给朋友，注册时填写即可双方得额度
          </p>
        </div>
        <BackLink href="/dashboard" label="返回工作台" />
      </div>

      {/* 我的邀请码 */}
      <div className="mt-6 rounded-2xl border border-black/5 bg-white p-6 shadow-sm">
        <p className="text-sm text-neutral-500">我的邀请码</p>
        <p className="mt-2 font-mono text-4xl font-bold tracking-[0.3em] text-brand">
          {inviteCode}
        </p>
        <p className="mt-3 text-sm text-neutral-500">
          新朋友注册时填写你的邀请码，你得{" "}
          <span className="font-medium text-brand">{formatBonus(INVITE_REWARD_INVITER_SECONDS)}</span>
          ，TA 额外得{" "}
          <span className="font-medium text-brand">{formatBonus(INVITE_REWARD_INVITEE_SECONDS)}</span>
          （叠加在 {formatBonus(SIGNUP_BONUS_SECONDS)}注册赠送之上）。
        </p>
        <div className="mt-4">
          <InviteActions inviteCode={inviteCode} />
        </div>
      </div>

      {/* 累计统计 */}
      <div className="mt-4 grid grid-cols-2 gap-4">
        <div className="rounded-2xl border border-black/5 bg-white p-5 text-center shadow-sm">
          <p className="text-2xl font-bold">{invitedCount}</p>
          <p className="mt-1 text-sm text-neutral-500">已邀请好友</p>
        </div>
        <div className="rounded-2xl border border-black/5 bg-white p-5 text-center shadow-sm">
          <p className="text-2xl font-bold text-brand">{formatBonus(totalReward)}</p>
          <p className="mt-1 text-sm text-neutral-500">累计获得奖励</p>
        </div>
      </div>

      {/* 邀请记录 */}
      <div className="mt-4 rounded-2xl border border-black/5 bg-white p-6 shadow-sm">
        <h2 className="font-semibold">邀请记录</h2>
        {records.length === 0 ? (
          <div className="flex flex-col items-center py-8 text-center">
            <div className="empty-float">
              <MailEmpty3D />
            </div>
            <p className="mt-3 text-sm text-neutral-400">还没有好友通过你的邀请注册</p>
            <p className="mt-1 text-xs text-neutral-400">把上面的邀请链接发给朋友，记录会出现在这里</p>
          </div>
        ) : (
          <ul className="mt-3 divide-y divide-neutral-100">
            {records.map((r) => (
              <li key={r.id} className="flex items-center justify-between py-3">
                <div>
                  <p className="text-sm font-medium">{maskPhone(r.invitee.phone)}</p>
                  <p className="mt-0.5 text-xs text-neutral-400">
                    {new Date(r.createdAt).toLocaleString("zh-CN", { hour12: false })}
                  </p>
                </div>
                <span className="text-sm font-medium text-brand">
                  +{formatBonus(r.bonusInviterSec)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
