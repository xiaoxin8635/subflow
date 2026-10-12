/**
 * @file 购买页（/pricing，服务端组件）
 * @description 展示在售套餐（数据来自 Plan 表，与后台发码同一数据源）与
 *              一次性加油包档位（ADDON_PACKAGES 常量，与后台快捷发码同源），
 *              以及 MVP 阶段的购买流程：扫码付款 → 客服发激活码 → 兑换到账。
 *              收款码图片放 public/pay-qr/wechat.png 与 alipay.png（可任选其一配置），
 *              未配置时显示待配置占位（不影响页面结构）。
 */
import fs from "node:fs";
import path from "node:path";
import Link from "next/link";
import { db } from "@/lib/db";
import { ADDON_PACKAGES } from "@/lib/constants";
import { SiteHeader } from "@/components/site-header";

// 读取数据库套餐（动态渲染声明，Cache Components 下必须显式）
export const instant = false;

/** 收款码图片路径（public 下相对路径） */
const QR_FILES = [
  { key: "wechat", label: "微信支付", file: "pay-qr/wechat.png" },
  { key: "alipay", label: "支付宝", file: "pay-qr/alipay.png" },
] as const;

/**
 * 检查收款码图片是否已配置（public 目录存在性检查）
 * @param rel public 下相对路径
 */
function qrExists(rel: string): boolean {
  return fs.existsSync(
    path.join(/* turbopackIgnore: true */ process.cwd(), "public", rel),
  );
}

/** 分 → 元展示（如 1990 → "19.9"） */
function yuan(cents: number): string {
  return (cents / 100).toFixed(cents % 100 === 0 ? 0 : 2);
}

/** 秒数格式化为「X 小时 / X 分钟」 */
function formatSeconds(total: number): string {
  const hours = Math.floor(total / 3600);
  const minutes = Math.round((total % 3600) / 60);
  if (hours > 0) return `${hours} 小时${minutes > 0 ? ` ${minutes} 分钟` : ""}`;
  return `${total} 秒`;
}

/** 购买页入口组件 */
export default async function PricingPage() {
  const plans = await db.plan.findMany({
    where: { isActive: true },
    orderBy: { priceCents: "asc" },
  });

  return (
    <div className="flex min-h-screen flex-col bg-neutral-50">
      <SiteHeader />
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-12">
        <h1 className="text-center text-3xl font-bold tracking-tight">购买额度</h1>
        <p className="mt-2 text-center text-neutral-600">
          按转写时长付费，付款后客服发放激活码，兑换即时到账
        </p>

        {/* 套餐卡片：三档时中间档为推荐位（与加油包「最受欢迎」同语言） */}
        <div className="mt-10 grid gap-6 md:grid-cols-3">
          {plans.map((p, i) => {
            const featured = plans.length === 3 && i === 1;
            return (
              <div
                key={p.id}
                className={`relative rounded-2xl border bg-white p-8 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md ${
                  featured ? "border-brand/40 ring-1 ring-brand/20" : "border-black/5"
                }`}
              >
                {featured && (
                  <span className="absolute -top-3 left-6 rounded-full bg-brand px-3 py-0.5 text-xs font-medium text-white">
                    最受欢迎
                  </span>
                )}
                <h2 className="font-semibold">{p.name}</h2>
                {p.description && (
                  <p className="mt-1 text-sm text-neutral-500">{p.description}</p>
                )}
                <p className="mt-4">
                  <span className="text-4xl font-bold">¥{yuan(p.priceCents)}</span>
                  <span className="text-neutral-500"> /月</span>
                </p>
                <ul className="mt-6 space-y-2 text-sm text-neutral-600">
                  <li className="flex items-center gap-2">
                    <span className="text-brand">✓</span>每月 {formatSeconds(p.monthlySeconds)} 转写额度
                  </li>
                  <li className="flex items-center gap-2">
                    <span className="text-brand">✓</span>AI 润色 + 关键词高亮
                  </li>
                  <li className="flex items-center gap-2">
                    <span className="text-brand">✓</span>高清成片导出
                  </li>
                </ul>
                {/* CTA：锚到页面底部付款区（MVP 激活码模式无在线支付） */}
                <a
                  href="#pay"
                  className={`mt-8 block rounded-xl py-2.5 text-center text-sm font-medium transition-colors ${
                    featured
                      ? "bg-brand text-white hover:bg-brand-strong"
                      : "border border-brand/30 bg-brand-soft text-brand hover:bg-brand/10"
                  }`}
                >
                  扫码购买
                </a>
              </div>
            );
          })}
          {plans.length === 0 && (
            <p className="col-span-3 text-center text-sm text-neutral-400">
              暂无在售套餐，请稍后再来
            </p>
          )}
        </div>

        {/* 一次性加油包（P2.8）：无需订阅，买多少用多少，用完可再购 */}
        <section className="mt-12">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-xl font-semibold">⚡ 加油包（一次性额度）</h2>
            <p className="text-sm text-neutral-500">
              不想订阅？买多少用多少，额度永久有效，用完可再购
            </p>
          </div>
          <div className="mt-5 grid gap-6 md:grid-cols-3">
            {ADDON_PACKAGES.map((pkg, i) => {
              const pricePerMin = (pkg.priceCents / 100 / (pkg.seconds / 60)).toFixed(2);
              return (
                <div
                  key={pkg.id}
                  className={`relative rounded-2xl border bg-white p-6 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md ${
                    i === 1 ? "border-brand/40 ring-1 ring-brand/20" : "border-black/5"
                  }`}
                >
                  {i === 1 && (
                    <span className="absolute -top-3 left-6 rounded-full bg-brand px-3 py-0.5 text-xs font-medium text-white">
                      最受欢迎
                    </span>
                  )}
                  <h3 className="font-semibold">{pkg.name}</h3>
                  <p className="mt-3">
                    <span className="text-3xl font-bold">¥{yuan(pkg.priceCents)}</span>
                    <span className="text-neutral-500"> / {formatSeconds(pkg.seconds)}</span>
                  </p>
                  <p className="mt-1 text-xs text-neutral-400">
                    折合 ¥{pricePerMin} / 分钟 · 一次性到手，无需月付
                  </p>
                  <p className="mt-4 text-sm text-neutral-600">
                    兑换后额度直接进账户余额，转写 / 导出 / 翻译通用
                  </p>
                </div>
              );
            })}
          </div>
        </section>

        {/* 购买流程（id 供套餐卡 CTA 锚点滚动） */}
        <section id="pay" className="mt-12 scroll-mt-20 rounded-2xl border border-black/5 bg-white p-8 shadow-sm">
          <h2 className="text-lg font-semibold">购买流程（三步到账）</h2>
          <ol className="mt-6 grid gap-6 md:grid-cols-3">
            <li>
              <p className="text-sm font-medium text-brand">① 扫码付款</p>
              <p className="mt-1 text-sm text-neutral-600">
                扫下方收款码，按套餐或加油包价格付款，备注您的手机号后 4 位
              </p>
            </li>
            <li>
              <p className="text-sm font-medium text-brand">② 获取激活码</p>
              <p className="mt-1 text-sm text-neutral-600">
                客服核对到账后，将激活码发送到您的手机（短信/微信）
              </p>
            </li>
            <li>
              <p className="text-sm font-medium text-brand">③ 兑换到账</p>
              <p className="mt-1 text-sm text-neutral-600">
                在工作台「兑换额度」输入激活码，额度立即到账
              </p>
            </li>
          </ol>

          {/* 收款码区 */}
          <div className="mt-8 grid gap-6 sm:grid-cols-2">
            {QR_FILES.map((q) =>
              qrExists(q.file) ? (
                <div key={q.key} className="mx-auto text-center">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`/${q.file}`}
                    alt={`${q.label}收款码`}
                    width={200}
                    height={200}
                    className="rounded-xl border border-neutral-200"
                  />
                  <p className="mt-2 text-sm text-neutral-500">{q.label}</p>
                </div>
              ) : (
                <div
                  key={q.key}
                  className="flex h-[200px] w-[200px] flex-col items-center justify-center rounded-xl border-2 border-dashed border-neutral-200 text-center"
                >
                  <p className="text-sm text-neutral-400">{q.label}收款码待配置</p>
                  <p className="mt-1 px-4 text-xs text-neutral-300">
                    将图片放到 public/{q.file}
                  </p>
                </div>
              ),
            )}
          </div>

          <div className="mt-8 text-center">
            <Link
              href="/dashboard/redeem"
              className="inline-block rounded-xl bg-brand px-8 py-3 font-medium text-white transition-colors hover:bg-brand-strong"
            >
              已购？去兑换激活码
            </Link>
          </div>
        </section>
      </main>
    </div>
  );
}
