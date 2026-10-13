/**
 * @file 登录后应用外壳：深色侧边栏 + 浅色内容区
 * @description 视觉母题取自剪辑软件（剪映/PR/达芬奇均为深色工具面板）——侧边栏是
 *              「工具面板」，内容区是「画面」。桌面（≥lg）左侧固定 240px 面板；
 *              窄屏收纳为顶部横向标签栏（可横滑）。底部用户区含脱敏手机号、
 *              通知铃铛、余额与退出登录。导航部分（SideNav / MobileNavTabs）
 *              为客户端组件——共享滑动高亮层，切换页面时平滑平移；须由
 *              dashboard/layout.tsx（或项目详情页）渲染以保留跨页 DOM。
 *              营销页（首页/价格/法务）仍用 SiteHeader，不套本外壳。
 */
import Link from "next/link";
import { maskPhone } from "@/lib/auth";
import { formatSecondsLabel } from "@/lib/format";
import { NotificationBell } from "@/components/notification-bell";
import { LogoutButton, MobileLogout } from "@/components/logout-button";
import { SideNav, MobileNavTabs } from "@/components/side-nav";

/** AppShell 属性 */
interface AppShellProps {
  /** 当前用户手机号（组件内脱敏展示） */
  phone: string;
  /** 剩余额度（秒） */
  balanceSeconds: number;
  /** 页面内容 */
  children: React.ReactNode;
}

/**
 * 应用外壳组件
 * @param props 用户信息 / 内容
 */
export function AppShell({ phone, balanceSeconds, children }: AppShellProps) {
  return (
    <div className="min-h-screen bg-neutral-50">
      {/* 移动端顶部面板（<lg）：Logo + 横向滚动标签栏（滑动高亮块） */}
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
        <MobileNavTabs>
          <span className="shrink-0 self-center pl-2">
            <MobileLogout />
          </span>
        </MobileNavTabs>
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

          {/* 主导航：滑动高亮层（渐变底 + 发光指示条整体平移），见 side-nav.tsx */}
          <SideNav />

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
