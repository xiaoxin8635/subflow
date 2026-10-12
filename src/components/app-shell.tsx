/**
 * @file 登录后应用外壳：深色侧边栏 + 浅色内容区（服务端组件，零客户端 JS）
 * @description 视觉母题取自剪辑软件（剪映/PR/达芬奇均为深色工具面板）——侧边栏是
 *              「工具面板」，内容区是「画面」。桌面（≥lg）左侧固定 240px 面板；
 *              窄屏收纳为顶部横向标签栏（可横滑）。底部用户区含脱敏手机号、
 *              通知铃铛、余额与退出登录。当前项由各页面传入 active 标识高亮。
 *              营销页（首页/价格/法务）仍用 SiteHeader，不套本外壳。
 */
import Link from "next/link";
import { maskPhone } from "@/lib/auth";
import { formatSecondsLabel } from "@/lib/format";
import { NotificationBell } from "@/components/notification-bell";
import { LogoutButton, MobileLogout } from "@/components/logout-button";

/** 侧边栏导航项 */
const NAV_ITEMS = [
  { href: "/dashboard", label: "我的项目", key: "projects" },
  { href: "/dashboard/new", label: "新建项目", key: "new" },
  { href: "/dashboard/invite", label: "邀请好友", key: "invite" },
  { href: "/dashboard/redeem", label: "兑换额度", key: "redeem" },
  { href: "/pricing", label: "购买额度", key: "pricing" },
] as const;

/** 导航项图标（stroke 1.7 线性风格，随文字色继承；projects=胶片格呼应剪辑母题） */
const NAV_ICONS: Record<(typeof NAV_ITEMS)[number]["key"], string[]> = {
  projects: [
    "M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z",
    "M8 5v14",
    "M16 5v14",
    "M3 10h5",
    "M3 14h5",
    "M16 10h5",
    "M16 14h5",
  ],
  new: ["M12 8v8", "M8 12h8"],
  invite: [
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2",
    "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z",
    "M19 8v6",
    "M22 11h-6",
  ],
  redeem: [
    "M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z",
    "M13 5v2",
    "M13 11v2",
    "M13 17v2",
  ],
  pricing: ["M13 2 3 14h9l-1 8 10-12h-9l1-8Z"],
};

/** 导航图标组件 */
function NavIcon({ paths }: { paths: string[] }) {
  return (
    <svg
      viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
      strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 shrink-0" aria-hidden
    >
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

/** AppShell 属性 */
interface AppShellProps {
  /** 当前高亮的导航 key（NAV_ITEMS.key） */
  active: (typeof NAV_ITEMS)[number]["key"];
  /** 当前用户手机号（组件内脱敏展示） */
  phone: string;
  /** 剩余额度（秒） */
  balanceSeconds: number;
  /** 页面内容 */
  children: React.ReactNode;
}

/**
 * 应用外壳组件
 * @param props active 高亮项 / 用户信息 / 内容
 */
export function AppShell({ active, phone, balanceSeconds, children }: AppShellProps) {
  /** 桌面/移动共用的当前项判定 */
  const isActive = (key: string) => key === active;

  return (
    <div className="min-h-screen bg-neutral-50">
      {/* 移动端顶部面板（<lg）：Logo + 横向滚动标签栏（激活 chip 品牌渐变底） */}
      <div className="sticky top-0 z-40 bg-[#17171a] lg:hidden">
        <div className="flex items-center justify-between px-4 pt-3">
          <Link href="/" className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-gradient-to-br from-[#6366f1] to-[#4338ca] text-xs font-bold text-white shadow-[0_0_10px_rgba(99,102,241,0.4)]">
              SF
            </span>
            <span className="text-sm font-semibold text-white">字幕工坊</span>
          </Link>
          <NotificationBell variant="dark" />
        </div>
        <nav className="flex gap-1 overflow-x-auto px-3 pb-2 pt-2 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.key}
              href={item.href}
              aria-current={isActive(item.key) ? "page" : undefined}
              className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm transition-colors ${
                isActive(item.key)
                  ? "bg-brand/20 font-medium text-white"
                  : "text-neutral-400 hover:text-white"
              }`}
            >
              <span
                aria-hidden
                className={isActive(item.key) ? "text-indigo-300" : "text-neutral-500"}
              >
                <NavIcon paths={NAV_ICONS[item.key]} />
              </span>
              {item.label}
            </Link>
          ))}
          {/* 移动端无侧边栏用户区，退出入口挂在标签栏末尾 */}
          <span className="shrink-0 self-center pl-2">
            <MobileLogout />
          </span>
        </nav>
      </div>

      <div className="lg:flex">
        {/* 桌面侧边栏（≥lg）：固定深色工具面板（顶部靛蓝微光晕营造氛围） */}
        <aside className="sticky top-0 isolate hidden h-screen w-60 shrink-0 flex-col bg-[#17171a] lg:flex">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-44 bg-[radial-gradient(70%_100%_at_50%_0%,rgba(99,102,241,0.14),transparent)]"
          />
          {/* Logo 区（SF 渐变辉光方块） */}
          <div className="px-5 pb-6 pt-6">
            <Link href="/" className="flex items-center gap-2.5">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-[#6366f1] to-[#4338ca] text-sm font-bold text-white shadow-[0_0_14px_rgba(99,102,241,0.45)]">
                SF
              </span>
              <span className="text-base font-semibold tracking-tight text-white">
                字幕工坊
              </span>
            </Link>
          </div>

          {/* 主导航：当前项品牌渐变底 + 发光指示条；图标 hover 微移 */}
          <nav className="flex-1 space-y-0.5 px-3" aria-label="主导航">
            {NAV_ITEMS.map((item) => (
              <Link
                key={item.key}
                href={item.href}
                aria-current={isActive(item.key) ? "page" : undefined}
                className={`group relative flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-all duration-150 ${
                  isActive(item.key)
                    ? "bg-gradient-to-r from-brand/25 to-brand/5 font-medium text-white"
                    : "text-neutral-400 hover:bg-white/5 hover:text-white"
                }`}
              >
                {isActive(item.key) && (
                  <span
                    aria-hidden
                    className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-brand shadow-[0_0_8px_2px_rgba(79,70,229,0.55)]"
                  />
                )}
                <span
                  aria-hidden
                  className={`transition-all duration-150 group-hover:translate-x-0.5 ${
                    isActive(item.key)
                      ? "text-indigo-300"
                      : "text-neutral-500 group-hover:text-neutral-300"
                  }`}
                >
                  <NavIcon paths={NAV_ICONS[item.key]} />
                </span>
                {item.label}
              </Link>
            ))}
          </nav>

          {/* 底部用户区：余额 + 手机号 + 铃铛 + 退出 */}
          <div className="border-t border-white/10 px-3 py-4">
            <div className="rounded-xl bg-white/5 px-3 py-3 ring-1 ring-inset ring-white/5">
              <p className="text-xs text-neutral-500">剩余额度</p>
              <p className="mt-0.5 bg-gradient-to-r from-white via-white to-neutral-400 bg-clip-text text-lg font-semibold tabular-nums text-transparent">
                {formatSecondsLabel(balanceSeconds)}
              </p>
              <div className="mt-1 flex items-center justify-between text-xs">
                <span className="text-neutral-500">{maskPhone(phone)}</span>
                <NotificationBell variant="dark" placement="bottom" />
              </div>
            </div>
            <LogoutButton />
          </div>
        </aside>

        {/* 内容区 */}
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
