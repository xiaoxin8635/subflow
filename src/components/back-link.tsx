/**
 * @file 返回导航胶囊按钮（登录态页面顶部统一的「返回」入口）
 * @description 「剪辑台」工具语言的返回键：白底胶囊内嵌一枚品牌软底圆形箭头键，
 *              hover 时圆底染成实心品牌色、箭头翻白并左移——方向感先行，
 *              像按下播放器上的回退键。三页（新建/详情/邀请）复用同一组件。
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
      className="group inline-flex items-center gap-2 rounded-full border border-neutral-200 bg-white py-1 pl-1 pr-3.5 text-sm font-medium text-neutral-700 shadow-sm transition-all hover:border-brand/30 hover:shadow-md"
    >
      <span className="flex h-6.5 w-6.5 items-center justify-center rounded-full bg-brand-soft text-brand transition-colors duration-200 group-hover:bg-brand group-hover:text-white">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-3.5 w-3.5 transition-transform duration-200 group-hover:-translate-x-px"
          aria-hidden
        >
          <path d="M19 12H5" />
          <path d="m11 18-6-6 6-6" />
        </svg>
      </span>
      {label}
    </Link>
  );
}
