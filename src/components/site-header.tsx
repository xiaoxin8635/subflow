/**
 * @file 全站顶部导航栏组件（服务端组件，无客户端状态）
 * @description 展示产品 Logo 与主要入口。登录态显示由各页面根据需要自行处理，
 *              MVP 阶段先展示静态导航，接入认证后再动态渲染「控制台/登录」按钮。
 */

/** 顶部导航栏 */
export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-black/5 bg-white/80 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4">
        {/* Logo 区 */}
        <a href="/" className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand text-sm font-bold text-white">
            SF
          </span>
          <span className="text-lg font-semibold tracking-tight">
            SubFlow{" "}
            <span className="hidden text-sm font-normal text-neutral-500 sm:inline">
              字幕工坊
            </span>
          </span>
        </a>

        {/* 导航链接 */}
        <nav className="flex items-center gap-6 text-sm text-neutral-600">
          <a href="/#features" className="hidden hover:text-foreground sm:inline">
            功能
          </a>
          <a href="/pricing" className="hidden hover:text-foreground sm:inline">
            定价
          </a>
          <a
            href="/dashboard"
            className="rounded-lg bg-brand px-4 py-2 font-medium text-white transition-colors hover:bg-brand-strong"
          >
            进入工作台
          </a>
        </nav>
      </div>
    </header>
  );
}
