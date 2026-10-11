// =====================================================================
// SubFlow E2E — P2.8 加油包（一次性时长包）专项
// 覆盖：购买页 SSR 渲染加油包档位（名称/价格/时长/单价/标签，未登录可看）
//       → 按档位秒数生成时长激活码（复用 gen-redeem-codes.mjs 发码工具）
//       → 兑换到账（余额增加、REDEEM_BONUS 流水）→ 重复兑换 409
//       → 档位常量与购买页/发码同源一致性 → 清理（码/流水/余额扣回）
// 前提：PostgreSQL 运行中、server 运行中（登录态接口用）。零 LLM/API 费用。
// 运行：node scripts/e2e-addon-test.mjs
// =====================================================================
import { spawnSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

const BASE = process.env.E2E_BASE ?? "http://localhost:3000";
const PHONE_A = process.env.E2E_PHONE_A ?? "13900002501";
const CODE = "123456"; // SMS_DEV_MODE 万能码

/** 体验档：与 constants.ts ADDON_PACKAGES[0] 同源（3600 秒 / ¥9.9） */
const STARTER = { id: "starter", name: "体验加油包", priceCents: 990, seconds: 3600 };

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
 * 登录并返回 Cookie（发码 60s 冷却 429 时等 65s 重试一次）
 * @param phone 手机号
 */
async function login(phone) {
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
    body: JSON.stringify({ phone, code: CODE }),
  });
  if (!res.ok) throw new Error(`登录失败 HTTP ${res.status}`);
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("登录响应缺少 set-cookie");
  return setCookie.split(";")[0];
}

async function main() {
  console.log("[阶段①] 购买页 SSR 渲染加油包（未登录可看）…");
  const res = await jfetch(`${BASE}/pricing`);
  const html = await res.text();
  ok(res.status === 200, "GET /pricing → 200");
  ok(html.includes("加油包"), "页面含「加油包」区块标题");
  ok(html.includes(STARTER.name), `含档位名「${STARTER.name}」`);
  ok(html.includes("9.9"), "含体验档价格 ¥9.9");
  ok(html.includes("1 小时"), "含体验档时长（3600 秒 → 展示为「1 小时」）");
  ok(html.includes("标准加油包") && html.includes("大容量加油包"), "三档齐全（标准/大容量）");
  ok(html.includes("最受欢迎"), "含「最受欢迎」推荐标签");
  ok(html.includes("/ 分钟"), "含折合单价展示");
  ok(html.includes("无需月付"), "含一次性语义文案");

  console.log("[阶段②] 按档位秒数生成激活码（发码工具同源）…");
  const gen = spawnSync("node", [
    "scripts/gen-redeem-codes.mjs", "--seconds", String(STARTER.seconds), "--count", "1",
  ], { encoding: "utf8", cwd: process.cwd() });
  ok(gen.status === 0, `发码脚本执行成功（${STARTER.seconds} 秒 × 1）`);
  const codeMatch = gen.stdout.match(/SUBF-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}/);
  ok(!!codeMatch, "stdout 提取到 SUBF 激活码");
  const redeemCode = codeMatch[0];
  const codeRow = await db.redeemCode.findUnique({ where: { code: redeemCode } });
  ok(codeRow?.bonusSeconds === STARTER.seconds && codeRow.status === "UNUSED",
    `落库校验：bonusSeconds=${STARTER.seconds}、状态 UNUSED`);

  console.log("[阶段③] 兑换到账…");
  const cookieA = await login(PHONE_A);
  const userA = await db.user.findUnique({ where: { phone: PHONE_A } });
  const balBefore = userA.balanceSeconds;
  const r1 = await jfetch(`${BASE}/api/redeem`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieA },
    body: JSON.stringify({ code: redeemCode }),
  });
  const body1 = await r1.json();
  ok(r1.status === 200 && body1.addedSeconds === STARTER.seconds,
    `兑换 → 200（到账 ${body1.addedSeconds} 秒 = 档位时长）`);
  const userA2 = await db.user.findUnique({ where: { id: userA.id } });
  ok(userA2.balanceSeconds === balBefore + STARTER.seconds,
    `余额 ${balBefore} → ${userA2.balanceSeconds}（+${STARTER.seconds}）`);
  const ledger = await db.creditLedger.findFirst({
    where: { userId: userA.id, reason: "REDEEM_BONUS", refId: codeRow.id },
  });
  ok(ledger?.changeSeconds === STARTER.seconds, "REDEEM_BONUS 流水落库");

  console.log("[阶段④] 重复兑换 409…");
  const r2 = await jfetch(`${BASE}/api/redeem`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieA },
    body: JSON.stringify({ code: redeemCode }),
  });
  ok(r2.status === 409, "同一激活码二次兑换 → 409（防重复核销）");

  console.log("[阶段⑤] 清理…");
  await db.creditLedger.deleteMany({ where: { refId: codeRow.id } });
  await db.redeemCode.delete({ where: { id: codeRow.id } });
  await db.user.update({
    where: { id: userA.id },
    data: { balanceSeconds: { decrement: STARTER.seconds } },
  });
  const leftCode = await db.redeemCode.count({ where: { id: codeRow.id } });
  ok(leftCode === 0, "激活码已删除");
  console.log("  测试激活码/流水已清理，余额已扣回");

  if (process.exitCode) {
    console.error("===== 存在失败断言 ❌ =====");
  } else {
    console.log("===== 结果：全部通过 🎉 P2.8 加油包 E2E 完成 =====");
  }
}

main()
  .catch((e) => {
    console.error("E2E 异常终止：", e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
