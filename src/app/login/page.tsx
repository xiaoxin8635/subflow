"use client";
/**
 * @file 登录页（手机号 + 短信验证码）
 * @description 客户端组件：手机号格式校验、验证码 60 秒倒计时、提交登录。
 *              依赖 API：POST /api/auth/sms（发码）、POST /api/auth/login（登录）。
 */

import { useState } from "react";
import { SiteHeader } from "@/components/site-header";
import { PHONE_RE } from "@/lib/constants";

/** 登录页组件 */
export default function LoginPage() {
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [countdown, setCountdown] = useState(0);
  const [sending, setSending] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<{ type: "error" | "info"; text: string } | null>(
    null,
  );

  /** 手机号是否有效 */
  const phoneValid = PHONE_RE.test(phone);

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
    if (!phoneValid || code.length !== 6 || submitting) return;
    setSubmitting(true);
    setMessage(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, code }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "登录失败");
      window.location.href = "/dashboard";
    } catch (e) {
      setMessage({ type: "error", text: e instanceof Error ? e.message : "登录失败" });
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main className="flex flex-1 items-center justify-center px-4 py-16">
        <div className="w-full max-w-sm rounded-2xl border border-black/5 bg-white p-8 shadow-sm">
          <h1 className="text-2xl font-bold tracking-tight">登录 / 注册</h1>
          <p className="mt-2 text-sm text-neutral-500">
            未注册的手机号将自动创建账号，并获得 30 分钟免费额度
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
                className="w-full rounded-xl border border-neutral-200 px-4 py-2.5 outline-none transition-colors focus:border-brand"
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
                  className="w-full rounded-xl border border-neutral-200 px-4 py-2.5 outline-none transition-colors focus:border-brand"
                />
                <button
                  type="button"
                  onClick={handleSendCode}
                  disabled={!phoneValid || countdown > 0 || sending}
                  className="shrink-0 rounded-xl border border-brand/30 bg-brand-soft px-4 text-sm font-medium text-brand transition-colors hover:bg-brand/10 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {countdown > 0 ? `${countdown}s` : sending ? "发送中…" : "获取验证码"}
                </button>
              </div>
            </div>

            {/* 提示信息 */}
            {message && (
              <p
                className={`text-sm ${message.type === "error" ? "text-red-600" : "text-green-600"}`}
              >
                {message.text}
              </p>
            )}

            {/* 登录按钮 */}
            <button
              type="submit"
              disabled={!phoneValid || code.length !== 6 || submitting}
              className="w-full rounded-xl bg-brand py-3 font-medium text-white transition-colors hover:bg-brand-strong disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? "登录中…" : "登录"}
            </button>
          </form>
        </div>
      </main>
    </div>
  );
}
