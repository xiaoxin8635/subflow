"use client";
/**
 * @file 工作台状态筛选标签栏（客户端组件）
 * @description URL 参数驱动（?status=active|ready|failed，空 = 全部），刷新/分享不丢状态。
 *              底部品牌色指示条随选中项滑动（useLayoutEffect 测量，reduced-motion 下
 *              由 Tailwind motion-reduce 关闭过渡）。点击后列表由服务端重渲染。
 */
import { useLayoutEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

/** 筛选键（与 URL 参数一致） */
export type StatusFilter = "" | "active" | "ready" | "failed";

/** 筛选选项与各档计数 */
interface FilterTabsProps {
  current: StatusFilter;
  counts: Record<"all" | "active" | "ready" | "failed", number>;
}

/** 选项定义（顺序即展示顺序） */
const OPTIONS: { key: StatusFilter; label: string }[] = [
  { key: "", label: "全部" },
  { key: "active", label: "进行中" },
  { key: "ready", label: "已完成" },
  { key: "failed", label: "失败" },
];

/**
 * 筛选标签栏组件
 * @param props current 当前筛选 / counts 各档计数
 */
export function FilterTabs({ current, counts }: FilterTabsProps) {
  const router = useRouter();
  const btnRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [bar, setBar] = useState({ left: 0, width: 0 });

  // 测量当前选中按钮的位置，驱动指示条滑动（字体加载完成后可能重排，双 rAF 重测一次）
  useLayoutEffect(() => {
    const measure = () => {
      const idx = OPTIONS.findIndex((o) => o.key === current);
      const el = btnRefs.current[idx];
      if (el) setBar({ left: el.offsetLeft, width: el.offsetWidth });
    };
    measure();
    const raf = requestAnimationFrame(() => requestAnimationFrame(measure));
    return () => cancelAnimationFrame(raf);
  }, [current]);

  /** 切换筛选：写 URL 参数（reset 页码），列表由服务端重渲染 */
  function select(key: StatusFilter) {
    const params = new URLSearchParams();
    if (key) params.set("status", key);
    router.replace(params.size > 0 ? `/dashboard?${params}` : "/dashboard", { scroll: false });
  }

  return (
    <div className="relative inline-flex gap-1 border-b border-neutral-200">
      {OPTIONS.map((o, i) => {
        const selected = o.key === current;
        return (
          <button
            key={o.key || "all"}
            ref={(el) => {
              btnRefs.current[i] = el;
            }}
            type="button"
            onClick={() => select(o.key)}
            aria-pressed={selected}
            className={`relative px-3 pb-2.5 pt-1.5 text-sm transition-colors motion-reduce:transition-none ${
              selected ? "font-medium text-neutral-900" : "text-neutral-500 hover:text-neutral-800"
            }`}
          >
            {o.label}
            <span
              className={`ml-1.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-xs tabular-nums transition-colors motion-reduce:transition-none ${
                selected
                  ? "bg-brand/10 font-medium text-brand"
                  : counts[o.key === "" ? "all" : o.key] === 0
                    ? "bg-neutral-50 text-neutral-300"
                    : "bg-neutral-100 text-neutral-500"
              }`}
            >
              {counts[o.key === "" ? "all" : o.key]}
            </span>
          </button>
        );
      })}
      {/* 滑动指示条 */}
      <span
        aria-hidden
        className="absolute bottom-0 h-0.5 rounded-full bg-brand transition-[left,width] duration-300 ease-out motion-reduce:transition-none"
        style={{ left: bar.left, width: bar.width }}
      />
    </div>
  );
}
