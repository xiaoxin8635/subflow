"use client";
/**
 * @file 侧边栏底部「退出登录」按钮（客户端组件）
 * @description POST /api/auth/logout 清除会话后跳转首页并刷新服务端缓存。
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { API_ROUTES } from "@/lib/constants";

/** 退出登录按钮（侧边栏底部：整行左对齐样式） */
export function LogoutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  /** 提交登出请求并回首页 */
  async function handleLogout() {
    if (busy) return;
    setBusy(true);
    try {
      await fetch(API_ROUTES.logout, { method: "POST" });
      router.push("/");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleLogout}
      disabled={busy}
      className="w-full rounded-lg px-3 py-2 text-left text-sm text-neutral-400 transition-colors hover:bg-white/5 hover:text-white disabled:opacity-50"
    >
      {busy ? "退出中…" : "退出登录"}
    </button>
  );
}

/**
 * 退出登录按钮（移动端顶部标签栏末尾：紧凑行内样式）
 * @description 移动端无侧边栏用户区，退出入口挂在横向标签栏最后。
 */
export function MobileLogout() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  /** 提交登出请求并回首页 */
  async function handleLogout() {
    if (busy) return;
    setBusy(true);
    try {
      await fetch(API_ROUTES.logout, { method: "POST" });
      router.push("/");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleLogout}
      disabled={busy}
      className="shrink-0 rounded-lg px-3 py-1.5 text-sm text-neutral-500 transition-colors hover:text-white disabled:opacity-50"
    >
      {busy ? "退出中…" : "退出"}
    </button>
  );
}
