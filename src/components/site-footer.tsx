/**
 * @file 全站页脚组件
 * @description 展示版权、协议入口与 ICP 备案号。备案号通过 NEXT_PUBLIC_ICP_BEIAN
 *              环境变量注入（备案通过后配置，未配置时不显示占位）。
 */

/** 版权起始年份（静态常量：Next.js Cache Components 模式禁止预渲染期调用 new Date()） */
const COPYRIGHT_YEAR = 2026;

/** ICP 备案号（如 "京ICP备2026XXXXXX号-1"，空串 = 未备案不展示） */
const ICP_BEIAN = process.env.NEXT_PUBLIC_ICP_BEIAN ?? "";

/** 页脚 */
export function SiteFooter() {
  return (
    <footer className="border-t border-black/5 bg-white">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-4 py-8 text-sm text-neutral-500 sm:flex-row">
        <p>
          © {COPYRIGHT_YEAR} SubFlow 字幕工坊
          {ICP_BEIAN && (
            <>
              {" · "}
              <a
                href="https://beian.miit.gov.cn"
                target="_blank"
                rel="noreferrer"
                className="hover:text-foreground"
              >
                {ICP_BEIAN}
              </a>
            </>
          )}
        </p>
        <nav className="flex gap-6">
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
