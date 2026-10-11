// =====================================================================
// SubFlow E2E — P2.5 邀请裂变专项
// 覆盖：未登录 401 → A 首访懒生成邀请码 → 新用户 D 带码注册（双方各得 600 秒）
//       → 邀请记录/统计/流水断言 → 老用户带码再登录无效 → 无效/非法码注册静默忽略
//       → invitee unique 防重复被邀请 → 邀请页/登录页/工作台 SSR 文案 → 清理
// 前提：生产/dev server 已启动、Postgres/Redis 运行中（SMS_DEV_MODE 万能码）。
// 运行：node scripts/e2e-invite-test.mjs
// 注意：若此前大量发码触发了 IP 级限流（rl:sms:ip:*），先清 Redis 计数再跑。
// =====================================================================
import { createHash, randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const BASE = process.env.E2E_BASE ?? "http://localhost:3000";
const PHONE_A = process.env.E2E_PHONE_A ?? "13900002301";
const PHONE_D = process.env.E2E_PHONE_D ?? "13900002304"; // 被邀请新用户
const PHONE_E = process.env.E2E_PHONE_E ?? "13900002305"; // 无效码新用户
const CODE = "123456"; // SMS_DEV_MODE 万能码
const INVITER_BONUS = 600; // 与 constants.ts 默认值一致
const INVITEE_BONUS = 600;

const db = new PrismaClient();

/** 断言辅助 */
function ok(cond, label) {
  if (cond) {
    console.log(`✅ ${label}`);
  } else {
    console.error(`❌ ${label}`);
    process.exitCode = 1;
  }
}

/** 带重试的 JSON fetch（网络抖动重试 2 次） */
async function jfetch(url, opts = {}, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fetch(url, opts);
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw lastErr;
}

/**
 * 登录并返回 { cookie, body }（发码 60s 冷却 429 时等 65s 重试一次）
 * @param phone      手机号
 * @param inviteCode 邀请码（可选，注册分支生效）
 */
async function login(phone, inviteCode) {
  let res = await jfetch(`${BASE}/api/auth/sms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone }),
  });
  if (res.status === 429) {
    console.log("  ⏳ 发码冷却中，等待 65 秒后重试…");
    await new Promise((r) => setTimeout(r, 65000));
    res = await jfetch(`${BASE}/api/auth/sms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone }),
    });
  }
  if (!res.ok) throw new Error(`发码失败 HTTP ${res.status}`);

  res = await jfetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone, code: CODE, inviteCode }),
  });
  if (!res.ok) throw new Error(`登录失败 HTTP ${res.status}`);
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("登录响应缺少 set-cookie");
  return { cookie: setCookie.split(";")[0], body: await res.json() };
}

/** 直连 DB 造登录态 Cookie（绕开发码冷却/IP 限流，页面渲染验证用） */
async function makeSessionCookie(phone) {
  const user = await db.user.findUnique({ where: { phone } });
  const token = randomBytes(32).toString("hex");
  await db.session.create({
    data: {
      userId: user.id,
      tokenHash: createHash("sha256").update(token).digest("hex"),
      expiresAt: new Date(Date.now() + 3600_000),
    },
  });
  return `subflow_session=${token}`;
}

async function main() {
  console.log("[阶段①] 未登录访问…");
  const res401 = await jfetch(`${BASE}/api/invite`);
  ok(res401.status === 401, "未登录 GET /api/invite → 401");

  console.log("[阶段②] 登录 A，首访懒生成邀请码…");
  const userA0 = await db.user.findUnique({ where: { phone: PHONE_A } });
  const balanceA0 = userA0.balanceSeconds;
  const { cookie: cookieA } = await login(PHONE_A);
  const resInvite = await jfetch(`${BASE}/api/invite`, { headers: { Cookie: cookieA } });
  const invite = await resInvite.json();
  ok(resInvite.status === 200 && /^[2-9A-HJ-NP-Z]{8}$/.test(invite.inviteCode ?? ""),
    `GET /api/invite → 200 且邀请码格式合法（${invite.inviteCode}）`);
  ok(invite.rewardInviterSeconds === INVITER_BONUS && invite.rewardInviteeSeconds === INVITEE_BONUS,
    "奖励规则字段正确（双方各 600 秒）");
  ok(Array.isArray(invite.records), "records 数组存在");
  const invitedCount0 = invite.invitedCount;

  console.log("[阶段③] 新用户 D 带码注册（双方发奖）…");
  const d = await login(PHONE_D, invite.inviteCode);
  ok(d.body.inviteApplied === true, "注册响应 inviteApplied=true");
  ok(d.body.user.balanceSeconds === 1800 + INVITEE_BONUS,
    `D 余额 = 注册赠送 ${1800} + 邀请奖励 ${INVITEE_BONUS} = ${d.body.user.balanceSeconds}`);
  const userD = await db.user.findUnique({ where: { phone: PHONE_D } });
  const userA1 = await db.user.findUnique({ where: { phone: PHONE_A } });
  ok(userA1.balanceSeconds === balanceA0 + INVITER_BONUS,
    `A 余额 +${INVITER_BONUS}（${balanceA0} → ${userA1.balanceSeconds}）`);
  const record = await db.inviteRecord.findUnique({ where: { inviteeId: userD.id } });
  ok(record?.inviterId === userA1.id && record.bonusInviterSec === INVITER_BONUS && record.bonusInviteeSec === INVITEE_BONUS,
    "InviteRecord 落库且双方奖励快照正确");
  const dLedgers = await db.creditLedger.findMany({
    where: { userId: userD.id, reason: { in: ["SIGNUP_BONUS", "INVITEE_BONUS"] } },
  });
  ok(dLedgers.length === 2, "D 两条流水（SIGNUP_BONUS + INVITEE_BONUS）");
  const aReward = await db.creditLedger.findFirst({
    where: { userId: userA1.id, reason: "INVITE_REWARD", refId: userD.id },
  });
  ok(aReward?.changeSeconds === INVITER_BONUS, "A 流水 INVITE_REWARD（refId=D）");

  console.log("[阶段④] 邀请统计与记录…");
  const resInvite2 = await jfetch(`${BASE}/api/invite`, { headers: { Cookie: cookieA } });
  const invite2 = await resInvite2.json();
  ok(invite2.invitedCount === invitedCount0 + 1, `invitedCount +1（${invitedCount0} → ${invite2.invitedCount}）`);
  ok(invite2.totalRewardSeconds === (await db.inviteRecord.aggregate({
    where: { inviterId: userA1.id }, _sum: { bonusInviterSec: true },
  }))._sum.bonusInviterSec, "totalRewardSeconds 与库内聚合一致");
  const rec = invite2.records.find((r) => r.id === record.id);
  ok(rec && rec.phone !== PHONE_D && rec.phone.endsWith("2304"), `记录手机号脱敏（${rec?.phone}）`);

  console.log("[阶段⑤] 老用户带码再登录（非注册分支无效）…");
  const d2 = await login(PHONE_D, invite.inviteCode);
  const userD2 = await db.user.findUnique({ where: { phone: PHONE_D } });
  ok(d2.body.inviteApplied === false && userD2.balanceSeconds === 1800 + INVITEE_BONUS,
    "老用户带码登录 inviteApplied=false 且余额不变");

  console.log("[阶段⑥] 无效/非法邀请码注册静默忽略…");
  const e1 = await login(PHONE_E, "XXXX2222"); // 格式合法但不存在
  ok(e1.body.inviteApplied === false && e1.body.user.balanceSeconds === 1800,
    "不存在的邀请码 → 正常注册 1800，无奖励");
  const userE = await db.user.findUnique({ where: { phone: PHONE_E } });
  const eRecord = await db.inviteRecord.findUnique({ where: { inviteeId: userE.id } });
  ok(eRecord === null, "无效码未产生邀请记录");

  console.log("[阶段⑦] invitee unique 防重复被邀请…");
  let uniqueBlocked = false;
  try {
    await db.inviteRecord.create({
      data: { inviterId: userA1.id, inviteeId: userD.id, bonusInviterSec: 1, bonusInviteeSec: 1 },
    });
  } catch {
    uniqueBlocked = true;
  }
  ok(uniqueBlocked, "同一账号重复被邀请 → unique 约束拦截");

  console.log("[阶段⑧] 页面 SSR 渲染…");
  const cookieSession = await makeSessionCookie(PHONE_A);
  const pageHtml = await (await jfetch(`${BASE}/dashboard/invite`, { headers: { Cookie: cookieSession } })).text();
  ok(pageHtml.includes(invite.inviteCode), "邀请页含我的邀请码");
  ok(pageHtml.includes("邀请记录") && pageHtml.includes("已邀请好友"), "邀请页含统计与记录区块");
  const loginHtml = await (await jfetch(`${BASE}/login?ref=${invite.inviteCode}`)).text();
  ok(loginHtml.includes("邀请码"), "登录页含邀请码输入框（?ref= 场景）");
  const dashHtml = await (await jfetch(`${BASE}/dashboard`, { headers: { Cookie: cookieSession } })).text();
  ok(dashHtml.includes("邀请好友"), "工作台含邀请好友入口");

  console.log("[阶段⑨] 清理…");
  // CreditLedger 的 user 外键无级联（财务流水有意独立于用户生命周期）——先删流水再删用户
  const testUserIds = (await db.user.findMany({
    where: { phone: { in: [PHONE_D, PHONE_E] } },
    select: { id: true },
  })).map((u) => u.id);
  await db.creditLedger.deleteMany({ where: { userId: { in: testUserIds } } });
  await db.user.deleteMany({ where: { id: { in: testUserIds } } }); // Session/InviteRecord 级联删除
  await db.user.update({ where: { id: userA1.id }, data: { balanceSeconds: { decrement: INVITER_BONUS } } });
  await db.creditLedger.deleteMany({ where: { id: aReward.id } });
  const left = await db.inviteRecord.count({ where: { inviterId: userA1.id } });
  ok(left === invitedCount0, "清理后邀请记录回到测试前数量");
  console.log("  已删除测试用户 D/E，A 余额与流水已还原");

  if (process.exitCode) {
    console.error("===== 存在失败断言 ❌ =====");
  } else {
    console.log("===== 结果：全部通过 🎉 P2.5 邀请裂变 E2E 完成 =====");
  }
}

main()
  .catch((e) => {
    console.error("E2E 异常终止：", e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
