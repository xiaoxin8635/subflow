/**
 * @file 数据库种子脚本：写入默认套餐与字幕样式模板
 * @description 运行方式：node prisma/seed.mjs（幂等，可重复执行，存在即跳过）
 *              目的：让本地与生产环境拥有一致的基础数据。
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

/** 默认套餐配置（价格单位：人民币分；额度单位：秒） */
const DEFAULT_PLANS = [
  {
    name: "免费体验",
    priceCents: 0,
    monthlySeconds: 0,
    description: "注册即用，体验完整转写流程",
  },
  {
    name: "基础版",
    priceCents: 2900,
    monthlySeconds: 5 * 3600, // 每月 5 小时
    description: "适合个人创作者，每月 5 小时转写额度",
  },
  {
    name: "专业版",
    priceCents: 9900,
    monthlySeconds: 20 * 3600, // 每月 20 小时
    description: "适合高频创作者/小团队，每月 20 小时转写额度",
  },
];

/**
 * 默认字幕样式模板集合
 * config 结构约定（前端渲染器与 FFmpeg ASS 生成器共同遵守）：
 *   fontFamily  字体名（需为部署机可用字体）
 *   fontSize    字号（相对 1080p 高度的百分比）
 *   primaryColor 主颜色（#RRGGBB）
 *   outlineColor 描边颜色
 *   outlineWidth 描边宽度（像素 @1080p）
 *   position     垂直位置：top / center / bottom
 *   marginV      垂直边距（像素 @1080p）
 *   highlight    关键词高亮色（#RRGGBB），为空则不高亮
 */
const DEFAULT_STYLES = [
  {
    name: "经典白字黑边",
    config: {
      fontFamily: "Noto Sans SC",
      fontSize: 5.2,
      primaryColor: "#FFFFFF",
      outlineColor: "#000000",
      outlineWidth: 3,
      position: "bottom",
      marginV: 90,
      highlight: "",
    },
    isDefault: true,
  },
  {
    name: "抖音爆款黄",
    config: {
      fontFamily: "Noto Sans SC",
      fontSize: 6.0,
      primaryColor: "#FFE135",
      outlineColor: "#000000",
      outlineWidth: 4,
      position: "bottom",
      marginV: 120,
      highlight: "#FF3B30",
    },
    isDefault: false,
  },
  {
    name: "简洁纯白",
    config: {
      fontFamily: "Noto Sans SC",
      fontSize: 4.6,
      primaryColor: "#FFFFFF",
      outlineColor: "",
      outlineWidth: 0,
      position: "bottom",
      marginV: 70,
      highlight: "",
    },
    isDefault: false,
  },
];

/** 主流程：逐项幂等写入种子数据 */
async function main() {
  for (const plan of DEFAULT_PLANS) {
    const exists = await db.plan.findFirst({ where: { name: plan.name } });
    if (!exists) {
      await db.plan.create({ data: plan });
      console.log(`[seed] 已创建套餐：${plan.name}`);
    }
  }

  for (const style of DEFAULT_STYLES) {
    const exists = await db.style.findFirst({ where: { name: style.name } });
    if (!exists) {
      await db.style.create({ data: style });
      console.log(`[seed] 已创建样式：${style.name}`);
    }
  }

  console.log("[seed] 完成");
}

main()
  .catch((e) => {
    console.error("[seed] 失败：", e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
