"use client";
/**
 * @file 登录页（手机号 + 短信验证码，支持邀请码）——左右分栏版式
 * @description 桌面端（≥lg）左侧为产品舞台：一个迷你播放器 mock（青蓝紫柔和
 *               渐变视频帧上字幕逐句浮现、关键词品牌色高亮，下方声波条做起伏
 *               动画呼应编辑器音轨），纯 CSS 动画、尊重 prefers-reduced-motion；
 *               右侧为登录卡。移动端只保留顶部 Logo 行 + 登录卡。表单逻辑：
 *               手机号格式校验、验证码 60 秒倒计时、邀请码默认收起（?ref=CODE
 *               链接进入时自动展开填充）、提交登录；仅新用户注册时生效。
 *               依赖 API：POST /api/auth/sms（发码）、POST /api/auth/login（登录）。
 */

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { PHONE_RE, INVITE_CODE_RE } from "@/lib/constants";

/** 播放器 mock 里轮播的一句字幕（before + 关键词高亮 + after 拼成整句） */
const CAPTIONS = [
  { before: "大家好，欢迎来到", kw: "我的频道", after: "" },
  { before: "今天带大家逛逛", kw: "老城区", after: "的巷子" },
  { before: "这条街已有", kw: "一百年", after: "历史，还是老味道" },
];

/** 波形条高度序列（%）：确定性伪随机，呼应编辑器的音频波形轨道 */
const WAVE_BARS = [
  38, 62, 45, 80, 30, 55, 90, 48, 66, 35, 74, 52, 88, 42, 60, 28, 70, 46, 82,
  36, 58, 76, 44, 64, 32, 78, 50, 68, 40, 56,
];

/** 已播放染色的波形条数量（约前 1/3，模拟播放进度） */
const WAVE_PLAYED = 11;

/** 左侧产品舞台的三条价值点（stroke 线性图标风格与工作台侧边栏一致） */
const VALUE_PROPS: { icon: ReactNode; title: string; desc: string }[] = [
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" className="h-4 w-4">
        <path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4" />
      </svg>
    ),
    title: "语音转字幕",
    desc: "中文 / 英文视频，几分钟出稿",
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
        <circle cx="12" cy="12" r="10" />
        <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
      </svg>
    ),
    title: "一键翻译",
    desc: "译文与原文逐句对齐，时间轴不动",
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
        <path d="M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1-.3 2.1.3 2.4 1.4Z" />
        <path d="m6.2 5.3 3.1 3.9" />
        <path d="m12.4 3.4 3.1 4" />
        <path d="M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
      </svg>
    ),
    title: "烧录成片",
    desc: "关键词高亮样式，直接导出视频",
  },
];

/** 登录页组件 */
export default function LoginPage() {
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [inviteOpen, setInviteOpen] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [sending, setSending] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<{ type: "error" | "info"; text: string } | null>(
    null,
  );

  /** 手机号是否有效 */
  const phoneValid = PHONE_RE.test(phone);
  /** 邀请码选填：空值合法，非空须匹配字符集 */
  const inviteValid = inviteCode === "" || INVITE_CODE_RE.test(inviteCode.toUpperCase());

  // 邀请链接 ?ref=CODE 自动填充并展开邀请码输入（微任务包裹：避免 effect 内同步 setState 触发 eslint 规则）
  useEffect(() => {
    void Promise.resolve().then(() => {
      const ref = new URLSearchParams(window.location.search).get("ref");
      if (ref) {
        setInviteCode(ref.trim().toUpperCase());
        setInviteOpen(true);
      }
    });
  }, []);

  /** 请求发送短信验证码，并启动 60 秒倒计时 */
  async function handleSendCode() {
    if (!phoneValid || countdown > 0 || sending) return;
    setSending(true);
    setMessage(null);
    try {
      const res = await fetch("/api/auth/sms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "发送失败");
      setMessage({ type: "info", text: "验证码已发送，请注意查收" });
      setCountdown(60);
      const timer = setInterval(() => {
        setCountdown((c) => {
          if (c <= 1) clearInterval(timer);
          return c - 1;
        });
      }, 1000);
    } catch (e) {
      setMessage({ type: "error", text: e instanceof Error ? e.message : "发送失败" });
    } finally {
      setSending(false);
    }
  }

  /** 提交手机号 + 验证码登录，成功后跳转工作台 */
  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    if (!phoneValid || code.length !== 6 || !inviteValid || submitting) return;
    setSubmitting(true);
    setMessage(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, code, inviteCode: inviteCode.trim().toUpperCase() || undefined }),
      });
      const body = (await res.json().catch(() => ({}))) as { inviteApplied?: boolean };
      if (!res.ok) throw new Error((body as { error?: string }).error ?? "登录失败");
      window.location.href = "/dashboard";
    } catch (e) {
      setMessage({ type: "error", text: e instanceof Error ? e.message : "登录失败" });
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-background lg:grid lg:grid-cols-[1.1fr_1fr]">
      {/* ============ 左侧产品舞台（桌面端） ============ */}
      <aside className="hidden flex-col bg-[linear-gradient(180deg,#f0fdfa_0%,#fafafa_100%)] p-10 lg:flex xl:p-14">
        {/* Logo（链接回首页） */}
        <Link href="/" className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand text-sm font-bold text-white">
            SF
          </span>
          <span className="text-lg font-semibold tracking-tight">
            SubFlow{" "}
            <span className="text-sm font-normal text-neutral-500">字幕工坊</span>
          </span>
        </Link>

        <div className="flex flex-1 flex-col justify-center py-10">
          {/* 主张文案 */}
          <h2 className="text-3xl font-semibold leading-tight tracking-tight xl:text-4xl">
            上传一段视频，
            <br />
            拿回一套能直接用的字幕
          </h2>

          {/* 迷你播放器 mock：字幕逐句浮现（产品核心产出的直观预览） */}
          <div className="mt-8 max-w-lg overflow-hidden rounded-2xl shadow-[0_24px_60px_-18px_rgba(13,148,136,0.35)]">
            <div className="relative aspect-video bg-[linear-gradient(135deg,#3730a3_0%,#6366f1_55%,#14b8a6_130%)]">
              {/* 播放按钮（静态装饰，中央半透明圆钮） */}
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="flex h-14 w-14 items-center justify-center rounded-full border border-white/30 bg-white/10 backdrop-blur-sm">
                  <svg viewBox="0 0 24 24" fill="white" className="ml-1 h-5 w-5" aria-hidden>
                    <path d="M8 5.14v13.72c0 .8.87 1.3 1.56.88l10.54-6.86a1.05 1.05 0 0 0 0-1.76L9.56 4.26A1.04 1.04 0 0 0 8 5.14z" />
                  </svg>
                </span>
              </div>
              {/* 字幕层：三句轮播（login-caption 动画见 globals.css） */}
              <div className="absolute inset-x-0 bottom-6 flex justify-center px-8">
                <div className="relative h-12 w-full max-w-sm">
                  {CAPTIONS.map((c, i) => (
                    <p
                      key={i}
                      className="login-caption absolute inset-0 flex items-end justify-center text-center text-sm leading-snug text-white [text-shadow:0_1px_4px_rgba(0,0,0,0.6)] sm:text-base"
                    >
                      <span>
                        {c.before}
                        <span className="font-medium text-teal-300">{c.kw}</span>
                        {c.after}
                      </span>
                    </p>
                  ))}
                </div>
              </div>
              {/* 时长角标（与项目封面同款位置语言） */}
              <span className="absolute bottom-3 right-3 rounded bg-black/50 px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-white">
                00:35
              </span>
            </div>
          </div>

          {/* 波形条（呼应编辑器音轨；前段品牌色 = 已播放染色，整体做声波起伏动画） */}
          <div className="mt-5 flex h-10 max-w-lg items-center gap-[3px]" aria-hidden>
            {WAVE_BARS.map((v, i) => (
              <span
                key={i}
                className={`login-wave w-1 rounded-full ${i < WAVE_PLAYED ? "bg-brand" : "bg-teal-200"}`}
                style={{ height: `${v}%`, animationDelay: `${(i % 10) * 0.14}s` }}
              />
            ))}
          </div>

          {/* 三条价值点（平铺行，不做卡片阵列） */}
          <ul className="mt-8 max-w-lg space-y-4">
            {VALUE_PROPS.map((p) => (
              <li key={p.title} className="flex items-start gap-3">
                <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand">
                  {p.icon}
                </span>
                <span>
                  <span className="block text-sm font-medium">{p.title}</span>
                  <span className="mt-0.5 block text-sm text-neutral-500">{p.desc}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>

        {/* 页脚微文案 */}
        <p className="text-xs text-neutral-400">无需安装，全部流程在浏览器完成</p>
      </aside>

      {/* ============ 右侧登录卡 ============ */}
      <main className="flex flex-1 flex-col items-center justify-center px-4 py-12">
        {/* 移动端顶部 Logo 行（桌面端左侧已有） */}
        <Link href="/" className="mb-8 flex items-center gap-2 lg:hidden">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand text-sm font-bold text-white">
            SF
          </span>
          <span className="text-lg font-semibold tracking-tight">
            SubFlow{" "}
            <span className="text-sm font-normal text-neutral-500">字幕工坊</span>
          </span>
        </Link>

        <div className="w-full max-w-sm rounded-2xl border border-black/5 bg-white p-8 shadow-[0_12px_40px_-12px_rgba(15,60,52,0.14)]">
          <h1 className="text-2xl font-bold tracking-tight">登录 / 注册</h1>
          <p className="mt-2 text-sm text-neutral-500">
            未注册的手机号将自动创建账号，并获得{" "}
            <span className="font-medium text-coral">30 分钟免费额度</span>
          </p>

          <form onSubmit={handleLogin} className="mt-8 space-y-4">
            {/* 手机号 */}
            <div>
              <label htmlFor="phone" className="mb-1.5 block text-sm font-medium">
                手机号
              </label>
              <input
                id="phone"
                type="tel"
                inputMode="numeric"
                maxLength={11}
                placeholder="请输入手机号"
                value={phone}
                onChange={(e) => setPhone(e.target.value.replace(/\D/g, ""))}
                className="w-full rounded-xl border border-neutral-200 bg-neutral-50 px-4 py-2.5 outline-none transition-colors focus:border-brand focus:bg-white"
              />
            </div>

            {/* 验证码 */}
            <div>
              <label htmlFor="code" className="mb-1.5 block text-sm font-medium">
                验证码
              </label>
              <div className="flex gap-2">
                <input
                  id="code"
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  placeholder="6 位验证码"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                  className="w-full rounded-xl border border-neutral-200 bg-neutral-50 px-4 py-2.5 outline-none transition-colors focus:border-brand focus:bg-white"
                />
                <button
                  type="button"
                  onClick={handleSendCode}
                  disabled={!phoneValid || countdown > 0 || sending}
                  className="shrink-0 rounded-xl border border-brand bg-white px-4 text-sm font-medium text-brand transition-colors hover:bg-brand-soft disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {countdown > 0 ? `${countdown}s` : sending ? "发送中…" : "获取验证码"}
                </button>
              </div>
            </div>

            {/* 邀请码（选填，默认收起；?ref=CODE 链接进入时自动展开填充） */}
            <div>
              {inviteOpen ? (
                <>
                  <div className="mb-1.5 flex items-center justify-between">
                    <label htmlFor="invite" className="block text-sm font-medium">
                      邀请码 <span className="font-normal text-neutral-400">（选填）</span>
                    </label>
                    <button
                      type="button"
                      onClick={() => setInviteOpen(false)}
                      className={`text-xs text-neutral-400 transition-colors hover:text-neutral-600 ${inviteCode ? "invisible" : ""}`}
                    >
                      收起
                    </button>
                  </div>
                  <input
                    id="invite"
                    type="text"
                    maxLength={8}
                    placeholder="好友邀请码，双方各得额外额度"
                    value={inviteCode}
                    onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
                    className={`w-full rounded-xl border bg-neutral-50 px-4 py-2.5 outline-none transition-colors focus:border-brand focus:bg-white ${
                      inviteValid ? "border-neutral-200" : "border-red-300"
                    }`}
                  />
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setInviteOpen(true)}
                  className="flex w-full items-center gap-1.5 text-sm text-neutral-400 transition-colors hover:text-brand"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden>
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                  填写邀请码，双方各得额外额度
                </button>
              )}
            </div>

            {/* 提示信息 */}
            {message && (
              <p
                className={`text-sm ${message.type === "error" ? "text-red-600" : "text-brand-strong"}`}
              >
                {message.text}
              </p>
            )}

            {/* 登录按钮 */}
            <button
              type="submit"
              disabled={!phoneValid || code.length !== 6 || !inviteValid || submitting}
              className="w-full rounded-xl bg-gradient-to-r from-brand to-brand-strong py-3 font-medium text-white shadow-[0_4px_0_0_#0f766e] transition-all duration-150 hover:-translate-y-0.5 hover:shadow-[0_6px_0_0_#0f766e] active:translate-y-0.5 active:shadow-[0_1px_0_0_#0f766e] disabled:cursor-not-allowed disabled:opacity-50 disabled:translate-y-0 disabled:shadow-none"
            >
              {submitting ? "登录中…" : "登录"}
            </button>
          </form>
        </div>

        {/* 条款提示 */}
        <p className="mt-6 text-center text-xs text-neutral-400">
          登录即表示同意
          <Link href="/terms" className="underline underline-offset-2 hover:text-neutral-600">
            《服务条款》
          </Link>
          与
          <Link href="/privacy" className="underline underline-offset-2 hover:text-neutral-600">
            《隐私政策》
          </Link>
        </p>
      </main>
    </div>
  );
}
