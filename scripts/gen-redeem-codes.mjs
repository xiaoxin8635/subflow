/**
 * @file 激活码生成脚本（node scripts/gen-redeem-codes.mjs）
 * @description 直接操作数据库批量生成激活码并打印到控制台（同时落库 RedeemCode 表）。
 *              码格式：SUBF-XXXX-XXXX-XXXX，字符集剔除易混淆的 0/O/1/I/L。
 * 用法：
 *   node scripts/gen-redeem-codes.mjs --seconds 600 --count 5      # 生成 5 个 600 秒时长码
 *   node scripts/gen-redeem-codes.mjs --plan 基础版 --count 3      # 生成 3 个「基础版」套餐码
 * 前提：PostgreSQL 运行中、prisma generate 已执行、.env 已配置 DATABASE_URL。
 */
import crypto from "node:crypto";
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

/** 码字符集（剔除 0/O/1/I/L 易混淆字符） */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
/** 一段码的字符数 */
const GROUP_LEN = 4;
/** 一枚激活码的段数（含前缀段 SUBF） */
const GROUPS = 4;

/**
 * 解析命令行参数（--seconds N / --plan 名称 / --count N）
 * @returns { seconds?: number, plan?: string, count: number }
 */
function parseArgs() {
  const argv = process.argv.slice(2);
  const get = (key) => {
    const i = argv.indexOf(key);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const seconds = get("--seconds") ? Number(get("--seconds")) : undefined;
  const plan = get("--plan");
  const count = Math.min(Number(get("--count") ?? 1) || 1, 100); // 单次上限 100，防误操作
  if (!seconds && !plan) {
    console.error("用法：node scripts/gen-redeem-codes.mjs --seconds 600 --count 5");
    console.error("      node scripts/gen-redeem-codes.mjs --plan 基础版 --count 3");
    process.exit(1);
  }
  if (seconds != null && (!Number.isFinite(seconds) || seconds <= 0)) {
    console.error("--seconds 必须为正整数（单位：秒）");
    process.exit(1);
  }
  return { seconds, plan, count };
}

/**
 * 生成一枚随机码：SUBF-XXXX-XXXX-XXXX
 */
function generateCode() {
  const groups = [];
  for (let g = 0; g < GROUPS - 1; g++) {
    let s = "";
    for (let i = 0; i < GROUP_LEN; i++) {
      s += ALPHABET[crypto.randomInt(ALPHABET.length)];
    }
    groups.push(s);
  }
  return `SUBF-${groups.join("-")}`;
}

async function main() {
  const { seconds, plan, count } = parseArgs();

  let planId = null;
  let planName = null;
  if (plan) {
    const record = await db.plan.findFirst({ where: { name: plan, isActive: true } });
    if (!record) {
      console.error(`套餐「${plan}」不存在或已下架。可先运行 npx tsx prisma/seed.mjs 写入种子套餐。`);
      process.exit(1);
    }
    planId = record.id;
    planName = record.name;
  }

  console.log(`生成 ${count} 枚激活码（${planName ? `套餐：${planName}，每月 ${seconds ?? "?"} ` : `时长：${seconds} 秒`}）…\n`);

  const codes = [];
  for (let i = 0; i < count; i++) {
    // 唯一约束冲突重试（随机碰撞概率极低，兜底 5 次）
    for (let attempt = 0; ; attempt++) {
      const code = generateCode();
      try {
        await db.redeemCode.create({
          data: { code, planId, bonusSeconds: planId ? null : seconds },
        });
        codes.push(code);
        break;
      } catch (e) {
        // 仅唯一约束冲突（P2002）换码重试；其他错误（如 DB 断连）立即抛出
        if (e?.code !== "P2002" || attempt >= 5) throw e;
      }
    }
  }

  console.log("========== 复制以下激活码 ==========");
  for (const c of codes) console.log(c);
  console.log("====================================");
  console.log(`\n已落库 ${codes.length} 枚（状态 UNUSED）。`);
}

main()
  .catch((e) => {
    console.error("生成失败：", e.message);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
