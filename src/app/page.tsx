/**
 * @file 落地页（首页）
 * @description 产品门面：Hero 区（价值主张 + CTA）、核心功能卡片、使用流程、
 *              定价区块。定价数据与数据库种子保持一致（静态展示，后续可改 SSR 读取）。
 */
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";

/** 落地页功能点配置 */
const FEATURES = [
  {
    icon: "🎯",
    title: "精准转写",
    desc: "基于阿里云百炼语音识别大模型（qwen3-asr），中文识别准确率业界领先，自动打轴、按句分段。",
  },
  {
    icon: "✨",
    title: "AI 智能润色",
    desc: "通义千问大模型自动修正口语、错别字，补齐标点，让字幕可读性大幅提升。",
  },
  {
    icon: "🖍️",
    title: "关键词高亮",
    desc: "AI 自动识别重点词并高亮标色，显著提升短视频完播率与信息传达效率。",
  },
  {
    icon: "🎨",
    title: "样式模板",
    desc: "内置多套爆款字幕样式，字体、描边、位置一键切换，适配抖音 / B站 / 视频号。",
  },
  {
    icon: "⬇️",
    title: "一键导出",
    desc: "字幕保持原画质烧录进视频，同时提供 SRT 文件，可直接导入剪映 / PR 二次剪辑。",
  },
  {
    icon: "🔒",
    title: "隐私安全",
    desc: "视频仅用于为你生成字幕，支持随时删除，绝不用于其他用途。",
  },
];

/** 使用流程步骤 */
const STEPS = [
  { step: "1", title: "上传视频", desc: "拖拽上传，最大 500MB / 30 分钟" },
  { step: "2", title: "AI 处理", desc: "自动转写 + 润色 + 关键词标记" },
  { step: "3", title: "编辑调整", desc: "逐句校对字幕，切换样式模板" },
  { step: "4", title: "导出成品", desc: "烧录字幕导出 MP4 + SRT" },
];

/** 定价卡片（与 prisma/seed.mjs 保持一致） */
const PRICING = [
  {
    name: "免费体验",
    price: "¥0",
    unit: "",
    desc: "注册即送 30 分钟转写额度",
    features: ["完整功能体验", "高清烧录导出", "SRT 字幕导出", "全部样式模板"],
    cta: "免费开始",
    highlighted: false,
  },
  {
    name: "基础版",
    price: "¥29",
    unit: "/月",
    desc: "适合个人创作者",
    features: ["每月 5 小时转写额度", "高清烧录导出", "SRT 字幕导出", "全部样式模板"],
    cta: "立即开通",
    highlighted: true,
  },
  {
    name: "专业版",
    price: "¥99",
    unit: "/月",
    desc: "适合高频创作者 / 小团队",
    features: ["每月 20 小时转写额度", "高清烧录导出", "SRT 字幕导出", "全部样式模板"],
    cta: "立即开通",
    highlighted: false,
  },
];

/** 落地页入口组件 */
export default function HomePage() {
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />

      <main className="flex-1">
        {/* ---------- Hero 区 ---------- */}
        <section className="bg-gradient-to-b from-brand-soft to-background">
          <div className="mx-auto max-w-6xl px-4 py-24 text-center">
            <p className="mb-4 inline-block rounded-full border border-brand/20 bg-white px-4 py-1 text-sm text-brand">
              🎬 专为短视频创作者打造
            </p>
            <h1 className="mx-auto max-w-3xl text-4xl font-bold leading-tight tracking-tight sm:text-6xl">
              AI 帮你做字幕
              <span className="text-brand">，3 分钟出成品</span>
            </h1>
            <p className="mx-auto mt-6 max-w-2xl text-lg text-neutral-600">
              上传视频，自动生成精准字幕：AI 润色、关键词高亮、爆款样式模板，
              一键烧录导出。告别枯燥的逐句打轴。
            </p>
            <div className="mt-10 flex items-center justify-center gap-4">
              <a
                href="/dashboard"
                className="rounded-xl bg-brand px-8 py-3.5 text-lg font-medium text-white shadow-lg shadow-brand/25 transition-colors hover:bg-brand-strong"
              >
                免费开始使用
              </a>
              <a
                href="#features"
                className="rounded-xl border border-neutral-200 bg-white px-8 py-3.5 text-lg font-medium text-neutral-700 transition-colors hover:border-neutral-300"
              >
                了解更多
              </a>
            </div>
            <p className="mt-4 text-sm text-neutral-500">
              注册即送 30 分钟额度 · 免费体验
            </p>
          </div>
        </section>

        {/* ---------- 核心功能 ---------- */}
        <section id="features" className="mx-auto max-w-6xl px-4 py-24">
          <h2 className="text-center text-3xl font-bold tracking-tight">
            为短视频而生的完整字幕工作流
          </h2>
          <p className="mt-3 text-center text-neutral-600">
            从转写到成品，一个工具搞定
          </p>
          <div className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f) => (
              <div
                key={f.title}
                className="rounded-2xl border border-black/5 bg-white p-6 shadow-sm transition-shadow hover:shadow-md"
              >
                <div className="text-3xl">{f.icon}</div>
                <h3 className="mt-4 text-lg font-semibold">{f.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-neutral-600">
                  {f.desc}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* ---------- 使用流程 ---------- */}
        <section className="border-y border-black/5 bg-white">
          <div className="mx-auto max-w-6xl px-4 py-24">
            <h2 className="text-center text-3xl font-bold tracking-tight">
              四步出片，快得离谱
            </h2>
            <div className="mt-14 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
              {STEPS.map((s) => (
                <div key={s.step} className="relative text-center">
                  <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-brand text-lg font-bold text-white">
                    {s.step}
                  </div>
                  <h3 className="mt-4 font-semibold">{s.title}</h3>
                  <p className="mt-1 text-sm text-neutral-600">{s.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ---------- 定价 ---------- */}
        <section id="pricing" className="mx-auto max-w-6xl px-4 py-24">
          <h2 className="text-center text-3xl font-bold tracking-tight">
            简单透明的定价
          </h2>
          <p className="mt-3 text-center text-neutral-600">
            按转写时长付费，不玩套路
          </p>
          <div className="mt-14 grid gap-6 lg:grid-cols-3">
            {PRICING.map((p) => (
              <div
                key={p.name}
                className={`relative rounded-2xl border bg-white p-8 ${
                  p.highlighted
                    ? "border-brand shadow-lg shadow-brand/10"
                    : "border-black/5 shadow-sm"
                }`}
              >
                {p.highlighted && (
                  <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-brand px-3 py-1 text-xs font-medium text-white">
                    最受欢迎
                  </span>
                )}
                <h3 className="font-semibold">{p.name}</h3>
                <p className="mt-1 text-sm text-neutral-500">{p.desc}</p>
                <p className="mt-4">
                  <span className="text-4xl font-bold">{p.price}</span>
                  <span className="text-neutral-500">{p.unit}</span>
                </p>
                <ul className="mt-6 space-y-3 text-sm text-neutral-600">
                  {p.features.map((f) => (
                    <li key={f} className="flex items-start gap-2">
                      <span className="text-brand">✓</span>
                      {f}
                    </li>
                  ))}
                </ul>
                <a
                  href={p.price === "¥0" ? "/dashboard" : "/pricing"}
                  className={`mt-8 block rounded-xl py-3 text-center font-medium transition-colors ${
                    p.highlighted
                      ? "bg-brand text-white hover:bg-brand-strong"
                      : "border border-neutral-200 text-neutral-700 hover:border-neutral-300"
                  }`}
                >
                  {p.cta}
                </a>
              </div>
            ))}
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
