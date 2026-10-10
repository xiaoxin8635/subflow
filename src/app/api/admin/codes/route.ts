/**
 * @file /api/admin/codes — 管理员生成激活码
 * @description POST：仅 ADMIN_PHONES 白名单用户可调用（否则 404）。
 *              支持时长码（seconds + count）与套餐码（planId + count），单次 ≤50 枚。
 *              返回生成的码列表（仅此一次明文展示；库里只有状态，无泄露面）。
 */
import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { isAdminPhone } from "@/lib/admin";

/** 码字符集（剔除 0/O/1/I/L 易混淆字符，与 scripts/gen-redeem-codes.mjs 一致） */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/** 单次生成上限（防误操作刷库） */
const MAX_PER_REQUEST = 50;

/**
 * 生成一枚随机码：SUBF-XXXX-XXXX-XXXX
 */
function generateCode(): string {
  const group = () =>
    Array.from({ length: 4 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join("");
  return `SUBF-${group()}-${group()}-${group()}`;
}

/**
 * 生成激活码
 * @param request 请求体 { seconds?: number, planId?: string, count?: number }
 *                seconds 与 planId 二选一；count 默认 1，上限 50
 */
export async function POST(request: Request): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user || !isAdminPhone(user.phone)) {
    return NextResponse.json({ error: "不存在" }, { status: 404 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    seconds?: unknown;
    planId?: unknown;
    count?: unknown;
  };

  const count = Math.min(Number(body.count) || 1, MAX_PER_REQUEST);
  if (count < 1) return NextResponse.json({ error: "count 无效" }, { status: 400 });

  let planId: string | null = null;
  let bonusSeconds: number | null = null;

  if (typeof body.planId === "string" && body.planId) {
    // 套餐码：校验套餐存在且在售
    const plan = await db.plan.findUnique({ where: { id: body.planId } });
    if (!plan || !plan.isActive) {
      return NextResponse.json({ error: "套餐不存在或已下架" }, { status: 400 });
    }
    planId = plan.id;
  } else if (Number.isFinite(Number(body.seconds)) && Number(body.seconds) > 0) {
    bonusSeconds = Math.floor(Number(body.seconds));
  } else {
    return NextResponse.json({ error: "需提供 seconds（时长码）或 planId（套餐码）" }, { status: 400 });
  }

  // 逐枚生成（P2002 唯一冲突换码重试，上限 5 次）
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    for (let attempt = 0; ; attempt++) {
      const code = generateCode();
      try {
        await db.redeemCode.create({ data: { code, planId, bonusSeconds } });
        codes.push(code);
        break;
      } catch (e) {
        if ((e as { code?: string })?.code !== "P2002" || attempt >= 5) throw e;
      }
    }
  }

  return NextResponse.json({ codes, planId, bonusSeconds });
}
