/**
 * @file 返回导航胶囊按钮（登录态页面顶部统一的「返回」入口）
 * @description 白底胶囊 + stroke 左箭头（1.7 线宽与全站图标一致）；
 *              hover 时描边与文字染品牌色、箭头左移 2px 给出「会返回」的
 *              方向性微交互。替换各页面原先的纯文本「← 返回…」链接。
 */
import Link from "next/link";

/** 返回胶囊按钮属性 */
interface BackLinkProps {
  /** 跳转目标 */
  href: string;
  /** 按钮文案（如「返回项目列表」） */
  label: string;
}

/** 返回导航胶囊按钮组件 */
export function BackLink({ href, label }: BackLinkProps) {
  return (
    <Link
      href={href}
      className="group inline-flex items-center gap-1.5 rounded-full border border-neutral-200 bg-white px-3.5 py-1.5 text-sm text-neutral-600 shadow-sm transition-colors hover:border-brand/40 hover:text-brand"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-4 w-4 transition-transform duration-200 group-hover:-translate-x-0.5"
        aria-hidden
      >
        <path d="M19 12H5" />
        <path d="m11 18-6-6 6-6" />
      </svg>
      {label}
    </Link>
  );
}
