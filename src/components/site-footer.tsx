/**
 * @file 全站页脚组件
 * @description 展示版权与协议入口。隐私协议/用户协议页面上线前补充（合规必需）。
 */

/** 版权起始年份（静态常量：Next.js Cache Components 模式禁止预渲染期调用 new Date()） */
const COPYRIGHT_YEAR = 2026;

/** 页脚 */
export function SiteFooter() {
  return (
    <footer className="border-t border-black/5 bg-white">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-4 py-8 text-sm text-neutral-500 sm:flex-row">
        <p>© {COPYRIGHT_YEAR} SubFlow 字幕工坊</p>
        <nav className="flex gap-6">
          {/* TODO: 上线前必须补充以下协议页面（合规要求） */}
          <a href="/privacy" className="hover:text-foreground">
            隐私政策
          </a>
          <a href="/terms" className="hover:text-foreground">
            用户协议
          </a>
          <a href="mailto:support@example.com" className="hover:text-foreground">
            联系我们
          </a>
        </nav>
      </div>
    </footer>
  );
}
