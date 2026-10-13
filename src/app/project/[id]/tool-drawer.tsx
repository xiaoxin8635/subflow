"use client";
/**
 * @file 通用右侧滑入抽屉（批次①信息架构重排）
 * @description 编辑器的次要工具面板（字幕翻译 / 导出成片）收进抽屉：
 *              主界面只保留剪辑主任务，低频操作点顶部按钮唤起。
 *              交互：遮罩点击 / Esc 键 / 右上角 ✕ 关闭；打开时锁定 body 滚动；
 *              入场动画（遮罩淡入 + 面板右滑入）由挂载后一帧切换 shown 驱动。
 *              父组件以条件渲染挂载（`{drawer && <ToolDrawer/>}`），
 *              关闭即卸载、内部状态自然丢弃，无需退出动画。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * 抽屉组件
 * @param title    抽屉标题（顶部栏 + aria-label）
 * @param onClose  关闭回调（遮罩点击 / Esc / ✕ 按钮统一走这里）
 * @param children 抽屉内容（滚动区域）
 */
export function ToolDrawer({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  // 入场动画开关：挂载后下一帧置 true，触发 transition（避免首帧直接渲染终态无动画）
  const [shown, setShown] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  // 挂载：下一帧滑入 + Esc 关闭 + body 滚动锁 + 焦点移到关闭按钮（键盘可达）
  useEffect(() => {
    const raf = requestAnimationFrame(() => setShown(true));
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label={title}>
      {/* 遮罩：点击关闭 */}
      <div
        onClick={onClose}
        className={`absolute inset-0 bg-black/40 transition-opacity duration-200 ${
          shown ? "opacity-100" : "opacity-0"
        }`}
      />
      {/* 面板：右侧滑入（左侧大圆角 + 柔和弥散投影） */}
      <div
        className={`absolute inset-y-0 right-0 flex w-full max-w-lg flex-col rounded-l-3xl bg-white shadow-[0_0_60px_-15px_rgba(16,60,52,0.35)] transition-transform duration-300 ease-out ${
          shown ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-neutral-100 px-5 py-4">
          <h2 className="text-lg font-bold">{title}</h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            title="关闭（Esc）"
            className="rounded-lg px-2 py-1 text-lg leading-none text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700"
          >
            ✕
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
      </div>
    </div>
  );
}
