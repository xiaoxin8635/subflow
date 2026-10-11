/**
 * @file 邀请裂变模块（P2.5）：邀请码生成 / 懒生成 / 兑换查找
 * @description 每个用户有一个 8 位邀请码（User.inviteCode，unique）。生成时机为
 *              懒生成——首次访问邀请页（GET /api/invite）时若无码则生成落库；
 *              新用户注册请求携带邀请码时按码找到邀请人，在注册事务内双方发奖
 *              （见 login 路由）。字符集剔除 0/O/1/I，避免口头传播与手抄混淆。
 */
import { randomInt } from "crypto";
import { db } from "@/lib/db";
import { INVITE_CODE_ALPHABET, INVITE_CODE_LENGTH } from "@/lib/constants";

/**
 * 生成一个随机邀请码（crypto randomInt 避免取模偏差）
 * @returns 8 位大写字母数字码（不含 0/O/1/I）
 */
export function generateInviteCode(): string {
  let code = "";
  for (let i = 0; i < INVITE_CODE_LENGTH; i++) {
    code += INVITE_CODE_ALPHABET[randomInt(INVITE_CODE_ALPHABET.length)];
  }
  return code;
}

/**
 * 确保用户有邀请码（懒生成）：无码则生成并落库；unique 撞码时自动重试
 * @param userId 用户 ID
 * @returns 该用户的邀请码
 */
export async function ensureInviteCode(userId: string): Promise<string> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { inviteCode: true } });
  if (user?.inviteCode) return user.inviteCode;

  // 撞码概率约 1/1.1e12，重试 3 次兜底（理论上的唯一失败路径）
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = generateInviteCode();
    const updated = await db.user
      .update({ where: { id: userId }, data: { inviteCode: code }, select: { inviteCode: true } })
      .catch(() => null);
    if (updated?.inviteCode) return updated.inviteCode;
  }
  throw new Error("邀请码生成失败，请稍后重试");
}

/**
 * 按邀请码查找邀请人（注册事务外调用：仅格式合法才查，查无此人返回 null 静默忽略）
 * @param code 邀请码（调用方已做格式校验）
 * @returns 邀请人（不存在返回 null）
 */
export async function findInviterByCode(code: string): Promise<{ id: string } | null> {
  if (!code) return null;
  return db.user.findUnique({ where: { inviteCode: code.toUpperCase() }, select: { id: true } });
}
