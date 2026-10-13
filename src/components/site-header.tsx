/**
 * @file 全站顶部导航栏组件（服务端组件，无客户端状态）
 * @description 展示产品 Logo 与主要入口。登录态显示由各页面根据需要自行处理，
 *              MVP 阶段先展示静态导航，接入认证后再动态渲染「控制台/登录」按钮。
 *              页内导航统一用 next/link（客户端路由，避免整页刷新）。
 */
import Link from "next/link";

/** 顶部导航栏 */
export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-black/5 bg-white/80 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4">
        {/* Logo 区 */}
        <Link href="/" className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand text-sm font-bold text-white">
            SF
          </span>
          <span className="text-lg font-semibold tracking-tight">
            SubFlow{" "}
            <span className="hidden text-sm font-normal text-neutral-500 sm:inline">
              字幕工坊
            </span>
          </span>
        </Link>

        {/* 导航链接 */}
        <nav className="flex items-center gap-6 text-sm text-neutral-600">
          <Link href="/#features" className="hidden hover:text-foreground sm:inline">
            功能
          </Link>
          <Link href="/pricing" className="hidden hover:text-foreground sm:inline">
            定价
          </Link>
          <Link
            href="/dashboard"
            className="rounded-lg bg-brand px-4 py-2 font-medium text-white shadow-[0_2px_0_0_#0f766e] transition-all duration-150 hover:-translate-y-px hover:bg-brand-strong hover:shadow-[0_3px_0_0_#0f766e] active:translate-y-px active:shadow-none"
          >
            进入工作台
          </Link>
        </nav>
      </div>
    </header>
  );
}
