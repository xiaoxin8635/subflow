"use client";

/**
 * @file 站内通知铃铛（P1.3 任务完成通知）
 * @description 客户端组件：60 秒轮询 GET /api/notifications 展示未读红点，
 *              点击打开下拉列表（最近 30 条），点条目标记已读并跳转 link，
 *              支持「全部已读」。tab 可见时立即刷新一次（回页即见最新）。
 *              挂载点：AppShell 侧边栏（variant="dark"）与 project 详情页顶栏
 *              （默认浅色），两种宿主配色由 BELL_STYLES 区分。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

/** 通知条目结构（GET /api/notifications 的 item） */
type NotificationItem = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
};

/** 通知类型 → 图标与强调色（展示层映射，与 DB 存的字符串对应） */
const TYPE_META: Record<string, { icon: string; tone: string }> = {
  TRANSCRIBE_DONE: { icon: "✅", tone: "text-green-600" },
  TRANSCRIBE_FAILED: { icon: "❌", tone: "text-red-500" },
  EXPORT_DONE: { icon: "🎬", tone: "text-green-600" },
  EXPORT_FAILED: { icon: "⚠️", tone: "text-red-500" },
  TRANSLATE_DONE: { icon: "🌐", tone: "text-green-600" },
  TRANSLATE_FAILED: { icon: "⚠️", tone: "text-red-500" },
};

/** 轮询间隔（毫秒） */
const POLL_INTERVAL_MS = 60_000;

/** 触发按钮配色（浅色顶栏 / 深色侧边栏两种宿主环境） */
const BELL_STYLES = {
  light: "border border-black/5 bg-white text-neutral-500 shadow-sm hover:text-brand",
  dark: "bg-white/10 text-neutral-300 hover:bg-white/15 hover:text-white",
} as const;

/**
 * 相对时间显示（如「3 分钟前」）
 * @param iso ISO 时间字符串
 */
function timeAgo(iso: string): string {
  const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 60) return "刚刚";
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟前`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} 小时前`;
  return new Date(iso).toLocaleDateString("zh-CN");
}

/**
 * 铃铛组件入口
 * @param variant 宿主配色：light 浅色顶栏（默认）/ dark 深色侧边栏
 */
export function NotificationBell({ variant = "light" }: { variant?: "light" | "dark" }) {
  const router = useRouter();
  const [unread, setUnread] = useState(0);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  /** 拉取未读数与列表（失败静默：通知是增强能力，不打扰用户） */
  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { unread: number; items: NotificationItem[] };
      setUnread(data.unread);
      setItems(data.items);
    } catch {
      /* 网络抖动忽略，下一轮再试 */
    }
  }, []);

  useEffect(() => {
    // 首次刷新走微任务（fetch 本就异步；避免在 effect 同步段触发 setState 级联渲染）
    void Promise.resolve().then(refresh);
    const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  // 点击面板外部关闭下拉
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  /**
   * 点击通知条目：标记该条已读 → 有 link 则跳转（关闭面板）
   * @param item 被点击的通知
   */
  const onItemClick = async (item: NotificationItem) => {
    setOpen(false);
    if (item.readAt) {
      if (item.link) router.push(item.link);
      return;
    }
    setItems((prev) => prev.map((n) => (n.id === item.id ? { ...n, readAt: new Date().toISOString() } : n)));
    setUnread((u) => Math.max(0, u - 1));
    try {
      await fetch("/api/notifications/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [item.id] }),
      });
    } catch {
      /* 乐观更新已做，失败不打断跳转 */
    }
    if (item.link) router.push(item.link);
  };

  /** 全部已读 */
  const onReadAll = async () => {
    setItems((prev) => prev.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() })));
    setUnread(0);
    try {
      await fetch("/api/notifications/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ all: true }),
      });
    } catch {
      /* 乐观更新已做 */
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label="站内通知"
        onClick={() => {
          setOpen((v) => !v);
          if (!open) void refresh();
        }}
        className={`relative flex h-9 w-9 items-center justify-center rounded-xl transition-colors ${BELL_STYLES[variant]}`}
      >
        {/* 铃铛图标 */}
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.7 21a2 2 0 0 1-3.4 0" />
        </svg>
        {unread > 0 && (
          <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-medium leading-none text-white">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-11 z-50 w-80 overflow-hidden rounded-2xl border border-black/5 bg-white shadow-lg">
          <div className="flex items-center justify-between border-b border-neutral-100 px-4 py-2.5">
            <span className="text-sm font-medium">通知</span>
            {unread > 0 && (
              <button type="button" onClick={onReadAll} className="text-xs text-neutral-500 transition-colors hover:text-brand">
                全部已读
              </button>
            )}
          </div>
          {items.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-neutral-400">暂无通知</p>
          ) : (
            <ul className="max-h-80 overflow-y-auto">
              {items.map((item) => {
                const meta = TYPE_META[item.type] ?? { icon: "🔔", tone: "text-neutral-600" };
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => void onItemClick(item)}
                      className={`flex w-full items-start gap-2.5 px-4 py-3 text-left transition-colors hover:bg-neutral-50 ${item.readAt ? "opacity-60" : ""}`}
                    >
                      <span className="mt-0.5 shrink-0 text-sm">{meta.icon}</span>
                      <span className="min-w-0 flex-1">
                        <span className={`block truncate text-sm ${item.readAt ? "font-normal text-neutral-600" : "font-medium text-neutral-900"}`}>
                          {item.title}
                          {!item.readAt && <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-red-500 align-middle" />}
                        </span>
                        {item.body && <span className="mt-0.5 block text-xs leading-5 text-neutral-500">{item.body}</span>}
                        <span className="mt-1 block text-[11px] text-neutral-400">{timeAgo(item.createdAt)}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
