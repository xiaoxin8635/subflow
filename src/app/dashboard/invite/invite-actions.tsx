"use client";
/**
 * @file 邀请页交互组件（P2.5）：复制邀请链接 / 复制邀请码
 * @description 客户端组件（剪贴板操作需要浏览器权限）：
 *              - 复制邀请链接：{origin}/login?ref={code}（部署后即完整域名）
 *              - 复制邀请码：纯码文本，方便微信/短信手动发送
 *              复制成功显示 2 秒反馈；剪贴板 API 不可用时降级选中提示。
 */
import { useRef, useState } from "react";

/** 邀请交互组件 */
export function InviteActions({ inviteCode }: { inviteCode: string }) {
  const [copied, setCopied] = useState<"link" | "code" | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** 复制文本并展示 2 秒成功反馈 */
  async function copy(text: string, kind: "link" | "code") {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(null), 2000);
    } catch {
      // 剪贴板权限被拒等场景：静默失败，用户可手动选中复制
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        onClick={() => void copy(`${window.location.origin}/login?ref=${inviteCode}`, "link")}
        className="rounded-xl bg-gradient-to-r from-brand to-brand-strong px-5 py-2.5 text-sm font-medium text-white shadow-[0_4px_0_0_#0f766e] transition-all duration-150 hover:-translate-y-0.5 hover:shadow-[0_6px_0_0_#0f766e] active:translate-y-0.5 active:shadow-[0_1px_0_0_#0f766e]"
      >
        {copied === "link" ? "已复制链接 ✓" : "复制邀请链接"}
      </button>
      <button
        type="button"
        onClick={() => void copy(inviteCode, "code")}
        className="rounded-xl border border-black/10 px-5 py-2.5 text-sm font-medium text-neutral-600 transition-colors hover:border-brand hover:text-brand"
      >
        {copied === "code" ? "已复制码 ✓" : "复制邀请码"}
      </button>
    </div>
  );
}
